import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildManifest } from '@celsian/vura-core';
import { startStandaloneServer } from '../src/commands/dev.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PAGE = `import { h } from 'what-framework';
import { label } from '../shared';
export const page = { mode: 'hybrid' };
export default function Page() { return h('h1', null, label); }
`;
let root: string;
let srv: Awaited<ReturnType<typeof startStandaloneServer>> | undefined;
const streams: AbortController[] = [];

async function boot(extra: Record<string, string> = {}) {
  root = await mkdtemp(join(tmpdir(), 'vura-standalone-reload-'));
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(join(repo, 'node_modules', 'what-framework'), join(root, 'node_modules', 'what-framework'));
  const files = {
    'src/pages/index.ts': PAGE,
    'src/shared.ts': `export const label = 'heading-one';`,
    'src/api/value.ts': `import { label } from '../shared'; export function GET() { return { label }; }`,
    ...extra,
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  srv = await startStandaloneServer(await buildManifest(root), { projectRoot: root, host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${srv.port}`;
}

function clientPath(html: string) {
  const path = html.match(/src="([^"\s]*\/__vura\/dev\/reload\.js\?[^"\s]+)"/)?.[1];
  expect(path, 'every standalone page includes its dev-only reload client').toBeTruthy();
  return path!;
}

async function openEvents(base: string, generation: string) {
  const abort = new AbortController();
  streams.push(abort);
  const response = await fetch(`${base}/__vura/dev/events?generation=${encodeURIComponent(generation)}`, { signal: abort.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  let pending = '';
  async function next() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          for (;;) {
            const end = pending.indexOf('\n\n');
            if (end >= 0) {
              const event = pending.slice(0, end);
              pending = pending.slice(end + 2);
              if (event.startsWith(':')) continue;
              return JSON.parse(event.match(/^data: (.+)$/m)![1]!);
            }
            const chunk = await reader.read();
            if (chunk.done) throw new Error('reload stream ended');
            pending += new TextDecoder().decode(chunk.value);
          }
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('reload event timed out')), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  return { response, next, abort };
}

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.abort();
  await srv?.close();
  srv = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

describe('standalone dev automatic full-page reload', () => {
  it('refreshes shared src imports and cached browser bundles before notifying connected pages', async () => {
    const base = await boot();
    const html = await (await fetch(base)).text();
    expect(html).toContain('heading-one');
    const path = clientPath(html);
    const generation = new URL(path, base).searchParams.get('generation')!;
    const events = await openEvents(base, generation);
    expect(await events.next()).toEqual({ generation });
    expect(await (await fetch(`${base}/_then/pages/index.js`)).text()).toContain('heading-one');
    await writeFile(join(root, 'src/shared.ts'), `export const label = 'heading-two';`);
    const update = await events.next();
    expect(update.generation).not.toBe(generation);
    expect(JSON.stringify(update)).not.toContain(root);
    expect(await (await fetch(`${base}/api/value`)).json()).toEqual({ label: 'heading-two' });
    expect(await (await fetch(base)).text()).toContain('heading-two');
    expect(await (await fetch(`${base}/_then/pages/index.js`)).text()).toContain('heading-two');
  });

  it('catches edits between HTML load and SSE connect, with a one-shot client reload', async () => {
    const base = await boot();
    const path = clientPath(await (await fetch(base)).text());
    const generation = new URL(path, base).searchParams.get('generation')!;
    await writeFile(join(root, 'src/shared.ts'), `export const label = 'heading-late';`);
    await vi.waitFor(async () => expect(await (await fetch(`${base}/api/value`)).json()).toEqual({ label: 'heading-late' }));
    const events = await openEvents(base, generation);
    const update = await events.next();
    expect(update.generation).not.toBe(generation);
    const code = await (await fetch(base + path)).text();
    const reload = vi.fn();
    const close = vi.fn();
    let receive: (event: { data: string }) => void = () => {};
    let connectUrl = '';
    class EventSource {
      constructor(url: string) { connectUrl = url; }
      addEventListener(_name: string, fn: typeof receive) { receive = fn; }
      close = close;
    }
    runInNewContext(code, { EventSource, location: { reload }, addEventListener: vi.fn() });
    expect(connectUrl).toContain(encodeURIComponent(generation));
    receive({ data: JSON.stringify({ generation }) });
    expect(reload).not.toHaveBeenCalled();
    receive({ data: JSON.stringify(update) });
    receive({ data: JSON.stringify(update) });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('handles additions/deletions, suppresses unchanged writes, and closes open SSE without listener leaks', async () => {
    const listeners = process.listenerCount('SIGINT');
    const base = await boot();
    const generation = new URL(clientPath(await (await fetch(base)).text()), base).searchParams.get('generation')!;
    const events = await openEvents(base, generation);
    await events.next();
    await writeFile(join(root, 'src/shared.ts'), `export const label = 'heading-one';`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const fresh = new URL(clientPath(await (await fetch(base)).text()), base).searchParams.get('generation');
    expect(fresh).toBe(generation);
    await mkdir(join(root, 'src/api/added'), { recursive: true });
    await writeFile(join(root, 'src/api/added/index.ts'), `export function GET() { return { added: true }; }`);
    await events.next();
    expect((await fetch(`${base}/api/added`)).status).toBe(200);
    await rm(join(root, 'src/api/added'), { recursive: true });
    await events.next();
    expect((await fetch(`${base}/api/added`)).status).toBe(404);
    await srv!.close();
    srv = undefined;
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  });

  it('rejects cross-origin reload access even when application CORS is configured', async () => {
    const base = await boot();
    const path = clientPath(await (await fetch(base)).text());
    const cors = process.env.THEN_CORS_ORIGIN;
    process.env.THEN_CORS_ORIGIN = 'https://evil.test';
    try {
      for (const endpoint of [path, '/__vura/dev/events?generation=old']) {
        const denied = await fetch(base + endpoint, { headers: { Origin: 'https://evil.test' } });
        expect(denied.status).toBe(403);
        expect(denied.headers.get('access-control-allow-origin')).toBeNull();
        expect((await fetch(base + endpoint, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
      }
    } finally {
      if (cors === undefined) delete process.env.THEN_CORS_ORIGIN;
      else process.env.THEN_CORS_ORIGIN = cors;
    }
  });

  it('keeps a reload client on HTML 404/500 pages so deletion and broken startup can recover', async () => {
    const base = await boot();
    const events = await openEvents(base, new URL(clientPath(await (await fetch(base)).text()), base).searchParams.get('generation')!);
    await events.next();
    await rm(join(root, 'src/pages/index.ts'));
    await events.next();
    const missing = await fetch(base, { headers: { Accept: 'text/html' } });
    expect(missing.status).toBe(404);
    const missingPath = clientPath(await missing.text());
    const deleted = await openEvents(base, new URL(missingPath, base).searchParams.get('generation')!);
    await deleted.next();
    await writeFile(join(root, 'src/pages/index.ts'), PAGE);
    await deleted.next();
    expect((await fetch(base)).status).toBe(200);
  });

  it('does not reload on a failed rescan and preserves old API instances until a successful edit', async () => {
    const base = await boot();
    const generation = new URL(clientPath(await (await fetch(base)).text()), base).searchParams.get('generation')!;
    const events = await openEvents(base, generation);
    await events.next();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await writeFile(join(root, 'src/api/broken.ts'), `export function GET( {`);
      await vi.waitFor(() => expect(errors.mock.calls.some((args) => String(args[0]).includes('route re-scan failed'))).toBe(true));
      expect((await fetch(`${base}/api/broken`)).status).toBe(404);
      expect(new URL(clientPath(await (await fetch(base)).text()), base).searchParams.get('generation')).toBe(generation);
      expect(await (await fetch(`${base}/api/value`)).json()).toEqual({ label: 'heading-one' });
      await writeFile(join(root, 'src/api/broken.ts'), `export function GET() { return { fixed: true }; }`);
      await events.next();
      expect(await (await fetch(`${base}/api/broken`)).json()).toEqual({ fixed: true });
    } finally { errors.mockRestore(); }
  });

  it('fails closed with 500 on broken middleware, then recovers after editing src/middleware.ts', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const base = await boot({ 'src/middleware.ts': `export default function middleware( {` });
      expect((await fetch(`${base}/api/value`)).status).toBe(500);
      const failed = await fetch(base, { headers: { Accept: 'text/html' } });
      expect(failed.status).toBe(500);
      const generation = new URL(clientPath(await failed.text()), base).searchParams.get('generation')!;
      const events = await openEvents(base, generation);
      await events.next();
      await writeFile(join(root, 'src/middleware.ts'), `export default function middleware(ctx) { return ctx.deny(403); }`);
      await events.next();
      await vi.waitFor(async () => expect((await fetch(`${base}/api/value`)).status).toBe(403));
      await rm(join(root, 'src/middleware.ts'));
      await vi.waitFor(async () => expect((await fetch(`${base}/api/value`)).status).toBe(200));
    } finally { errors.mockRestore(); }
  });
});
