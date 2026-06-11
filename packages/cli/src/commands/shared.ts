/**
 * Shared helpers for CLI commands that need to load route module files
 * (TypeScript/JSX) at runtime without a full Vite build.
 *
 * Extracted from commands/dev.ts (Task 12) so that the tasks command can reuse
 * the same transpile-then-import flow without duplicating it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Cache-dir relative to the project root — matches where dev.ts wrote its
 * temporary modules so we don't litter multiple cache dirs.
 */
const DEV_CACHE_SUBPATH = join('node_modules', '.then-dev-cache');

/**
 * Transpile a TypeScript/JSX route file via esbuild and import it as an ES
 * module. Each call writes a uniquely-named `.mjs` file (keyed by wall-clock
 * time) so repeated loads within the same process never collide.
 *
 * @param projectRoot  Absolute path to the project root.
 * @param filePath     Path to the route file, relative to `projectRoot`.
 * @returns            The dynamically-imported module record.
 */
export async function importRouteModule(
  projectRoot: string,
  filePath: string,
): Promise<Record<string, unknown>> {
  const { build: esbuild } = await import('esbuild');

  const absPath = resolve(projectRoot, filePath);
  const isPage = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');

  // Determine JSX import source (mirrors dev.ts heuristic)
  let jsxImportSource = '@celsian/vura-core';
  try {
    // @ts-ignore — optional peer dep
    await import('what-framework/jsx-runtime');
    jsxImportSource = 'what-framework';
  } catch {
    // not installed — keep default
  }

  const result = await esbuild({
    entryPoints: [absPath],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'node',
    write: false,
    outfile: 'handler.mjs',
    ...(isPage ? { jsx: 'automatic', jsxImportSource } : {}),
  });

  const tmpDir = join(projectRoot, DEV_CACHE_SUBPATH);
  await mkdir(tmpDir, { recursive: true });

  const hash = Date.now().toString(36);
  const safeName = filePath.replace(/[/\\:]/g, '_');
  const outPath = join(tmpDir, `${safeName}_${hash}.mjs`);
  await writeFile(outPath, result.outputFiles[0]!.text);

  return import(pathToFileURL(outPath).href) as Promise<Record<string, unknown>>;
}
