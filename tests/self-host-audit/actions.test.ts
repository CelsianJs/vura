/**
 * Server actions, proven in a built and booted application.
 *
 * Two claims are worth proving here rather than in a unit test, because both
 * are properties of the *artifact* rather than of a function:
 *
 *   1. Action source does not reach the browser. The unit test proves the
 *      esbuild plugin; this proves the CLI actually installs it on the bundle
 *      it ships, which is a different question and the one that matters.
 *   2. An HttpError thrown by an action keeps its status. Each server bundle
 *      inlines its own copy of core, so the HttpError an action module
 *      constructs is a different class object from the one the dispatcher
 *      would compare against — `instanceof` is false for exactly the errors it
 *      is meant to recognise. Only a real build has two real copies.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldAndBuild, bootServer } from './helpers.js';

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
const SECRET = 'ACTION-SOURCE-MUST-NOT-SHIP';

/** A browser's same-origin fetch, as the generated stub performs it. */
async function withToken(): Promise<{ token: string; cookie: string }> {
  const res = await fetch(`${base()}/__vura/action`, {
    headers: { origin: base(), 'sec-fetch-site': 'same-origin' },
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  const { token } = (await res.json()) as { token: string };
  return { token, cookie: setCookie!.split(';')[0]! };
}

function callAction(
  id: string,
  args: unknown[],
  auth: { token: string; cookie: string },
  overrides: Record<string, string> = {},
) {
  return fetch(`${base()}/__vura/action`, {
    method: 'POST',
    headers: {
      origin: base(),
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-vura-action': id,
      'x-vura-csrf': auth.token,
      cookie: auth.cookie,
      ...overrides,
    },
    body: JSON.stringify({ args }),
  });
}

describe('V1: the build emits the server half and records it', () => {
  it('bundles every action module under dist/server/actions', () => {
    expect(existsSync(join(app.dir, 'dist', 'server', 'actions', 'todos.js'))).toBe(true);
  });

  it('lists the module and its exports in the manifest', () => {
    const actions = app.readManifest().actions;
    expect(actions).toBeDefined();
    const todos = actions.find((a: any) => a.moduleId === 'todos');
    expect(todos).toBeDefined();
    expect(todos.exports).toContain('addTodo');
    expect(todos.exports).toContain('missingTodo');
  });

  it('hands them to the server entry, which is what registers them', () => {
    // The entry passes the loaded module keyed by module id; the per-export
    // ids are derived at registration time rather than written into the
    // bundle, so the module id is what appears here.
    const entry = readFileSync(join(app.dir, 'dist', 'server', 'entry.js'), 'utf8');
    expect(entry).toMatch(/actions:\s*\{/);
    expect(entry).toContain('"todos"');
  });
});

describe('V2: action source does not reach the browser', () => {
  it('ships the id and the transport, not the module', () => {
    const clientDir = join(app.dir, 'dist', 'static', '_then', 'pages');
    const bundles = readdirSync(clientDir).filter(f => f.startsWith('todos') && f.endsWith('.js'));
    expect(bundles.length).toBeGreaterThan(0);

    const source = bundles.map(f => readFileSync(join(clientDir, f), 'utf8')).join('\n');
    expect(source).not.toContain(SECRET);
    expect(source).not.toContain('db.internal');
    expect(source).toContain('todos#addTodo');
    expect(source).toContain('/__vura/action');
  });

  it('stubs the Node16 `.js` spelling of the same import', () => {
    // The form tsc requires under moduleResolution Node16, and the one the
    // resolver used to miss: the page bundle held the action module's real
    // source, secret included, with no callAction anywhere in it.
    const clientDir = join(app.dir, 'dist', 'static', '_then', 'pages');
    const bundles = readdirSync(clientDir).filter(
      f => f.startsWith('todos-node16') && f.endsWith('.js'),
    );
    expect(bundles.length).toBeGreaterThan(0);

    const source = bundles.map(f => readFileSync(join(clientDir, f), 'utf8')).join('\n');
    expect(source).not.toContain(SECRET);
    expect(source).toContain('todos#addTodo');
    expect(source).toContain('/__vura/action');
  });

  it('leaves the secret out of every client-served file, not just that bundle', () => {
    const staticDir = join(app.dir, 'dist', 'static');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (readFileSync(full, 'utf8').includes(SECRET)) offenders.push(full);
      }
    };
    walk(staticDir);
    expect(offenders).toEqual([]);
  });
});

describe('V3: the endpoint runs an action', () => {
  it('returns the action’s value', async () => {
    const auth = await withToken();
    const res = await callAction('todos#addTodo', ['milk'], auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { text: 'milk', added: true } });
  });

  it('is never cached', async () => {
    const auth = await withToken();
    const res = await callAction('todos#addTodo', ['milk'], auth);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('V4: the gates hold against a real HTTP client', () => {
  it('rejects a call with no CSRF token', async () => {
    const auth = await withToken();
    const res = await callAction('todos#addTodo', ['milk'], auth, { 'x-vura-csrf': '' });
    expect(res.status).toBe(403);
  });

  it('rejects a token that does not match the cookie', async () => {
    const auth = await withToken();
    const other = await withToken();
    const res = await callAction('todos#addTodo', ['milk'], { token: other.token, cookie: auth.cookie });
    expect(res.status).toBe(403);
  });

  it('rejects a cross-site call', async () => {
    const auth = await withToken();
    const res = await callAction('todos#addTodo', ['milk'], auth, {
      'sec-fetch-site': 'cross-site',
      origin: 'http://evil.test',
    });
    expect(res.status).toBe(403);
  });

  it('rejects a form-encoded body, which is what a cross-site form can send', async () => {
    const auth = await withToken();
    const res = await fetch(`${base()}/__vura/action`, {
      method: 'POST',
      headers: {
        origin: base(),
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
        'x-vura-action': 'todos#addTodo',
        'x-vura-csrf': auth.token,
        cookie: auth.cookie,
      },
      body: 'args=milk',
    });
    expect(res.status).toBe(415);
  });

  it('refuses to issue a token cross-origin', async () => {
    const res = await fetch(`${base()}/__vura/action`, {
      headers: { origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });

  it('does not expose an export that is not a function', async () => {
    const auth = await withToken();
    const res = await callAction('todos#DB_URL', [], auth);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown action', async () => {
    const auth = await withToken();
    const res = await callAction('ghost#gone', [], auth);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('ghost#gone');
  });
});

describe('V5: errors cross the real bundle boundary intact', () => {
  it('keeps a thrown notFound() a 404 — the instanceof case', async () => {
    const auth = await withToken();
    const res = await callAction('todos#missingTodo', [], auth);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('No such todo');
  });

  it('keeps a thrown notFound() a 404 from an API route as well', async () => {
    // Vura's HttpError is not Celsian's, so Celsian's `instanceof` branch
    // misses it and its default handler would make this a 500. Vura registers
    // a trailing onError hook that recognises its own errors by brand and
    // answers with their status. Pinned because it runs through the real
    // bundle split, where `instanceof` fails against Vura's own class too.
    const res = await fetch(`${base()}/api/boom`);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('No such thing');
  });

  it('sanitises an unexpected error, keeping the connection string off the wire', async () => {
    const auth = await withToken();
    const res = await callAction('todos#explode', [], auth);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('db.internal');
  });
});
