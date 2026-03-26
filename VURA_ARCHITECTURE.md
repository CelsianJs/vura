# Vura.io — Architecture Document

> **Vura.io** is a closed-source deployment platform purpose-built for the ThenJS meta-framework ecosystem.
> ThenJS is the open-source meta-framework (like Next.js). Vura is the managed platform (like Vercel).
>
> Domain: vura.io (owned)
> Dashboard: app.vura.io
> Preview URLs: *.vura.app
> API: api.vura.io

---

## 1. System Overview

### High-Level Architecture

```
                                    ┌─────────────────────────────────────────────┐
                                    │              Vura Control Plane              │
                                    │                                             │
  ┌──────────┐    ┌──────────┐      │  ┌───────────┐  ┌───────────┐  ┌────────┐  │
  │  GitHub   │───▶│ Webhook  │─────▶│  │  Build    │  │  Deploy   │  │  API   │  │
  │  GitLab   │    │ Receiver │      │  │  Queue    │  │  Engine   │  │ Server │  │
  └──────────┘    └──────────┘      │  └─────┬─────┘  └─────┬─────┘  └────┬───┘  │
                                    │        │              │              │       │
  ┌──────────┐                      │  ┌─────▼─────┐  ┌─────▼─────┐      │       │
  │ CLI      │──────────────────────│──│  Build    │  │  Artifact │      │       │
  │ then     │                      │  │  Workers  │  │  Store    │      │       │
  └──────────┘                      │  └───────────┘  └───────────┘      │       │
                                    │                                     │       │
  ┌──────────┐                      │  ┌──────────────────────────────────┤       │
  │ Dashboard│──────────────────────│──│         PostgreSQL               │       │
  │ app.vura │                      │  │  (projects, deployments, users)  │       │
  └──────────┘                      │  └──────────────────────────────────┘       │
                                    └─────────────────────────────────────────────┘

                                    ┌─────────────────────────────────────────────┐
                                    │              Vura Data Plane                 │
                                    │                                             │
  ┌──────────┐                      │  ┌───────────┐  ┌───────────┐  ┌────────┐  │
  │ Incoming │─────────────────────▶│  │  Edge     │  │  Static   │  │ Hot    │  │
  │ Request  │                      │  │  Router   │  │  CDN      │  │ Server │  │
  └──────────┘                      │  │  (CF Wkr) │  │  (R2/S3)  │  │ Pool   │  │
                                    │  └─────┬─────┘  └───────────┘  └────────┘  │
                                    │        │                                    │
                                    │  ┌─────▼─────┐  ┌───────────┐  ┌────────┐  │
                                    │  │ Serverless│  │  Task     │  │ Cron   │  │
                                    │  │ Functions │  │  Workers  │  │ Sched. │  │
                                    │  └───────────┘  └───────────┘  └────────┘  │
                                    └─────────────────────────────────────────────┘
```

### Component List

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **Edge Router** | Route incoming requests to correct deployment | Cloudflare Worker |
| **API Server** | REST API for dashboard, CLI, integrations | CelsianJS on Fly.io |
| **Build Queue** | Ordered build job processing | BullMQ + Redis |
| **Build Workers** | Clone, install, `then build`, upload artifacts | Fly Machines (ephemeral) |
| **Artifact Store** | Store built deployment artifacts | Cloudflare R2 |
| **Static CDN** | Serve static pages and client assets | Cloudflare R2 + Cache |
| **Serverless Runtime** | Execute serverless function entries | Cloudflare Workers |
| **Hot Server Pool** | Run persistent server containers | Fly Machines (persistent) |
| **Task Workers** | Execute background tasks + cron | Fly Machines (ephemeral/scheduled) |
| **Cron Scheduler** | Trigger cron-scheduled tasks | Vura control plane service |
| **PostgreSQL** | Primary data store | Neon (serverless Postgres) |
| **Redis** | Build queue, rate limiting, sessions | Upstash Redis |
| **Dashboard** | Web UI for project management | What Framework SPA |
| **CLI Integration** | `then deploy`, `then link`, `then env` | Additions to @then/cli |

---

## 2. Data Model

### 2.1 Core Entities

#### User
```
users
├── id                  UUID PRIMARY KEY
├── email               VARCHAR(255) UNIQUE NOT NULL
├── name                VARCHAR(255)
├── password_hash       VARCHAR(255) NULL          -- NULL if OAuth-only
├── github_id           BIGINT UNIQUE NULL
├── github_username     VARCHAR(255) NULL
├── github_access_token TEXT NULL                   -- encrypted
├── avatar_url          TEXT NULL
├── created_at          TIMESTAMPTZ NOT NULL
├── updated_at          TIMESTAMPTZ NOT NULL
└── last_login_at       TIMESTAMPTZ NULL
```

#### Team
```
teams
├── id                  UUID PRIMARY KEY
├── name                VARCHAR(255) NOT NULL
├── slug                VARCHAR(128) UNIQUE NOT NULL  -- used in URLs
├── owner_id            UUID REFERENCES users(id)
├── plan                VARCHAR(32) DEFAULT 'free'    -- free, pro, enterprise
├── billing_email       VARCHAR(255) NULL
├── stripe_customer_id  VARCHAR(255) NULL
├── created_at          TIMESTAMPTZ NOT NULL
└── updated_at          TIMESTAMPTZ NOT NULL
```

#### TeamMembership
```
team_memberships
├── team_id             UUID REFERENCES teams(id) ON DELETE CASCADE
├── user_id             UUID REFERENCES users(id) ON DELETE CASCADE
├── role                VARCHAR(32) NOT NULL           -- owner, admin, member
├── invited_by          UUID REFERENCES users(id) NULL
├── joined_at           TIMESTAMPTZ NOT NULL
└── PRIMARY KEY (team_id, user_id)
```

#### Project
```
projects
├── id                  UUID PRIMARY KEY
├── team_id             UUID REFERENCES teams(id) ON DELETE CASCADE
├── name                VARCHAR(255) NOT NULL
├── slug                VARCHAR(128) NOT NULL          -- unique within team
├── repo_url            TEXT NULL                       -- github.com/org/repo
├── repo_provider       VARCHAR(32) NULL               -- github, gitlab
├── repo_id             BIGINT NULL                    -- provider's repo ID
├── repo_branch         VARCHAR(255) DEFAULT 'main'    -- production branch
├── install_id          BIGINT NULL                    -- GitHub App installation ID
├── root_directory      VARCHAR(512) DEFAULT '.'       -- monorepo support
├── build_command       VARCHAR(512) NULL               -- override: default 'then build'
├── node_version        VARCHAR(32) DEFAULT '20'
├── framework           VARCHAR(64) DEFAULT 'thenjs'
├── created_at          TIMESTAMPTZ NOT NULL
├── updated_at          TIMESTAMPTZ NOT NULL
├── UNIQUE (team_id, slug)
└── INDEX ON (repo_provider, repo_id)
```

