/**
 * `then admin` — Launch the ThenJS admin dashboard.
 *
 * A local web UI for managing deployments, routes, environment
 * variables, and domain configuration. Inspired by Vercel's dashboard.
 *
 * Usage:
 *   then admin                    — Start on 127.0.0.1:4000
 *   then admin --port 9000        — Start on 127.0.0.1:9000
 *   then admin --host 127.0.0.1 — Bind explicitly to loopback
 */

import { buildManifest } from '@then/core';
import { loadConfig } from '../config-loader.js';

interface AdminOptions {
  port: number;
  host: string;
  projectRoot: string;
}

export function parseAdminOptions(args: string[], projectRoot = process.cwd()): AdminOptions {
  const portArg = args.find((_, i) => args[i - 1] === '--port');
  const hostArg = args.find((_, i) => args[i - 1] === '--host');

  return {
    port: portArg ? parseInt(portArg, 10) : 4000,
    host: hostArg || '127.0.0.1',
    projectRoot,
  };
}

export function isLocalAdminHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function assertSafeAdminBindHost(host: string): void {
  if (!isLocalAdminHost(host)) {
    throw new Error(
      `then admin must bind to localhost/loopback. Refusing unsafe host "${host}" because the dashboard manages local secrets.`,
    );
  }
}

export function adminApiHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
}

