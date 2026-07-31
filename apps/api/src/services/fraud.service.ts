import { prisma } from '../config/prisma';

const HIGH_RISK_THRESHOLD = 60;

interface ConversionContext {
  conversionId: string;
  affiliateId: string;
  campaignId: string;
  attributionCookieId?: string;
  clickTimestamps: number[];
  conversionTimestamp: number;
}

interface Signal {
  rule: string;
  score: number;
  detail: string;
}

/**
 * Pure rule-based fraud scoring (Phase-1 stand-in for an ML model).
 * Higher score = more suspicious. Each rule contributes 0–40.
 *
 * Rules:
 *  1. Click-to-convert latency < 5s → bot or stuffed cookie
 *  2. > 5 clicks from same IP hash in the attribution window → cookie stuffing
 *  3. Same attribution cookie has already triggered a conversion in the
 *     last 24h on this campaign → likely fraud or test traffic
 */
export function fraudService() {
  async function score(ctx: ConversionContext): Promise<{ total: number; signals: Signal[] }> {
    const signals: Signal[] = [];

    // Rule 1: click-to-convert latency
    if (ctx.clickTimestamps.length > 0) {
      const lastClick = Math.max(...ctx.clickTimestamps);
      const latencyMs = ctx.conversionTimestamp - lastClick;
      if (latencyMs < 5_000) {
        signals.push({
          rule: 'low_latency',
          score: 40,
          detail: `${latencyMs}ms between click and conversion`,
        });
      } else if (latencyMs < 60_000) {
        signals.push({
          rule: 'low_latency',
          score: 20,
          detail: `${(latencyMs / 1000).toFixed(0)}s between click and conversion`,
        });
      }
    }

    // Rule 2: many clicks from one IP, for the cookie being scored.
    //
    // Both halves of this must describe the *same* traffic. They did not: the
    // click count was scoped to the cookie while the distinct-IP count was
    // taken across every click for the affiliate and campaign. So the rule
    // read "this cookie clicked a lot AND the whole campaign has only ever
    // seen one IP", and the second half stopped being true the moment a
    // campaign had two real visitors -- which silently disabled the signal on
    // exactly the busy campaigns worth policing.
    //
    // One grouped query now, so the two numbers cannot drift apart again.
    if (ctx.attributionCookieId) {
      const rows = await prisma.$queryRaw<{ clicks: bigint; unique_ips: bigint }[]>`
        SELECT COUNT(*)::bigint                    AS clicks,
               COUNT(DISTINCT ce."ipHash")::bigint AS unique_ips
        FROM "ClickEvent" ce
        JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
        WHERE ce."attributionCookieId" = ${ctx.attributionCookieId}
          AND tl."affiliateId" = ${ctx.affiliateId}
          AND tl."campaignId" = ${ctx.campaignId}
          AND ce."isCounted" = true
          AND ce."timestamp" >= NOW() - INTERVAL '24 hours'
      `;

      const clickCount = Number(rows[0]?.clicks ?? 0);
      const uniqueIps = Number(rows[0]?.unique_ips ?? 0);

      if (clickCount > 5 && uniqueIps <= 1) {
        signals.push({
          rule: 'cookie_ip_concentration',
          score: 30,
          detail: `${clickCount} clicks from ${uniqueIps} unique IP(s) on this cookie`,
        });
      }
    }

    // Rule 3: duplicate conversion from same attribution cookie
    if (ctx.attributionCookieId) {
      const recent = await prisma.conversion.count({
        where: {
          campaignId: ctx.campaignId,
          createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
          clickEvent: { attributionCookieId: ctx.attributionCookieId },
          id: { not: ctx.conversionId },
        },
      });
      if (recent > 0) {
        signals.push({
          rule: 'duplicate_cookie',
          score: 30,
          detail: `Cookie already converted ${recent} time(s) today on this campaign`,
        });
      }
    }

    const total = Math.min(
      100,
      signals.reduce((s, x) => s + x.score, 0)
    );
    return { total, signals };
  }

  return {
    async evaluate(ctx: ConversionContext) {
      const { total, signals } = await score(ctx);
      if (signals.length === 0) return null;

      const review = await prisma.fraudReview.create({
        data: {
          conversionId: ctx.conversionId,
          riskScore: total,
          signals: signals as any,
          decision: total >= HIGH_RISK_THRESHOLD ? 'FLAGGED' : 'PENDING',
        },
      });
      return review;
    },

    HIGH_RISK_THRESHOLD,
  };
}