#### Deployment
```
deployments
├── id                  UUID PRIMARY KEY
├── project_id          UUID REFERENCES projects(id) ON DELETE CASCADE
├── status              VARCHAR(32) NOT NULL           -- queued, building, deploying,
│                                                      -- ready, failed, cancelled
├── trigger             VARCHAR(32) NOT NULL           -- push, pr, manual, rollback, promote
├── git_ref             VARCHAR(255) NULL              -- branch name or tag
├── git_sha             VARCHAR(40) NULL               -- full commit SHA
├── pr_number           INTEGER NULL                   -- if triggered by PR
├── pr_title            TEXT NULL
├── commit_message      TEXT NULL
├── commit_author       VARCHAR(255) NULL
├── is_production       BOOLEAN DEFAULT FALSE
├── url                 TEXT NULL                       -- assigned preview/production URL
├── ready_at            TIMESTAMPTZ NULL               -- when deployment became ready
├── build_duration_ms   INTEGER NULL
├── deploy_duration_ms  INTEGER NULL
├── artifact_key        TEXT NULL                       -- R2 key for deployment artifact
├── manifest            JSONB NULL                     -- ThenJS RouteManifest snapshot
├── meta                JSONB DEFAULT '{}'             -- arbitrary deployment metadata
├── created_at          TIMESTAMPTZ NOT NULL
├── created_by          UUID REFERENCES users(id) NULL
├── INDEX ON (project_id, created_at DESC)
├── INDEX ON (project_id, is_production)
└── INDEX ON (status)
```

#### DeploymentRoute
```
deployment_routes
├── id                  UUID PRIMARY KEY
├── deployment_id       UUID REFERENCES deployments(id) ON DELETE CASCADE
├── url_pattern         VARCHAR(512) NOT NULL           -- /api/users/:id
├── kind                VARCHAR(32) NOT NULL            -- serverless, hot, task
├── mode                VARCHAR(32) NULL                -- static, server, client, hybrid (pages only)
├── methods             VARCHAR(64)[] NOT NULL          -- {GET, POST}
├── entry_type          VARCHAR(32) NOT NULL            -- api, page
├── file_path           VARCHAR(512) NOT NULL           -- src/api/users/[id].ts
├── artifact_path       TEXT NULL                       -- path within artifact bundle
├── config              JSONB DEFAULT '{}'              -- route-level config
│                                                       -- (schedule, retries, timeout, revalidate)
├── runtime_id          TEXT NULL                       -- assigned worker/container ID
├── INDEX ON (deployment_id)
└── INDEX ON (deployment_id, kind)
```

#### Domain
```
domains
├── id                  UUID PRIMARY KEY
├── project_id          UUID REFERENCES projects(id) ON DELETE CASCADE
├── domain              VARCHAR(512) UNIQUE NOT NULL    -- example.com or sub.example.com
├── type                VARCHAR(32) NOT NULL            -- custom, preview
├── status              VARCHAR(32) NOT NULL            -- pending, active, error
├── ssl_status          VARCHAR(32) DEFAULT 'pending'   -- pending, provisioning, active, error
├── ssl_certificate_id  TEXT NULL
├── ssl_expires_at      TIMESTAMPTZ NULL
├── verification_token  VARCHAR(255) NULL               -- DNS TXT verification
├── verified_at         TIMESTAMPTZ NULL
├── created_at          TIMESTAMPTZ NOT NULL
└── updated_at          TIMESTAMPTZ NOT NULL
```

#### EnvironmentVariable
```
environment_variables
├── id                  UUID PRIMARY KEY
├── project_id          UUID REFERENCES projects(id) ON DELETE CASCADE
├── key                 VARCHAR(255) NOT NULL
├── value_encrypted     TEXT NOT NULL                   -- AES-256-GCM encrypted
├── scope               VARCHAR(32) NOT NULL            -- production, preview, development
├── target              VARCHAR(32) DEFAULT 'all'       -- all, serverless, hot, task
├── created_at          TIMESTAMPTZ NOT NULL
├── updated_at          TIMESTAMPTZ NOT NULL
├── UNIQUE (project_id, key, scope)
└── INDEX ON (project_id, scope)
```

#### ApiToken
```
api_tokens
├── id                  UUID PRIMARY KEY
├── user_id             UUID REFERENCES users(id) ON DELETE CASCADE
├── team_id             UUID REFERENCES teams(id) NULL  -- scope to team, or NULL for personal
├── name                VARCHAR(255) NOT NULL
├── token_hash          VARCHAR(255) NOT NULL           -- SHA-256 of the actual token
├── token_prefix        VARCHAR(12) NOT NULL            -- first 8 chars for identification
├── scopes              VARCHAR(64)[] NOT NULL           -- {deploy, read, admin}
├── last_used_at        TIMESTAMPTZ NULL
├── expires_at          TIMESTAMPTZ NULL
├── created_at          TIMESTAMPTZ NOT NULL
└── INDEX ON (token_hash)
```

#### BuildLog
```
build_logs
├── id                  UUID PRIMARY KEY
├── deployment_id       UUID REFERENCES deployments(id) ON DELETE CASCADE
├── stream              VARCHAR(16) NOT NULL            -- stdout, stderr
├── content             TEXT NOT NULL                   -- log chunk
├── timestamp           TIMESTAMPTZ NOT NULL
├── sequence            INTEGER NOT NULL                -- ordering within deployment
└── INDEX ON (deployment_id, sequence)
```

#### HotServerInstance
```
hot_server_instances
├── id                  UUID PRIMARY KEY
├── deployment_id       UUID REFERENCES deployments(id) ON DELETE CASCADE
├── machine_id          TEXT NOT NULL                   -- Fly Machine ID
├── region              VARCHAR(16) NOT NULL            -- iad, cdg, nrt, etc.
├── status              VARCHAR(32) NOT NULL            -- starting, running, stopped, error
├── internal_url        TEXT NULL                       -- internal network address
├── health_check_url    TEXT NULL                       -- /__health endpoint
├── last_health_at      TIMESTAMPTZ NULL
├── cpu_kind            VARCHAR(32) DEFAULT 'shared'
├── memory_mb           INTEGER DEFAULT 256
├── started_at          TIMESTAMPTZ NULL
├── stopped_at          TIMESTAMPTZ NULL
├── created_at          TIMESTAMPTZ NOT NULL
└── INDEX ON (deployment_id, status)
```

#### CronJob
```
cron_jobs
├── id                  UUID PRIMARY KEY
├── deployment_id       UUID REFERENCES deployments(id) ON DELETE CASCADE
├── route_id            UUID REFERENCES deployment_routes(id) ON DELETE CASCADE
├── task_name           VARCHAR(255) NOT NULL
├── schedule            VARCHAR(128) NOT NULL           -- 5-field cron expression
├── enabled             BOOLEAN DEFAULT TRUE
├── last_run_at         TIMESTAMPTZ NULL
├── last_status         VARCHAR(32) NULL                -- completed, failed
├── next_run_at         TIMESTAMPTZ NULL                -- pre-computed for efficient polling
├── created_at          TIMESTAMPTZ NOT NULL
└── INDEX ON (next_run_at) WHERE enabled = TRUE
```

### 2.2 Analytics Entities (Design Now, Implement Later)

#### RequestLog
```
request_logs (TimescaleDB hypertable on timestamp)
├── timestamp           TIMESTAMPTZ NOT NULL
├── deployment_id       UUID NOT NULL
├── project_id          UUID NOT NULL
├── route_pattern       VARCHAR(512)
├── method              VARCHAR(8)
├── status_code         INTEGER
├── duration_ms         INTEGER
├── response_size_bytes BIGINT
├── region              VARCHAR(16)
├── kind                VARCHAR(32)                     -- serverless, hot, static, task
├── client_ip_hash      VARCHAR(64)                     -- hashed, not raw
├── user_agent          TEXT NULL
├── error_message       TEXT NULL
└── INDEX ON (deployment_id, timestamp DESC)
```

