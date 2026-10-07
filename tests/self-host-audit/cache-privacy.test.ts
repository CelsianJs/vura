import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { scaffoldAndBuild, bootServer } from './helpers.js';

let server: Awaited<ReturnType<typeof bootServer>>;

beforeAll(async () => {
  await scaffoldAndBuild();
  server = await bootServer({ NODE_ENV: 'production', PORT: '0' });
}, 300_000);

afterAll(async () => { await server?.kill(); });

describe('packed Node application cache privacy', () => {
  it('separates cookie, header and repeated-query variants without advertising shared caching', async () => {
    const visit = (session: string, language: string, query = 'filter=a&filter=b') =>
      fetch(`${server.url}/account?${query}`, { headers: { cookie: `session=${session}`, 'accept-language': language } });
    const alice = await visit('alice', 'en');
    const aliceBody = await alice.text();
    expect(aliceBody).toContain('session=alice');

    const bob = await visit('bob', 'en');
    const bobBody = await bob.text();
    expect(bobBody).toContain('session=bob');
    expect(bobBody).not.toContain('session=alice');
    expect(bob.headers.get('cache-control')).toBe('private, no-store');
    expect(bob.headers.get('vary')?.toLowerCase()).toBe('cookie, accept-language');
    expect(bob.headers.get('x-what-cache')).toBe('MISS');

    const repeat = await visit('bob', 'en');
    expect(await repeat.text()).toBe(bobBody);
    expect(repeat.headers.get('x-what-cache')).toBe('HIT');

    const language = await visit('bob', 'fr');
    expect(await language.text()).not.toBe(bobBody);
    expect(language.headers.get('x-what-cache')).toBe('MISS');

    const reversedQuery = await visit('bob', 'en', 'filter=b&filter=a');
    expect(await reversedQuery.text()).not.toBe(bobBody);
    expect(reversedQuery.headers.get('x-what-cache')).toBe('MISS');
  });
});
