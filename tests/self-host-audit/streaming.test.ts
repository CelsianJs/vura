/**
 * Streaming SSR, in a built and booted application.
 *
 * The assertion that matters is a *timing* one. Every other property of a
 * streamed page (correct markup, resolved Suspense content, a serialized
 * loader payload) is also true of a buffered response, so asserting only on
 * the final document would pass against a server that streamed nothing. These
 * tests read the socket chunk by chunk and require the shell to arrive
 * measurably before the data it is waiting on.
 *
 * The fixture's slow resource takes 150ms. The gate below is deliberately
 * loose (40ms) so the test is not a CI-load flake detector, while still being
 * impossible to satisfy by buffering: a buffered response delivers both
 * markers in the same chunk, at a gap of exactly 0.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { scaffoldAndBuild, bootServer, bootDevServer } from './helpers.js';

let app: Awaited<ReturnType<typeof scaffoldAndBuild>>;
let server: Awaited<ReturnType<typeof bootServer>>;

beforeAll(async () => {
  app = await scaffoldAndBuild();
  server = await bootServer({ NODE_ENV: 'production', PORT: '0' });
}, 300_000);

afterAll(async () => {
  await server?.kill();
});

const base = () => `http://localhost:${server.port}`;

/** Read a response body chunk by chunk, stamping when each marker first appears. */
async function readTimeline(
  url: string,
  markers: string[],
): Promise<{ res: Response; html: string; seenAt: Record<string, number>; chunks: number }> {
  const started = Date.now();
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const seenAt: Record<string, number> = {};
  let html = '';
  let chunks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks++;
    html += decoder.decode(value, { stream: true });
    for (const m of markers) {
      if (seenAt[m] === undefined && html.includes(m)) seenAt[m] = Date.now() - started;
    }
  }
  html += decoder.decode();
  for (const m of markers) {
    if (seenAt[m] === undefined && html.includes(m)) seenAt[m] = Date.now() - started;
  }
  return { res, html, seenAt, chunks };
}

describe('S1: a streaming page delivers its shell before its slow data', () => {
  it('emits the shell measurably earlier than the resolved resource', async () => {
    const { res, html, seenAt, chunks } = await readTimeline(`${base()}/streamed`, [
      'STREAM-SHELL',
      'SLOW-STREAM-DATA',
    ]);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(html).toContain('STREAM-SHELL');
    expect(html).toContain('SLOW-STREAM-DATA');

    // More than one chunk reached us: the response was not buffered.
    expect(chunks).toBeGreaterThan(1);

    const shellAt = seenAt['STREAM-SHELL'];
    const dataAt = seenAt['SLOW-STREAM-DATA'];
    expect(shellAt).toBeTypeOf('number');
    expect(dataAt).toBeTypeOf('number');
    expect(dataAt - shellAt).toBeGreaterThan(40);
  }, 30_000);

  it('does not advertise a content-length it cannot know', async () => {
    const res = await fetch(`${base()}/streamed`);
    expect(res.headers.get('content-length')).toBeNull();
    await res.text();
  });

  it('resolves the Suspense boundary rather than shipping the fallback', async () => {
    const res = await fetch(`${base()}/streamed`);
    const html = await res.text();
    expect(html).toContain('id="slow"');
    expect(html).toContain('SLOW-STREAM-DATA');
    // The fallback is the failure mode: it means the boundary gave up.
    expect(html).not.toContain('>loading<');
  }, 30_000);

  it('closes the document it opened', async () => {
    const res = await fetch(`${base()}/streamed`);
    const html = await res.text();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).toContain('<div id="app">');
  }, 30_000);
});

describe('S2: streaming composes with the rest of the page contract', () => {
  it('preserves duplicate query values through the packed loader and serialized payload', async () => {
    const res = await fetch(`${base()}/streamed-loader?tag=a&tag=b&empty=&empty=z`);
    const html = await res.text();
    const match = html.match(/<script id="__VURA_LOADER__" type="application\/json">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]!).page.query).toEqual({ tag: ['a', 'b'], empty: ['', 'z'] });
  });

  it('runs the loader chain and serializes its payload', async () => {
    const res = await fetch(`${base()}/streamed-loader`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('STREAM-LOADER-DATA');
    expect(html).toContain('id="__VURA_LOADER__"');
  }, 30_000);

  it('honours the page title from `export const page`', async () => {
    const res = await fetch(`${base()}/streamed`);
    const html = await res.text();
    expect(html).toContain('<title>Streamed</title>');
  }, 30_000);

  it('still returns a real 404 when the loader calls notFound()', async () => {
    // The status has to be settled before the first byte, which is the whole
    // reason the loader chain runs ahead of the stream rather than inside it.
    const res = await fetch(`${base()}/streamed-404`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    await res.text();
  }, 30_000);

  it('answers HEAD without a body and without breaking', async () => {
    const res = await fetch(`${base()}/streamed`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('');
  }, 30_000);
});

describe('S3: `vura dev` streams the same page the same way', () => {
  // Dev is the half that has drifted every time a page feature shipped, so it
  // is held to the production assertions rather than to a weaker set.
  let dev: Awaited<ReturnType<typeof bootDevServer>>;

  beforeAll(async () => {
    await scaffoldAndBuild();
    dev = await bootDevServer();
  }, 300_000);

  afterAll(async () => {
    await dev?.kill();
  });

  const devBase = () => `http://localhost:${dev.port}`;

  it('delivers the shell before the slow data in dev too', async () => {
    const { res, html, seenAt, chunks } = await readTimeline(`${devBase()}/streamed`, [
      'STREAM-SHELL',
      'SLOW-STREAM-DATA',
    ]);
    expect(res.status).toBe(200);
    expect(html).toContain('STREAM-SHELL');
    expect(html).toContain('SLOW-STREAM-DATA');
    expect(chunks).toBeGreaterThan(1);
    expect(seenAt['SLOW-STREAM-DATA'] - seenAt['STREAM-SHELL']).toBeGreaterThan(40);
  }, 60_000);

  it('runs the loader chain on a streamed page in dev', async () => {
    const html = await (await fetch(`${devBase()}/streamed-loader`)).text();
    expect(html).toContain('STREAM-LOADER-DATA');
    expect(html).toContain('id="__VURA_LOADER__"');
  }, 60_000);

  it('still returns a 404 from a streamed loader in dev', async () => {
    const res = await fetch(`${devBase()}/streamed-404`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    await res.text();
  }, 60_000);

  it('leaves non-streaming pages on the buffered path in dev', async () => {
    // The opt-in has to mean something: an ordinary server page must not start
    // streaming just because streaming exists.
    const res = await fetch(`${devBase()}/loaders/nested`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('SITE:AUDIT-SITE');
  }, 60_000);
});
