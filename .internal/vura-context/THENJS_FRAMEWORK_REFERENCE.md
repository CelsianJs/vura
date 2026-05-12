# ThenJS Framework Reference — For Vura Platform Context

> This document provides the complete technical context about ThenJS that the Vura.io
> deployment platform needs to understand. ThenJS is the open-source meta-framework;
> Vura is the closed-source deployment platform built specifically for it.

---

## What ThenJS Is

ThenJS is a meta-framework that combines:
- **What Framework** — Frontend signals+JSX UI library (React-familiar API, signal-based reactivity)
- **CelsianJS** — Backend HTTP framework (req/reply pattern, similar to Fastify)

ThenJS sits on top of both, providing file-based routing, SSR, static generation, serverless deployment, background tasks, and multi-target adapters.

**Analogy**: What Framework is to React as CelsianJS is to Express as ThenJS is to Next.js as **Vura is to Vercel**.

---

## Package Structure

ThenJS is a pnpm monorepo at `~/Desktop/Coding/ZVN/then/`:

| Package | npm Name | Purpose |
|---------|----------|---------|
| `packages/core` | `@celsian/then-core` | Manifest scanner, build pipeline, SSR renderer, task system, route matching |
| `packages/cli` | `@celsian/then-cli` | CLI commands: `then dev`, `then build`, `then deploy`, `then admin`, `then manifest` |
| `packages/vite-plugin` | `@celsian/then-vite-plugin` | Vite integration for dev server with HMR |
| `packages/adapter-cloudflare` | `@celsian/then-adapter-cloudflare` | Generates wrangler.toml + Worker entries |
| `packages/adapter-lambda` | `@celsian/then-adapter-lambda` | Generates SAM template + Lambda handler files |
| `packages/compiler` | `@celsian/then-compiler` | Pure JS route scanner (regex-based, fallback) |
| `packages/compiler-native` | `@celsian/then-compiler-native` | Rust/napi-rs route scanner using swc (fast path) |

---

## The Route Kind System

Every API route declares a `kind` that determines WHERE it deploys:

```typescript
// src/api/hello.ts
export const route = { kind: 'serverless' };  // or 'hot' or 'task'
export async function GET(req, reply) { ... }
```

| Kind | Meaning | Infrastructure Requirement |
|------|---------|---------------------------|
| `serverless` | Stateless, per-request execution | Cloudflare Worker, Lambda, or similar |
| `hot` | Long-running persistent server | Container or VM with health checking |
| `task` | Background job (scheduled or on-demand) | Invoked by scheduler or HTTP trigger |

### Task Routes Have Extra Config

```typescript
export const route = {
  kind: 'task',
  schedule: '*/5 * * * *',  // 5-field cron expression
  retries: 3,
  timeout: 30000,            // milliseconds
};
export async function POST(job) {
  // job = { taskId: string, input: unknown, attempt: number }
  return { result: 'done' };
}
```

---

## The Page Mode System

Every page declares a `mode` that determines HOW it renders:

```tsx
// src/pages/blog/[slug].tsx
export const page = { mode: 'server', title: 'Blog Post', revalidate: 60 };

export async function getServerData({ params, url, query }) {
  return { post: await fetchPost(params.slug) };
}

export default function BlogPost({ post, params }) {
  return <article><h1>{post.title}</h1><p>{post.content}</p></article>;
}
```

| Mode | Meaning | Build Behavior | Runtime Behavior |
|------|---------|----------------|-----------------|
| `static` | Pre-rendered at build time | HTML files in `dist/static/` | Served from CDN |
| `server` | Rendered per-request | Page bundled to `dist/server/pages/` | SSR in hot server, calls `getServerData()` |
| `client` | Minimal shell, JS-rendered | Shell HTML in `dist/static/` | Client-side rendering |
| `hybrid` | Static shell + island hydration | Pre-rendered with island markers | Partial hydration on client |

### ISR (Incremental Static Regeneration)

Server-mode pages with `revalidate` config get ISR:
```typescript
export const page = { mode: 'server', revalidate: 60 }; // seconds
```
- First request: full render, cached
- Subsequent requests: serve from cache
- After `revalidate` seconds: serve stale, background re-render
- Cache is per-URL (including query params)

---

## Build Output Structure

Running `then build` produces:

```
dist/
├── server/
│   ├── entry.js          ← Self-contained Node.js HTTP server
│   └── pages/            ← Bundled server-mode page modules
│       ├── blog/[slug].js
│       └── profile/[username].js
├── functions/
│   ├── api_hello/        ← One bundle per serverless route
│   │   └── index.js
│   ├── task_api_tasks_cleanup/  ← One bundle per task route
│   │   └── index.js
│   └── ...
├── static/
│   ├── index.html        ← Pre-rendered static pages
│   └── about/index.html
└── manifest.json         ← Complete route manifest
```

### The Server Entry (`dist/server/entry.js`)

This is the crown jewel. It's a **completely self-contained** Node.js HTTP server with:
- Zero external dependencies (no `node_modules` needed at runtime for the entry itself)
- Inline route matching (regex-based pattern matcher)
- Inline body parser (with 1MB size limit)
- Inline SSR renderer (`renderToString` that handles What Framework vnodes)
- Inline ISR cache (LRU, max 1000 entries, revalidation dedup)
- Inline task queue (with concurrency guard, exponential backoff retries)
- Inline cron scheduler (with double-fire prevention)
- Health check endpoint at `/__health`
- Task management endpoints at `/__tasks/*` (protected by `THEN_TASK_SECRET`)

It imports the actual route handler modules and page modules.

**For Vura**: This entry.js is what runs inside the hot server container. No build step needed at runtime — just `node dist/server/entry.js`.

