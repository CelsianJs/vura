# Vura.io — Product Context

> This document provides the product-level context for Vura.io — what it is, how it
> relates to the ThenJS ecosystem, and the key decisions already made.

---

## The Ecosystem

```
┌──────────────────────────────────────────────────────┐
│                    Open Source                         │
│                                                       │
│  What Framework ──► CelsianJS ──► ThenJS              │
│  (frontend)        (backend)      (meta-framework)    │
│                                                       │
│  Packages:                                            │
│    @then/core, @then/cli, @then/vite-plugin          │
│    @then/adapter-cloudflare, @then/adapter-lambda    │
│    @then/adapter-vura (to be built)                  │
│    @then/compiler, @then/compiler-native             │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│                   Closed Source                        │
│                                                       │
│  Vura.io — Deployment Platform                        │
│  "Vercel for ThenJS"                                  │
│                                                       │
│  app.vura.io    — Dashboard                           │
│  api.vura.io    — Platform API                        │
│  *.vura.app     — Preview deployment URLs             │
│  vura.io        — Marketing site                      │
└──────────────────────────────────────────────────────┘
```

## What Vura Does (Scope)

Vura handles the **must-haves** of a modern deployment platform. Nothing exotic.

### Core Features (MVP)
- Multi-project management with git-linked repos
- Push-to-deploy from GitHub (GitLab later)
- Preview deployments per branch/PR with unique URLs
- Production deployments (auto from main, or promote from preview)
- Build pipeline: clone → install → `then build` → deploy artifacts
- Environment variables (production/preview/development scopes)
- Custom domains with auto-SSL
- Instant rollbacks to any previous deployment
- Build logs (real-time streaming)

### Architecture-Dependent Features
- Hot server management (persistent containers for `kind: 'hot'` routes)
- Serverless function deployment (for `kind: 'serverless'` routes)
- Task worker execution + cron scheduling (for `kind: 'task'` routes)
- Static page CDN serving
- ISR support (server-mode pages with `revalidate`)

### Planned Later (Design Data Model Now)
- Request analytics (volume, latency, status codes per route)
- Runtime logs (function invocation logs, hot server stdout/stderr)
- Error tracking (capture and surface runtime errors)
- Usage metering (bandwidth, invocations, build minutes — for billing)
- Team management with roles

### Explicitly Not Building
- AI features
- Edge middleware / edge functions (separate from serverless)
- Serverless databases (users bring their own)
- Image optimization CDN
- Web analytics / visitor tracking
- Marketplace or integrations platform
- Monorepo support (single project per repo for now)

---

## Key Architectural Decisions (Already Made)

These decisions are documented in `VURA_ARCHITECTURE.md`:

### 1. Infrastructure Split
| Component | Technology | Why |
|-----------|-----------|-----|
| Edge Router | Cloudflare Worker | Global, fast, routes all incoming traffic |
| API Server | CelsianJS on Fly.io | Dogfooding our own backend framework |
| Build Workers | Ephemeral Fly Machines | Isolated builds, scale to zero |
| Serverless Runtime | Cloudflare Workers | ThenJS function entries are already Worker-compatible |
| Hot Server Pool | Persistent Fly Machines | Containers for long-running Node.js servers |
| Static CDN | Cloudflare R2 + Cache | Edge-cached static pages and assets |
| Task Workers | Cloudflare Workers | Invoked by Vura's cron scheduler |
| Database | Neon (serverless Postgres) | Scales, serverless-friendly |
| Cache/Queue | Upstash Redis | BullMQ for build queue, rate limiting |
| Artifact Store | Cloudflare R2 | Store built deployment bundles |
| Dashboard | What Framework SPA | Dogfooding our own frontend framework |

### 2. Hot Server Preview Strategy
- **Production**: Always-on Fly Machines, health-checked
- **Preview**: On-demand Fly Machines with scale-to-zero after 5min idle
- **Free tier preview**: Hot routes return 503 with upgrade prompt
- Cold start: ~2-4 seconds (Node.js alpine)

### 3. Deployment Model
- Each deployment is immutable — a snapshot of build artifacts + env vars
- Deployments are linked to a git commit SHA
- Production deployment = current alias of a deployment
- Rollback = re-alias production to a previous deployment (instant)

### 4. Domain Architecture
- Vura owns IP addresses for A/AAAA records
- Users add CNAME to `cname.vura.app` or A record to Vura IPs
- SSL via Cloudflare for SaaS or Let's Encrypt
- Preview URLs: `<branch>--<project>.vura.app`

---

## How ThenJS's Build Output Maps to Vura

This is the critical integration point:

```
then build output              Vura deployment target
─────────────────              ─────────────────────
dist/server/entry.js      ──►  Fly Machine (hot server container)
dist/server/pages/*.js    ──►  Bundled INTO the hot server container
dist/functions/*/index.js ──►  Individual Cloudflare Workers
dist/functions/task_*     ──►  CF Workers + cron_jobs table entries
dist/static/**/*.html     ──►  R2 bucket → CDN edge
dist/manifest.json        ──►  Parsed by Vura to configure routing
```

The `@then/adapter-vura` package (to be built, lives in the ThenJS repo) will:
1. Package `dist/` into a tarball
2. POST it to `api.vura.io/v1/deployments`
3. Stream deployment logs back to the CLI

---

## Git Repository Layout

The Vura platform will be its own repo (closed-source). Suggested structure:

```
vura/
├── apps/
│   ├── api/              ← CelsianJS API server (api.vura.io)
│   ├── dashboard/        ← What Framework SPA (app.vura.io)
│   ├── edge-router/      ← Cloudflare Worker (routes all traffic)
│   ├── build-worker/     ← Runs inside ephemeral build machines
│   └── marketing/        ← vura.io landing page
├── packages/
│   ├── database/         ← Prisma/Drizzle schema + migrations
│   ├── shared/           ← Shared types, utils
│   └── sdk/              ← Vura JS SDK (for CLI integration)
├── infra/
│   ├── fly/              ← Fly.io config (API server, build workers)
│   ├── cloudflare/       ← Worker configs, R2 setup
│   └── terraform/        ← Infrastructure as code
└── docs/
    └── architecture.md   ← Copy of VURA_ARCHITECTURE.md
```

Meanwhile, the open-source ThenJS repo gets a new package:
```
then/packages/adapter-vura/   ← @then/adapter-vura (open-source)
```

---

## Environment & Credentials

### Vura Platform Needs
- Cloudflare API token (Workers, R2, DNS)
- Fly.io API token (Machines)
- GitHub App credentials (webhooks, OAuth)
- Neon database connection string
- Upstash Redis credentials
- Let's Encrypt / Cloudflare SSL config
- Stripe API keys (for billing, later)

### User-Facing Environment
- Users set env vars per-project in the Vura dashboard
- Scoped: `production`, `preview`, `development`
- Injected at build time AND runtime
- Encrypted at rest in Postgres

---

## Relationship to Other Sessions / Projects

- **What Framework**: `~/Desktop/Coding/ZVN/what-fw/` — The frontend library
- **ThenJS**: `~/Desktop/Coding/ZVN/then/` — The meta-framework (this repo)
- **CelsianJS**: Backend framework used by ThenJS routes
- **Vura**: New repo to be created — the deployment platform
- **GitHub org**: CelsianJs (for open-source packages)

The `VURA_ARCHITECTURE.md` file in the ThenJS repo contains the full 1,581-line
technical architecture with data models, API design, build pipeline flows, etc.
That document should be the primary reference when building Vura.