#### BuildMetric
```
build_metrics
├── deployment_id       UUID PRIMARY KEY REFERENCES deployments(id)
├── total_duration_ms   INTEGER
├── clone_duration_ms   INTEGER
├── install_duration_ms INTEGER
├── build_duration_ms   INTEGER
├── upload_duration_ms  INTEGER
├── artifact_size_bytes BIGINT
├── cache_hit           BOOLEAN
├── node_version        VARCHAR(32)
├── route_count         INTEGER
├── page_count          INTEGER
├── serverless_count    INTEGER
├── hot_count           INTEGER
├── task_count          INTEGER
├── static_count        INTEGER
├── created_at          TIMESTAMPTZ NOT NULL
```

#### RuntimeLog
```
runtime_logs (TimescaleDB hypertable on timestamp)
├── timestamp           TIMESTAMPTZ NOT NULL
├── deployment_id       UUID NOT NULL
├── instance_id         UUID NULL                       -- hot_server_instances.id
├── stream              VARCHAR(16)                     -- stdout, stderr
├── message             TEXT NOT NULL
├── level               VARCHAR(16) NULL                -- info, warn, error
├── source              VARCHAR(32)                     -- serverless, hot, task
└── INDEX ON (deployment_id, timestamp DESC)
```

#### UsageMeter
```
usage_meters (for billing, aggregated hourly)
├── id                  UUID PRIMARY KEY
├── team_id             UUID NOT NULL
├── period_start        TIMESTAMPTZ NOT NULL            -- hour boundary
├── bandwidth_bytes     BIGINT DEFAULT 0
├── function_invocations BIGINT DEFAULT 0
├── build_minutes       DECIMAL(10,2) DEFAULT 0
├── hot_server_seconds  BIGINT DEFAULT 0
├── task_invocations    BIGINT DEFAULT 0
├── static_requests     BIGINT DEFAULT 0
├── UNIQUE (team_id, period_start)
└── INDEX ON (team_id, period_start DESC)
```

---

## 3. Build Pipeline

### Step-by-Step: Git Push to Live Deployment

```
1. WEBHOOK RECEIVED
   GitHub sends push/PR webhook to api.vura.io/webhooks/github
   ├── Validate webhook signature (HMAC SHA-256)
   ├── Extract: repo_id, branch, commit SHA, PR number (if PR)
   ├── Look up project by (repo_provider='github', repo_id)
   └── Determine deployment type:
       ├── Push to production branch → production deployment
       ├── Push to other branch with open PR → preview deployment
       └── PR opened/synchronized → preview deployment

2. DEPLOYMENT RECORD CREATED
   ├── Insert into deployments table (status: 'queued')
   ├── Determine URL:
   │   ├── Production: project's custom domain or <project>-<team>.vura.app
   │   └── Preview: <branch>--<project>-<team>.vura.app
   ├── Post GitHub commit status: 'pending'
   └── Enqueue build job to BullMQ

3. BUILD JOB STARTS
   ├── Spin up ephemeral Fly Machine (build worker)
   ├── Update deployment status: 'building'
   ├── Stream build logs to build_logs table via WebSocket
   │
   │  Inside the build worker:
   │  ┌─────────────────────────────────────────────────────────┐
   │  │ a. git clone --depth=1 --branch=<ref> <repo_url>       │
   │  │ b. cd <root_directory>                                   │
   │  │ c. Detect then.config.ts → confirm framework='thenjs'   │
   │  │ d. Inject environment variables (scope: production or    │
   │  │    preview, decrypted at build time)                     │
   │  │ e. npm install / pnpm install (with cache from R2)       │
   │  │ f. Run: npx then build                                   │
   │  │    → Produces:                                           │
   │  │      dist/manifest.json      (RouteManifest)             │
   │  │      dist/server/entry.js    (hot server entry)          │
   │  │      dist/server/pages/*.js  (server-mode page bundles)  │
   │  │      dist/functions/*/       (serverless function entries)│
   │  │      dist/static/            (pre-rendered HTML + assets)│
   │  │ g. Parse dist/manifest.json                              │
   │  │ h. Upload entire dist/ to R2 under:                      │
   │  │    artifacts/<project_id>/<deployment_id>/               │
   │  │ i. Upload dependency cache (node_modules hash) to R2     │
   │  └─────────────────────────────────────────────────────────┘
   │
   ├── Record BuildMetric
   └── Destroy build machine

4. DEPLOY PHASE
   ├── Update deployment status: 'deploying'
   ├── Parse manifest from artifact store
   ├── Create deployment_routes records from manifest
   ├── For each route, deploy to appropriate target:
   │
   │   STATIC PAGES (mode: 'static')
   │   ├── Upload dist/static/**/* to R2 CDN bucket
   │   ├── Keyed by: <deployment_id>/static/<path>
   │   └── Purge CDN cache for production domains
   │
   │   CLIENT PAGES (mode: 'client')
   │   ├── Upload static shell HTML + JS bundles to R2
   │   └── Same as static but includes JS entry
   │
   │   SERVER PAGES (mode: 'server', 'hybrid')
   │   ├── Bundle dist/server/entry.js + dist/server/pages/*.js
   │   │   together for the hot server
   │   └── Included in hot server deployment (see HOT below)
   │
   │   SERVERLESS FUNCTIONS (kind: 'serverless')
   │   ├── For each dist/functions/*/index.js:
   │   │   ├── Bundle with esbuild (single file, no external deps)
   │   │   ├── Upload as Cloudflare Worker script
   │   │   └── Worker name: vura-fn-<deployment_id_short>-<route_hash>
   │   └── Register routes in edge router KV
   │
   │   HOT SERVER (kind: 'hot')
   │   ├── Build Docker image from dist/server/entry.js
   │   │   (Dockerfile template: Node 20 alpine, copy dist/, expose 3000)
   │   ├── Push image to Fly registry
   │   ├── Create/update Fly Machine
   │   │   ├── Production: persistent machine in primary region
   │   │   ├── Preview: on-demand machine (scale to zero after 5min idle)
   │   │   └── Inject runtime env vars
   │   ├── Wait for health check (/__health returns 200)
   │   └── Record in hot_server_instances
   │
   │   TASK ROUTES (kind: 'task')
   │   ├── Deploy as serverless functions (same as serverless)
   │   ├── Register cron schedules in cron_jobs table
   │   └── Cron scheduler will invoke via HTTP POST
   │
   ├── Update edge router KV with new route map
   └── Update deployment status: 'ready'

5. FINALIZE
   ├── If production deployment:
   │   ├── Update project's active production deployment
   │   ├── Point custom domains to new deployment
   │   └── Purge CDN cache
   ├── Post GitHub commit status: 'success' with deployment URL
   ├── If PR: post/update comment with preview URL
   └── Record deployment ready_at timestamp
```

### Build Caching Strategy

