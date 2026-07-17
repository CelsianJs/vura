#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { runBenchmark } from './lib/runtime-benchmark.mjs';

try {
  const args = parseArgs(process.argv.slice(2));
  const result = await runBenchmark({
    baseUrl: args.url || process.env.LAB_BASE_URL,
    sampleCount: args.samples || process.env.LAB_SAMPLES || 20,
    output: args.output || process.env.LAB_OUTPUT,
    requireCold: args.requireCold,
    portablePlacement: args.portablePlacement || process.env.LAB_PORTABLE_PLACEMENT || 'function',
    coldBootThresholdMs: args.coldBootThresholdMs || process.env.LAB_COLD_BOOT_THRESHOLD_MS,
    dedicatedIdleMs: args.dedicatedIdleMs || process.env.LAB_DEDICATED_IDLE_MS,
    requestTimeoutMs: process.env.LAB_REQUEST_TIMEOUT_MS,
    coldControl: {
      url: process.env.LAB_COLD_CONTROL_URL,
      token: process.env.LAB_COLD_CONTROL_TOKEN,
      timeoutMs: process.env.LAB_COLD_CONTROL_TIMEOUT_MS,
      allowedHosts: (process.env.LAB_COLD_CONTROL_ALLOWED_HOSTS || '')
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean),
    },
    onProgress: ({ routeName, completed, total, valid }) => {
      process.stderr.write(`[runtime-benchmark] ${routeName} ${completed}/${total}${valid ? '' : ' not-proven'}\n`);
    },
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const output = args.output || process.env.LAB_OUTPUT;
  if (output) await writeFile(output, serialized, 'utf8');
  process.stdout.write(serialized);
  if (!result.ok) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`[runtime-benchmark] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

export function parseArgs(argv) {
  const parsed = { requireCold: false };
  const valueFlags = new Set([
    '--url', '--samples', '--output', '--portable-placement',
    '--cold-boot-threshold-ms', '--dedicated-idle-ms',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') continue;
    if (arg === '--require-cold') {
      parsed.requireCold = true;
      continue;
    }
    if (!valueFlags.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    index += 1;
    if (arg === '--url') parsed.url = value;
    else if (arg === '--samples') parsed.samples = value;
    else if (arg === '--output') parsed.output = value;
    else if (arg === '--portable-placement') parsed.portablePlacement = value;
    else if (arg === '--cold-boot-threshold-ms') parsed.coldBootThresholdMs = value;
    else if (arg === '--dedicated-idle-ms') parsed.dedicatedIdleMs = value;
  }
  if (parsed.portablePlacement && !['function', 'hot'].includes(parsed.portablePlacement)) {
    throw new Error('--portable-placement must be function or hot');
  }
  return parsed;
}
