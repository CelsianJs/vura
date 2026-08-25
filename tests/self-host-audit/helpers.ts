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