```
Cache key: SHA-256 of (lockfile content + node_version + root_directory)

On build start:
  1. Check R2 for cache key → download node_modules tar if exists
  2. Run install (fast with cached modules)
  3. After build: if lockfile changed, upload new node_modules tar

Cache storage: R2 bucket 'vura-build-cache'
  Key format: cache/<team_id>/<cache_hash>.tar.zst
  TTL: 30 days, LRU eviction per team
  Max cache per team: 2GB (free), 10GB (pro)
```

---

## 4. Deployment Engine

### Route Kind to Infrastructure Mapping

ThenJS's `kind` system maps directly to Vura's infrastructure targets:

| Route Kind | ThenJS Declaration | Vura Target | Scaling Model |
|---|---|---|---|
| `serverless` | `export const route = { kind: 'serverless' }` | Cloudflare Worker | Per-request, auto-scale |
| `hot` | `export const route = { kind: 'hot' }` | Fly Machine (persistent) | Container, health-checked |
| `task` | `export const route = { kind: 'task' }` | CF Worker (invoked by scheduler) | On-demand |
| Static page | `export const page = { mode: 'static' }` | R2 + CDN | Edge-cached |
| Server page | `export const page = { mode: 'server' }` | Included in hot server entry | Part of hot server |
| Client page | `export const page = { mode: 'client' }` | R2 + CDN (shell + JS) | Edge-cached |
| Hybrid page | `export const page = { mode: 'hybrid' }` | Included in hot server entry | Part of hot server |

### Serverless Function Deployment

Each serverless route from `dist/functions/<name>/index.js` is already a self-contained
Worker-compatible module with the `export default { async fetch(request) { ... } }` format
(generated by `generateFunctionEntry()` in `@then/core/build.ts`).

Vura deployment steps:
1. Read the generated function entry from R2 artifacts
2. Bundle with esbuild to ensure single-file, zero-dependency output
3. Upload to Cloudflare Workers API as a new script version
4. Worker naming: `vura-<project_slug>-<route_hash>-<deployment_id_short>`
5. Update route mapping in edge router KV

### Hot Server Deployment

The generated `dist/server/entry.js` is a complete Node.js HTTP server that:
- Imports all API route handlers
- Imports all server-mode page modules
- Contains inline route matching, body parsing, SSR rendering
- Runs the task queue and cron scheduler (if task routes exist)
- Exposes `/__health` endpoint

Vura containerizes this as:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY dist/ ./dist/
COPY node_modules/ ./node_modules/  # only production deps
ENV PORT=3000
ENV NODE_ENV=production
CMD ["node", "dist/server/entry.js"]
EXPOSE 3000
```

### Task Route Deployment

Task routes with `kind: 'task'` are dual-deployed:

1. **As serverless functions** — for HTTP-triggered invocation via `/__tasks/<name>`
   (using `generateTaskEntry()` from `@then/core/build.ts`)
2. **Cron entries** — if `route.config.schedule` exists, Vura's cron scheduler
   calls the serverless function on schedule

The existing task config maps directly:
```typescript
export const route = {
  kind: 'task',
  schedule: '*/5 * * * *',  // every 5 minutes
  retries: 3,
  timeout: 30000,
};
```

Vura reads `config.schedule` and creates a `cron_jobs` record. The control plane's
cron scheduler polls `cron_jobs WHERE enabled = TRUE AND next_run_at <= NOW()` every
30 seconds and dispatches HTTP POST requests to the deployed serverless task function.

---

## 5. Hot Server Strategy

### The Problem

Hot servers (`kind: 'hot'`) and server-mode pages (`mode: 'server'` / `mode: 'hybrid'`)
require a persistent, long-running Node.js process. This creates challenges:

- **Production**: needs always-on containers with health checking
- **Preview**: every PR branch needs its own running server, but keeping N containers
  running for N open PRs is expensive
- **WebSocket**: hot servers may maintain stateful WebSocket connections
- **State**: hot routes with in-memory state (counters, caches) are per-container

### Chosen Strategy: On-Demand Machines with Idle Scale-to-Zero

**Production hot servers**: Always-on Fly Machines.
- Persistent machines in the primary region
- Health-checked every 30 seconds via `/__health`
- Auto-restart on crash
- Can scale to multiple regions for pro/enterprise plans

**Preview hot servers**: On-demand Fly Machines with scale-to-zero.
- Machine starts when the first request hits the preview URL
- Edge router detects `kind: 'hot'` for the route and proxies to Fly Machine
- If machine is stopped, edge router sends a start command via Fly API, holds the
  request for up to 10 seconds (with a "Starting preview..." loading page for browser
  requests), then proxies once healthy
- Machine scales to zero after 5 minutes of no requests
- Cold start: approximately 2-4 seconds (Node.js alpine container)

**Why this works for ThenJS specifically**:
- ThenJS's `dist/server/entry.js` is self-contained with no external service deps
- The `/__health` endpoint is generated automatically by the build pipeline
- ISR cache in the server entry uses in-memory Maps, which is fine for preview
  (cold start just means empty cache, pages re-render on demand)
- Task routes in preview deployments still work: the cron scheduler is disabled for
  preview deployments, but manual `POST /__tasks/<name>` still functions

**Fallback for hot routes in preview (budget tier)**:
If a project is on the free tier with many preview deployments, hot routes in preview
return a 503 with a JSON body:
```json
{
  "error": "Hot server not available in preview (free tier)",
  "upgrade": "https://vura.io/pricing",
  "workaround": "Use `then dev` locally for hot route testing"
}
```

### Container Lifecycle

```
                  ┌──────────────────────────────┐
                  │     Edge Router receives      │
                  │     request for preview URL    │
                  └──────────────┬─────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  Lookup deployment +     │
                    │  route in KV             │
                    └────────────┬─────────────┘
                                 │
               ┌─────────────────▼──────────────────┐
               │  Route kind?                        │
               ├──────────┬──────────┬───────────────┤
               │ static   │serverless│  hot           │
               │ → R2     │ → Worker │  ↓             │
               └──────────┴──────────┘                │
                                    ┌─────────────────▼──────────┐
                                    │  Is Fly Machine running?    │
                                    ├──────────┬─────────────────┤
                                    │  Yes     │  No              │
                                    │  ↓       │  ↓               │
                                    │ Proxy    │ Start Machine    │
                                    │ request  │ Wait for health  │
                                    │          │ Then proxy       │
                                    └──────────┴─────────────────┘
```

### Hot Server Networking

Production hot servers receive traffic via Fly's internal anycast proxy.
The edge router proxies requests using Fly's `.internal` DNS:

```
Edge Router → HTTPS → <machine-id>.vm.<app-name>.internal:3000
```

For preview, the edge router makes a Fly API call to ensure the machine is
running before proxying.

---

## 6. Preview Deployment Flow

### PR Opened / Push to PR Branch

```
1. GitHub webhook arrives: event=pull_request, action=synchronize
2. Vura resolves project from repo_id
3. Create deployment record:
   ├── trigger: 'pr'
   ├── git_ref: 'feature-branch'
   ├── git_sha: 'abc1234...'
   ├── pr_number: 42
   ├── is_production: FALSE
   └── url: 'feature-branch--myapp-myteam.vura.app'

4. Build pipeline runs (same as production, but with preview env vars)

5. Deploy phase:
   ├── Static/client pages → R2 under preview deployment key
   ├── Serverless functions → CF Workers with preview-specific names
   ├── Hot server → On-demand Fly Machine (or skip on free tier)
   └── Tasks → Deployed but cron disabled

