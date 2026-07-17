#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

const args = parseArgs(process.argv.slice(2));
const baseUrl = (args.url || process.env.LAB_BASE_URL || '').replace(/\/+$/, '');
const sampleCount = Number(args.samples || process.env.LAB_SAMPLES || 20);
const output = args.output || process.env.LAB_OUTPUT || '';

if (!baseUrl) {
  console.error('Usage: node scripts/benchmark.mjs --url https://project.vura.app [--samples 20] [--output evidence.json]');
  process.exit(1);
}

const routes = {
  function: '/api/function',
  hot: '/api/hot',
  portable: '/api/portable',
};

const candidateCold = await measure('function', 1);
const results = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  sampleCount,
  functionColdCandidate: candidateCold[0],
  functionWarm: summarize(await measure('function', sampleCount)),
  hotWarm: summarize(await measure('hot', sampleCount)),
  portable: summarize(await measure('portable', sampleCount)),
};

const serialized = `${JSON.stringify(results, null, 2)}\n`;
if (output) await writeFile(output, serialized, 'utf8');
process.stdout.write(serialized);

async function measure(source, count) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const correlationId = `bench-${source}-${crypto.randomUUID()}`;
    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}${routes[source]}`, {
      cache: 'no-store',
      headers: { 'x-lab-correlation-id': correlationId },
    });
    const ttfbMs = performance.now() - startedAt;
    const body = await response.json();
    const totalMs = performance.now() - startedAt;
    const wakeHeader = response.headers.get('x-vura-function-wake-ms');
    samples.push({
      source,
      status: response.status,
      totalMs,
      ttfbMs,
      wakeMs: wakeHeader == null ? null : Number(wakeHeader),
      observedRuntime: response.headers.get('x-vura-route-kind') || response.headers.get('x-vura-runtime') || body.runtimeIntent || 'unknown',
      correlationId: body.correlationId || correlationId,
      requestId: response.headers.get('x-vura-request-id') || body.requestId || null,
      bootId: body.bootId,
      bootAgeMs: body.bootAgeMs,
      requestOrdinal: body.requestOrdinal,
      handlerVersion: body.handlerVersion,
    });
  }
  return samples;
}

function summarize(samples) {
  const values = samples.map((sample) => sample.totalMs).sort((left, right) => left - right);
  return {
    count: samples.length,
    ok: samples.every((sample) => sample.status === 200 && sample.handlerVersion === 1),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    minMs: values[0] ?? null,
    maxMs: values.at(-1) ?? null,
    runtimeKinds: [...new Set(samples.map((sample) => sample.observedRuntime))],
    bootIds: [...new Set(samples.map((sample) => sample.bootId))],
    samples,
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--url') parsed.url = argv[++index];
    else if (argv[index] === '--samples') parsed.samples = argv[++index];
    else if (argv[index] === '--output') parsed.output = argv[++index];
  }
  return parsed;
}