export function isAllowedAdminRequest(
  headers: { host?: string | string[]; origin?: string | string[] },
  bindHost: string,
  port: number,
): boolean {
  const hostHeader = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  if (!hostHeader) return false;
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  if (isLocalAdminHost(bindHost)) {
    allowedHosts.add(`${bindHost}:${port}`);
  } else {
    allowedHosts.add(`${bindHost}:${port}`);
  }
  if (!allowedHosts.has(hostHeader)) return false;

  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return allowedHosts.has(parsed.host) && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

export async function adminCommand(args: string[]): Promise<void> {
  const opts = parseAdminOptions(args);

  assertSafeAdminBindHost(opts.host);

  const { createServer } = await import('node:http');
  const { randomBytes } = await import('node:crypto');
  const { readFile, writeFile, readdir, stat, access } = await import('node:fs/promises');
  const { join, basename } = await import('node:path');

  // Scan project
  let manifest = await buildManifest(opts.projectRoot);
  const config = await loadConfig(opts.projectRoot);
  const projectName = basename(opts.projectRoot);
  const adminToken = randomBytes(32).toString('base64url');

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = (req.method ?? 'GET').toUpperCase();
    const isAdminApi = url.pathname.startsWith('/__admin/api/');
    const sameOrigin = isAllowedAdminRequest(req.headers, opts.host, opts.port);
    const apiHeaders = adminApiHeaders();

    if (method === 'OPTIONS') {
      res.writeHead(sameOrigin ? 204 : 403, {
        ...apiHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Then-Admin-Token',
      });
      res.end();
      return;
    }

    if (isAdminApi) {
      if (!sameOrigin || req.headers['x-then-admin-token'] !== adminToken) {
        res.writeHead(403, apiHeaders);
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
    }

    // ─── API Endpoints ───

    if (url.pathname === '/__admin/api/manifest' && method === 'GET') {
      manifest = await buildManifest(opts.projectRoot);
      res.writeHead(200, apiHeaders);
      res.end(JSON.stringify(manifest));
      return;
    }

    if (url.pathname === '/__admin/api/project' && method === 'GET') {
      const pkg = await readFile(join(opts.projectRoot, 'package.json'), 'utf-8').catch(() => '{}');
      const pkgJson = JSON.parse(pkg);

      // Check for build output
      let lastBuild: string | null = null;
      let hasServerEntry = false;
      let hasFunctions = false;
      let hasStatic = false;
      let functionCount = 0;
      let staticPageCount = 0;
      let taskEntryCount = 0;
      try {
        const manifestFile = await readFile(join(opts.projectRoot, 'dist', 'manifest.json'), 'utf-8');
        const buildManifest = JSON.parse(manifestFile);
        lastBuild = buildManifest.timestamp;
      } catch {}
      try {
        await access(join(opts.projectRoot, 'dist', 'server', 'entry.js'));
        hasServerEntry = true;
      } catch {}
      try {
        const funcs = await readdir(join(opts.projectRoot, 'dist', 'functions'));
        functionCount = funcs.length;
        hasFunctions = functionCount > 0;
        taskEntryCount = funcs.filter(f => f.startsWith('task_')).length;
      } catch {}
      try {
        const statics = await readdir(join(opts.projectRoot, 'dist', 'static'), { recursive: true });
        staticPageCount = (statics as string[]).filter(f => String(f).endsWith('.html')).length;
        hasStatic = staticPageCount > 0;
      } catch {}

      // Check adapter output
      let adapterName = config.adapter?.name ?? null;
      let adapterOutput: Record<string, boolean> = {};
      for (const dir of ['cloudflare', 'lambda']) {
        try {
          await access(join(opts.projectRoot, 'dist', dir));
          adapterOutput[dir] = true;
        } catch {
          adapterOutput[dir] = false;
        }
      }

      res.writeHead(200, apiHeaders);
      res.end(JSON.stringify({
        name: pkgJson.name ?? projectName,
        version: pkgJson.version ?? '0.0.0',
        root: opts.projectRoot,
        adapter: adapterName,
        adapterOutput,
        lastBuild,
        hasServerEntry,
        hasFunctions,
        hasStatic,
        functionCount,
        staticPageCount,
        taskEntryCount,
        nodeVersion: process.version,
        platform: process.platform,
      }));
      return;
    }

    if (url.pathname === '/__admin/api/env' && method === 'GET') {
      let envContent = '';
      try {
        envContent = await readFile(join(opts.projectRoot, '.env'), 'utf-8');
      } catch {}
      let envLocalContent = '';
      try {
        envLocalContent = await readFile(join(opts.projectRoot, '.env.local'), 'utf-8');
      } catch {}

      const parseEnv = (content: string) => {
        const vars: { key: string; value: string }[] = [];
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            let value = trimmed.slice(eqIdx + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            vars.push({ key, value });
          }
        }
        return vars;
      };

      res.writeHead(200, apiHeaders);
      res.end(JSON.stringify({
        env: parseEnv(envContent),
        envLocal: parseEnv(envLocalContent),
        rawEnv: envContent,
        rawEnvLocal: envLocalContent,
      }));
      return;
    }

    if (url.pathname === '/__admin/api/env' && method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      if (body.file === '.env' || body.file === '.env.local') {
        await writeFile(join(opts.projectRoot, body.file), body.content, 'utf-8');
        res.writeHead(200, apiHeaders);
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(400, apiHeaders);
        res.end(JSON.stringify({ error: 'Invalid file' }));
      }
      return;
    }

    if (url.pathname === '/__admin/api/deployments' && method === 'GET') {
      const deployments: any[] = [];

      // Hot server
      if (manifest.api.some(r => r.kind === 'hot') || manifest.pages.some(p => p.mode === 'server')) {
        deployments.push({
          type: 'hot-server',
          label: 'Hot Server',
          description: 'Long-running Node.js server for hot routes & SSR pages',
          entry: 'dist/server/entry.js',
          url: `http://localhost:${process.env.PORT || 3000}`,
          routes: [
            ...manifest.api.filter(r => r.kind === 'hot').map(r => ({ pattern: r.urlPattern, methods: r.methods })),
            ...manifest.pages.filter(p => p.mode === 'server' || p.mode === 'hybrid').map(p => ({ pattern: p.urlPattern, methods: ['GET'] })),
          ],
          status: 'ready',
        });
      }

      // Static / CDN
      if (manifest.pages.some(p => p.mode === 'static')) {
        deployments.push({
          type: 'static',
          label: 'Static Pages',
          description: 'Pre-rendered HTML pages for CDN deployment',
          directory: 'dist/static/',
          pages: manifest.pages.filter(p => p.mode === 'static').map(p => p.urlPattern),
          status: 'ready',
        });
      }

      // Serverless functions
      const serverlessFns = manifest.api.filter(r => r.kind === 'serverless');
      if (serverlessFns.length > 0) {
        deployments.push({
          type: 'serverless',
          label: 'Serverless Functions',
          description: 'Individual function bundles for Lambda/Workers',
          directory: 'dist/functions/',
          functions: serverlessFns.map(r => ({ pattern: r.urlPattern, methods: r.methods })),
          status: 'ready',
        });
      }

      // Task routes
      const taskFns = manifest.api.filter(r => r.kind === 'task');
      if (taskFns.length > 0) {
        deployments.push({
          type: 'tasks',
          label: 'Background Tasks',
          description: 'Scheduled & on-demand task workers',
          directory: 'dist/functions/',
          tasks: taskFns.map(r => ({
            pattern: r.urlPattern,
            schedule: r.config.schedule ?? null,
            retries: r.config.retries ?? 0,
            timeout: r.config.timeout ?? 30000,
          })),
          status: 'ready',
        });
      }

      res.writeHead(200, apiHeaders);
      res.end(JSON.stringify(deployments));
      return;
    }

    // ─── Serve Dashboard UI ───
    if (url.pathname === '/' || url.pathname === '/admin' || url.pathname.startsWith('/admin')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHtml(adminToken));
      return;
    }

    res.writeHead(404, apiHeaders);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(opts.port, opts.host, () => {
    const displayHost = opts.host === '127.0.0.1' ? 'localhost' : opts.host;
    const displayUrl = displayHost.includes(':')
      ? `http://[${displayHost}]:${opts.port}`
      : `http://${displayHost}:${opts.port}`;
    console.log(`
  ┌─────────────────────────────────────────┐
  │                                         │
  │   then admin                            │
  │                                         │
  │   Dashboard: ${displayUrl.padEnd(22)} │
  │   Token:     ${adminToken.slice(0, 8).padEnd(25)} │
  │   Project:   ${projectName.slice(0, 25).padEnd(25)} │
  │                                         │
  │   ${manifest.api.length} API routes · ${manifest.pages.length} pages             │
  │                                         │
  └─────────────────────────────────────────┘
`);
  });

  await new Promise(() => {});
}

