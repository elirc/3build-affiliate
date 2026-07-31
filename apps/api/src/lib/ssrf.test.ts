import { describe, expect, it } from 'vitest';
import { isBlockedAddress, parseWebhookUrl } from './ssrf';

describe('isBlockedAddress', () => {
  it('accepts ordinary public addresses', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:2800:220:1::']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('rejects every range a webhook must not reach', () => {
    const blocked = [
      '127.0.0.1', // loopback
      '127.13.9.2', // the rest of 127/8, which a /32 check would miss
      '10.0.0.1', // RFC 1918
      '172.16.0.1', // start of 172.16/12
      '172.31.255.254', // end of 172.16/12
      '192.168.1.1', // RFC 1918
      '169.254.169.254', // cloud metadata
      '::1', // IPv6 loopback
    ];

    for (const address of blocked) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('does not over-reach into neighbouring public ranges', () => {
    // 172.15 and 172.32 are outside 172.16/12. A guard that blocks all of
    // 172/8 refuses real customers.
    expect(isBlockedAddress('172.15.0.1')).toBe(false);
    expect(isBlockedAddress('172.32.0.1')).toBe(false);
    expect(isBlockedAddress('169.253.0.1')).toBe(false);
  });

  it('rejects the ranges people forget', () => {
    expect(isBlockedAddress('0.0.0.0')).toBe(true); // localhost on Linux
    expect(isBlockedAddress('100.64.0.1')).toBe(true); // carrier-grade NAT
    expect(isBlockedAddress('224.0.0.1')).toBe(true); // multicast
    expect(isBlockedAddress('fd00::1')).toBe(true); // unique-local
    expect(isBlockedAddress('fe80::1')).toBe(true); // link-local
  });

  it('sees through IPv4-mapped IPv6', () => {
    // The same loopback in different notation. A text-pattern guard on the
    // IPv4 form waves this straight through.
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::FFFF:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:93.184.216.34')).toBe(false);
  });

  it('sees through the hex spelling of an embedded IPv4 address', () => {
    // Only the dotted form was recognised, so `::a00:5` -- 10.0.0.5 written in
    // hex -- walked through a guard whose entire job is refusing 10/8. A check
    // that depends on notation is not a check.
    expect(isBlockedAddress('::a00:5')).toBe(true); // 10.0.0.5
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true); // 127.0.0.1
    expect(isBlockedAddress('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isBlockedAddress('::7f00:1')).toBe(true); // 127.0.0.1, compatible form

    // and still lets a genuinely public address through in the same notation
    expect(isBlockedAddress('::ffff:808:808')).toBe(false); // 8.8.8.8
  });

  it('rejects IPv6 multicast', () => {
    // The IPv4 side already refused 224/4. Leaving the v6 equivalent out was an
    // asymmetry rather than a decision.
    expect(isBlockedAddress('ff02::1')).toBe(true); // all nodes on this link
    expect(isBlockedAddress('ff05::2')).toBe(true);
  });
});

describe('parseWebhookUrl', () => {
  it('accepts a public https url and keeps its path and query', () => {
    const target = parseWebhookUrl('https://hooks.example.com/affiliate?v=2');
    expect(target).toEqual({
      hostname: 'hooks.example.com',
      port: 443,
      protocol: 'https:',
      path: '/affiliate?v=2',
    });
  });

  it('rejects a literal private address at registration', () => {
    for (const url of [
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/hook',
    ]) {
      expect(() => parseWebhookUrl(url), url).toThrow(/private address/);
    }
  });

  it('rejects a bare hostname', () => {
    // `localhost`, `metadata`, or a Kubernetes service name only resolve to
    // something inside our own network.
    expect(() => parseWebhookUrl('https://localhost/hook')).toThrow(
      /fully qualified/
    );
  });

  it('rejects schemes that are not http', () => {
    expect(() => parseWebhookUrl('file:///etc/passwd')).toThrow(/http or https/);
    expect(() => parseWebhookUrl('gopher://example.com/')).toThrow(/http or https/);
  });

  it('rejects credentials in the authority', () => {
    // Reads as one host to a human and resolves as another.
    expect(() => parseWebhookUrl('https://example.com@10.0.0.1/hook')).toThrow(
      /credentials/
    );
  });

  it('rejects something that is not a url at all', () => {
    expect(() => parseWebhookUrl('not a url')).toThrow(/valid url/);
  });
});
