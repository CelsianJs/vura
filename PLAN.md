# ThenJS — Open Source Meta-Framework

> **ThenJS** is the open-source meta-framework (like Next.js).
> **Celsian** ([github.com/CelsianJs/celsian](https://github.com/CelsianJs/celsian), private) is the deployment platform (like Vercel).
>
> ThenJS provides the build pipeline, routing, and adapters.
> Celsian provides managed deployment, edge routing, scaling, previews, and analytics.
>
> Users can deploy ThenJS apps anywhere using the open-source adapters, or use
> Celsian for a fully managed experience.

---

## The Big Picture

ThenJS is a full-stack meta-framework that combines:
- **What Framework** (frontend) — signal-based UI with JSX, SSR, islands architecture
- **CelsianJS** (backend) — lightweight backend framework with req/reply, plugins, WebSocket, tasks/cron
- **ThenJS** (this repo) — glues them together with file-based routing, build pipeline, and provider adapters

### Deployment Options
- **Celsian (managed)** — `then deploy` or connect your GitHub repo at [celsian.dev](https://celsian.dev)
- **Self-hosted Cloudflare** — use `@celsian/then-adapter-cloudflare` with your own Cloudflare account
- **Self-hosted AWS Lambda** — use `@celsian/then-adapter-lambda` with your own AWS account
- **Any Node.js server** — use the built output directly

---

## Architecture

### Route System

#### API Route Kinds
| Kind | Where it runs | Use case |
|------|---------------|----------|
| `serverless` | CF Workers / Lambda | Stateless, auto-scaling, pay-per-request |
| `hot` | Persistent server | WebSocket, long-running, stateful, cron/tasks |
| `task` | Background worker | Async jobs, email, processing |

#### Page Modes
| Mode | Rendering | Use case |
|------|-----------|----------|
| `static` | Build-time HTML | Marketing, docs, blog |
| `server` | Per-request SSR | Dynamic data, personalized |
| `client` | SPA (JS-only) | Dashboards, admin panels |
| `hybrid` | Static shell + islands | Best of both worlds (PPR) |

### File-Based Routing
```
src/
  api/
    hello.ts              -> GET /api/hello        (serverless)
    users/
      index.ts            -> GET/POST /api/users   (serverless)
      [id].ts             -> GET /api/users/:id    (hot)
    ws/
      chat.ts             -> WS /api/ws/chat       (hot)
  pages/
    index.tsx             -> /                      (static)
    about.tsx             -> /about                 (static)
    dashboard/
      index.tsx           -> /dashboard             (client)
    blog/
      [slug].tsx          -> /blog/:slug            (server)
```

### Handler Pattern (CelsianJS-compatible)
```typescript
// src/api/users/[id].ts
export const route = { kind: 'hot' };

export function GET(req, reply) {
  const { id } = req.params;
  return reply.json({ id, name: `User ${id}` });
}

export function DELETE(req, reply) {
  return reply.status(204).send('');
}
```

### Page Pattern (What Framework JSX)
```tsx
// src/pages/index.tsx — ALWAYS use JSX, never h()
import { useSignal } from 'what-framework';

export const page = { mode: 'static', title: 'Home' };

export default function HomePage() {
  return (
    <div>
      <h1>Welcome to My App</h1>
      <p>Built with ThenJS + What Framework</p>
    </div>
  );
}
```

> **IMPORTANT**: Pages use JSX via `jsxImportSource: "what-framework"`.
> The h() function is an internal compiler detail — users should NEVER call it directly.
> The What Framework compiler transforms JSX into optimized fine-grained DOM operations.

---

## Phases

### Phase 1 — Foundation (DONE)
- [x] Route manifest scanner (regex-based, 19 tests)
- [x] Build pipeline (server entry + function bundles)
- [x] CLI: `then manifest`, `then build`, `then deploy`
- [x] CF Workers deployment via adapter
- [x] Lambda deployment via adapter
- [x] Dev server (`then dev` with on-the-fly TS compilation)
- [x] Static page generation (VNode -> HTML at build time)
- [x] Vite plugin (API route middleware + file watching)
- [x] CelsianJS-compatible req/reply shim for workers
- [x] 64 tests passing

### Phase 2 — Multi-Provider & Backend-Only (CURRENT)
- [ ] **CelsianJS backend-only deployment** — pure API projects, no pages required
- [ ] **Real What Framework integration** — JSX pages with compiler, not manual h()
- [ ] **Provider adapter improvements** — better error messages, dry-run support
- [ ] **Create-then scaffolding** — `npm create then@latest`

### Phase 3 — Production Readiness
- [ ] **Build cache** — incremental builds, shared artifact cache
- [ ] **Edge middleware** — user-defined middleware (auth, redirects)
- [ ] **Chunked server HTML** — full HTML emitted in chunks for server pages marked `stream`; not progressive SSR
- [ ] **API versioning** — route-level version management

---

## Key Decisions

1. **JSX only** — Pages always use JSX with `jsxImportSource: "what-framework"`. Never expose h() to users.
2. **CelsianJS req/reply** — All handlers use the same API whether serverless or hot.
3. **esbuild for bundling** — Fast, zero-config, handles TS/JSX natively.
4. **Backend-only is first-class** — CelsianJS apps without any frontend deploy through the same pipeline.
5. **Open adapters** — Users can deploy anywhere without Celsian. Adapters are open source.

---

## Monorepo Structure

```
packages/
  core/                  — manifest scanner, build pipeline, config, static renderer
  cli/                   — then manifest, then build, then deploy, then dev
  vite-plugin/           — Vite middleware for API routes + HMR
  adapter-cloudflare/    — CF Workers adapter (open source)
  adapter-lambda/        — AWS Lambda adapter (open source)
  create-then/           — (TODO) project scaffolding
examples/
  serverless-poc/        — 4 API routes + 2 static pages (proven working)
```
