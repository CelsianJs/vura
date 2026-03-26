/**
 * Benchmark: @then/compiler-native vs @then/compiler
 *
 * Usage:
 *   node bench/bench.js
 *
 * Requires both packages to be built first:
 *   cd packages/compiler-native && npm run build
 *   cd packages/compiler && tsc
 */

import { performance } from 'node:perf_hooks';

// Sample route source files of varying complexity
const sources = {
  simple: `
    export const route = { kind: 'serverless' };
    export function GET(req, reply) { return reply.json({ hello: 'world' }); }
  `,
  medium: `
    export const route = { kind: 'hot', timeout: 5000 };
    export async function GET(req, reply) {
      const data = await fetchData(req.params.id);
      return reply.json(data);
    }
    export async function POST(req, reply) {
      const result = await createItem(req.parsedBody);
      return reply.status(201).json(result);
    }
    export async function DELETE(req, reply) {
      await deleteItem(req.params.id);
      return reply.status(204).send('');
    }
  `,
  task: `
    export const route = { kind: 'task', schedule: '*/5 * * * *', retries: 3, timeout: 30000 };
    export async function POST(job) {
      const { taskId, input, attempt } = job;
      console.log('Processing task', taskId, 'attempt', attempt);
      const result = await processJob(input);
      return { success: true, result };
    }
  `,
  page: `
    export const page = { mode: 'server', title: 'Dashboard', revalidate: 60 };
    export async function getServerData(ctx) {
      const data = await fetch('/api/stats');
      return { stats: await data.json(), url: ctx.url };
    }
    export default function DashboardPage({ stats, url }) {
      return <div class="dashboard"><h1>Stats for {url}</h1></div>;
    }
  `,
};

async function runBenchmark(scanFn, name, iterations = 1000) {
  const results = {};

  for (const [sourceName, source] of Object.entries(sources)) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      scanFn(source, 'ts');
    }
    const elapsed = performance.now() - start;
    results[sourceName] = {
      total: elapsed.toFixed(2) + 'ms',
      perOp: (elapsed / iterations * 1000).toFixed(2) + 'μs',
    };
  }

  console.log(`\n  ${name} (${iterations} iterations):`);
  for (const [sourceName, timing] of Object.entries(results)) {
    console.log(`    ${sourceName.padEnd(10)} total: ${timing.total.padStart(10)}  per-op: ${timing.perOp.padStart(10)}`);
  }

  return results;
}

async function main() {
  console.log('ThenJS Compiler Benchmark\n');

  // JS fallback
  let jsScan;
  try {
    const jsCompiler = await import('../../compiler/src/index.js');
    jsScan = jsCompiler.scanRoute;
  } catch (e) {
    console.log('  JS compiler not available:', e.message);
  }

  // Native
  let nativeScan;
  try {
    const native = await import('../index.js');
    nativeScan = native.scanRoute;
  } catch (e) {
    console.log('  Native compiler not available:', e.message);
    console.log('  Build it first: cd packages/compiler-native && npm run build\n');
  }

  const iterations = [100, 500, 1000];

  for (const n of iterations) {
    console.log(`\n--- ${n} iterations ---`);

    if (jsScan) {
      await runBenchmark(jsScan, 'JS (regex)', n);
    }

    if (nativeScan) {
      await runBenchmark(nativeScan, 'Native (Rust/SWC)', n);
    }
  }

  if (jsScan && nativeScan) {
    console.log('\n  Speedup (native vs JS) at 1000 iterations:');
    const jsResults = await runBenchmark(jsScan, 'JS', 1000);
    const nativeResults = await runBenchmark(nativeScan, 'Native', 1000);

    for (const key of Object.keys(sources)) {
      const jsTime = parseFloat(jsResults[key].total);
      const nativeTime = parseFloat(nativeResults[key].total);
      const speedup = (jsTime / nativeTime).toFixed(1);
      console.log(`    ${key.padEnd(10)} ${speedup}x faster`);
    }
  }
}

main().catch(console.error);