### Function Entries (`dist/functions/*/index.js`)

Each serverless function entry is a self-contained Worker-compatible module:
```javascript
export default {
  async fetch(request) {
    // ... inline body parsing, route handling, response building
  }
}
```

**For Vura**: These can be deployed directly as Cloudflare Workers.

### Task Entries (`dist/functions/task_*/index.js`)

Similar to function entries but with timeout enforcement and the task handler signature.

**For Vura**: These are the targets for cron scheduler HTTP calls.

---

## The Manifest (`dist/manifest.json`)

```json
{
  "api": [
    {
      "filePath": "src/api/users/[id].ts",
      "urlPattern": "/api/users/:id",
      "methods": ["GET", "POST"],
      "kind": "serverless",
      "config": {}
    },
    {
      "filePath": "src/api/tasks/cleanup.ts",
      "urlPattern": "/api/tasks/cleanup",
      "methods": ["POST"],
      "kind": "task",
      "config": { "kind": "task", "schedule": "0 2 * * *", "retries": 3, "timeout": 60000 }
    }
  ],
  "pages": [
    {
      "filePath": "src/pages/blog/[slug].tsx",
      "urlPattern": "/blog/:slug",
      "mode": "server",
      "hasGetServerData": true,
      "config": { "mode": "server", "revalidate": 60 }
    }
  ],
  "timestamp": "2026-03-14T02:54:20.005Z"
}
```

**For Vura**: The manifest is the source of truth for what to deploy where. Vura reads it after the build to:
1. Know which routes are serverless vs hot vs task
2. Know which pages are static vs server-rendered
3. Extract cron schedules for task routes
4. Map URL patterns for the edge router

---

## The Adapter Interface

ThenJS has a plugin system for deployment targets:

```typescript
export interface ThenAdapter {
  name: string;
  buildEnd(ctx: AdapterBuildContext): Promise<void>;
}

export interface AdapterBuildContext {
  serverEntry: string;       // path to dist/server/entry.js
  clientDir: string;         // path to dist/client/
  manifest: RouteManifest;   // the full route manifest
  projectRoot: string;       // the project root
  outDir: string;            // the dist/ directory
}
```

Adapters run after `then build` and produce platform-specific output:
- `@celsian/then-adapter-cloudflare` → `dist/cloudflare/wrangler.toml` + `entry.js`
- `@celsian/then-adapter-lambda` → `dist/template.yaml` + `dist/lambda/*/index.js`
- `@celsian/then-adapter-vura` → packages dist/ and POSTs to `api.vura.io` (to be built)

Config in `then.config.ts`:
```typescript
import { defineConfig } from '@celsian/then-core';
import { vuraAdapter } from '@celsian/then-adapter-vura';

export default defineConfig({
  adapter: vuraAdapter({ team: 'my-team' }),
});
```

---

## Request/Reply Pattern

ThenJS API routes use the CelsianJS req/reply pattern:

```typescript
export async function GET(req: ThenRequest, reply: ThenReply) {
  const userId = req.params.id;
  const data = req.parsedBody;
  return reply.status(200).json({ user: userId });
}
```

```typescript
interface ThenRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;     // URL params like :id
  query: Record<string, string>;      // Query string params
  parsedBody: unknown;                 // Parsed JSON/form body
}

interface ThenReply {
  status(code: number): ThenReply;
  header(name: string, value: string): ThenReply;
  json(data: unknown): null;
  send(data: string): null;
}
```

---

## What Framework VNodes

What Framework's JSX produces vnodes in the format:
```javascript
{ tag: 'div', props: { className: 'foo' }, children: [...] }
```

Note: `tag` not `type` (React uses `type`). The SSR renderer handles both:
```javascript
const type = vnode.type || vnode.tag;
```

Fragment is `Symbol.for('Fragment')` — the renderer checks `typeof type === 'symbol'`.

---

## File-Based Routing Convention

```
src/
├── api/                              ← API routes
│   ├── health.ts                    → GET /api/health
│   ├── users/
│   │   ├── index.ts                 → /api/users
│   │   └── [id].ts                  → /api/users/:id
│   └── tasks/
│       └── cleanup.ts               → /api/tasks/cleanup
└── pages/                            ← Pages
    ├── index.tsx                     → /
    ├── about.tsx                     → /about
    ├── blog/
    │   └── [slug].tsx               → /blog/:slug
    └── dashboard.tsx                → /dashboard
```

- `[param]` → `:param` (dynamic segment)
- `[...param]` → `*param` (catch-all)
- `(group)/` → removed from URL (route groups)
- `_private/` → skipped (underscore prefix)

---

## Current Test Coverage

- 132 unit tests across 9 test files (all passing)
- Integration test suite with 12 runtime tests (build + server + curl)
- Adapter verification: 28 tests (Cloudflare + Lambda)
- Task system deep test: 49 assertions

---

## Security Features in Generated Code

These were added during the Phase A-C review cycle and are important for Vura to understand:

1. **Body size limit**: 1MB max, `req.destroy()` on overflow
2. **Task endpoint auth**: `THEN_TASK_SECRET` env var or localhost-only
3. **XSS prevention**: `escapeHtml` includes single-quote (`&#39;`)
4. **Safe URI decoding**: `decodeURIComponent` wrapped in try/catch
5. **ISR cache**: LRU eviction (max 1000), revalidation dedup, query params in key
6. **Task results**: Eviction at 10,000 entries
7. **Timer safety**: `clearTimeout` on `Promise.race` success
8. **Cron safety**: Double-fire prevention via last-fired tracking
9. **Fragment rendering**: Handles `Symbol.for('Fragment')` correctly
10. **No stack traces**: Error responses don't leak internals
