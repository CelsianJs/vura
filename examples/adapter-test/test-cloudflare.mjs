import { buildManifest } from '../../packages/core/dist/index.js';
import { cloudflareAdapter, generateWranglerToml, generateWorkerEntry } from '../../packages/adapter-cloudflare/dist/index.js';
import { join } from 'path';
import { readFile, rm, mkdir } from 'fs/promises';

const root = process.cwd();
const manifest = await buildManifest(root);

console.log('=== Cloudflare Adapter Test ===');
console.log('Routes found:', manifest.api.length);
console.log('Pages found:', manifest.pages.length);

// Test wrangler.toml generation
const taskRoutes = manifest.api.filter(r => r.kind === 'task');
const toml = generateWranglerToml({ name: 'test-app', compatibilityDate: '2024-12-01' }, manifest.api.filter(r => r.kind === 'serverless'), taskRoutes);
console.log('\n--- wrangler.toml ---');
console.log(toml);

// Verify cron triggers are present
if (taskRoutes.length > 0) {
  const hasCrons = toml.includes('[triggers]') && toml.includes('crons');
  console.log('Cron triggers in wrangler.toml:', hasCrons ? 'PASS' : 'FAIL');
}

// Test worker entry generation
const workerEntry = generateWorkerEntry(
  manifest.api.filter(r => r.kind === 'serverless'),
  root,
  join(root, 'dist/cloudflare'),
  taskRoutes,
);
console.log('\n--- Worker Entry Checks ---');

// Check for scheduled handler
const hasScheduled = workerEntry.includes('async scheduled(');
console.log('Has scheduled handler:', hasScheduled ? 'PASS' : 'FAIL');

// Check for task route imports
const hasTaskImports = workerEntry.includes('daily_cleanup') || workerEntry.includes('daily-cleanup');
console.log('Has task route imports:', hasTaskImports ? 'PASS' : 'FAIL');

// Check for safe decodeURIComponent
const hasSafeDecode = workerEntry.includes('try { params[name] = decodeURIComponent');
console.log('Safe decodeURIComponent:', hasSafeDecode ? 'PASS' : 'FAIL');

// Check that hot routes are NOT in the routes table
const hasHotInRoutes = workerEntry.includes("'/api/stream'");
console.log('Hot routes excluded from routes table:', !hasHotInRoutes ? 'PASS' : 'FAIL');

// Run the full adapter buildEnd
await rm(join(root, 'dist'), { recursive: true, force: true });
const adapter = cloudflareAdapter({ name: 'test-app', compatibilityDate: '2024-12-01' });
await adapter.buildEnd({
  serverEntry: join(root, 'dist/server/entry.js'),
  clientDir: join(root, 'dist/client'),
  manifest,
  projectRoot: root,
  outDir: join(root, 'dist'),
});

// Verify output files
const entryExists = await readFile(join(root, 'dist/cloudflare/entry.js'), 'utf-8').then(() => true).catch(() => false);
const tomlExists = await readFile(join(root, 'dist/cloudflare/wrangler.toml'), 'utf-8').then(() => true).catch(() => false);
console.log('\ndist/cloudflare/entry.js exists:', entryExists ? 'PASS' : 'FAIL');
console.log('dist/cloudflare/wrangler.toml exists:', tomlExists ? 'PASS' : 'FAIL');

// Read and verify generated entry
if (entryExists) {
  const entry = await readFile(join(root, 'dist/cloudflare/entry.js'), 'utf-8');
  console.log('Generated entry has scheduled handler:', entry.includes('scheduled') ? 'PASS' : 'FAIL');
  console.log('Generated entry has fetch handler:', entry.includes('async fetch(') ? 'PASS' : 'FAIL');
}
