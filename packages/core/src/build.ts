/**
 * ThenJS Build Pipeline
 *
 * Takes a route manifest and produces deployment-ready output:
 * 1. Server bundle (CelsianJS app that handles API routes + SSR pages)
 * 2. Client bundle (static assets for CDN)
 * 3. Function bundles (one per serverless route, for Lambda/Workers)
 *
 * The adapter then takes these artifacts and generates platform-specific config.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import type { RouteManifest, ApiRoute } from './manifest.js';
import type { ThenConfig, AdapterBuildContext } from './config.js';

// ─── Server Entry Generator ───

/**
 * Generate a CelsianJS server entry that registers all routes from the manifest.
 * This is the "hot server" entry — runs on Fly/Railway/etc.
 */
export function generateServerEntry(manifest: RouteManifest, projectRoot: string): string {
  const imports: string[] = [
    `import { createApp, serve } from '@celsian/core';`,
  ];
  const registrations: string[] = [];

  for (const route of manifest.api) {
    const varName = routeToVarName(route);
    const importPath = `./${relative('dist/server', join(projectRoot, route.filePath))}`.replace(/\.ts$/, '.js');
    imports.push(`import * as ${varName} from '${importPath}';`);

    for (const method of route.methods) {
      const celsianMethod = method.toLowerCase();
      registrations.push(
        `app.${celsianMethod}('${route.urlPattern}', { kind: '${route.kind}' }, (req, reply) => ${varName}.${method}(req, reply));`,
      );
    }
  }

  return `${imports.join('\n')}

const app = createApp({
  logger: true,
  trustProxy: true,
});

// Register API routes
${registrations.join('\n')}

// Health check
app.get('/__health', (req, reply) => reply.json({ ok: true }));

const port = parseInt(process.env.PORT || '3000', 10);
serve(app, { port });
console.log(\`ThenJS server listening on :\${port}\`);
`;
}

// ─── Serverless Function Generator ───

/**
 * Generate a standalone Lambda/Worker handler for a single API route.
 * Each serverless route gets its own entry point for independent deployment.
 */
export function generateFunctionEntry(route: ApiRoute, projectRoot: string): string {
  const importPath = `./${relative('dist/functions', join(projectRoot, route.filePath))}`.replace(/\.ts$/, '.js');
  const varName = routeToVarName(route);

  return `import { createApp } from '@celsian/core';
import * as ${varName} from '${importPath}';

const app = createApp();

${route.methods.map(method => {
    const celsianMethod = method.toLowerCase();
    return `app.${celsianMethod}('${route.urlPattern}', (req, reply) => ${varName}.${method}(req, reply));`;
  }).join('\n')}

// Export the app's fetch handler for serverless runtimes
export default { fetch: (request: Request) => app.handle(request) };

// Also export for AWS Lambda
export const handler = async (event: unknown, context: unknown) => {
  const { createLambdaHandler } = await import('@celsian/adapter-lambda');
  return createLambdaHandler(app)(event, context);
};
`;
}

// ─── Build Orchestrator ───

export interface BuildResult {
  serverEntry: string;
  functions: { route: ApiRoute; entryPath: string }[];
  manifest: RouteManifest;
}

/**
 * Run the ThenJS build pipeline.
 *
 * 1. Generate server entry (for hot server deployment)
 * 2. Generate function entries (for serverless deployment)
 * 3. Write manifest.json
 * 4. Run adapter.buildEnd() if configured
 */
export async function build(
  manifest: RouteManifest,
  config: ThenConfig,
  projectRoot: string,
): Promise<BuildResult> {
  const outDir = join(projectRoot, 'dist');
  const serverDir = join(outDir, 'server');
  const functionsDir = join(outDir, 'functions');

  // Ensure output directories
  await mkdir(serverDir, { recursive: true });
  await mkdir(functionsDir, { recursive: true });

  // 1. Generate server entry
  const serverEntryCode = generateServerEntry(manifest, projectRoot);
  const serverEntryPath = join(serverDir, 'entry.js');
  await writeFile(serverEntryPath, serverEntryCode);

  // 2. Generate function entries for serverless routes
  const functions: BuildResult['functions'] = [];
  const serverlessRoutes = manifest.api.filter(r => r.kind === 'serverless');

  for (const route of serverlessRoutes) {
    const funcName = route.urlPattern.replace(/[/:*]/g, '_').replace(/^_/, '');
    const funcDir = join(functionsDir, funcName);
    await mkdir(funcDir, { recursive: true });

    const entryCode = generateFunctionEntry(route, projectRoot);
    const entryPath = join(funcDir, 'index.js');
    await writeFile(entryPath, entryCode);

    functions.push({ route, entryPath });
  }

  // 3. Write manifest
  await writeFile(
    join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  // 4. Run adapter if configured
  if (config.adapter) {
    const ctx: AdapterBuildContext = {
      serverEntry: serverEntryPath,
      clientDir: join(outDir, 'client'),
      manifest,
      projectRoot,
      outDir,
    };
    await config.adapter.buildEnd(ctx);
  }

  return { serverEntry: serverEntryPath, functions, manifest };
}

// ─── Helpers ───

function routeToVarName(route: ApiRoute): string {
  return 'route_' + route.urlPattern
    .replace(/^\//, '')
    .replace(/[/:*\-]/g, '_')
    .replace(/_+/g, '_');
}
