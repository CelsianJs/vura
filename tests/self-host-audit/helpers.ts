/**
 * Self-host audit helpers — scaffoldAndBuild, startSinkhole, bootServer.
 *
 * scaffoldAndBuild()
 *   Creates a fresh Vura scaffold in a tmpdir, links local workspace tarballs
 *   via scripts/link-local-packages.mjs (reuse — no duplication), writes the
 *   audit fixture routes, runs `npm install` + `vura build`, caches the result
 *   per process so each test file pays the cost only once.
 *
 * startSinkhole()
 *   An HTTP/HTTPS proxy that records every outbound host the server touches.
 *   Returns 502 to all connections. Allows localhost through transparently.
 *   Used to prove the production server makes zero external calls at runtime.
 *
 * bootServer(env)
 *   Spawns `node dist/server/entry.js` with the given env, waits for the
 *   "[vura] listening on port N" stdout line, returns { port, kill, stdout }.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import * as net from 'node:net';

// ─── Constants ────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINK_LOCAL_SCRIPT = join(REPO_ROOT, 'scripts', 'link-local-packages.mjs');

/** The what-framework range @celsian/vura-core itself declares. */
function whatFrameworkRange(): string {
  const corePkg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'core', 'package.json'), 'utf8'));
  const range = corePkg.dependencies?.['what-framework'] ?? corePkg.peerDependencies?.['what-framework'];
  if (typeof range !== 'string') {
    throw new Error('packages/core/package.json declares no what-framework dependency — the audit cannot pick a version.');
  }
  return range;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let _cached: Awaited<ReturnType<typeof _scaffoldAndBuild>> | null = null;

export async function scaffoldAndBuild(): Promise<{
  dir: string;
  cliBin: string;
  readManifest: () => any;
}> {
  if (_cached) return _cached;
  _cached = await _scaffoldAndBuild();
  return _cached;
}

// ─── Fixture source files ─────────────────────────────────────────────────────

/**
 * src/pages/posts.tsx — rung-2 ISR page.
 * Embeds a render timestamp in a hidden comment so cache hit ≡ identical body.
 * Reads posts from a tmp JSON file (cross-bundle safe — no in-memory sharing).
 */
const POSTS_PAGE = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const page = {
  mode: 'server',
  revalidate: 60,
  tags: ['posts'],
};

const DB_FILE = join(process.env.VURA_POSTS_DB || '/tmp/vura-audit-posts.json');

export async function getServerData() {
  let posts: { id: number; title: string }[] = [];
  try {
    posts = JSON.parse(readFileSync(DB_FILE, 'utf8'));
  } catch {
    posts = [];
  }
  return { posts, renderedAt: Date.now() };
}

export default function Posts({ posts, renderedAt }: { posts: { id: number; title: string }[]; renderedAt: number }) {
  return (
    <div>
      <h1>Posts</h1>
      {/* render-stamp: {renderedAt} */}
      <ul>
        {posts.map((p: { id: number; title: string }) => (
          <li key={p.id}>{p.title}</li>
        ))}
      </ul>
    </div>
  );
}
`;

/**
 * src/api/posts.ts — rung-2 mutation route.
 * Appends to the same JSON file and calls revalidateTag('posts').
 * Returns 201 on success.
 */
const POSTS_API = `import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';
import { revalidateTag } from '@celsian/vura-core';

const DB_FILE = join(process.env.VURA_POSTS_DB || '/tmp/vura-audit-posts.json');

export const route = { kind: 'serverless' };

export async function POST(req: CelsianRequest, reply: CelsianReply) {
  let posts: { id: number; title: string }[] = [];
  try {
    posts = JSON.parse(readFileSync(DB_FILE, 'utf8'));
  } catch {
    posts = [];
  }

  const body = req.parsedBody as { title?: string } | null;
  const title = (body?.title ?? '').trim() || 'untitled';
  posts.push({ id: Date.now(), title });
  writeFileSync(DB_FILE, JSON.stringify(posts), 'utf8');

  await revalidateTag('posts');

  return reply.status(201).json({ ok: true, posts });
}
`;

/**
 * src/api/counter.ts — rung-4 in-memory counter.
 * GET returns count, POST increments. Proves in-memory state persists across requests.
 */
const COUNTER_API = `import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';

export const route = { kind: 'hot' };

let count = 0;

