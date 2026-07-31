import { Errors } from './errors';

/**
 * Server-side request forgery guard for outbound webhooks.
 *
 * A webhook url is an address a stranger chooses and our server dials. That is
 * the whole SSRF primitive: someone with a free trial account registers
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and we
 * fetch it from inside the VPC, with whatever the instance role can reach. The
 * signed payload we POST is not the prize -- the response, the timing, and the
 * mere fact that the connection succeeded all leak.
 *
 * The address checks are pure and unit tested. Resolution is not, and lives in
 * `webhook-transport.ts` alongside the socket it protects: checking at
 * registration and then again "at delivery time" a few lines before connecting
 * still leaves a window, because DNS is the attacker's to change. The only
 * check that cannot be raced is the one applied to the address the socket is
 * about to use.
 */

/** Parsed from the dotted quad. Returns null for anything that is not IPv4. */
function ipv4Octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

/**
 * True for any address a webhook must never reach.
 *
 * The list is longer than the four RFC 1918 ranges people remember, and every
 * addition is an address that has been used to get out of a naive guard:
 * link-local is the cloud metadata endpoint, carrier-grade NAT is a neighbour
 * in a shared environment, `0.0.0.0/8` resolves to localhost on Linux, and
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is the same loopback wearing a
 * different notation.
 */
export function isBlockedAddress(address: string): boolean {
  const normalised = address.trim().toLowerCase();
  if (normalised.length === 0) return true;

  // IPv4-mapped and IPv4-compatible IPv6 are IPv4 with extra syntax, and a
  // guard that only pattern-matches the text form waves them through.
  const mapped = normalised.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedAddress(mapped[1]!);

  // The same addresses again, spelled in hex.
  //
  // `::ffff:7f00:1` and `::a00:5` are 127.0.0.1 and 10.0.0.5, and only the
  // dotted spelling was recognised -- so the hex form of exactly the addresses
  // this function exists to refuse went straight through it. An allow/deny
  // check that depends on notation is not a check.
  const embedded = normalised.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (embedded) {
    const high = parseInt(embedded[1]!, 16);
    const low = parseInt(embedded[2]!, 16);
    return isBlockedAddress(
      `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
    );
  }

  const octets = ipv4Octets(normalised);
  if (octets) {
    const [a, b] = octets as [number, number, number, number];
    if (a === 0) return true; // "this network" -- 0.0.0.0 is localhost on Linux
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // 127/8 loopback
    if (a === 169 && b === 254) return true; // 169.254/16 link-local, incl. metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier-grade NAT
    if (a === 192 && b === 0) return true; // 192.0.0/24 and 192.0.2/24
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (normalised === '::' || normalised === '::1') return true;
  // fc00::/7 unique-local and fe80::/10 link-local. Matched on the leading
  // nibbles because the text form of an IPv6 address has too many spellings to
  // enumerate, and this is the part that identifies the range.
  if (/^f[cd]/.test(normalised)) return true;
  if (/^fe[89ab]/.test(normalised)) return true;
  // ff00::/8 multicast. The IPv4 side already refuses 224/4; leaving the v6
  // equivalent out was an asymmetry rather than a decision, and `ff02::1` is
  // all-nodes-on-this-link.
  if (/^ff/.test(normalised)) return true;

  return false;
}

export interface WebhookUrlTarget {
  hostname: string;
  port: number;
  protocol: 'https:' | 'http:';
  path: string;
}

/**
 * Validates the shape of a url before it is ever stored.
 *
 * Catches the obvious cases -- a literal private IP, a non-http scheme, a
 * hostname that only resolves inside our network -- so a brand gets a 400 at
 * registration rather than a delivery log full of failures. It is a usability
 * check, not the security boundary; the boundary is the resolved address.
 */
export function parseWebhookUrl(
  raw: string,
  opts: {
    /**
     * Skips the address checks, leaving only the scheme and authority ones.
     * Set exclusively by a transport configured for a test stub on loopback;
     * nothing on the registration path passes it.
     */
    allowPrivate?: boolean;
  } = {}
): WebhookUrlTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Errors.badRequest('Webhook url is not a valid url');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw Errors.badRequest('Webhook url must be http or https');
  }

  // `file:`, `gopher:` and friends are refused above; credentials in the
  // authority are refused here because they are a common way to make a url
  // read as one host to a human and resolve as another.
  if (url.username || url.password) {
    throw Errors.badRequest('Webhook url must not contain credentials');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname.length === 0) {
    throw Errors.badRequest('Webhook url must have a host');
  }

  if (!opts.allowPrivate) {
    // A bare hostname with no dot -- `localhost`, `metadata`, a Kubernetes
    // service name -- only means anything inside our own network.
    if (!hostname.includes('.') && !hostname.includes(':')) {
      throw Errors.badRequest('Webhook url must use a fully qualified host');
    }

    if (isBlockedAddress(hostname)) {
      throw Errors.badRequest('Webhook url must not point at a private address');
    }
  }

  return {
    hostname,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    protocol: url.protocol,
    path: `${url.pathname}${url.search}`,
  };
}
