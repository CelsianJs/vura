import { buildManifest } from '../../packages/core/dist/index.js';
import { lambdaAdapter } from '../../packages/adapter-lambda/dist/index.js';
import { join } from 'path';
import { readFile, rm } from 'fs/promises';

const root = process.cwd();
const manifest = await buildManifest(root);

console.log('=== Lambda Adapter Test ===');

await rm(join(root, 'dist'), { recursive: true, force: true });

const adapter = lambdaAdapter({
  region: 'us-east-1',
  memory: 256,
  timeout: 30,
  stackName: 'test-app',
  cors: {
    allowOrigins: ['https://example.com'],
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['Content-Type', 'Authorization'],
  },
});

await adapter.buildEnd({
  serverEntry: join(root, 'dist/server/entry.js'),
  clientDir: join(root, 'dist/client'),
  manifest,
  projectRoot: root,
  outDir: join(root, 'dist'),
});

// Check SAM template
const template = await readFile(join(root, 'dist/template.yaml'), 'utf-8');
console.log('\n--- SAM Template Checks ---');

// CORS should NOT be wildcard
const hasWildcardCors = template.includes('"*"');
console.log('No wildcard CORS:', !hasWildcardCors ? 'PASS' : 'FAIL');

// Should have our configured origins
const hasConfiguredOrigins = template.includes('https://example.com');
console.log('Configured CORS origins:', hasConfiguredOrigins ? 'PASS' : 'FAIL');

// Task routes should have Schedule events
const hasScheduleEvent = template.includes('Type: Schedule');
console.log('Task routes have Schedule events:', hasScheduleEvent ? 'PASS' : 'FAIL');

// Check cron conversion (0 2 * * * -> AWS format with day-of-week adjusted)
// Standard: 0 2 * * * -> AWS: 0 2 * * ? *
const hasCronExpr = template.includes('cron(');
console.log('Has cron expressions:', hasCronExpr ? 'PASS' : 'FAIL');

// Weekly report: '0 9 * * 1' -> AWS should convert day 1 to day 2 (Mon=1 in standard, Mon=2 in AWS)
const hasWeeklyCron = template.includes('cron(0 9');
console.log('Weekly cron present:', hasWeeklyCron ? 'PASS' : 'FAIL');

// Check handler files exist
const lambdaDir = join(root, 'dist/lambda');

// Check for EventBridge handling in task handler
// Note: task dir names preserve hyphens because the adapter uses urlPattern
// which converts [id] to :id but leaves hyphens in place
const taskDirs = ['task_api_tasks_daily-cleanup', 'task_api_tasks_weekly-report'];
for (const taskDir of taskDirs) {
  try {
    const handler = await readFile(join(lambdaDir, taskDir, 'index.js'), 'utf-8');
    const hasEventBridgeDetection = handler.includes('aws.events') || handler.includes('Scheduled Event');
    console.log(`${taskDir} handles EventBridge:`, hasEventBridgeDetection ? 'PASS' : 'FAIL');

    // Check route.js was copied
    const hasRouteFile = await readFile(join(lambdaDir, taskDir, 'route.js'), 'utf-8').then(() => true).catch(() => false);
    console.log(`${taskDir} has route.js:`, hasRouteFile ? 'PASS' : 'FAIL');
  } catch (e) {
    console.log(`${taskDir}: ERROR - ${e.message}`);
  }
}

// Check serverless handler files
// Note: :id in urlPattern becomes single underscore, not double
const serverlessDirs = ['api_hello_get', 'api_users_id_get', 'api_users_id_post'];
for (const dir of serverlessDirs) {
  try {
    const handler = await readFile(join(lambdaDir, dir, 'index.js'), 'utf-8');
    console.log(`${dir} handler exists: PASS`);
    const hasRouteJs = await readFile(join(lambdaDir, dir, 'route.js'), 'utf-8').then(() => true).catch(() => false);
    console.log(`${dir} has route.js: ${hasRouteJs ? 'PASS' : 'FAIL'}`);
  } catch (e) {
    console.log(`${dir}: MISSING`);
  }
}

// Check samconfig.toml
const samconfig = await readFile(join(root, 'dist/samconfig.toml'), 'utf-8');
console.log('\nsamconfig.toml has stack name:', samconfig.includes('test-app') ? 'PASS' : 'FAIL');
console.log('samconfig.toml has region:', samconfig.includes('us-east-1') ? 'PASS' : 'FAIL');

console.log('\n--- Template excerpt (CORS section) ---');
const corsSection = template.split('CorsConfiguration')[1]?.split('Resources')[0] || 'NOT FOUND';
console.log(corsSection.substring(0, 200));
