/**
 * Identifying traffic that should not count as a click.
 *
 * Three distinct populations, and conflating them is the usual mistake:
 *
 *  - **Crawlers** announce themselves. Googlebot has no reason to hide.
 *  - **Link previewers** fetch a URL because a human pasted it into Slack or
 *    iMessage. That is not a visit, and there may be several per share.
 *  - **Tools** -- curl, wget, python-requests -- are usually a developer or a
 *    monitor.
 *
 * All three are *redirected* normally. Breaking a link preview makes an
 * affiliate's post look broken in every chat app, which costs them real
 * traffic. They are simply not counted.
 */

export type TrafficKind = 'human' | 'crawler' | 'preview' | 'tool';

interface Rule {
  kind: Exclude<TrafficKind, 'human'>;
  /** Lowercase substrings. Cheaper and less brittle than regexes here. */
  match: string[];
}

const RULES: Rule[] = [
  {
    kind: 'preview',
    match: [
      'slackbot',
      'twitterbot',
      'facebookexternalhit',
      'linkedinbot',
      'whatsapp',
      'telegrambot',
      'discordbot',
      'skypeuripreview',
      'embedly',
      'quora link preview',
      'redditbot',
      'applebot',
      'pinterest',
      'vkshare',
      'iframely',
    ],
  },
  {
    kind: 'crawler',
    match: [
      'googlebot',
      'bingbot',
      'yandexbot',
      'duckduckbot',
      'baiduspider',
      'ahrefsbot',
      'semrushbot',
      'mj12bot',
      'dotbot',
      'petalbot',
      'bytespider',
      'gptbot',
      'ccbot',
      'claudebot',
      'crawler',
      'spider',
    ],
  },
  {
    kind: 'tool',
    match: [
      'curl/',
      'wget/',
      'python-requests',
      'python-urllib',
      'go-http-client',
      'java/',
      'okhttp',
      'axios/',
      'node-fetch',
      'postmanruntime',
      'headlesschrome',
      'phantomjs',
      'httpclient',
      'apache-httpclient',
    ],
  },
];

/**
 * Classifies a user agent.
 *
 * An empty or absent UA counts as a tool: every real browser sends one, so
 * its absence means something is speaking HTTP directly.
 */
export function classifyTraffic(userAgent: string | undefined | null): TrafficKind {
  if (!userAgent || userAgent.trim() === '') return 'tool';

  const ua = userAgent.toLowerCase();
  for (const rule of RULES) {
    if (rule.match.some((m) => ua.includes(m))) return rule.kind;
  }
  return 'human';
}

/** Whether this traffic should count toward clicks, EPC and attribution. */
export function countsAsClick(kind: TrafficKind): boolean {
  return kind === 'human';
}

const KINDS: readonly TrafficKind[] = ['human', 'crawler', 'preview', 'tool'];

/**
 * Narrows a value that arrived over the wire.
 *
 * The queue payload is JSON, so its `trafficKind` is just a string -- it may
 * come from an older producer, or from something that made a value up.
 * Returning null lets the caller fall back to classifying the user agent
 * itself rather than trusting an unknown label.
 */
export function parseTrafficKind(value: unknown): TrafficKind | null {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
    ? (value as TrafficKind)
    : null;
}

export function isBot(userAgent: string | undefined | null): boolean {
  return !countsAsClick(classifyTraffic(userAgent));
}

/**
 * How long two clicks from the same visitor on the same link are treated as
 * one.
 *
 * Covers a double-click, a refresh, and the common pattern where a link
 * preview and the human's own visit arrive seconds apart. Long enough to
 * catch those, short enough that someone genuinely returning half a minute
 * later still counts.
 */
export const DEFAULT_DEDUP_WINDOW_SECONDS = 30;

export function dedupKey(trackingLinkId: string, cookieId: string): string {
  return `click_seen:${trackingLinkId}:${cookieId}`;
}
