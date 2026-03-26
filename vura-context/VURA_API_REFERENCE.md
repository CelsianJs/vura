# Vura.io — API Reference Summary

> Full API design is in VURA_ARCHITECTURE.md section 9.
> Base URL: `api.vura.io/v1`
> Auth: Bearer token in `Authorization` header

---

## Authentication
```
POST   /auth/signup              — Email/password signup
POST   /auth/login               — Email/password login → JWT
GET    /auth/github              — GitHub OAuth redirect
GET    /auth/github/callback     — GitHub OAuth callback
POST   /auth/tokens              — Create API token
DELETE /auth/tokens/:id          — Revoke API token
```

## Teams
```
GET    /teams                    — List user's teams
POST   /teams                    — Create team
GET    /teams/:slug              — Get team
PATCH  /teams/:slug              — Update team
GET    /teams/:slug/members      — List members
POST   /teams/:slug/members      — Invite member
DELETE /teams/:slug/members/:uid — Remove member
```

## Projects
```
GET    /teams/:slug/projects         — List projects
POST   /teams/:slug/projects         — Create project (link git repo)
GET    /projects/:id                 — Get project
PATCH  /projects/:id                 — Update project settings
DELETE /projects/:id                 — Delete project
GET    /projects/:id/manifest        — Get latest manifest
```

## Deployments
```
GET    /projects/:id/deployments          — List deployments
POST   /projects/:id/deployments          — Create deployment (CLI push, multipart with tarball)
GET    /deployments/:id                   — Get deployment details
GET    /deployments/:id/logs              — Get build logs
GET    /deployments/:id/logs/stream       — SSE stream of build logs
POST   /deployments/:id/promote           — Promote to production
POST   /deployments/:id/rollback          — Rollback production to this deployment
DELETE /deployments/:id                   — Cancel/delete deployment
```

## Environment Variables
```
GET    /projects/:id/env                  — List env vars (values redacted)
POST   /projects/:id/env                  — Create env var
PATCH  /projects/:id/env/:varId           — Update env var
DELETE /projects/:id/env/:varId           — Delete env var
GET    /projects/:id/env/pull             — Download env vars as .env format (for CLI)
```

## Domains
```
GET    /projects/:id/domains              — List domains
POST   /projects/:id/domains              — Add custom domain
DELETE /projects/:id/domains/:domainId    — Remove domain
POST   /projects/:id/domains/:domainId/verify — Verify DNS configuration
```

## Logs & Analytics (Later)
```
GET    /projects/:id/analytics/requests   — Request volume/latency
GET    /projects/:id/analytics/errors     — Error events
GET    /deployments/:id/runtime-logs      — Runtime logs from functions/hot server
```

---

## CLI Command → API Mapping

| CLI Command | API Call |
|-------------|----------|
| `then link` | `GET /teams/:slug/projects` → select → write `.vura/project.json` |
| `then deploy` | `POST /projects/:id/deployments` (multipart tarball) |
| `then deploy --prod` | `POST /projects/:id/deployments` + `POST /deployments/:id/promote` |
| `then env pull` | `GET /projects/:id/env/pull` → write `.env.local` |
| `then env push` | `POST /projects/:id/env` (batch) |
| `then logs` | `GET /deployments/:id/logs/stream` (SSE) |
| `then rollback` | `POST /deployments/:id/rollback` |
| `then domains add` | `POST /projects/:id/domains` |

---

## Webhook Endpoints (Internal)

```
POST   /webhooks/github          — GitHub push/PR events → trigger builds
```

GitHub webhook payload handling:
- `push` to production branch → production deployment
- `push` to any other branch → preview deployment
- `pull_request.opened/synchronize` → preview deployment
- `pull_request.closed` → cleanup preview resources