6. Edge router KV update:
   Key: 'route:<preview-domain>'
   Value: { deploymentId, routes: [...], hotMachineId, ... }

7. GitHub PR comment posted:
   "✅ Preview deployed to https://feature-branch--myapp-myteam.vura.app
    
    Route summary:
    λ GET /api/hello          serverless
    ● GET /api/health         hot (on-demand)
    ◆ /                       static
    ◈ /blog/:slug             server (on-demand)"

8. GitHub commit status: success with preview URL
```

### Preview URL Format

```
<sanitized-branch>--<project-slug>-<team-slug>.vura.app

Examples:
  feature-auth--myapp-acmecorp.vura.app
  fix-login-42--dashboard-acmecorp.vura.app
  main--myapp-acmecorp.vura.app   (not used — main goes to production domain)

Branch sanitization:
  - Lowercase
  - Replace non-alphanumeric with hyphens
  - Truncate to 48 chars
  - Remove leading/trailing hyphens
```

### Preview Cleanup

When a PR is closed or merged:
1. GitHub webhook: `pull_request.closed`
2. Mark deployment as superseded
3. Schedule cleanup (runs after 24 hours):
   - Delete CF Worker scripts for serverless routes
   - Stop and destroy Fly Machine for hot server
   - Delete static assets from R2
   - Remove edge router KV entries
4. Keep deployment record and build logs (for audit trail)

---

## 7. Domain & Routing Architecture

### Request Flow

```
Client Request
      │
      ▼
┌──────────────────────┐
│   DNS Resolution     │
│                      │
│  Custom domain:      │
│   CNAME → proxy.     │
│   vura.app           │
│   (or A record to    │
│    Vura IP)          │
│                      │
│  Preview domain:     │
│   *.vura.app →       │
│   Cloudflare DNS     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Cloudflare Edge    │
│   (SSL termination)  │
│                      │
│   SSL for *.vura.app │
│   is wildcard cert   │
│                      │
│   SSL for custom     │
│   domains: per-      │
│   domain cert via    │
│   Cloudflare for     │
│   SaaS               │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────────────────────────────┐
│   Edge Router (Cloudflare Worker)                 │
│                                                   │
│   1. Extract hostname from request                │
│   2. Look up in KV: 'domain:<hostname>'           │
│      → { projectId, deploymentId }                │
│   3. Look up: 'deployment:<deploymentId>'         │
│      → { routes: [...], hotMachineId, ... }       │
│   4. Match request path against routes            │
│   5. Route to target:                             │
│                                                   │
│   ┌─────────┬──────────┬───────────┬──────────┐   │
│   │ static  │serverless│   hot     │  task    │   │
│   │         │          │          │         │   │
│   │ Fetch   │ Workers  │  Proxy   │ (HTTP)  │   │
│   │ from R2 │ binding  │  to Fly  │ invoke  │   │
│   │         │ dispatch │  Machine │ worker  │   │
│   └─────────┴──────────┴───────────┴──────────┘   │
│                                                   │
│   Headers added:                                  │
│   x-vura-deployment-id: <id>                      │
│   x-vura-route-kind: serverless|hot|static        │
│   x-vura-request-id: <uuid>                       │
│   x-vura-region: <edge-region>                    │
│   x-vura-timing: <edge-processing-ms>             │
└──────────────────────────────────────────────────┘
```

### Edge Router KV Schema

```
KV Namespace: VURA_ROUTES

Key: domain:<hostname>
Value: {
  "projectId": "uuid",
  "deploymentId": "uuid",
  "teamId": "uuid"
}
TTL: 60 seconds (cached, with background revalidation)

Key: deployment:<deploymentId>
Value: {
  "routes": [
    {
      "pattern": "/api/hello",
      "kind": "serverless",
      "methods": ["GET"],
      "workerId": "vura-fn-abc123-hello"
    },
    {
      "pattern": "/api/users/:id",
      "kind": "hot",
      "methods": ["GET", "DELETE"],
      "hotMachineId": "fly-machine-xyz"
    },
    {
      "pattern": "/",
      "kind": "static",
      "methods": ["GET"],
      "staticKey": "artifacts/<pid>/<did>/static/index.html"
    },
    {
      "pattern": "/blog/:slug",
      "kind": "hot",
      "mode": "server",
      "methods": ["GET"],
      "hotMachineId": "fly-machine-xyz"
    }
  ],
  "hotMachineApp": "vura-hot-<project_id_short>",
  "hotMachineId": "fly-machine-xyz",
  "hotMachineRegion": "iad",
  "staticBucket": "vura-static",
  "staticPrefix": "artifacts/<pid>/<did>/static"
}
TTL: 300 seconds (cached)
```

### Custom Domain Setup

```
User adds domain in dashboard:
1. Insert domain record (status: 'pending')
2. Return DNS instructions:
   
   Option A (CNAME — recommended):
     CNAME <subdomain> → proxy.vura.app
   
   Option B (A record — apex domains):
     A @ → <Vura IP 1>
     A @ → <Vura IP 2>
   
   Verification:
     TXT _vura-verification.<domain> → <verification_token>

3. Background job polls DNS every 60 seconds:
   - Check TXT record for verification token
   - Once verified: verified_at = NOW(), status = 'active'

4. SSL provisioning (via Cloudflare for SaaS):
   - Cloudflare automatically provisions certificate for verified domains
   - ssl_status transitions: pending → provisioning → active
   - Certificate auto-renews

5. Edge router starts routing traffic for the domain
```

### Vura-Owned IPs

Vura uses Cloudflare's infrastructure for IP addresses:
- Anycast IPs provided by Cloudflare for SaaS custom hostname feature
- Users point A records to these IPs for apex domain support
- No IP management burden on Vura's side

---

## 8. CLI Integration

### New Commands Added to @then/cli

The ThenJS CLI (`then`) gets new commands that communicate with Vura's API.
These additions live in the open-source `@then/cli` package but call the
closed-source `api.vura.io` endpoints.

#### `then deploy`

```
Usage: then deploy [options]

Push the current project to Vura for deployment.

Options:
  --prod          Deploy to production (default: preview)
  --token <tok>   API token (default: from ~/.vura/credentials)
  --message <msg> Deployment message

Flow:
  1. Read ~/.vura/credentials for auth token
  2. Read .vura/project.json for project linkage
  3. If not linked: prompt to run `then link` first
  4. Run `then build` locally
  5. Upload dist/ directory to Vura API:
     POST api.vura.io/v1/deployments
     Body: multipart/form-data with tarball of dist/
  6. Stream build logs from WebSocket:
     wss://api.vura.io/v1/deployments/<id>/logs
  7. Print deployment URL when ready
```

#### `then link`

```
Usage: then link [project-name]

Link the current directory to a Vura project.

Flow:
  1. Authenticate (read token or prompt login)
  2. GET api.vura.io/v1/projects → list user's projects
  3. Interactive select or create new
  4. Write .vura/project.json:
     { "projectId": "uuid", "teamId": "uuid", "orgSlug": "acme" }
  5. Add .vura/ to .gitignore if not present
```

#### `then env pull`

```
Usage: then env pull [--scope production|preview|development]

Pull environment variables from Vura to local .env file.

