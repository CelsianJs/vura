import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { buildManifest } from '@celsian/vura-core';
import { startStandaloneServer } from '../src/commands/dev.js';
import { createStandaloneReload } from '../src/commands/standalone-reload.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PAGE = `import { h } from 'what-framework';
import { label } from '../shared';
export const page = { mode: 'hybrid' };
export default function Page() { return h('h1', null, label); }
`;
let root: string;
let srv: Awaited<ReturnType<typeof startStandaloneServer>> | undefined;
const streams: AbortController[] = [];
const taskGate = Symbol.for('vura.test.standalone-reload.task-gate');
const rescanGate = Symbol.for('vura.test.standalone-reload.rescan-gate');
// Bound ordinary HTTP too; explicit SSE controllers keep their longer lifetime.
const fetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, { signal: AbortSignal.timeout(5000), ...init });

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
  delete (globalThis as any)[taskGate];
  delete (globalThis as any)[rescanGate];
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('standalone dev automatic full-page reload', () => {
  it('returns 500 rather than an unhandled HTTP rejection when middleware execution throws', async () => {
    const base = await boot({ 'src/middleware.ts': `export default function middleware() { throw new Error('guard failed'); }` });
    const response = await fetch(`${base}/api/value`, { signal: AbortSignal.timeout(1500) });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('heading-one');
    const html = await fetch(base, { headers: { Accept: 'text/html' } });
    expect(html.status).toBe(500);
    expect(html.headers.get('cache-control')).toBe('private, no-store');
    clientPath(await html.text());
  });

  it('keeps application HTML private, including streamed loader 404s, and answers HEAD without a body', async () => {
    const base = await boot({
      'src/pages/streamed.ts': `export const page = { mode: 'server', streaming: true }; export default function Page() { return 'streamed'; }`,
      'src/pages/streamed-404.ts': `export const page = { mode: 'server', streaming: true }; export function loader(ctx) { throw ctx.notFound(); } export default function Page() { return 'unreachable'; }`,
      'src/pages/buffered-404.ts': `export const page = { mode: 'server' }; export function loader(ctx) { throw ctx.notFound(); } export default function Page() { return 'unreachable'; }`,
      'src/pages/client.ts': `export const page = { mode: 'client' }; export default function Page() { return 'client'; }`,
    });
    for (const [path, status] of [['/', 200], ['/client', 200], ['/streamed', 200], ['/streamed-404', 404], ['/buffered-404', 404]] as const) {
      const response = await fetch(base + path);
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      clientPath(await response.text());
      const head = await fetch(base + path, { method: 'HEAD' });
      expect(head.status).toBe(status);
      expect(head.headers.get('cache-control')).toBe('private, no-store');
      expect(head.headers.get('content-type')).toContain('text/html');
      expect(await head.text()).toBe('');
    }
  });

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
    await vi.waitFor(async () => expect(await (await fetch(`${base}/api/value`)).json()).toEqual({ label: 'heading-late' }), { timeout: 5000 });
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
    expect(missing.headers.get('cache-control')).toBe('private, no-store');
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
      await vi.waitFor(() => expect(errors.mock.calls.some((args) => String(args[0]).includes('route re-scan failed'))).toBe(true), { timeout: 5000 });
      expect((await fetch(`${base}/api/broken`)).status).toBe(404);
      expect(new URL(clientPath(await (await fetch(base)).text()), base).searchParams.get('generation')).toBe(generation);
      expect(await (await fetch(`${base}/api/value`)).json()).toEqual({ label: 'heading-one' });
      await writeFile(join(root, 'src/api/broken.ts'), `export function GET() { return { fixed: true }; }`);
      await events.next();
      expect(await (await fetch(`${base}/api/broken`)).json()).toEqual({ fixed: true });
    } finally { errors.mockRestore(); }
  });

  it('retains committed task handlers after a rejected edit, including child task dispatch', async () => {
    vi.stubEnv('THEN_TASK_SECRET', '');
    const base = await boot({
      'src/api/child.ts': `export const route = { kind: 'task' }; export function POST() { return { version: 'old' }; }`,
      'src/api/parent.ts': `export const route = { kind: 'task' }; export function POST(ctx) { return ctx.step.waitForTask('child', 'child', {}); }`,
    });
    const task = async (name: string) => {
      const response = await fetch(`${base}/__tasks/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ result: unknown }>;
    };
    expect((await task('child')).result).toEqual({ version: 'old' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await writeFile(join(root, 'src/api/child.ts'), `export const route = { kind: 'task' }; export function POST() { return { version: 'rejected' }; }`);
      await writeFile(join(root, 'src/api/broken.ts'), `export function GET( {`);
      await vi.waitFor(() => expect(errors.mock.calls.some((args) => String(args[0]).includes('route re-scan failed'))).toBe(true), { timeout: 5000 });
      expect((await task('child')).result).toEqual({ version: 'old' });
      expect((await task('parent')).result).toEqual({ ok: true, result: { version: 'old' } });
    } finally { errors.mockRestore(); }
  });

  it('refreshes actions and makes deleted exports unreachable after the committed reload', async () => {
    const base = await boot({ 'src/actions/sample.ts': `export function keep() { return 'old'; } export function removed() { return 'removed'; }` });
    const events = await openEvents(base, new URL(clientPath(await (await fetch(base)).text()), base).searchParams.get('generation')!);
    await events.next();
    const tokenResponse = await fetch(`${base}/__vura/action`, { headers: { Origin: base } });
    expect(tokenResponse.status).toBe(200);
    const { token } = await tokenResponse.json() as { token: string };
    const cookie = tokenResponse.headers.get('set-cookie')!.split(';')[0]!;
    const action = (id: string) => fetch(`${base}/__vura/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie, 'x-vura-csrf': token, 'x-vura-action': `sample#${id}` },
      body: JSON.stringify({ args: [] }),
    });
    expect(await (await action('keep')).json()).toEqual({ result: 'old' });
    await writeFile(join(root, 'src/actions/sample.ts'), `export function keep() { return 'new'; } export function added() { return 'added'; }`);
    await events.next();
    expect(await (await action('keep')).json()).toEqual({ result: 'new' });
    expect(await (await action('added')).json()).toEqual({ result: 'added' });
    expect((await action('removed')).status).toBe(404);
  });

  it('keeps an awaiting parent and its child on the captured generation across a successful rebuild', async () => {
    vi.stubEnv('THEN_TASK_SECRET', '');
    let release!: () => void;
    const gate = { entered: false, wait: new Promise<void>((resolve) => { release = resolve; }) };
    (globalThis as any)[taskGate] = gate;
    const base = await boot({
      'src/api/child.ts': `export const route = { kind: 'task' }; export function POST() { return { version: 'old' }; }`,
      'src/api/parent.ts': `export const route = { kind: 'task' }; export async function POST(ctx) {
        const gate = globalThis[Symbol.for('vura.test.standalone-reload.task-gate')];
        gate.entered = true; await gate.wait;
        return ctx.step.waitForTask('child', 'child', {});
      }`,
    });
    const events = await openEvents(base, new URL(clientPath(await (await fetch(base)).text()), base).searchParams.get('generation')!);
    await events.next();
    const pending = fetch(`${base}/__tasks/parent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) });
    // If a prerequisite assertion fails, afterEach destroys the request socket.
    // Observe that rejection too; it must not become a stray harness failure.
    void pending.catch(() => {});
    try {
      await vi.waitFor(() => expect(gate.entered).toBe(true), { timeout: 5000 });
      await writeFile(join(root, 'src/api/child.ts'), `export const route = { kind: 'task' }; export function POST() { return { version: 'new' }; }`);
      await events.next();
    } finally { release(); }
    expect((await (await pending).json()).result).toEqual({ ok: true, result: { version: 'old' } });
  });

  it('never notifies an intermediate generation when a save arrives during an active rescan', async () => {
    const base = await boot();
    const generation = new URL(clientPath(await (await fetch(base)).text()), base).searchParams.get('generation')!;
    const events = await openEvents(base, generation);
    await events.next();
    let release!: () => void;
    const gate = { entered: false, wait: new Promise<void>((resolve) => { release = resolve; }) };
    (globalThis as any)[rescanGate] = gate;
    await writeFile(join(root, 'src/api/slow.ts'), `
      const gate = globalThis[Symbol.for('vura.test.standalone-reload.rescan-gate')];
      gate.entered = true; await gate.wait;
      export function GET() { return { slow: true }; }
    `);
    try {
      await vi.waitFor(() => expect(gate.entered).toBe(true), { timeout: 5000 });
      await writeFile(join(root, 'src/shared.ts'), `export const label = 'last-save';`);
    } finally { release(); }
    expect((await events.next()).generation).not.toBe(generation);
    expect(await (await fetch(`${base}/api/value`)).json()).toEqual({ label: 'last-save' });
    // Exactly one committed update, not a notification for the stale candidate.
    const current = new URL(clientPath(await (await fetch(base)).text()), base).searchParams.get('generation')!;
    expect(current).toBe(generation.replace(/:0$/, ':1'));
  });

  it('preserves HTTP/hot-WS module identity through failed edits and closes upgraded sockets', async () => {
    const base = await boot({ 'src/api/counter.ts': `export const route = { kind: 'hot' };
      let connections = 0;
      export function websocket(peer) { connections++; peer.send('count:' + connections); }
      export function GET() { return { connections }; }
    ` });
    const open = () => new Promise<{ socket: WebSocket; greeting: string }>((resolve, reject) => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/counter');
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('WS open timed out')); }, 3000);
      socket.once('message', (data) => { clearTimeout(timer); resolve({ socket, greeting: String(data) }); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const first = await open();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let second: Awaited<ReturnType<typeof open>> | undefined;
    try {
      expect(first.greeting).toBe('count:1');
      await writeFile(join(root, 'src/api/broken.ts'), `export function GET( {`);
      await vi.waitFor(() => expect(errors.mock.calls.some((args) => String(args[0]).includes('route re-scan failed'))).toBe(true), { timeout: 5000 });
      second = await open();
      expect(second.greeting).toBe('count:2');
      expect(await (await fetch(`${base}/api/counter`)).json()).toEqual({ connections: 2 });
      const closed = new Promise<void>((resolve) => first.socket.once('close', () => resolve()));
      await srv!.close();
      srv = undefined;
      await closed;
      expect(first.socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      errors.mockRestore();
      first.socket.terminate();
      second?.socket.terminate();
    }
  });

  it('fails closed with 500 on broken middleware, then recovers after editing src/middleware.ts', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const base = await boot({ 'src/middleware.ts': `export default function middleware( {` });
      expect((await fetch(`${base}/api/value`)).status).toBe(500);
      const failed = await fetch(base, { headers: { Accept: 'text/html' } });
      expect(failed.status).toBe(500);
      expect(failed.headers.get('cache-control')).toBe('private, no-store');
      const generation = new URL(clientPath(await failed.text()), base).searchParams.get('generation')!;
      const events = await openEvents(base, generation);
      await events.next();
      await writeFile(join(root, 'src/middleware.ts'), `export default function middleware(ctx) { return ctx.deny(403); }`);
      await events.next();
      expect((await fetch(`${base}/api/value`)).status).toBe(403);
      await rm(join(root, 'src/middleware.ts'));
      await events.next();
      expect((await fetch(`${base}/api/value`)).status).toBe(200);
    } finally { errors.mockRestore(); }
  });
});

describe('private standalone reload channel resource limits', () => {
  it('bounds connections, drops backpressured streams, and cleans heartbeat timers', () => {
    vi.useFakeTimers();
    const reload = createStandaloneReload();
    const response = () => {
      const res = new EventEmitter() as any;
      res.setHeader = vi.fn();
      res.writeHead = vi.fn();
      res.write = vi.fn(() => true);
      res.end = vi.fn(() => res.emit('close'));
      res.destroy = vi.fn(() => res.emit('close'));
      return res;
    };
    const req = { method: 'GET', headers: {} } as any;
    const url = new URL('http://127.0.0.1:3000/__vura/dev/events?generation=old');
    try {
      const accepted = Array.from({ length: 64 }, () => response());
      for (const res of accepted) expect(reload.handle(req, res, url)).toBe(true);
      const overflow = response();
      reload.handle(req, overflow, url);
      expect(overflow.writeHead).toHaveBeenCalledWith(503, { 'Retry-After': '5' });
      accepted[0].write.mockReturnValue(false);
      reload.publish();
      expect(accepted[0].destroy).toHaveBeenCalledOnce();
      const replacement = response();
      reload.handle(req, replacement, url);
      expect(replacement.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      vi.advanceTimersByTime(15_000);
      expect(replacement.write).toHaveBeenCalledWith(': keepalive\n\n');
      reload.close();
      expect(replacement.end).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      reload.close();
      vi.useRealTimers();
    }
  });
});
