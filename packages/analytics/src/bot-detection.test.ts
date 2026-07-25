import { describe, expect, it } from 'vitest';
import {
  classifyTraffic,
  countsAsClick,
  dedupKey,
  isBot,
  type TrafficKind,
} from './bot-detection';

/** Real user agents, because the whole point is matching what actually arrives. */
const AGENTS: Array<[string, TrafficKind, string]> = [
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'human',
    'Chrome on macOS',
  ],
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    'human',
    'Safari on iOS',
  ],
  [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'human',
    'Firefox on Windows',
  ],
  [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'crawler',
    'Googlebot',
  ],
  [
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'crawler',
    'Bingbot',
  ],
  [
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'crawler',
    'AhrefsBot',
  ],
  ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'preview', 'Slack'],
  ['Twitterbot/1.0', 'preview', 'Twitter'],
  [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'preview',
    'Facebook',
  ],
  ['WhatsApp/2.23.20.0', 'preview', 'WhatsApp'],
  ['curl/8.4.0', 'tool', 'curl'],
  ['Wget/1.21.3', 'tool', 'wget'],
  ['python-requests/2.31.0', 'tool', 'python-requests'],
  ['PostmanRuntime/7.35.0', 'tool', 'Postman'],
];

describe('classifyTraffic', () => {
  it.each(AGENTS)('classifies %s', (ua, expected) => {
    expect(classifyTraffic(ua)).toBe(expected);
  });

  it('treats a missing user agent as a tool', () => {
    // Every real browser sends one. Its absence means something is speaking
    // HTTP directly.
    expect(classifyTraffic(undefined)).toBe('tool');
    expect(classifyTraffic('')).toBe('tool');
    expect(classifyTraffic('   ')).toBe('tool');
  });

  it('is case insensitive', () => {
    expect(classifyTraffic('GOOGLEBOT/2.1')).toBe('crawler');
  });

  it('does not mistake a browser for a bot', () => {
    // The expensive failure direction: a false positive here means a real
    // affiliate stops being credited for real traffic.
    for (const [ua, kind] of AGENTS) {
      if (kind !== 'human') continue;
      expect(isBot(ua), ua).toBe(false);
    }
  });
});

describe('countsAsClick', () => {
  it('counts only humans', () => {
    expect(countsAsClick('human')).toBe(true);
    expect(countsAsClick('crawler')).toBe(false);
    expect(countsAsClick('preview')).toBe(false);
    expect(countsAsClick('tool')).toBe(false);
  });

  it('separates previews from crawlers even though neither counts', () => {
    // They are still recorded, and telling them apart is what lets an
    // affiliate see that their post was shared 40 times in Slack.
    expect(classifyTraffic('Slackbot-LinkExpanding 1.0')).not.toBe(
      classifyTraffic('Googlebot/2.1')
    );
  });
});

describe('dedupKey', () => {
  it('is unique per link and visitor', () => {
    expect(dedupKey('link-1', 'cookie-a')).not.toBe(dedupKey('link-1', 'cookie-b'));
    expect(dedupKey('link-1', 'cookie-a')).not.toBe(dedupKey('link-2', 'cookie-a'));
  });

  it('is stable for the same pair', () => {
    expect(dedupKey('link-1', 'cookie-a')).toBe(dedupKey('link-1', 'cookie-a'));
  });
});
