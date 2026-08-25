/**
 * Server actions — registry, id scheme, CSRF gates, dispatch, and the build
 * plugin that keeps action source out of the browser.
 *
 * The plugin test runs a real esbuild. Asserting that a secret is absent from
 * generated output is only worth anything if the output was generated the way
 * the CLI generates it.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  actionRegistry,
  registerActionModules,
  actionId,
  dispatchAction,
  issueActionToken,
  csrfCookieName,
  csrfSetCookie,
  isSameOrigin,
  isSecureRequest,
  timingSafeEqual,
  type ActionRequestLike,
} from '../src/runtime/actions.js';
import {
  actionModuleId,
  extractActionExports,
  generateActionStub,
  resolveActionImport,
  vuraActionsStubPlugin,
} from '../src/actions-build.js';
import { badRequest, notFound } from '../src/errors.js';

const tmpDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vura-actions-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const ORIGIN = 'http://localhost:3000';
const TOKEN = 'a'.repeat(64);

function req(overrides: Partial<ActionRequestLike> = {}): ActionRequestLike {
  return {
    method: 'POST',
    url: `${ORIGIN}/__vura/action`,
    headers: {
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      cookie: `vura-csrf=${TOKEN}`,
      'x-vura-csrf': TOKEN,
      'x-vura-action': 'todos#add',
      ...overrides.headers,
    },
    body: { args: [] },
    ...('body' in overrides ? { body: overrides.body } : {}),
    ...(overrides.url ? { url: overrides.url } : {}),
    ...(overrides.method ? { method: overrides.method } : {}),
  };
}

beforeEach(() => {
  actionRegistry.clear();
});

// ─── Ids ───

describe('A1: the id scheme is derived from the path, not generated', () => {
  it('maps a file path to a module id', () => {
    expect(actionModuleId('src/actions/todos.ts')).toBe('todos');
    expect(actionModuleId('src/actions/admin/users.ts')).toBe('admin/users');
    expect(actionModuleId('src/actions/todos.js')).toBe('todos');
  });

  it('joins module and export with a hash', () => {
    expect(actionId('admin/users', 'ban')).toBe('admin/users#ban');
  });

  it('is stable across calls — the property what-fw’s random ids lack', () => {
    const first = actionModuleId('src/actions/todos.ts');
    const second = actionModuleId('src/actions/todos.ts');
    expect(first).toBe(second);
  });
});

describe('A2: exported function names are read from source', () => {
  it('finds function and const forms, and skips default', () => {
    const source = `
      export async function addTodo(text) {}
      export function removeTodo(id) {}
      export const toggleTodo = async (id) => {};
      const notExported = () => {};
      export default function page() {}
    `;
    const names = extractActionExports(source);
    expect(names).toContain('addTodo');
    expect(names).toContain('removeTodo');
    expect(names).toContain('toggleTodo');
    expect(names).not.toContain('notExported');
    expect(names).not.toContain('page');
  });
});

// ─── Registry ───

describe('A3: the registry survives the bundle split', () => {
  it('registers every function export and skips the rest', () => {
    registerActionModules({
      todos: {
        addTodo: async () => 1,
        LIMIT: 50,
        schema: { parse: () => {} },
      },
    });
    expect(actionRegistry.ids()).toEqual(['todos#addTodo']);
  });

  it('is reachable through globalThis, so a second copy of this module shares it', () => {
    registerActionModules({ todos: { addTodo: async () => 1 } });
    // A separately bundled copy would hold a different module-level Map but the
    // same well-known symbol. Reading it directly is how the other copy sees it.
    const shared = (globalThis as any)[Symbol.for('vura.actions.registry')];
    expect(shared).toBeInstanceOf(Map);
    expect(shared.has('todos#addTodo')).toBe(true);
  });
});

// ─── CSRF and origin ───

describe('A4: the origin gate fails closed', () => {
  it('accepts a same-origin fetch', () => {
    expect(isSameOrigin(req())).toBe(true);
  });

  it('rejects a cross-site fetch', () => {
    expect(isSameOrigin(req({ headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(false);
  });

  it('rejects same-site, which a sibling subdomain can reach', () => {
    expect(isSameOrigin(req({ headers: { 'sec-fetch-site': 'same-site' } }))).toBe(false);
  });

  it('falls back to comparing Origin against the request host', () => {
    const same = req({ headers: { 'sec-fetch-site': undefined, origin: ORIGIN } });
    expect(isSameOrigin(same)).toBe(true);
    const other = req({ headers: { 'sec-fetch-site': undefined, origin: 'http://evil.test' } });
    expect(isSameOrigin(other)).toBe(false);
  });

  it('rejects a request carrying neither header', () => {
    expect(isSameOrigin(req({ headers: { 'sec-fetch-site': undefined, origin: undefined } }))).toBe(false);
  });
});

describe('A5: the token cookie is scoped as tightly as the scheme allows', () => {
  it('uses the __Host- prefix over https, which a subdomain cannot set', () => {
    expect(csrfCookieName(true)).toBe('__Host-vura-csrf');
    expect(csrfCookieName(false)).toBe('vura-csrf');
  });

  it('sets HttpOnly and SameSite, and Secure only when it can', () => {
    const secure = csrfSetCookie(TOKEN, true);
    expect(secure).toContain('HttpOnly');
    expect(secure).toContain('SameSite=Lax');
    expect(secure).toContain('Secure');
    expect(csrfSetCookie(TOKEN, false)).not.toContain('Secure');
  });

  it('reads the scheme from x-forwarded-proto ahead of the URL', () => {
    expect(isSecureRequest(req({ headers: { 'x-forwarded-proto': 'https' } }))).toBe(true);
    expect(isSecureRequest(req())).toBe(false);
  });

  it('compares tokens without an early exit on the first differing byte', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });
});

describe('A6: issuing a token', () => {
  it('sets the cookie and returns the same value in the body', () => {
    const outcome = issueActionToken(req({ method: 'GET' }));
    expect(outcome.status).toBe(200);
    const token = (outcome.body as { token: string }).token;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.setCookie).toContain(`vura-csrf=${token}`);
  });

  it('refuses to issue one cross-origin', () => {
    const outcome = issueActionToken(req({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }));
    expect(outcome.status).toBe(403);
    expect(outcome.setCookie).toBeUndefined();
  });

  it('issues a different token each time', () => {
    const a = (issueActionToken(req({ method: 'GET' })).body as { token: string }).token;
    const b = (issueActionToken(req({ method: 'GET' })).body as { token: string }).token;
    expect(a).not.toBe(b);
  });
});

// ─── Dispatch ───

describe('A7: every gate runs before the action does', () => {
  beforeEach(() => {
    registerActionModules({ todos: { add: async (text: string) => ({ text }) } });
  });

  it('runs the action when every gate passes', async () => {
    const outcome = await dispatchAction(req({ body: { args: ['milk'] } }));
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ result: { text: 'milk' } });
  });

  it('rejects cross-origin', async () => {
    const outcome = await dispatchAction(req({ headers: { 'sec-fetch-site': 'cross-site' } }));
    expect(outcome.status).toBe(403);
  });

  it('rejects a non-JSON content type, which is what a cross-site form can send', async () => {
    const outcome = await dispatchAction(
      req({ headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    );
    expect(outcome.status).toBe(415);
  });

  it('rejects a missing token', async () => {
    const outcome = await dispatchAction(req({ headers: { 'x-vura-csrf': undefined } }));
    expect(outcome.status).toBe(403);
  });

  it('rejects a token that does not match the cookie', async () => {
    const outcome = await dispatchAction(req({ headers: { 'x-vura-csrf': 'b'.repeat(64) } }));
    expect(outcome.status).toBe(403);
  });

  it('rejects a missing action header', async () => {
    const outcome = await dispatchAction(req({ headers: { 'x-vura-action': undefined } }));
    expect(outcome.status).toBe(400);
  });

  it('rejects arguments that are not an array', async () => {
    const outcome = await dispatchAction(req({ body: { args: { __proto__: {} } } }));
    expect(outcome.status).toBe(400);
  });

  it('rejects an oversized argument list', async () => {
    const outcome = await dispatchAction(
      req({ body: { args: ['x'.repeat(2048)] } }),
      { maxBodyBytes: 100 },
    );
    expect(outcome.status).toBe(413);
  });

  it('returns 404 for an unknown action without echoing the id', async () => {
    const outcome = await dispatchAction(req({ headers: { 'x-vura-action': 'ghost#gone' } }));
    expect(outcome.status).toBe(404);
    expect(JSON.stringify(outcome.body)).not.toContain('ghost#gone');
  });

  it('serialises an undefined return as null rather than dropping the field', async () => {
    registerActionModules({ noop: { run: async () => undefined } });
    const outcome = await dispatchAction(req({ headers: { 'x-vura-action': 'noop#run' } }));
    expect(outcome.body).toEqual({ result: null });
  });
});

describe('A8: errors cross the boundary with their intent intact', () => {
  it('keeps a deliberate 404 a 404', async () => {
    registerActionModules({ todos: { get: async () => { throw notFound('No such todo'); } } });
    const outcome = await dispatchAction(req({ headers: { 'x-vura-action': 'todos#get' } }));
    expect(outcome.status).toBe(404);
    expect((outcome.body as { error: string }).error).toBe('No such todo');
  });

  it('keeps a deliberate 400 a 400', async () => {
    registerActionModules({ todos: { add: async () => { throw badRequest('Text required'); } } });
    const outcome = await dispatchAction(req({ headers: { 'x-vura-action': 'todos#add' } }));
    expect(outcome.status).toBe(400);
  });

  it('recognises an HttpError from another bundle, where instanceof is false', async () => {
    // What a separately bundled copy of core produces: same shape, same toJSON,
    // different class object. `instanceof HttpError` is false for this value.
    class ForeignHttpError extends Error {
      statusCode = 404;
      code = 'NOT_FOUND';
      toJSON() {
        return { error: this.message, code: this.code };
      }
    }
    const foreign = new ForeignHttpError('Gone from another bundle');
    expect(foreign instanceof (badRequest('x').constructor as any)).toBe(false);

    registerActionModules({ todos: { get: async () => { throw foreign; } } });
    const outcome = await dispatchAction(req({ headers: { 'x-vura-action': 'todos#get' } }));
    expect(outcome.status).toBe(404);
    expect((outcome.body as { error: string }).error).toBe('Gone from another bundle');
  });

  it('sanitises an unexpected error in production, keeping the message off the wire', async () => {
    registerActionModules({
      todos: { add: async () => { throw new Error('postgres://user:pw@db.internal/prod'); } },
    });
    const outcome = await dispatchAction(
      req({ headers: { 'x-vura-action': 'todos#add' } }),
      { errorMode: 'production' },
    );
    expect(outcome.status).toBe(500);
    expect(JSON.stringify(outcome.body)).not.toContain('db.internal');
  });
});

// ─── The build plugin ───

describe('A9: the stub swap', () => {
  it('resolves an import that lands in src/actions and rejects one that does not', () => {
    const root = scratch();
    mkdirSync(join(root, 'src', 'actions'), { recursive: true });
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    writeFileSync(join(root, 'src', 'actions', 'todos.ts'), 'export async function add() {}');
    writeFileSync(join(root, 'src', 'lib.ts'), 'export const x = 1;');

    const actionsRoot = join(root, 'src', 'actions');
    const fromPages = join(root, 'src', 'pages');

    // Real-path normalised on the way out: on macOS the scratch dir is under
    // /var, which is a symlink to /private/var, and esbuild reports the latter.
    // Comparing the two forms unnormalised is what made this boundary fail open.
    expect(resolveActionImport('../actions/todos', fromPages, actionsRoot))
      .toBe(realpathSync(join(actionsRoot, 'todos.ts')));
    expect(resolveActionImport('../lib', fromPages, actionsRoot)).toBeNull();
    // A bare specifier is a package, never an action, even if the name collides.
    expect(resolveActionImport('todos', fromPages, actionsRoot)).toBeNull();
  });

  it('contains an action reached through a symlinked project root', () => {
    // The bug this pins: esbuild reports an importer's resolved path while the
    // project root arrives as typed. Unnormalised, the containment check reads
    // the action file as outside src/actions and the plugin waves it through.
    const root = scratch();
    mkdirSync(join(root, 'src', 'actions'), { recursive: true });
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    writeFileSync(join(root, 'src', 'actions', 'todos.ts'), 'export async function add() {}');

    const symlinked = join(root, 'src', 'actions');
    const realDir = realpathSync(symlinked);
    // Only meaningful when the two forms differ; on Linux CI they may not.
    const viaTyped = resolveActionImport('../actions/todos', join(root, 'src', 'pages'), symlinked);
    const viaReal = resolveActionImport(
      '../actions/todos',
      realpathSync(join(root, 'src', 'pages')),
      realDir,
    );
    expect(viaTyped).not.toBeNull();
    expect(viaReal).not.toBeNull();
    expect(viaTyped).toBe(viaReal);
  });

  it('generates one wrapper per export, each naming its id', () => {
    const stub = generateActionStub('admin/users', ['ban', 'unban']);
    expect(stub).toContain('export function ban(...args)');
    expect(stub).toContain('"admin/users#ban"');
    expect(stub).toContain('"admin/users#unban"');
  });

  it('never lets action source reach a browser bundle', async () => {
    const root = scratch();
    mkdirSync(join(root, 'src', 'actions'), { recursive: true });
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });

    // A realistic action file: a secret, and an import that only exists on a
    // server. If esbuild opened this file, the build would fail on `node:fs`
    // even before the secret leaked.
    writeFileSync(
      join(root, 'src', 'actions', 'todos.ts'),
      `import { readFileSync } from 'node:fs';
       const DB_URL = 'postgres://user:SUPER-SECRET-PASSWORD@db.internal/prod';
       export async function addTodo(text: string) {
         readFileSync('/etc/passwd');
         return { text, db: DB_URL };
       }`,
    );
    writeFileSync(
      join(root, 'src', 'pages', 'index.tsx'),
      `import { addTodo } from '../actions/todos';
       export default function Page() { return addTodo('milk'); }`,
    );

    const { build: esbuild } = await import('esbuild');
    const outfile = join(root, 'out.js');
    await esbuild({
      entryPoints: [join(root, 'src', 'pages', 'index.tsx')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      outfile,
      plugins: [vuraActionsStubPlugin({ projectRoot: root })],
    });

    const bundle = readFileSync(outfile, 'utf8');
    expect(bundle).not.toContain('SUPER-SECRET-PASSWORD');
    expect(bundle).not.toContain('db.internal');
    expect(bundle).not.toContain('/etc/passwd');
    // What it contains instead: the id and the transport.
    expect(bundle).toContain('todos#addTodo');
    expect(bundle).toContain('/__vura/action');
  });

  it('leaves imports outside src/actions alone', async () => {
    const root = scratch();
    mkdirSync(join(root, 'src', 'actions'), { recursive: true });
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    writeFileSync(join(root, 'src', 'actions', 'todos.ts'), 'export async function add() {}');
    writeFileSync(join(root, 'src', 'lib.ts'), "export const GREETING = 'ORDINARY-MODULE';");
    writeFileSync(
      join(root, 'src', 'pages', 'index.tsx'),
      `import { GREETING } from '../lib';
       export default function Page() { return GREETING; }`,
    );

    const { build: esbuild } = await import('esbuild');
    const outfile = join(root, 'out.js');
    await esbuild({
      entryPoints: [join(root, 'src', 'pages', 'index.tsx')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      outfile,
      plugins: [vuraActionsStubPlugin({ projectRoot: root })],
    });

    expect(readFileSync(outfile, 'utf8')).toContain('ORDINARY-MODULE');
  });
});
