# Vura Runtime Routing Lab

This full-stack dogfood app measures Vura Function cold starts, warm Function
latency, Dedicated latency, and placement changes for one portable API route.
Every API uses the same response contract and emits a structured probe event
with a correlation ID.

## Routes

- `/api/function` — Function placement
- `/api/hot` — Dedicated placement
- `/api/portable` — begins on Function and is promoted to Dedicated, then
  demoted back to Function through the Vura control plane

The UI runs same-origin browser probes, charts response times, shows the
portable route's observed placement timeline, and filters its probe stream by
source, level, route, or correlation ID.

## Run locally

```sh
pnpm --filter vura-runtime-routing-lab dev
pnpm --filter vura-runtime-routing-lab test
pnpm --filter vura-runtime-routing-lab build
```

## Benchmark a deployment

```sh
node scripts/benchmark.mjs \
  --url https://runtime-routing-lab.example.vura.app \
  --samples 25 \
  --output runtime-evidence.json
```

The benchmark writes one JSON document to stdout and sends progress to stderr.
It rejects zero or fractional sample counts, non-JSON and non-200 responses,
wrong route placement, and correlation mismatches. Each route reports p50,
p90, p95, median absolute deviation, coefficient of variation, failures, boot
IDs, observed placements, and `cold`, `warm`, or `not_proven` classifications.

Ordinary Dedicated samples remain `warm`, including the first request. To prove
that a Dedicated runtime survives a known idle window, ask the harness to wait
between two probes. The result is reported separately as `dedicatedIdleProof`
and is labeled `idle` only when both probes are valid Dedicated responses on the
same boot, with boot age covering the requested window:

```sh
node scripts/benchmark.mjs \
  --url https://runtime-routing-lab.example.vura.app \
  --samples 25 \
  --dedicated-idle-ms 600000 \
  --json
```

When `--dedicated-idle-ms` or `LAB_DEDICATED_IDLE_MS` is configured, a failed
idle proof makes the benchmark exit nonzero even if the ordinary route samples
all pass.

The first request is never assumed to be cold. To require real cold evidence,
configure an authenticated control hook that stops or replaces the Function
runtime, then use strict mode:

```sh
LAB_COLD_CONTROL_URL=https://control.example/internal/replace-function \
LAB_COLD_CONTROL_TOKEN="$VURA_CONTROL_TOKEN" \
LAB_COLD_CONTROL_ALLOWED_HOSTS=control.example \
LAB_REQUEST_TIMEOUT_MS=30000 \
LAB_COLD_CONTROL_TIMEOUT_MS=30000 \
node scripts/benchmark.mjs \
  --url https://runtime-routing-lab.example.vura.app \
  --samples 25 \
  --require-cold \
  --json
```

The control URL, bearer token, and trusted host list are accepted only from
`LAB_COLD_CONTROL_URL`, `LAB_COLD_CONTROL_TOKEN`, and
`LAB_COLD_CONTROL_ALLOWED_HOSTS`. There are no control configuration
command-line flags that can leak through shell history or process lists. The
control URL must use HTTPS, and its exact host must be listed explicitly in the
trusted host list. The workload target host is not trusted automatically.
Redirects are rejected before credentials can be sent to another host.

The control hook receives a bearer-authenticated `POST` with the route and
pre-control boot ID. Its mutation response contract is:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "action": "replace_function_runtime",
  "operationId": "provider-operation-id",
  "leaseExpiresAt": "2026-07-17T20:05:00.000Z"
}
```

`leaseExpiresAt` is mandatory proof that the control service created a
server-side expiring mutation lease. It must leave room for the post-mutation
probe plus cleanup and may be no more than 15 minutes in the future. The
control service must automatically restore or destroy replacement resources
when the lease expires, even if the benchmark process or host crashes. The
harness will not run the post-mutation probe when this lease proof is absent,
invalid, too short, or too long.

After the first request on the replacement runtime, the harness sends a second
authenticated `POST` to the same allowlisted control URL with
`action: "restore_function_runtime"`, the operation ID, route, and before/after
boot IDs. The cleanup response contract is:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "action": "restore_function_runtime",
  "operationId": "provider-operation-id",
  "remaining": []
}
```

The evidence reports cleanup as required, attempted, passed, and empty only
after that exact authenticated response succeeds. Missing, rejected, timed-out,
or non-empty cleanup makes the entire benchmark fail. Cold is proven only when
the mutation succeeds and the following request is a 200 Function response
with an exact correlation match, a different boot ID, request ordinal 1, boot
age at or below the configured threshold, and positive wake work. Missing any
signal produces `not_proven`; `--require-cold` then exits nonzero. Runtime probes
and control calls each carry bounded abort signals; configured network
deadlines cannot exceed five minutes. Tokens and the control URL are not
included in the evidence JSON. Once a mutation is acknowledged, cleanup runs
from a `finally` block. SIGINT and SIGTERM also trigger the same memoized
best-effort cleanup request. Those process handlers complement the required
server-side expiring lease; they cannot replace it because a hard process or
host crash cannot execute JavaScript cleanup.

The benchmark cleanup evidence retains the provider `operationId` after a
required cleanup attempt so consumers can prove it matches
`coldProof.control.operationId`. When no provider mutation occurred, cleanup is
`not_applicable` and its `operationId` is `null`.
