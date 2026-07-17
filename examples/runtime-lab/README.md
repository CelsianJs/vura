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

For a deterministic cold-start sample, stop the lab's Function machine before
running the benchmark. The first Function result records Vura's wake timing
header when the platform wakes a stopped instance.