export function GET(_req: CelsianRequest, reply: CelsianReply) {
  return reply.json({ count });
}

export function POST(_req: CelsianRequest, reply: CelsianReply) {
  count++;
  return reply.json({ count });
}
`;

/**
 * src/api/live/room.ts — rung-4 WebSocket room (from 4-hot.md verified example).
 * Exact shape from the docs: broadcast join on connect, echo+broadcast on message.
 */
const ROOM_API = `import type { HotPeer, HotRequest } from '@celsian/vura-core';

export const kind = 'hot';

type Client = { peer: HotPeer; name: string };
const rooms = new Map<string, Set<Client>>();

export function websocket(peer: HotPeer, req: HotRequest) {
  const roomId = req.params['room'] ?? 'lobby';
  const client: Client = { peer, name: req.query.get('name') ?? 'anon' };

  const room = rooms.get(roomId) ?? new Set<Client>();
  room.add(client);
  rooms.set(roomId, room);

  broadcast(room, { type: 'join', name: client.name, count: room.size });

  peer.on('message', (data: unknown) => {
    broadcast(room, { type: 'message', name: client.name, body: String(data) });
  });

  peer.on('close', () => {
    room.delete(client);
    broadcast(room, { type: 'leave', name: client.name, count: room.size });
    if (room.size === 0) rooms.delete(roomId);
  });
}

export function GET(_req: HotRequest, reply: any) {
  return reply.json({
    rooms: [...rooms.entries()].map(([id, c]) => ({ id, clients: c.size })),
  });
}

function broadcast(room: Set<Client>, msg: object) {
  const data = JSON.stringify(msg);
  for (const c of room) c.peer.send(data);
}
`;

/**
 * src/api/tasks/encode.ts — rung-5 task route.
 * Prints the audit marker string to stdout for A6.
 * Has a 1-minute schedule for A7 manifest verification.
 */
const ENCODE_TASK = `export const route = { kind: 'task', retries: 0, timeout: 10_000 };

export const schedule = '*/1 * * * *';

export async function POST(ctx: { attempt: number; input: unknown }) {
  console.log('task encode: done');
  return { encoded: true };
}
`;

/**
 * src/pages/index.tsx — A10 static page.
 * Prerendered at build time to dist/static/index.html; served by the static
 * layer with zero runtime rendering. Marker string proves the right file.
 */
const INDEX_PAGE = `export const page = { mode: 'static', title: 'Audit Home' };

export default function Home() {
  return (
    <main>
      <h1>vura-audit-static-home</h1>
      <p>Prerendered at build time — no runtime render.</p>
    </main>
  );
}
`;

/**
 * src/pages/widget.tsx — A11 client page.
 * Build emits a shell (dist/static/widget/index.html) plus a browser bundle
 * (dist/static/_then/pages/widget.js) whose generated entry calls mount() —
 * mounting replaces the "Loading..." shell DOM. Signal idiom: sig() / sig.set().
 */
const WIDGET_PAGE = `import { signal } from 'what-framework';

export const page = { mode: 'client', title: 'Audit Widget' };

const clicks = signal(0);

export default function Widget() {
  return (
    <main>
      <h1>vura-audit-client-widget</h1>
      <button id="bump" onClick={() => clicks.set(clicks() + 1)}>bump</button>
    </main>
  );
}
`;

/**
 * src/pages/mixed.tsx — A12 hybrid page.
 * Prerendered at build time (SSR-visible markup) AND given a hydration bundle
 * (dist/static/_then/pages/mixed.js, generated entry calls hydrate()).
 * Markup is kept renderToString-safe; interactivity lives in the event handler.
 */
const MIXED_PAGE = `import { signal } from 'what-framework';

export const page = { mode: 'hybrid', title: 'Audit Mixed' };

const count = signal(0);

export default function Mixed() {
  return (
    <main>
      <h1>vura-audit-hybrid-ssr</h1>
      <button id="hydrate-bump" onClick={() => count.set(count() + 1)}>bump</button>
    </main>
  );
}
`;


/**
 * src/pages/loaders/_layout.tsx — RFC 0001 layered loader, outer segment.
 *
 * Deliberately in a subdirectory: a root layout would wrap every other fixture
 * page and change what the rest of the audit asserts.
 *
 * `startedAt` exists to prove the chain runs in parallel. All three loaders in
 * this subtree sleep, so if they ran in sequence their start stamps would be a
 * sleep apart.
 */
const LOADER_OUTER_LAYOUT = `import { useLoaderData } from '@celsian/vura-core';