// ─── Dashboard HTML ───

export function renderDashboardHtml(adminToken: string): string {
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>then · admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-root: #0a0a0b;
    --bg-surface: #111113;
    --bg-card: #161618;
    --bg-elevated: #1c1c1f;
    --bg-input: #1a1a1d;
    --border: #27272a;
    --border-subtle: #1f1f22;
    --border-focus: #3b82f6;
    --text-primary: #fafafa;
    --text-secondary: #a1a1aa;
    --text-tertiary: #71717a;
    --accent: #22c55e;
    --accent-dim: rgba(34, 197, 94, 0.12);
    --accent-blue: #3b82f6;
    --accent-blue-dim: rgba(59, 130, 246, 0.12);
    --accent-amber: #f59e0b;
    --accent-amber-dim: rgba(245, 158, 11, 0.12);
    --accent-red: #ef4444;
    --accent-red-dim: rgba(239, 68, 68, 0.12);
    --accent-purple: #a78bfa;
    --accent-purple-dim: rgba(167, 139, 250, 0.12);
    --accent-cyan: #06b6d4;
    --accent-cyan-dim: rgba(6, 182, 212, 0.12);
    --radius: 8px;
    --radius-lg: 12px;
    --font-sans: 'Outfit', -apple-system, sans-serif;
    --font-mono: 'JetBrains Mono', monospace;
    --shadow: 0 1px 3px rgba(0,0,0,0.4), 0 0 0 1px var(--border);
    --transition: 150ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font-sans);
    background: var(--bg-root);
    color: var(--text-primary);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  /* ─── Noise overlay ─── */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 9999;
  }

  /* ─── Layout ─── */
  .layout {
    display: grid;
    grid-template-columns: 220px 1fr;
    min-height: 100vh;
  }

  /* ─── Sidebar ─── */
  .sidebar {
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    padding: 20px 0;
    display: flex;
    flex-direction: column;
    position: sticky;
    top: 0;
    height: 100vh;
  }

  .sidebar-logo {
    padding: 0 20px 20px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }

  .sidebar-logo h1 {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.02em;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .sidebar-logo h1 .logo-mark {
    width: 22px;
    height: 22px;
    background: var(--accent);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    color: #000;
    font-family: var(--font-mono);
  }

  .sidebar-logo .project-name {
    font-size: 12px;
    color: var(--text-tertiary);
    margin-top: 4px;
    font-family: var(--font-mono);
    font-weight: 400;
  }

  .nav-section {
    padding: 8px 12px;
  }

  .nav-section-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-tertiary);
    padding: 8px 8px 4px;
    font-weight: 500;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 13px;
    font-weight: 400;
    color: var(--text-secondary);
    transition: all var(--transition);
    user-select: none;
  }

  .nav-item:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .nav-item.active {
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-weight: 500;
  }

  .nav-item .nav-icon {
    font-size: 15px;
    width: 20px;
    text-align: center;
    opacity: 0.7;
  }

  .nav-item.active .nav-icon { opacity: 1; }

  .sidebar-footer {
    margin-top: auto;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
  }

  .sidebar-footer .system-info {
    font-size: 11px;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    line-height: 1.6;
  }

  /* ─── Main ─── */
  .main {
    padding: 32px 40px;
    max-width: 1100px;
  }

  .page-header {
    margin-bottom: 28px;
  }

  .page-header h2 {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.03em;
  }

  .page-header p {
    font-size: 13px;
    color: var(--text-tertiary);
    margin-top: 4px;
  }

  /* ─── Cards ─── */
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    margin-bottom: 16px;
  }

  .card-header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .card-header h3 {
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .card-body {
    padding: 16px 20px;
  }

  /* ─── Stats Grid ─── */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }

  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
  }

  .stat-card .stat-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    font-weight: 500;
    margin-bottom: 8px;
  }

  .stat-card .stat-value {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.04em;
    font-family: var(--font-mono);
  }

  .stat-card .stat-detail {
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: 4px;
    font-family: var(--font-mono);
  }

  /* ─── Badges ─── */
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    font-family: var(--font-mono);
  }

  .badge-green { background: var(--accent-dim); color: var(--accent); }
  .badge-blue { background: var(--accent-blue-dim); color: var(--accent-blue); }
  .badge-amber { background: var(--accent-amber-dim); color: var(--accent-amber); }
  .badge-red { background: var(--accent-red-dim); color: var(--accent-red); }
  .badge-purple { background: var(--accent-purple-dim); color: var(--accent-purple); }
  .badge-cyan { background: var(--accent-cyan-dim); color: var(--accent-cyan); }

  .badge .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  /* ─── Table ─── */
  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .data-table th {
    text-align: left;
    padding: 10px 16px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    font-weight: 500;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }

  .data-table td {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
    vertical-align: middle;
  }

  .data-table tr:last-child td { border-bottom: none; }

  .data-table tr:hover td {
    background: var(--bg-elevated);
  }

  .data-table .mono {
    font-family: var(--font-mono);
    font-size: 12px;
  }

  /* ─── Deployment Cards ─── */
  .deploy-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    margin-bottom: 12px;
    display: flex;
    align-items: flex-start;
    gap: 16px;
  }

  .deploy-card .deploy-icon {
    width: 40px;
    height: 40px;
    border-radius: var(--radius);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    flex-shrink: 0;
  }

  .deploy-card .deploy-info { flex: 1; min-width: 0; }

  .deploy-card .deploy-info h4 {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 2px;
  }

  .deploy-card .deploy-info p {
    font-size: 12px;
    color: var(--text-tertiary);
    margin-bottom: 10px;
  }

  .deploy-card .deploy-url {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--accent-blue);
    background: var(--accent-blue-dim);
    padding: 6px 10px;
    border-radius: 6px;
    display: inline-block;
  }

  .deploy-card .deploy-routes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
  }

  .deploy-card .route-chip {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }

  /* ─── Env Editor ─── */
  .env-editor {
    margin-bottom: 16px;
  }

  .env-row {
    display: grid;
    grid-template-columns: 200px 1fr 36px;
    gap: 8px;
    margin-bottom: 6px;
    align-items: center;
  }

  .env-row input {
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 8px 12px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-primary);
    outline: none;
    transition: border-color var(--transition);
  }

  .env-row input:focus {
    border-color: var(--border-focus);
  }

  .env-row input.env-key {
    font-weight: 500;
    text-transform: uppercase;
  }

  .env-row input.env-value {
    color: var(--accent);
  }

  .env-btn {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 14px;
    transition: all var(--transition);
  }

  .env-btn:hover { background: var(--accent-red-dim); color: var(--accent-red); border-color: transparent; }

  .btn {
    padding: 8px 16px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition);
  }

  .btn:hover { background: var(--bg-card); }

  .btn-primary {
    background: var(--text-primary);
    color: var(--bg-root);
    border-color: transparent;
  }

  .btn-primary:hover { opacity: 0.9; background: var(--text-primary); }

  .btn-group {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  /* ─── Domain Section ─── */
  .domain-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .domain-card:last-child { border-bottom: none; }

  .domain-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .domain-info .domain-type {
    font-size: 11px;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
    width: 80px;
  }

  .domain-info .domain-url {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-primary);
  }

  .domain-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-tertiary);
  }

  /* ─── Animations ─── */
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .fade-in {
    animation: fadeIn 0.3s ease-out forwards;
    opacity: 0;
  }

  .fade-in:nth-child(1) { animation-delay: 0ms; }
  .fade-in:nth-child(2) { animation-delay: 50ms; }
  .fade-in:nth-child(3) { animation-delay: 100ms; }
  .fade-in:nth-child(4) { animation-delay: 150ms; }
  .fade-in:nth-child(5) { animation-delay: 200ms; }
  .fade-in:nth-child(6) { animation-delay: 250ms; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .pulse { animation: pulse 2s infinite; }

  /* ─── Toast ─── */
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 20px;
    font-size: 13px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    z-index: 10000;
    transform: translateY(80px);
    opacity: 0;
    transition: all 0.3s ease;
  }

  .toast.show {
    transform: translateY(0);
    opacity: 1;
  }

  .hidden { display: none !important; }
  .empty-state {
    text-align: center;
    padding: 40px 20px;
    color: var(--text-tertiary);
    font-size: 13px;
  }
