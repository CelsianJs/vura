# Vura deterministic build matrix

This harness generates source fixtures and compiles them through the real
Vura CLI. It covers all 15 combinations of Small, Medium, and Large projects
with Static, Function, Dedicated, Task, and Hybrid workloads. It never emits
or accepts an Edge placement.

## Workload contract

| Workload | Small | Medium | Large |
| --- | --- | --- | --- |
| Static | 1 page, 100 KiB asset | 10 pages, 5 MiB asset | 50 pages, 50 MiB asset |
| Function | 1 endpoint | 10 endpoints | 50 endpoints |
| Dedicated | 1 endpoint | 10 endpoints, 1 WebSocket | 50 endpoints, 1 WebSocket, 1 stream |
| Task | 1 task | 10 tasks | 50 tasks |
| Hybrid | 4 pages, 1 Function, 1 Dedicated, 2 tasks | 10 pages, 10 Functions, 5 Dedicated, 5 tasks | 50 pages, 50 Functions, 25 Dedicated, 25 tasks |

Hybrid assets use the same size tier as Static. Hybrid page modes are split
explicitly in the generated contract. The named seed, exact source counts,
asset checksum, current workspace package versions, source checksum, and build
output checksum are stored for every cell.

## Run

From a clone, first install the workspace prerequisites with the pinned package
manager (`pnpm install --frozen-lockfile`) on a supported Node version. This
benchmarks the current workspace source; it is not a fresh registry installation
benchmark and performs no network installs.

```sh
node benchmarks/build-matrix/run.mjs --json
```

Select cells when iterating:

```sh
node benchmarks/build-matrix/run.mjs \
  --cells small-static,medium-function,large-hybrid \
  --output /tmp/vura-build-matrix.json \
  --cell-timeout-ms 900000 \
  --bootstrap-timeout-ms 300000 \
  --json
```

The command sends progress and build diagnostics to stderr. Stdout is exactly
one sanitized JSON document. It does not include temporary filesystem paths or
raw build logs. When invoking it through pnpm and redirecting stdout, use
`pnpm --silent benchmark:build-matrix` so pnpm's script banner is suppressed.

Each cell is regenerated from scratch, checked against its source checksum,
built with the current workspace CLI through `vura build`, and checked against the expected
manifest counts, placements, features, asset bytes, and checksums. Any mismatch
exits nonzero rather than producing a passing result.

Before timing any cell, the harness runs an incremental TypeScript build for
the CLI and its project references. This bootstrap time is intentionally
excluded from fixture build durations, so stale ignored `dist/` output cannot
silently benchmark an older CLI revision.

Each newly owned fixture receives a `node_modules` directory link (a junction
on Windows) to the current CLI's installed workspace dependency closure. This
lets build-time page imports resolve the same What and workspace core packages
even when the default fixture directory is outside the checkout. The harness
never installs dependencies or changes a custom fixture root's dependency
directory. Dependency contents are explicitly excluded from fixture source
checksums; generated source, route counts and assets remain checked.

`bootstrapDurationMs` records the framework CLI source bootstrap separately.
Each cell's `setupDurationMs` includes source/asset generation, dependency linking
and source validation. Both are excluded from `durationMs`, which measures the
real app build subprocess. Resolved What Framework and Celsian Core versions
are included in `toolRevision` and fixture contracts. Filesystem caches are not
flushed, and dependency installation is not included in these app build timings.

Temporary generated fixtures are removed on both success and failure. Pass
`--fixtures-root <path>` only when you intentionally want to keep them for
inspection. Existing cell directories are replaced only when they contain the
matching `.vura-build-matrix-owned.json` ownership marker. The harness refuses
to recursively delete an unmarked directory. The harness also rejects symlink
fixture cells and custom fixture roots. Every CLI bootstrap and cell build has
a bounded timeout; timed-out process groups receive `SIGTERM`, then
`SIGKILL` after a short grace period, before temporary-root cleanup runs. The
timeouts can also be set with `VURA_BUILD_MATRIX_CELL_TIMEOUT_MS` and
`VURA_BUILD_MATRIX_BOOTSTRAP_TIMEOUT_MS`; process deadlines cannot exceed one
hour.