export async function loader() {
  const startedAt = Date.now();
  await new Promise(r => setTimeout(r, 120));
  return { site: 'AUDIT-SITE', startedAt };
}

export default function OuterLayout({ children }: { children?: unknown }) {
  const data = useLoaderData<typeof loader>();
  return (
    <div class="outer">
      <header id="site">SITE:{data.site}</header>
      <main>{children}</main>
    </div>
  );
}
`;

/** src/pages/loaders/nested/_layout.tsx — inner segment of the same chain. */
const LOADER_INNER_LAYOUT = `import { useLoaderData } from '@celsian/vura-core';

export async function loader() {
  const startedAt = Date.now();
  await new Promise(r => setTimeout(r, 120));
  return { dept: 'AUDIT-DEPT', startedAt };
}

export default function InnerLayout({ children }: { children?: unknown }) {
  const data = useLoaderData<typeof loader>();
  return (
    <div class="inner">
      <h2 id="dept">{data.dept}</h2>
      {children}
    </div>
  );
}
`;

/** src/pages/loaders/nested/index.tsx — the leaf of the chain. */
const LOADER_NESTED_PAGE = `import { useLoaderData } from '@celsian/vura-core';

export const page = { mode: 'server', title: 'Loader chain' };

export async function loader() {
  const startedAt = Date.now();
  await new Promise(r => setTimeout(r, 120));
  return { items: ['alpha', 'beta'], startedAt };
}

export default function NestedPage() {
  const data = useLoaderData<typeof loader>();
  return <ul id="items">{data.items.map((i: string) => <li>{i}</li>)}</ul>;
}
`;

/** src/pages/loaders/gate.tsx — loader-driven 404 and redirect. */
const LOADER_GATE_PAGE = `import { useLoaderData } from '@celsian/vura-core';
import type { LoaderContext } from '@celsian/vura-core';

export const page = { mode: 'server', title: 'Gate' };

export async function loader(ctx: LoaderContext) {
  if (ctx.query.mode === 'missing') throw ctx.notFound('no such thing');
  if (ctx.query.mode === 'moved') throw ctx.redirect('/loaders/nested');
  return { mode: ctx.query.mode ?? 'none' };
}

export default function GatePage() {
  const data = useLoaderData<typeof loader>();
  return <h1 id="mode">MODE:{data.mode}</h1>;
}
`;

/**
 * src/pages/loaders/island.tsx — hybrid page whose component reads loader data
 * on BOTH sides: server-rendered into the HTML, then hydrated from the
 * serialized payload.
 */
const LOADER_ISLAND_PAGE = `import { signal } from 'what-framework';
import { useLoaderData } from '@celsian/vura-core';

export const page = { mode: 'hybrid', title: 'Island' };

export async function loader() {
  return { greeting: 'ISLAND-LOADED' };
}

export default function IslandPage() {
  const data = useLoaderData<typeof loader>();
  const count = signal(0);
  return (
    <div>
      <h1 id="greeting">{data.greeting}</h1>
      <button id="inc" onClick={() => count.set(count() + 1)}>inc</button>
      <span id="count">{() => count()}</span>
    </div>
  );
}
`;

/** src/pages/loaders/prebuilt.tsx — a build-time loader (static mode). */
const LOADER_STATIC_PAGE = `import { useLoaderData } from '@celsian/vura-core';

export const page = { mode: 'static', title: 'Prebuilt' };

export async function loader() {
  return { builtAt: 'BUILD-TIME-DATA' };
}

export default function PrebuiltPage() {
  const data = useLoaderData<typeof loader>();
  return <h1 id="built">{data.builtAt}</h1>;
}
`;


/**
 * src/middleware.ts — project middleware.
 *
 * Guards a page subtree, sets a header on every matched request, and leaves
 * everything else alone. The matcher covers both a page path and an API path
 * so the audit can prove middleware reaches both.
 */
const MIDDLEWARE = `import type { MiddlewareContext } from '@celsian/vura-core';

export const config = {
  matcher: ['/guarded/:path*', '/api/guarded'],
};