Flow:
  1. Read project linkage from .vura/project.json
  2. GET api.vura.io/v1/projects/<id>/env?scope=development
  3. Write to .env.local (never overwrite .env)
  4. Print summary: "Pulled 12 env vars (scope: development)"
```

#### `then env push`

```
Usage: then env push [--scope production|preview|development]

Push local .env.local to Vura as environment variables.

Flow:
  1. Read .env.local
  2. PUT api.vura.io/v1/projects/<id>/env
  3. Confirm with user before overwriting existing vars
```

#### `then logs`

```
Usage: then logs [--deployment <id>] [--follow]

Stream runtime logs from Vura.

Flow:
  1. Default: latest production deployment
  2. Connect to WebSocket:
     wss://api.vura.io/v1/deployments/<id>/runtime-logs
  3. Print log entries as they arrive
  4. Support --follow for continuous streaming
```

#### `then login`

```
Usage: then login

Authenticate with Vura.

Flow:
  1. Open browser to app.vura.io/cli-auth?code=<random>
  2. User approves in browser
  3. CLI polls api.vura.io/v1/auth/cli-poll?code=<random>
  4. Receive API token
  5. Write to ~/.vura/credentials:
     { "token": "vura_...", "email": "user@example.com" }
```

### Credential Storage

```
~/.vura/
├── credentials          # { "token": "vura_abc123...", "email": "..." }
└── config               # { "defaultTeam": "acme" }

<project>/.vura/
├── project.json         # { "projectId": "uuid", "teamId": "uuid" }
└── (added to .gitignore)
```

---

## 9. API Design

### Base URL: `https://api.vura.io/v1`

### Authentication

All API requests require a Bearer token:
```
Authorization: Bearer vura_<token>
```

Tokens are issued via:
- CLI login flow (long-lived)
- Dashboard settings (API tokens with scopes)
- GitHub App OAuth flow (session tokens)

### Endpoints

#### Auth
```
POST   /v1/auth/login              { email, password } → { token, user }
POST   /v1/auth/register           { email, password, name } → { token, user }
POST   /v1/auth/github             { code } → { token, user }   (OAuth callback)
POST   /v1/auth/cli-poll           { code } → { token } | 202   (CLI login poll)
GET    /v1/auth/me                 → { user, teams }
```

#### Teams
```
GET    /v1/teams                   → [{ id, name, slug, role }]
POST   /v1/teams                   { name, slug } → { team }
GET    /v1/teams/:slug             → { team, members }
PATCH  /v1/teams/:slug             { name } → { team }
POST   /v1/teams/:slug/members     { email, role } → { membership }
DELETE /v1/teams/:slug/members/:userId  → 204
```

#### Projects
```
GET    /v1/projects                ?teamId=<uuid> → [{ project }]
POST   /v1/projects                { name, teamId, repoUrl? } → { project }
GET    /v1/projects/:id            → { project, latestDeployment }
PATCH  /v1/projects/:id            { name, buildCommand, ... } → { project }
DELETE /v1/projects/:id            → 204
POST   /v1/projects/:id/repo       { repoUrl, repoBranch } → { project }
```

#### Deployments
```
GET    /v1/projects/:id/deployments            ?page,limit → [{ deployment }]
POST   /v1/projects/:id/deployments            (multipart: artifact tarball)
                                                → { deployment } (status: queued)
GET    /v1/deployments/:id                     → { deployment, routes }
POST   /v1/deployments/:id/promote             → { newDeployment }  (promote to prod)
POST   /v1/deployments/:id/rollback            → { newDeployment }  (rollback to this)
DELETE /v1/deployments/:id                     → 204 (cancel if building)
GET    /v1/deployments/:id/logs                → [{ buildLog }]
WS     /v1/deployments/:id/logs                → streaming build logs
WS     /v1/deployments/:id/runtime-logs        → streaming runtime logs
```

#### Environment Variables
```
GET    /v1/projects/:id/env        ?scope=production → [{ key, scope, target, updated_at }]
                                                       (values are NOT returned in list)
GET    /v1/projects/:id/env/:key   ?scope=production → { key, value, scope, target }
PUT    /v1/projects/:id/env        [{ key, value, scope, target }] → 200
DELETE /v1/projects/:id/env/:key   ?scope=production → 204
POST   /v1/projects/:id/env/pull   { scope } → [{ key, value }]   (CLI env pull)
```

#### Domains
```
GET    /v1/projects/:id/domains    → [{ domain }]
POST   /v1/projects/:id/domains    { domain } → { domain, dnsInstructions }
DELETE /v1/domains/:id             → 204
POST   /v1/domains/:id/verify      → { verified: boolean }
GET    /v1/domains/:id/ssl         → { sslStatus, expiresAt }
```

#### API Tokens
```
GET    /v1/tokens                  → [{ id, name, prefix, scopes, lastUsedAt }]
POST   /v1/tokens                  { name, scopes } → { token }  (full token shown ONCE)
DELETE /v1/tokens/:id              → 204
```

#### Webhooks (Internal)
```
POST   /v1/webhooks/github         (GitHub webhook payload, signature-verified)
POST   /v1/webhooks/gitlab         (GitLab webhook payload)
```

#### Analytics (Future)
```
GET    /v1/projects/:id/analytics/requests   ?from,to,granularity → { timeseries }
GET    /v1/projects/:id/analytics/builds     ?from,to → { timeseries }
GET    /v1/projects/:id/analytics/usage      ?from,to → { bandwidth, invocations, ... }
GET    /v1/deployments/:id/analytics         ?from,to → { timeseries }
```

#### Health
```
GET    /v1/health                  → { ok: true, version: '0.1.0' }
```

### Error Format

```json
{
  "error": {
    "code": "PROJECT_NOT_FOUND",
    "message": "Project with ID abc-123 not found",
    "status": 404
  }
}
```

### Rate Limiting

```
Headers:
  X-RateLimit-Limit: 100
  X-RateLimit-Remaining: 97
  X-RateLimit-Reset: 1710432000

Limits:
  - API calls: 100/minute per token
  - Deployments: 100/hour per project
  - Build minutes: per plan (free: 100/month, pro: 6000/month)
```

---

## 10. Infrastructure

### Technology Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| **API Server** | CelsianJS on Fly.io | Dogfooding our own backend framework; Fly for persistent process |
| **Database** | Neon (serverless Postgres) | Scale-to-zero, branching for dev, low ops |
| **Cache / Queue** | Upstash Redis | Serverless Redis, BullMQ-compatible, global replication |
| **Edge Router** | Cloudflare Worker | Global edge, sub-ms routing, KV for route maps |
| **Static / CDN** | Cloudflare R2 + Cache | S3-compatible, zero egress fees, edge-cached |
| **Serverless Runtime** | Cloudflare Workers | V8 isolates, <1ms cold start, global edge |
| **Hot Server Runtime** | Fly.io Machines | Fast boot, scale-to-zero, global regions, Docker |
| **Build Workers** | Fly.io Machines (ephemeral) | Spin up per build, destroy after, controlled environment |
| **Container Registry** | Fly.io Registry | Native to Fly, zero-config |
| **SSL** | Cloudflare for SaaS | Automatic cert provisioning for custom domains |
| **DNS** | Cloudflare DNS | *.vura.app wildcard, proxy for custom domains |
| **Auth** | Custom (CelsianJS JWT plugin) | GitHub OAuth via GitHub App |
| **Secrets Encryption** | AES-256-GCM | Envelope encryption, master key in env |
| **Monitoring** | Grafana Cloud | Metrics, logs, alerting |
| **Dashboard** | What Framework SPA | Dogfooding our own frontend framework |