</style>
</head>
<body>

<div class="layout">
  <!-- Sidebar -->
  <nav class="sidebar">
    <div class="sidebar-logo">
      <h1><span class="logo-mark">t</span> then</h1>
      <div class="project-name" id="projectName">loading...</div>
    </div>

    <div class="nav-section">
      <div class="nav-section-label">Overview</div>
      <div class="nav-item active" data-page="overview">
        <span class="nav-icon">◫</span> Overview
      </div>
      <div class="nav-item" data-page="deployments">
        <span class="nav-icon">▲</span> Deployments
      </div>
      <div class="nav-item" data-page="routes">
        <span class="nav-icon">⑂</span> Routes
      </div>
    </div>

    <div class="nav-section">
      <div class="nav-section-label">Settings</div>
      <div class="nav-item" data-page="env">
        <span class="nav-icon">⎋</span> Environment
      </div>
      <div class="nav-item" data-page="domains">
        <span class="nav-icon">◎</span> Domains
      </div>
    </div>

    <div class="sidebar-footer">
      <div class="system-info" id="systemInfo">loading...</div>
    </div>
  </nav>

  <!-- Main Content -->
  <main class="main" id="mainContent">
    <!-- Pages rendered by JS -->
  </main>
</div>

<div class="toast" id="toast"></div>

