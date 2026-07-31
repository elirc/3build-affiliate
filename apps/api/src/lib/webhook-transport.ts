import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { isBlockedAddress, parseWebhookUrl } from './ssrf';

/**
 * The one place this service dials an address a customer chose.
 *
 * Everything here exists because the far end is not ours. It will be slow, it
 * will return 500, it will present an expired certificate, and -- the case
 * people forget -- it will accept the connection and then say nothing at all.
 * A worker blocked forever on a socket that never speaks is indistinguishable
 * from a worker that has stopped, except that nothing alerts on it.
 */

/** Whole-request deadline: connect, TLS, request and response headers. */
export const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * A response body is read and thrown away up to this much.
 *
 * We do not use it, but the socket has to be drained before it can be closed,
 * and a subscriber that answers a webhook with a 200 and a 2GB body should not
 * be able to make that our problem.
 */
const MAX_RESPONSE_BYTES = 8 * 1024;

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * The outcome of one attempt.
 *
 * A transport error and an HTTP error are both failures but they are not the
 * same failure, and the delivery log is worth very little if it cannot tell a
 * brand which of the two happened. Hence a nullable status code rather than a
 * sentinel like 0.
 */
export interface WebhookAttempt {
  statusCode: number | null;
  error: string | null;
}

export interface WebhookTransport {
  send(request: WebhookRequest): Promise<WebhookAttempt>;
}

export interface HttpWebhookTransportOptions {
  /**
   * Permits delivery to private addresses.
   *
   * Off everywhere except an integration test, whose stub server is on
   * loopback by definition. Registration stays strict regardless -- this
   * relaxes the delivery-time check only, so a test can exercise the real
   * socket without also disabling the guard the routes depend on.
   */
  allowPrivateTargets?: boolean;
  timeoutMs?: number;
}

export class HttpWebhookTransport implements WebhookTransport {
  private readonly allowPrivateTargets: boolean;
  private readonly timeoutMs: number;

  constructor(options: HttpWebhookTransportOptions = {}) {
    this.allowPrivateTargets = options.allowPrivateTargets ?? false;
    this.timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  }

  async send(request: WebhookRequest): Promise<WebhookAttempt> {
    let target;
    try {
      target = parseWebhookUrl(request.url, { allowPrivate: this.allowPrivateTargets });
    } catch (err) {
      return { statusCode: null, error: `Invalid url: ${(err as Error).message}` };
    }

    let address: string;
    let family: number;
    try {
      const resolved = await dns.lookup(target.hostname, { all: true });
      const usable = resolved.find(
        (a) => this.allowPrivateTargets || !isBlockedAddress(a.address)
      );
      if (!usable) {
        // Not a transient failure and not worth a retry: the endpoint resolves
        // somewhere it is not allowed to reach. Recorded as an error the brand
        // can read, because the alternative is a mysterious dead integration.
        return {
          statusCode: null,
          error: 'Host resolves to a private or reserved address',
        };
      }
      address = usable.address;
      family = usable.family;
    } catch (err) {
      return { statusCode: null, error: `DNS lookup failed: ${String(err)}` };
    }

    return this.dial(target, address, family, request);
  }

  /**
   * Connects to the resolved address rather than the hostname.
   *
   * This is what makes the check above unraceable. Resolving, validating, and
   * then handing the *hostname* to the socket lets a second lookup return a
   * different answer -- DNS rebinding, and it is the standard way past a guard
   * that checks the name instead of the address. TLS still verifies against
   * the hostname, via SNI, so pinning the address costs no certificate safety.
   */
  private dial(
    target: ReturnType<typeof parseWebhookUrl>,
    address: string,
    family: number,
    request: WebhookRequest
  ): Promise<WebhookAttempt> {
    const secure = target.protocol === 'https:';
    const client = secure ? https : http;

    return new Promise<WebhookAttempt>((resolve) => {
      let settled = false;
      const settle = (attempt: WebhookAttempt) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(attempt);
      };

      const req = client.request(
        {
          host: address,
          family,
          port: target.port,
          path: target.path,
          method: 'POST',
          // The socket is addressed by IP, so the name has to travel in the
          // header and in SNI or a virtual host answers 404 and a certificate
          // fails to match.
          headers: { ...request.headers, host: target.hostname },
          ...(secure ? { servername: target.hostname } : {}),
          // No keep-alive pool. A pooled socket is one that skipped the
          // resolution check above, and reusing it for a later delivery would
          // let an endpoint that has since moved to a private address keep the
          // connection it earned while it was still public.
          agent: false,
        },
        (res) => {
          let seen = 0;
          res.on('data', (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > MAX_RESPONSE_BYTES) res.destroy();
          });
          res.on('end', () => settle({ statusCode: res.statusCode ?? null, error: null }));
          // A body we abandoned is still a response: the status code arrived,
          // which is the only thing delivery is judged on.
          res.on('close', () => settle({ statusCode: res.statusCode ?? null, error: null }));
          res.on('error', (err) =>
            settle({ statusCode: res.statusCode ?? null, error: String(err) })
          );
        }
      );

      // One deadline over the whole exchange, not a socket-inactivity timeout.
      // An endpoint that dribbles a byte every four seconds resets an
      // inactivity timer forever and holds the worker exactly as effectively as
      // one that says nothing.
      const deadline = setTimeout(() => {
        req.destroy();
        settle({
          statusCode: null,
          error: `Timed out after ${this.timeoutMs}ms`,
        });
      }, this.timeoutMs);

      req.on('error', (err) => settle({ statusCode: null, error: String(err) }));
      req.end(request.body);
    });
  }
}