### Infrastructure Layout

```
Cloudflare
├── DNS Zone: vura.app
│   ├── *.vura.app → CNAME to Cloudflare proxy
│   └── proxy.vura.app → Cloudflare proxy (for custom domains)
│
├── Workers
│   ├── vura-edge-router          (edge request routing)
│   ├── vura-fn-*                 (user serverless functions, dynamic)
│   └── vura-webhook-receiver     (GitHub/GitLab webhook intake)
│
├── KV Namespaces
│   ├── VURA_ROUTES               (domain→deployment, deployment→routes)
│   └── VURA_RATE_LIMITS          (rate limit counters)
│
├── R2 Buckets
│   ├── vura-artifacts            (deployment build artifacts)
│   ├── vura-static               (static page content for CDN)
│   └── vura-build-cache          (node_modules caches)
│
└── Cloudflare for SaaS
    └── Custom hostname SSL provisioning

Fly.io
├── App: vura-api                 (CelsianJS API server, persistent, 2+ machines)
│   ├── Region: iad (primary)
│   └── Region: cdg (secondary)
│
├── App: vura-build-workers       (ephemeral build machines, spot-like)
│   └── Region: iad
│
├── Apps: vura-hot-<project_short> (one app per project, machines per deployment)
│   ├── Production machines: persistent
│   └── Preview machines: auto-stop after 5min
│
└── App: vura-cron-scheduler      (single machine, runs cron tick loop)

Neon
└── Database: vura-production
    ├── Branch: main              (production)
    └── Branch: dev               (development, auto-branching)

Upstash
└── Redis: vura-queue
    ├── BullMQ build queue
    ├── Rate limit counters
    └── Session cache
```

### Cost Optimization Notes

1. **Serverless functions on CF Workers**: Zero cost at rest. Pay per invocation.
   User serverless routes cost Vura nothing when idle.

2. **Static pages on R2**: Zero egress fees. Cloudflare Cache serves most reads
   from edge. Storage cost is minimal (<$0.015/GB/month).

3. **Hot servers on Fly Machines**: The primary cost driver. Production machines
   run continuously. Preview machines use auto-stop to minimize idle costs.
   On free tier, preview hot servers are disabled entirely.

4. **Build workers on Fly Machines**: Ephemeral. Only billed while building.
   Spot-like pricing for non-urgent builds.

5. **Database on Neon**: Scale-to-zero during low traffic. Compute charges
   only when actively querying.

---

## 11. Analytics & Monitoring Data Model

### Data Flow

```
Request hits Edge Router
    │
    ▼
Log entry emitted (via cf.waitUntil):
  POST api.vura.io/v1/internal/log-batch
  Body: [{ timestamp, deploymentId, method, path, status, durationMs, ... }]
    │
    ▼
API Server batches and inserts into request_logs (TimescaleDB)
    │
    ▼
Continuous aggregation (TimescaleDB):
  - Per-minute rollups for real-time dashboard
  - Per-hour rollups for usage metering
  - Per-day rollups for analytics charts
```

### Aggregation Tables

```
request_rollups_1min (continuous aggregate)
├── bucket              TIMESTAMPTZ (1-minute interval)
├── deployment_id       UUID
├── route_pattern       VARCHAR
├── method              VARCHAR(8)
├── request_count       BIGINT
├── error_count         BIGINT (status >= 500)
├── p50_duration_ms     DOUBLE PRECISION
├── p95_duration_ms     DOUBLE PRECISION
├── p99_duration_ms     DOUBLE PRECISION
├── total_bytes         BIGINT
└── RETENTION: 7 days

request_rollups_1hour (continuous aggregate)
├── bucket              TIMESTAMPTZ (1-hour interval)
├── deployment_id       UUID
├── project_id          UUID
├── request_count       BIGINT
├── error_count         BIGINT
├── avg_duration_ms     DOUBLE PRECISION
├── p95_duration_ms     DOUBLE PRECISION
├── total_bytes         BIGINT
├── unique_routes       INTEGER
└── RETENTION: 90 days

request_rollups_1day (continuous aggregate)
├── bucket              TIMESTAMPTZ (1-day interval)
├── project_id          UUID
├── team_id             UUID
├── request_count       BIGINT
├── error_count         BIGINT
├── bandwidth_bytes     BIGINT
├── function_invocations BIGINT
├── hot_requests        BIGINT
├── static_requests     BIGINT
└── RETENTION: 2 years
```

### Usage Metering for Billing

The `usage_meters` table aggregates per team per hour:

```
Billing dimensions:
  1. Bandwidth (total response bytes)     — from request_logs.response_size_bytes
  2. Function invocations                 — from request_logs WHERE kind='serverless'
  3. Build minutes                        — from build_metrics.total_duration_ms
  4. Hot server uptime                    — from hot_server_instances.(stopped_at - started_at)
  5. Task invocations                     — from request_logs WHERE kind='task'

Billing aggregation runs every hour:
  INSERT INTO usage_meters
  SELECT team_id, date_trunc('hour', timestamp), SUM(...), COUNT(...)
  FROM request_logs
  WHERE timestamp >= last_hour_boundary
  GROUP BY team_id
```

### Runtime Log Collection

Hot servers and serverless functions emit structured logs:

**Serverless**: Edge router captures function stdout via Workers binding, forwards
to log collection endpoint.

**Hot servers**: Fly.io's log drain forwards stdout/stderr to a Vura log ingestion
endpoint. Alternatively, the hot server entry can be patched during build to include
a log shipper that POSTs batched log lines to `api.vura.io/v1/internal/runtime-logs`.

**Log format**:
```json
{
  "timestamp": "2026-03-14T10:30:00.123Z",
  "deploymentId": "uuid",
  "instanceId": "fly-machine-xyz",
  "stream": "stdout",
  "message": "[ThenJS] GET /api/users/42 → 200 (12ms)",
  "level": "info",
  "source": "hot"
}
```

---

## 12. Security

### Authentication

**User sessions**: JWT tokens signed with RS256. Short-lived access tokens (15 min)
with refresh tokens (30 days). Refresh tokens stored hashed in database.

**API tokens**: Generated with `crypto.randomBytes(32)`, stored as SHA-256 hash.
Prefix (`vura_abc1...`) stored for identification. Full token shown once at creation.

**GitHub OAuth**: GitHub App with minimal scopes:
- `read:user` — for user profile
- `repo` — for webhook setup and code access
- `admin:repo_hook` — for webhook management

### Secrets Management

**Encryption at rest**: Environment variable values are encrypted using AES-256-GCM.

```
Encryption flow:
  1. Master key (32 bytes) stored in Vura API server environment
  2. Per-project data encryption key (DEK) derived from master key + project_id
  3. Each env var value encrypted: AES-256-GCM(DEK, nonce, plaintext)
  4. Stored as: base64(nonce + ciphertext + tag)

Decryption:
  - Only the API server and build workers can decrypt
  - Edge router and serverless functions receive pre-decrypted values
    injected as environment variables at deployment time
  - Hot servers receive env vars as Fly Machine secrets (encrypted by Fly)
```