<script>
const API = '/__admin/api';
const ADMIN_TOKEN = '__THEN_ADMIN_TOKEN__';
let state = { project: null, manifest: null, deployments: null, env: null };
let currentPage = 'overview';
const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function h(value) { return String(value ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPE[ch]); }


// ─── Data Fetching ───
function adminFetch(path, options = {}) {
  return fetch(API + path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-Then-Admin-Token': ADMIN_TOKEN,
    },
  });
}

async function fetchAll() {
  const [project, manifest, deployments, env] = await Promise.all([
    adminFetch('/project').then(r => r.json()),
    adminFetch('/manifest').then(r => r.json()),
    adminFetch('/deployments').then(r => r.json()),
    adminFetch('/env').then(r => r.json()),
  ]);
  state = { project, manifest, deployments, env };
  document.getElementById('projectName').textContent = project.name;
  document.getElementById('systemInfo').textContent =
    'Node ' + project.nodeVersion + ' · ' + project.platform;
  renderPage(currentPage);
}

// ─── Navigation ───
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    currentPage = item.dataset.page;
    renderPage(currentPage);
  });
});

// ─── Toast ───
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ─── Page Renderer ───
function renderPage(page) {
  const main = document.getElementById('mainContent');
  const renderers = { overview: renderOverview, deployments: renderDeployments, routes: renderRoutes, env: renderEnv, domains: renderDomains };
  main.innerHTML = (renderers[page] || renderOverview)();
  bindPageEvents(page);
}

