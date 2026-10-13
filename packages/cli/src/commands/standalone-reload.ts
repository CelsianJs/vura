import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

const CLIENT_PATH = '/__vura/dev/reload.js';
const EVENTS_PATH = '/__vura/dev/events';

/** Private to the standalone development server; never included in builds. */
export function createStandaloneReload() {
  const epoch = randomUUID();
  let revision = 0;
  let closed = false;
  const clients = new Set<ServerResponse>();
  const generation = () => `${epoch}:${revision}`;
  const send = (res: ServerResponse) => {
    // A slow/background tab must not grow an unbounded writable queue.
    if (!res.write(`event: generation\ndata: ${JSON.stringify({ generation: generation() })}\n\n`)) res.destroy();
  };
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      if (!res.write(': keepalive\n\n')) res.destroy();
    }
  }, 15_000);
  heartbeat.unref();

  return {
    scriptPath: () => `${CLIENT_PATH}?generation=${encodeURIComponent(generation())}`,
    publish() {
      if (closed) return;
      revision++;
      for (const res of clients) send(res);
    },
    handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
      if (url.pathname !== CLIENT_PATH && url.pathname !== EVENTS_PATH) return false;
      // Handle BEFORE application CORS/middleware. In particular, an app's
      // permissive CORS setting must never expose this control channel.
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if ((origin !== undefined && origin !== url.origin) ||
          (site !== undefined && site !== 'same-origin' && site !== 'none')) {
        res.writeHead(403);
        res.end('Forbidden');
        return true;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' });
        res.end();
        return true;
      }
      if (url.pathname === CLIENT_PATH) {
        const loaded = url.searchParams.get('generation') ?? '';
        // The HTML embeds its generation in the script URL, not the current
        // script-response generation: a save between HTML and connect must
        // still trigger a reload. Reconnects receive the latest generation too.
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(`(() => {
  const loaded = ${JSON.stringify(loaded)};
  const source = new EventSource(${JSON.stringify(EVENTS_PATH)} + '?generation=' + encodeURIComponent(loaded));
  let reloading = false;
  source.addEventListener('generation', (event) => {
    let next;
    try { next = JSON.parse(event.data).generation; } catch { return; }
    if (typeof next !== 'string' || next === loaded || reloading) return;
    reloading = true;
    source.close();
    location.reload();
  });
  addEventListener('pagehide', () => source.close(), { once: true });
})();`);
        return true;
      }
      if (closed || clients.size >= 64) {
        res.writeHead(503, { 'Retry-After': '5' });
        res.end();
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
      });
      clients.add(res);
      res.on('close', () => clients.delete(res));
      send(res);
      return true;
    },
    close() {
      closed = true;
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

/** Content, not fs event count: unchanged saves must not reset browser state. */
export async function sourceFingerprint(root: string, hooksFiles: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  async function addFile(path: string) {
    try {
      const contents = await readFile(join(root, path));
      hash.update(path).update('\0').update(contents).update('\0');
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  async function visit(path: string) {
    let entries;
    try { entries = await readdir(join(root, path), { withFileTypes: true }); }
    catch (err: any) { if (err.code === 'ENOENT') return; throw err; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const next = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile()) await addFile(next);
    }
  }
  await visit('src');
  for (const file of hooksFiles) await addFile(file);
  return hash.digest('hex');
}

/** Watch all src imports, including folders created after the server starts. */
export function watchStandaloneSource(root: string, hooksFiles: readonly string[], changed: () => void): () => void {
  let sourceWatcher: FSWatcher | undefined;
  const watchSource = () => {
    sourceWatcher?.close();
    try { sourceWatcher = watch(join(root, 'src'), { recursive: true }, changed); }
    catch { sourceWatcher = undefined; /* src can be added later */ }
  };
  watchSource();
  const rootWatcher = watch(root, (_event, filename) => {
    const file = filename?.toString();
    if (file === 'src') { watchSource(); changed(); }
    else if (file && hooksFiles.includes(file)) changed();
  });
  return () => { sourceWatcher?.close(); rootWatcher.close(); };
}