**Secret injection points**:
- **Build time**: Decrypted and set as env vars in build worker
- **Serverless runtime**: Set as CF Worker environment bindings
- **Hot server runtime**: Set as Fly Machine environment secrets
- **Never**: Logged, stored in artifacts, or returned by API (except env pull)

### Deployment Isolation

**Serverless functions**: Run in Cloudflare Workers V8 isolates. Per-request isolation
is guaranteed by the runtime. No cross-deployment access possible.

**Hot servers**: Run in separate Fly Machines (containers). Network isolation via
Fly's private networking. Each deployment gets its own machine. No shared process space.

**Build workers**: Ephemeral Fly Machines destroyed after each build. Fresh environment
for every build. No state leakage between builds.

**Static assets**: Stored in R2 under deployment-specific prefixes. Edge router
only serves assets for the correct deployment based on domain mapping.

### Network Security

- All external traffic over TLS 1.3 (Cloudflare edge termination)
- Internal traffic between Fly apps uses WireGuard mesh (Fly's default)
- API server to database: TLS with certificate pinning (Neon)
- API server to Redis: TLS (Upstash)
- GitHub webhooks: HMAC SHA-256 signature verification
- CORS: API server returns strict CORS headers (only app.vura.io dashboard origin)
- Rate limiting: Per-token, per-IP via Upstash Redis

### Audit Trail

All destructive operations are logged:
```
audit_log
├── id                  UUID
├── team_id             UUID
├── user_id             UUID
├── action              VARCHAR(64)  -- project.create, deployment.promote, env.update, etc.
├── resource_type       VARCHAR(64)  -- project, deployment, domain, env_var
├── resource_id         UUID
├── metadata            JSONB        -- action-specific details
├── ip_address          VARCHAR(45)
├── created_at          TIMESTAMPTZ
└── INDEX ON (team_id, created_at DESC)
```

---

## 13. Rollback Strategy

### Instant Rollbacks

Every production deployment is a complete, immutable snapshot:
- Serverless function code stored in R2
- Static assets stored in R2
- Hot server Docker image stored in Fly registry
- Route manifest stored in database

**Rollback flow**:
```
1. User clicks "Rollback to deployment X" or:
   POST api.vura.io/v1/deployments/<target_id>/rollback

2. Create new deployment record (trigger: 'rollback', points to target's artifacts)

3. For serverless routes:
   - Re-activate the CF Worker scripts from the target deployment
   - (Scripts are retained in R2, not deleted on new deploy)

4. For static assets:
   - Update edge router KV to point to target deployment's R2 prefix

5. For hot server:
   - Start a new Fly Machine from the target deployment's Docker image
   - Wait for health check
   - Update edge router KV to point to new machine
   - Stop the previous machine

6. Update edge router KV: domain → target deployment
7. Deployment status: 'ready'

Total time: < 10 seconds (serverless/static), < 30 seconds (with hot server)
```

### Artifact Retention

```
Production deployments: artifacts retained for 90 days
Preview deployments: artifacts retained for 7 days after PR close
Build logs: retained for 30 days
Runtime logs: retained for 7 days (free), 30 days (pro)
```

---

## 14. Vura Adapter for ThenJS

The open-source ThenJS repo will include a `@then/adapter-vura` package that
integrates with Vura's deployment API. This adapter is used when deploying via
`then deploy` (CLI push) rather than git-based deployment.

```typescript
// @then/adapter-vura — lives in open-source ThenJS repo

export interface VuraAdapterOptions {
  /** Vura API token (default: from ~/.vura/credentials) */
  token?: string;
  /** Team slug */
  team?: string;
  /** Project ID (default: from .vura/project.json) */
  projectId?: string;
}

export function vuraAdapter(options: VuraAdapterOptions = {}): ThenAdapter {
  return {
    name: 'vura',

    async buildEnd(ctx: AdapterBuildContext): Promise<void> {
      // 1. Package dist/ into tarball
      // 2. POST to api.vura.io/v1/deployments with tarball
      // 3. Stream deployment logs
      // 4. Print deployment URL
    },
  };
}
```

This follows the exact `ThenAdapter` interface from `@then/core/config.ts`:
```typescript
export interface ThenAdapter {
  name: string;
  buildEnd(ctx: AdapterBuildContext): Promise<void>;
}
```

The `AdapterBuildContext` provides everything Vura needs:
- `serverEntry` — path to generated hot server entry
- `clientDir` — path to static client assets
- `manifest` — the RouteManifest with all routes, kinds, and configs
- `projectRoot` — the project root
- `outDir` — the dist/ directory

---

## 15. Future Considerations

### Edge Functions

ThenJS does not currently have a concept of edge middleware. When added:
- New route kind: `edge` — runs as Cloudflare Worker at the edge
- Executes before the request reaches serverless/hot backend
- Use cases: auth checks, redirects, A/B testing, geolocation

Vura will deploy edge functions as a chained Worker that runs before
the edge router dispatches to the backend target.

### Real-Time (WebSocket) in Preview

Hot servers already support WebSocket connections. For preview deployments
with on-demand machines:
- WebSocket upgrade triggers machine start (same as HTTP)
- Edge router upgrades the connection and proxies the WebSocket to Fly Machine
- Machine idle timer resets on WebSocket message activity
- When machine stops, WebSocket connections are terminated (client must reconnect)

### Monorepo Support

ThenJS projects inside monorepos (e.g., turborepo, nx):
- `project.root_directory` specifies the package path (e.g., `apps/web`)
- Build worker `cd`s into root_directory before running `then build`
- Dependency installation happens at monorepo root
- Future: detect monorepo tool (turbo, nx) and use their build pipeline

### Multi-Region Hot Servers

Pro/enterprise feature:
- Deploy hot server machines to multiple Fly regions
- Edge router selects nearest region based on client location
- State coordination (if needed) via Redis or CRDTs
- Requires careful handling of ISR cache (per-region or shared)

### Build Concurrency & Queuing

- Free tier: 1 concurrent build per project
- Pro tier: 3 concurrent builds per project
- Builds for the same branch cancel the previous in-progress build
- Priority queue: production deploys skip ahead of preview builds

### Framework Detection

While Vura is purpose-built for ThenJS, framework detection enables graceful handling:
```
Detection order:
  1. then.config.ts exists → ThenJS (primary path)
  2. package.json has "@then/core" dependency → ThenJS
  3. next.config.js exists → Show "Vura is built for ThenJS" message with migration guide
  4. No framework detected → Generic static site (serve dist/ or build output)
```

### Usage Limits by Plan

```
                    Free            Pro             Enterprise
Bandwidth           100 GB/mo       1 TB/mo         Custom
Builds              100/mo          Unlimited       Unlimited
Build Duration      5 min max       15 min max      30 min max
Concurrent Builds   1               3               10
Serverless          100K inv/mo     Unlimited       Unlimited
Hot Server          1 prod          5 prod          Unlimited
  (preview hot)     Disabled        On-demand       On-demand
Task Invocations    1K/mo           100K/mo         Unlimited
Custom Domains      1               10              Unlimited
Team Members        1               10              Unlimited
Log Retention       1 day           30 days         90 days
Analytics           48 hours        90 days         2 years
```