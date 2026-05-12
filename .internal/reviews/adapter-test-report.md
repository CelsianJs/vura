# ThenJS Adapter Test Report

**Date:** 2026-03-13
**Test project:** `examples/adapter-test/`

## Test Setup

Created a minimal ThenJS project with:
- 2 serverless API routes (`/api/hello`, `/api/users/:id`)
- 1 hot route (`/api/stream`) -- should be excluded from serverless output
- 2 task routes with cron schedules (`/api/tasks/daily-cleanup`, `/api/tasks/weekly-report`)
- 1 page (`/`)

## Cloudflare Adapter Results

| Test | Result |
|------|--------|
| Routes found (5 API) | PASS |
| Pages found (1) | PASS |
| Cron triggers in wrangler.toml | PASS |
| Has `scheduled()` handler | PASS |
| Has task route imports | PASS |
| Safe `decodeURIComponent` (try/catch) | PASS |
| Hot routes excluded from routes table | PASS |
| `dist/cloudflare/entry.js` exists | PASS |
| `dist/cloudflare/wrangler.toml` exists | PASS |
| Generated entry has `scheduled` handler | PASS |
| Generated entry has `fetch` handler | PASS |

**All 11 Cloudflare checks passed.**

### Generated wrangler.toml

```toml
name = "test-app"
main = "entry.js"
compatibility_date = "2024-12-01"

# Cron Triggers
[triggers]
crons = ["0 2 * * *", "0 9 * * 1"]
```

### Key observations

- The `hot` route (`/api/stream`) is correctly excluded from the routes table -- only `serverless` routes are wired up.
- Both task routes are imported and registered in a `taskRoutes` array with their schedule strings.
- The `scheduled()` handler iterates all task routes and invokes their POST handlers with a synthetic job object.
- Parameter extraction uses `try { decodeURIComponent(...) } catch { ... }` for safety against malformed URIs.
- Import paths are relative from `dist/cloudflare/` back to `src/api/`, which is correct for the worker bundler.

## Lambda Adapter Results

| Test | Result |
|------|--------|
| No wildcard CORS (`"*"` absent) | PASS |
| Configured CORS origins (`https://example.com`) | PASS |
| Task routes have `Type: Schedule` events | PASS |
| Has `cron()` expressions | PASS |
| Weekly cron present (`cron(0 9`) | PASS |
| `task_api_tasks_daily-cleanup` handles EventBridge | PASS |
| `task_api_tasks_daily-cleanup` has route.js | PASS |
| `task_api_tasks_weekly-report` handles EventBridge | PASS |
| `task_api_tasks_weekly-report` has route.js | PASS |
| `api_hello_get` handler exists | PASS |
| `api_hello_get` has route.js | PASS |
| `api_users_id_get` handler exists | PASS |
| `api_users_id_get` has route.js | PASS |
| `api_users_id_post` handler exists | PASS |
| `api_users_id_post` has route.js | PASS |
| samconfig.toml has stack name | PASS |
| samconfig.toml has region | PASS |

**All 17 Lambda checks passed.**

### Cron conversion verification

| Input (standard) | Output (AWS) | Correct? |
|---|---|---|
| `0 2 * * *` (daily at 2 AM) | `cron(0 2 * * ? *)` | Yes -- `*` day-of-week becomes `?` when day-of-month is `*` |
| `0 9 * * 1` (Mon at 9 AM) | `cron(0 9 ? * 2 *)` | Yes -- standard Mon=1 -> AWS Mon=2, day-of-month becomes `?` |

### Generated SAM template structure

- **API Gateway:** `AWS::Serverless::HttpApi` with correct CORS config (specific origins, not wildcards)
- **Serverless functions:** 3 functions (GET hello, GET users/{id}, POST users/{id}) each with `HttpApi` events
- **Task functions:** 2 functions (daily-cleanup, weekly-report) each with `Schedule` events and cron triggers
- **Task timeouts:** Correctly derived from route config (`timeout: 60000` -> SAM `Timeout: 60`, `timeout: 120000` -> SAM `Timeout: 120`)
- **Output:** API Gateway URL via `!Sub`

### Generated handler files

Each Lambda function directory contains:
- `index.js` -- self-contained handler with inline `eventToRequest`, `parseBody`, `responseToResult` utilities
- `route.js` -- copy of the source route file

Task handlers include EventBridge detection:
```js
if (event.source === 'aws.events' || event['detail-type'] === 'Scheduled Event') { ... }
```

### Hot route handling

The `hot` route (`/api/stream`) is correctly excluded from both adapters:
- **Cloudflare:** Not in the routes table, not included in entry.js route matching
- **Lambda:** Not generated as a Lambda function, not in SAM template

Hot routes are intended for persistent/streaming servers (not serverless), so this exclusion is correct.

## Summary

**28/28 tests passed.** Both adapters correctly:

1. Scan the manifest and filter routes by `kind`
2. Generate deployment-ready output files (wrangler.toml / SAM template)
3. Handle task routes with cron schedules (Cloudflare triggers / EventBridge rules)
4. Exclude hot routes from serverless deployment artifacts
5. Convert cron expressions between standard and AWS formats
6. Apply user-specified CORS configuration without wildcards
7. Generate self-contained handler files with no runtime framework dependency
8. Copy route source files alongside generated handlers
