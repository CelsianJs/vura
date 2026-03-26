# Vura.io — Data Model Summary

> Quick reference for all entities. Full schemas with field types are in VURA_ARCHITECTURE.md section 2.

---

## Core Entities

### users
User accounts. Email/password + GitHub OAuth.
- `id`, `email`, `name`, `password_hash`, `github_id`, `github_username`, `github_access_token`, `avatar_url`, `created_at`, `last_login_at`

### teams
Organizations that own projects. Every user has a personal team.
- `id`, `name`, `slug` (URL-safe), `owner_id`, `plan` (free/pro/enterprise), `created_at`

### team_members
Join table: users in teams with roles.
- `team_id`, `user_id`, `role` (owner/admin/member), `invited_by`, `joined_at`

### projects
A ThenJS project linked to a git repo.
- `id`, `team_id`, `name`, `slug`, `repo_url`, `repo_provider` (github/gitlab), `repo_id`, `production_branch` (default: main), `root_directory` (default: /), `node_version` (default: 20), `build_command` (default: then build), `install_command` (default: pnpm install), `framework` (default: thenjs), `created_at`

### deployments
Immutable deployment snapshots. Every build produces one.
- `id`, `project_id`, `git_ref` (branch/tag), `git_sha`, `git_message`, `trigger` (push/manual/rollback/promote), `triggered_by`, `status` (queued/building/deploying/ready/failed/cancelled), `build_duration_ms`, `artifact_url` (R2 path), `manifest_snapshot` (JSONB — frozen RouteManifest), `env_snapshot_hash`, `preview_url`, `created_at`, `ready_at`
- Relation: `is_production BOOLEAN` — true if this is the current production deployment

### domains
Custom domains pointed at a project's production deployment.
- `id`, `project_id`, `domain`, `type` (apex/subdomain), `dns_configured` (verified), `ssl_status` (pending/active/failed), `ssl_issued_at`, `created_at`

### environment_variables
Per-project env vars with scope.
- `id`, `project_id`, `key`, `encrypted_value`, `scope` (production/preview/development), `created_at`, `updated_at`

### build_logs
Streaming build output stored per deployment.
- `id`, `deployment_id`, `timestamp`, `level` (info/warn/error), `message`

### api_tokens
For CLI and CI/CD.
- `id`, `user_id`, `name`, `token_hash`, `scopes` (array), `last_used_at`, `expires_at`, `created_at`

### cron_jobs
One per task route with a schedule.
- `id`, `deployment_id`, `project_id`, `task_name`, `schedule` (cron expr), `target_url` (CF Worker URL), `enabled`, `last_run_at`, `next_run_at`, `created_at`

### deployment_resources
Maps a deployment to its live infrastructure.
- `id`, `deployment_id`, `resource_type` (worker/machine/r2_bucket/cron_job), `resource_id` (CF worker ID / Fly machine ID), `route_pattern`, `route_kind`, `status`, `created_at`

---

## Analytics Entities (Schema Now, Implement Later)

### request_logs
Per-request telemetry from edge router.
- `id`, `project_id`, `deployment_id`, `timestamp`, `method`, `path`, `status_code`, `latency_ms`, `route_kind`, `region`, `user_agent`, `cache_status` (hit/miss/stale)

### build_metrics
Build performance tracking.
- `id`, `deployment_id`, `project_id`, `install_duration_ms`, `build_duration_ms`, `deploy_duration_ms`, `total_duration_ms`, `artifact_size_bytes`, `route_count`, `page_count`, `cache_hit` (deps cached)

### error_events
Runtime errors captured from functions and hot servers.
- `id`, `project_id`, `deployment_id`, `timestamp`, `route_pattern`, `route_kind`, `error_message`, `stack_trace`, `request_path`, `request_method`

### usage_records
Billing-relevant usage (aggregated hourly).
- `id`, `team_id`, `project_id`, `period_start`, `period_end`, `metric` (bandwidth_bytes/function_invocations/build_minutes/hot_server_seconds), `value`

---

## Key Relationships

```
team ──< team_members >── user
team ──< projects
project ──< deployments
project ──< domains
project ──< environment_variables
project ──< cron_jobs
deployment ──< build_logs
deployment ──< deployment_resources
deployment ──< request_logs
deployment ──< error_events
user ──< api_tokens
team ──< usage_records
```

---

## Indexes to Plan

- `deployments(project_id, created_at DESC)` — latest deployments per project
- `deployments(project_id, is_production)` — find current production
- `domains(domain)` UNIQUE — domain lookup for routing
- `cron_jobs(enabled, next_run_at)` — cron scheduler polling
- `request_logs(project_id, timestamp)` — analytics queries (partition by month)
- `environment_variables(project_id, scope)` — env var lookup
- `api_tokens(token_hash)` — token auth lookup