export default function middleware(ctx: MiddlewareContext) {
  ctx.headers.set('x-vura-middleware', 'ran');
  if (ctx.cookies.get('session') !== 'letmein') {
    return ctx.redirect('/login', 302);
  }
}
`;

/** src/pages/guarded/index.tsx — the page the middleware protects. */
const GUARDED_PAGE = `export const page = { mode: 'server', title: 'Guarded' };

export default function GuardedPage() {
  return <h1 id="guarded">SECRET-CONTENT</h1>;
}
`;

/** src/api/guarded.ts — an API route behind the same matcher. */
const GUARDED_API = `import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';

export const route = { kind: 'serverless' };

export function GET(_req: CelsianRequest, reply: CelsianReply) {
  return reply.json({ secret: true });
}
`;

/**
 * src/actions/todos.ts — a server action module.
 *
 * Deliberately holds a credential-shaped constant and reaches for `node:fs`.
 * Either one reaching a browser bundle is a failure the audit can see, and the
 * `node:fs` import means a build that opened this file for the browser would
 * die rather than quietly ship it.
 */
const TODOS_ACTIONS = `import { readFileSync } from 'node:fs';
import { notFound } from '@celsian/vura-core';

const DB_URL = 'postgres://audit:ACTION-SOURCE-MUST-NOT-SHIP@db.internal/prod';

export async function addTodo(text: string) {
  return { text, added: true };
}

export async function readSecret() {
  // Present so the module genuinely cannot run in a browser.
  return typeof readFileSync === 'function' ? DB_URL.length : 0;
}

export async function missingTodo() {
  throw notFound('No such todo');
}

export async function explode() {
  throw new Error('postgres://audit:ACTION-SOURCE-MUST-NOT-SHIP@db.internal/prod');
}
`;

/** src/pages/todos.tsx — a hybrid page importing the action, so a browser bundle exists. */
const ACTIONS_PAGE = `import { addTodo } from '../actions/todos';

export const page = { mode: 'hybrid', title: 'Todos' };

export default function TodosPage() {
  return (
    <div>
      <h1 id="todos">Todos</h1>
      <button id="add" onClick={() => addTodo('milk')}>Add</button>
    </div>
  );
}
`;

/**
 * src/api/boom.ts — an API route that throws a Vura HttpError.
 *
 * The neighbouring half of the cross-bundle error question. Vura's HttpError is
 * not Celsian's, so Celsian's `instanceof HttpError` branch does not match it;
 * the status survives only because Celsian falls back to reading
 * `error.statusCode` structurally. That is load-bearing behaviour in a
 * dependency, so it is pinned here rather than assumed.
 */
const BOOM_API = `import { notFound } from '@celsian/vura-core';
import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';

export const route = { kind: 'serverless' };

export function GET(_req: CelsianRequest, _reply: CelsianReply) {
  throw notFound('No such thing');
}
`;

/**
 * Pages that call `useSignal()` — one per rendered mode.
 *
 * The audit's other fixtures all hold state in a module-level `signal()`, which
 * needs no component context, so none of them could see that every
 * build-time-rendered page inlined its own copy of what-core while
 * `renderToString` ran from the installed one. `useSignal` reads the renderer's
 * current-component state, so it is the shape that fails: it threw in every
 * `static` and `hybrid` page and nothing noticed.
 */
const HOOK_STATIC_PAGE = `import { useSignal } from 'what-framework';

export const page = { mode: 'static', title: 'Hook static' };

export default function HookStatic() {
  const label = useSignal('hook-static-ok');
  return <main><h1 id="hook">{label()}</h1></main>;
}
`;

const HOOK_SERVER_PAGE = `import { useSignal } from 'what-framework';

export const page = { mode: 'server', title: 'Hook server' };

export default function HookServer() {
  const label = useSignal('hook-server-ok');
  return <main><h1 id="hook">{label()}</h1></main>;
}
`;

const HOOK_HYBRID_PAGE = `import { useSignal } from 'what-framework';

export const page = { mode: 'hybrid', title: 'Hook hybrid' };