// ─── Overview ───
function renderOverview() {
  const p = state.project;
  const m = state.manifest;
  if (!p || !m) return '<div class="empty-state">Loading...</div>';

  const apiCount = m.api.length;
  const pageCount = m.pages.length;
  const serverless = m.api.filter(r => r.kind === 'serverless').length;
  const hot = m.api.filter(r => r.kind === 'hot').length;
  const tasks = m.api.filter(r => r.kind === 'task').length;

  return \`
    <div class="page-header">
      <h2>\${h(p.name)}</h2>
      <p>\${h(p.root)}</p>
    </div>

    <div class="stats-grid">
      <div class="stat-card fade-in">
        <div class="stat-label">API Routes</div>
        <div class="stat-value">\${apiCount}</div>
        <div class="stat-detail">\${serverless} serverless · \${hot} hot · \${tasks} task</div>
      </div>
      <div class="stat-card fade-in">
        <div class="stat-label">Pages</div>
        <div class="stat-value">\${pageCount}</div>
        <div class="stat-detail">\${m.pages.filter(p=>p.mode==='static').length} static · \${m.pages.filter(p=>p.mode==='server').length} server</div>
      </div>
      <div class="stat-card fade-in">
        <div class="stat-label">Last Build</div>
        <div class="stat-value" style="font-size:16px">\${p.lastBuild ? new Date(p.lastBuild).toLocaleString() : '—'}</div>
        <div class="stat-detail">\${p.hasServerEntry ? 'server entry ready' : 'not built'}</div>
      </div>
      <div class="stat-card fade-in">
        <div class="stat-label">Adapter</div>
        <div class="stat-value" style="font-size:16px">\${h(p.adapter || 'None')}</div>
        <div class="stat-detail">\${h(Object.entries(p.adapterOutput).filter(([,v])=>v).map(([k])=>k).join(', ') || 'no adapter output')}</div>
      </div>
    </div>

    <div class="card fade-in">
      <div class="card-header">
        <h3>Build Output</h3>
        <span class="badge \${p.hasServerEntry ? 'badge-green' : 'badge-red'}"><span class="dot"></span> \${p.hasServerEntry ? 'Ready' : 'Not Built'}</span>
      </div>
      <div class="card-body">
        <table class="data-table">
          <tr><td class="mono">dist/server/entry.js</td><td>\${p.hasServerEntry ? '<span class="badge badge-green">exists</span>' : '<span class="badge badge-red">missing</span>'}</td></tr>
          <tr><td class="mono">dist/functions/</td><td>\${p.hasFunctions ? '<span class="badge badge-green">' + p.functionCount + ' bundles</span>' : '<span class="badge badge-amber">empty</span>'}</td></tr>
          <tr><td class="mono">dist/static/</td><td>\${p.hasStatic ? '<span class="badge badge-green">' + p.staticPageCount + ' pages</span>' : '<span class="badge badge-amber">none</span>'}</td></tr>
          \${p.taskEntryCount > 0 ? '<tr><td class="mono">dist/functions/task_*</td><td><span class="badge badge-purple">' + p.taskEntryCount + ' task entries</span></td></tr>' : ''}
        </table>
      </div>
    </div>

    <div class="card fade-in">
      <div class="card-header">
        <h3>Quick Actions</h3>
      </div>
      <div class="card-body">
        <div class="btn-group">
          <button class="btn" onclick="navigator.clipboard.writeText('then build').then(()=>showToast('Copied: then build'))">Copy Build Command</button>
          <button class="btn" onclick="navigator.clipboard.writeText('then dev').then(()=>showToast('Copied: then dev'))">Copy Dev Command</button>
          <button class="btn" onclick="fetchAll().then(()=>showToast('Refreshed'))">Refresh Data</button>
        </div>
      </div>
    </div>
  \`;
}

// ─── Deployments ───
function renderDeployments() {
  const deps = state.deployments || [];
  if (deps.length === 0) return '<div class="page-header"><h2>Deployments</h2><p>No deployment targets found. Run <code>then build</code> first.</p></div>';

  const iconMap = { 'hot-server': '●', 'static': '◆', 'serverless': 'λ', 'tasks': '⏳' };
  const colorMap = { 'hot-server': 'var(--accent)', 'static': 'var(--accent-blue)', 'serverless': 'var(--accent-amber)', 'tasks': 'var(--accent-purple)' };
  const bgMap = { 'hot-server': 'var(--accent-dim)', 'static': 'var(--accent-blue-dim)', 'serverless': 'var(--accent-amber-dim)', 'tasks': 'var(--accent-purple-dim)' };

  return \`
    <div class="page-header">
      <h2>Deployments</h2>
      <p>Your application deployment targets and their status</p>
    </div>
    \${deps.map((d, i) => \`
      <div class="deploy-card fade-in" style="animation-delay: \${i * 60}ms">
        <div class="deploy-icon" style="background: \${bgMap[d.type]}; color: \${colorMap[d.type]}">\${iconMap[d.type] || '?'}</div>
        <div class="deploy-info">
          <h4>\${h(d.label)}</h4>
          <p>\${h(d.description)}</p>
          \${d.url ? '<div class="deploy-url">' + h(d.url) + '</div>' : ''}
          \${d.directory ? '<div class="deploy-url" style="background: var(--bg-elevated); color: var(--text-secondary)">' + h(d.directory) + '</div>' : ''}
          \${d.routes ? '<div class="deploy-routes">' + d.routes.map(r => '<span class="route-chip">' + r.methods.map(h).join(',') + ' ' + h(r.pattern) + '</span>').join('') + '</div>' : ''}
          \${d.pages ? '<div class="deploy-routes">' + d.pages.map(p => '<span class="route-chip">' + h(p) + '</span>').join('') + '</div>' : ''}
          \${d.functions ? '<div class="deploy-routes">' + d.functions.map(f => '<span class="route-chip">' + f.methods.map(h).join(',') + ' ' + h(f.pattern) + '</span>').join('') + '</div>' : ''}
          \${d.tasks ? '<div class="deploy-routes">' + d.tasks.map(t => '<span class="route-chip">' + h(t.pattern) + (t.schedule ? ' (' + h(t.schedule) + ')' : '') + '</span>').join('') + '</div>' : ''}
        </div>
        <span class="badge badge-green"><span class="dot"></span> \${h(d.status)}</span>
      </div>
    \`).join('')}
  \`;
}

// ─── Routes ───
function renderRoutes() {
  const m = state.manifest;
  if (!m) return '';

  const kindBadge = (k) => ({ serverless: 'badge-amber', hot: 'badge-green', task: 'badge-purple' }[k] || 'badge-blue');
  const modeBadge = (mode) => ({ static: 'badge-blue', server: 'badge-green', client: 'badge-amber', hybrid: 'badge-cyan' }[mode] || 'badge-blue');

  return \`
    <div class="page-header">
      <h2>Routes</h2>
      <p>All registered API routes and pages in your project</p>
    </div>

    <div class="card fade-in">
      <div class="card-header">
        <h3>API Routes</h3>
        <span class="badge badge-blue">\${m.api.length} routes</span>
      </div>
      <table class="data-table">
        <thead><tr><th>Pattern</th><th>Methods</th><th>Kind</th><th>File</th></tr></thead>
        <tbody>
          \${m.api.map(r => \`<tr>
            <td class="mono">\${h(r.urlPattern)}</td>
            <td>\${r.methods.map(m => '<span class="badge badge-blue">' + h(m) + '</span> ').join('')}</td>
            <td><span class="badge \${kindBadge(r.kind)}">\${h(r.kind)}</span></td>
            <td class="mono" style="color: var(--text-tertiary); font-size: 11px">\${h(r.filePath)}</td>
          </tr>\`).join('')}
        </tbody>
      </table>
    </div>

    <div class="card fade-in">
      <div class="card-header">
        <h3>Pages</h3>
        <span class="badge badge-blue">\${m.pages.length} pages</span>
      </div>
      <table class="data-table">
        <thead><tr><th>Pattern</th><th>Mode</th><th>SSR Data</th><th>File</th></tr></thead>
        <tbody>
          \${m.pages.map(p => \`<tr>
            <td class="mono">\${h(p.urlPattern)}</td>
            <td><span class="badge \${modeBadge(p.mode)}">\${h(p.mode)}</span></td>
            <td>\${p.hasGetServerData ? '<span class="badge badge-green">getServerData</span>' : '<span style="color: var(--text-tertiary)">—</span>'}</td>
            <td class="mono" style="color: var(--text-tertiary); font-size: 11px">\${h(p.filePath)}</td>
          </tr>\`).join('')}
        </tbody>
      </table>
    </div>
  \`;
}

// ─── Environment ───
function renderEnv() {
  const e = state.env || { env: [], envLocal: [], rawEnv: '', rawEnvLocal: '' };

  const renderVars = (vars, file) => vars.map((v, i) => \`
    <div class="env-row">
      <input class="env-key" value="\${h(v.key)}" data-file="\${file}" data-index="\${i}" data-field="key" spellcheck="false">
      <input class="env-value" value="\${h(v.value)}" data-file="\${file}" data-index="\${i}" data-field="value" spellcheck="false" type="\${v.key.includes('SECRET') || v.key.includes('KEY') || v.key.includes('TOKEN') ? 'password' : 'text'}">
      <button class="env-btn" data-remove="\${file}:\${i}" title="Remove">✕</button>
    </div>
  \`).join('');

  return \`
    <div class="page-header">
      <h2>Environment Variables</h2>
      <p>Manage environment variables for your project</p>
    </div>

    <div class="card fade-in">
      <div class="card-header">
        <h3>.env</h3>
        <span class="badge badge-blue">\${e.env.length} variables</span>
      </div>
      <div class="card-body">
        <div class="env-editor" id="envEditor">
          \${renderVars(e.env, '.env')}
        </div>
        <div class="btn-group">
          <button class="btn" id="addEnvBtn">+ Add Variable</button>
          <button class="btn btn-primary" id="saveEnvBtn">Save .env</button>
        </div>
      </div>
    </div>

    <div class="card fade-in">
      <div class="card-header">
        <h3>.env.local</h3>
        <span class="badge badge-amber">\${e.envLocal.length} variables</span>
      </div>
      <div class="card-body">
        <div class="env-editor" id="envLocalEditor">
          \${renderVars(e.envLocal, '.env.local')}
        </div>
        <div class="btn-group">
          <button class="btn" id="addEnvLocalBtn">+ Add Variable</button>
          <button class="btn btn-primary" id="saveEnvLocalBtn">Save .env.local</button>
        </div>
      </div>
    </div>
  \`;
}

function collectEnvVars(containerId) {
  const rows = document.querySelectorAll('#' + containerId + ' .env-row');
  const lines = [];
  rows.forEach(row => {
    const key = row.querySelector('.env-key').value.trim();
    const value = row.querySelector('.env-value').value;
    if (key) lines.push(key + '=' + value);
  });
  return lines.join('\\n') + '\\n';
}

async function saveEnvFile(file, containerId) {
  const content = collectEnvVars(containerId);
  await adminFetch('/env', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, content }),
  });
  showToast('Saved ' + file);
  const envData = await adminFetch('/env').then(r => r.json());
  state.env = envData;
}

// ─── Domains ───
function renderDomains() {
  const p = state.project;
  const m = state.manifest;
  if (!p || !m) return '';

  const hasHot = m.api.some(r => r.kind === 'hot') || m.pages.some(p => p.mode === 'server');
  const hasStatic = m.pages.some(p => p.mode === 'static');
  const hasServerless = m.api.some(r => r.kind === 'serverless');

  return \`
    <div class="page-header">
      <h2>Domains</h2>
      <p>URLs and endpoints for your deployment targets</p>
    </div>

    <div class="card fade-in">
      <div class="card-header">
        <h3>Endpoints</h3>
      </div>
      \${hasHot ? \`
        <div class="domain-card">
          <div class="domain-info">
            <span class="domain-type" style="color: var(--accent)">Backend</span>
            <span class="domain-url">http://localhost:3000</span>
          </div>
          <div class="domain-status"><span class="badge badge-green"><span class="dot pulse"></span> Hot Server</span></div>
        </div>
      \` : ''}
      \${hasStatic ? \`
        <div class="domain-card">
          <div class="domain-info">
            <span class="domain-type" style="color: var(--accent-blue)">Frontend</span>
            <span class="domain-url">dist/static/ → CDN</span>
          </div>
          <div class="domain-status"><span class="badge badge-blue"><span class="dot"></span> Static</span></div>
        </div>
      \` : ''}
      \${hasServerless ? \`
        <div class="domain-card">
          <div class="domain-info">
            <span class="domain-type" style="color: var(--accent-amber)">Functions</span>
            <span class="domain-url">\${p.adapter === 'cloudflare' ? '*.workers.dev' : p.adapter === 'adapter-lambda' ? '*.execute-api.*.amazonaws.com' : 'dist/functions/'}</span>
          </div>
          <div class="domain-status"><span class="badge badge-amber"><span class="dot"></span> Serverless</span></div>
        </div>
      \` : ''}
      \${m.api.filter(r => r.kind === 'task').length > 0 ? \`
        <div class="domain-card">
          <div class="domain-info">
            <span class="domain-type" style="color: var(--accent-purple)">Tasks</span>
            <span class="domain-url">/__tasks/* (internal)</span>
          </div>
          <div class="domain-status"><span class="badge badge-purple"><span class="dot"></span> Protected</span></div>
        </div>
      \` : ''}
    </div>

    <div class="card fade-in">
      <div class="card-header">
        <h3>Server Endpoints</h3>
      </div>
      <table class="data-table">
        <thead><tr><th>Endpoint</th><th>Description</th><th>Status</th></tr></thead>
        <tbody>
          <tr>
            <td class="mono">/__health</td>
            <td style="color: var(--text-secondary)">Health check endpoint</td>
            <td><span class="badge badge-green">active</span></td>
          </tr>
          <tr>
            <td class="mono">/__tasks</td>
            <td style="color: var(--text-secondary)">Task management (auth required)</td>
            <td><span class="badge badge-purple">protected</span></td>
          </tr>
          \${m.pages.filter(p => p.mode === 'server' || p.mode === 'hybrid').map(p => \`
            <tr>
              <td class="mono">\${h(p.urlPattern)}</td>
              <td style="color: var(--text-secondary)">SSR page\${p.hasGetServerData ? ' (getServerData)' : ''}</td>
              <td><span class="badge badge-green">SSR</span></td>
            </tr>
          \`).join('')}
        </tbody>
      </table>
    </div>
  \`;
}

// ─── Event Binding ───
function bindPageEvents(page) {
  if (page === 'env') {
    document.getElementById('addEnvBtn')?.addEventListener('click', () => {
      const editor = document.getElementById('envEditor');
      editor.insertAdjacentHTML('beforeend', \`
        <div class="env-row">
          <input class="env-key" placeholder="KEY" spellcheck="false">
          <input class="env-value" placeholder="value" spellcheck="false">
          <button class="env-btn" onclick="this.parentElement.remove()" title="Remove">✕</button>
        </div>
      \`);
    });

    document.getElementById('addEnvLocalBtn')?.addEventListener('click', () => {
      const editor = document.getElementById('envLocalEditor');
      editor.insertAdjacentHTML('beforeend', \`
        <div class="env-row">
          <input class="env-key" placeholder="KEY" spellcheck="false">
          <input class="env-value" placeholder="value" spellcheck="false">
          <button class="env-btn" onclick="this.parentElement.remove()" title="Remove">✕</button>
        </div>
      \`);
    });

    document.getElementById('saveEnvBtn')?.addEventListener('click', () => saveEnvFile('.env', 'envEditor'));
    document.getElementById('saveEnvLocalBtn')?.addEventListener('click', () => saveEnvFile('.env.local', 'envLocalEditor'));

    document.querySelectorAll('.env-btn[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => btn.parentElement.remove());
    });
  }
}

// ─── Init ───
fetchAll();
setInterval(fetchAll, 30000);
</script>
</body>
</html>`.replace('__THEN_ADMIN_TOKEN__', adminToken);
}