export default function HookHybrid() {
  const label = useSignal('hook-hybrid-ok');
  return <main><h1 id="hook">{label()}</h1></main>;
}
`;

// ─── Core scaffoldAndBuild impl ────────────────────────────────────────────────

async function _scaffoldAndBuild(): Promise<{
  dir: string;
  cliBin: string;
  readManifest: () => any;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'vura-selfhost-audit-'));

  // 1. Write package.json with workspace dep stubs (will be rewritten by link-local)
  const packageJson = {
    name: 'vura-selfhost-audit',
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: { build: 'vura build' },
    dependencies: {
      '@celsian/vura-core': '0.4.0',
      '@celsian/vura-cli': '0.4.0',
      // Read from packages/core rather than hardcoded. A pinned literal here
      // drifts: the audit spent the 0.12 and 0.13 cycles proving Vura works on
      // What 0.11, which is a version Vura had stopped shipping against, so a
      // framework fix Vura depended on could not be seen by the audit that
      // exists to catch exactly that.
      'what-framework': whatFrameworkRange(),
      'ws': '^8.18.0',
    },
  };
  await writeFile(join(dir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');

  // 2. Write vura.config.js
  await writeFile(
    join(dir, 'vura.config.js'),
    `import { defineConfig } from '@celsian/vura-core';\nexport default defineConfig({});\n`,
  );

  // 3. Write tsconfig.json
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022', module: 'Node16', moduleResolution: 'Node16',
      jsx: 'react-jsx', jsxImportSource: 'what-framework',
      strict: true, esModuleInterop: true, skipLibCheck: true,
      outDir: 'dist', rootDir: 'src',
    },
    include: ['src'],
  };
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');

  // 4. Write fixture source files
  await mkdir(join(dir, 'src', 'pages'), { recursive: true });
  await mkdir(join(dir, 'src', 'api', 'live'), { recursive: true });
  await mkdir(join(dir, 'src', 'api', 'tasks'), { recursive: true });

  await writeFile(join(dir, 'src', 'pages', 'posts.tsx'), POSTS_PAGE);
  await writeFile(join(dir, 'src', 'pages', 'index.tsx'), INDEX_PAGE);
  await writeFile(join(dir, 'src', 'pages', 'widget.tsx'), WIDGET_PAGE);
  await writeFile(join(dir, 'src', 'pages', 'mixed.tsx'), MIXED_PAGE);
  await writeFile(join(dir, 'src', 'api', 'posts.ts'), POSTS_API);
  await writeFile(join(dir, 'src', 'api', 'counter.ts'), COUNTER_API);
  await writeFile(join(dir, 'src', 'api', 'live', 'room.ts'), ROOM_API);
  await writeFile(join(dir, 'src', 'api', 'tasks', 'encode.ts'), ENCODE_TASK);

  // RFC 0001 loaders, exercised through a real build and a real server.
  await mkdir(join(dir, 'src', 'pages', 'loaders', 'nested'), { recursive: true });
  await writeFile(join(dir, 'src', 'pages', 'loaders', '_layout.tsx'), LOADER_OUTER_LAYOUT);
  await writeFile(join(dir, 'src', 'pages', 'loaders', 'nested', '_layout.tsx'), LOADER_INNER_LAYOUT);
  await writeFile(join(dir, 'src', 'pages', 'loaders', 'nested', 'index.tsx'), LOADER_NESTED_PAGE);
  await writeFile(join(dir, 'src', 'pages', 'loaders', 'gate.tsx'), LOADER_GATE_PAGE);
  await writeFile(join(dir, 'src', 'pages', 'loaders', 'island.tsx'), LOADER_ISLAND_PAGE);
  await writeFile(join(dir, 'src', 'pages', 'loaders', 'prebuilt.tsx'), LOADER_STATIC_PAGE);

  // Project middleware, and the page and API route it guards.
  await mkdir(join(dir, 'src', 'pages', 'guarded'), { recursive: true });
  await writeFile(join(dir, 'src', 'middleware.ts'), MIDDLEWARE);
  await writeFile(join(dir, 'src', 'pages', 'guarded', 'index.tsx'), GUARDED_PAGE);
  await writeFile(join(dir, 'src', 'api', 'guarded.ts'), GUARDED_API);

  // Server actions, and the hybrid page that imports them.
  await mkdir(join(dir, 'src', 'actions'), { recursive: true });
  await writeFile(join(dir, 'src', 'actions', 'todos.ts'), TODOS_ACTIONS);
  await writeFile(join(dir, 'src', 'pages', 'todos.tsx'), ACTIONS_PAGE);
  await writeFile(join(dir, 'src', 'api', 'boom.ts'), BOOM_API);

  // Pages using a component-context hook, one per rendered mode.
  await mkdir(join(dir, 'src', 'pages', 'hooks'), { recursive: true });
  await writeFile(join(dir, 'src', 'pages', 'hooks', 'static.tsx'), HOOK_STATIC_PAGE);
  await writeFile(join(dir, 'src', 'pages', 'hooks', 'server.tsx'), HOOK_SERVER_PAGE);
  await writeFile(join(dir, 'src', 'pages', 'hooks', 'hybrid.tsx'), HOOK_HYBRID_PAGE);

  // 5. Rewrite deps to local tarballs via link-local-packages.mjs
  const linkResult = spawnSync(process.execPath, [LINK_LOCAL_SCRIPT, dir], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (linkResult.status !== 0) {
    throw new Error(
      `link-local-packages.mjs failed:\n${linkResult.stdout}\n${linkResult.stderr}`,
    );
  }

  // 6. npm install
  const installResult = spawnSync('npm', ['install', '--prefer-offline'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'development' },
  });
  if (installResult.status !== 0) {
    throw new Error(
      `npm install failed in ${dir}:\n${installResult.stdout}\n${installResult.stderr}`,
    );
  }

  // 7. vura build
  const cliBin = join(dir, 'node_modules', '@celsian', 'vura-cli', 'bin.js');
  if (!existsSync(cliBin)) {
    throw new Error(`CLI bin not found after install: ${cliBin}`);
  }

  const buildResult = spawnSync(process.execPath, [cliBin, 'build'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (buildResult.status !== 0) {
    throw new Error(
      `vura build failed in ${dir}:\n${buildResult.stdout}\n${buildResult.stderr}`,
    );
  }

  function readManifest(): any {
    const manifestPath = join(dir, 'dist', 'manifest.json');
    return JSON.parse(readFileSync_sync(manifestPath));
  }

  return { dir, cliBin, readManifest };
}

function readFileSync_sync(p: string): string {
  return readFileSync(p, 'utf8');
}

// ─── Sinkhole proxy ───────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set([
  'localhost', '127.0.0.1', '::1', '0.0.0.0',
]);

function isLocal(host: string): boolean {
  const bare = host.split(':')[0]!;
  return LOCAL_HOSTS.has(bare);
}

export async function startSinkhole(): Promise<{
  url: string;
  externalHosts: () => string[];
  close: () => Promise<void>;
}> {
  const recorded: string[] = [];

  const server = http.createServer((req, res) => {
    // Plain HTTP requests (should not happen in prod; record and 502)
    const host = (req.headers.host ?? '').split(':')[0]!;
    if (!isLocal(host)) recorded.push(host);
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('sinkhole: blocked');
  });

  // CONNECT tunnel (HTTPS) — record the target host, immediately destroy
  server.on('connect', (req, socket) => {
    const host = (req.url ?? '').split(':')[0]!;
    if (!isLocal(host)) recorded.push(host);
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const addr = server.address() as net.AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    externalHosts: () => [...new Set(recorded)],
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

// ─── Server boot ─────────────────────────────────────────────────────────────

export async function bootServer(env: Record<string, string>): Promise<{
  port: number;
  kill: () => Promise<void>;
  stdout: () => string;
}> {
  const { dir } = await scaffoldAndBuild();
  const entryPath = join(dir, 'dist', 'server', 'entry.js');

  // Merge provided env over a clean base (no parent VURA_* unless explicitly passed)
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env as Record<string, string>)) {
    if (!/^VURA_/.test(k)) cleanEnv[k] = v;
  }
  // Apply caller-provided overrides
  for (const [k, v] of Object.entries(env)) {
    cleanEnv[k] = v;
  }

  const proc = spawn(process.execPath, [entryPath], {
    cwd: dir,
    env: cleanEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks: string[] = [];
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d: string) => stdoutChunks.push(d));
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d: string) => stdoutChunks.push(d));

  // Wait for "[vura] listening on port N"
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start in 15s')), 15_000);

    proc.stdout.on('data', (chunk: string) => {
      const m = chunk.match(/\[vura\] listening on port (\d+)/);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });

    proc.on('error', (err) => { clearTimeout(t); reject(err); });
    proc.on('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`server exited with code ${code} before listening`));
    });
  });

  return {
    port,
    kill: () => new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
      setTimeout(() => { proc.kill('SIGKILL'); }, 3000);
    }),
    stdout: () => stdoutChunks.join(''),
  };
}
