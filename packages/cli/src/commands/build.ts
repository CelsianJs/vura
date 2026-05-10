/**
 * `then build` — Build the project for deployment.
 *
 * 1. Scan routes → build manifest
 * 2. Generate server entry (for hot server)
 * 3. Generate function entries (for serverless)
 * 4. Generate task entries (for task routes)
 * 5. Bundle server-mode pages with esbuild
 * 6. Render static pages (mode: 'static')
 * 7. Run adapter.buildEnd() if configured
 * 8. Write manifest.json
 */

import { buildManifest, build, renderStaticPages } from '@then/core';
import { loadConfig } from '../config-loader.js';

export async function buildCommand(_args: string[]): Promise<void> {
  const startTime = Date.now();
  const projectRoot = process.cwd();

  console.log('\n  then build\n');

  // 1. Load config
  const config = await loadConfig(projectRoot);
  const root = config.root ?? projectRoot;
  console.log(`  Root: ${root}`);

  // 2. Scan routes
  console.log('  Scanning routes...');
  const manifest = await buildManifest(root);

  const serverlessCount = manifest.api.filter(r => r.kind === 'serverless').length;
  const hotCount = manifest.api.filter(r => r.kind === 'hot').length;
  const taskCount = manifest.api.filter(r => r.kind === 'task').length;

  console.log(`  Found ${manifest.api.length} API routes (${serverlessCount} serverless, ${hotCount} hot, ${taskCount} task)`);
  console.log(`  Found ${manifest.pages.length} pages`);

  // Shared esbuild helpers
  const { build: esbuild } = await import('esbuild');
  const { join, resolve } = await import('node:path');
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const { existsSync } = await import('node:fs');

  // Determine JSX import source: prefer what-framework, fall back to @then/core
  let jsxImportSource = '@then/core';
  try {
    // @ts-ignore — optional dependency
    await import('what-framework/jsx-runtime');
    jsxImportSource = 'what-framework';
    console.log('  Using What Framework JSX runtime');
  } catch {
    console.log('  Using built-in JSX runtime');
  }

  // Plugin to help esbuild resolve ESM-only package exports
  function findNodeModules(pkg: string): string {
    let pkgDir = join(root, 'node_modules', pkg);
    if (existsSync(pkgDir)) return pkgDir;
    let dir = root;
    for (let depth = 0; depth < 5; depth++) {
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
      const candidate = join(dir, 'node_modules', pkg);
      if (existsSync(candidate)) return candidate;
    }
    return pkgDir;
  }

  const esmResolvePlugin = {
    name: 'esm-resolve',
    setup(build: any) {
      build.onResolve({ filter: /^what-(framework|core)\// }, (args: any) => {
        const parts = args.path.split('/');
        const pkg = parts[0];
        const subpath = parts.slice(1).join('/');
        const pkgDir = findNodeModules(pkg);
        const candidates = [
          join(pkgDir, 'src', subpath + '.js'),
          join(pkgDir, 'src', subpath, 'index.js'),
        ];
        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            return { path: candidate };
          }
        }
        return null;
      });
    },
  };

  // 3. Bundle server-mode pages
  const serverPages = manifest.pages.filter(p => p.mode === 'server' || p.mode === 'hybrid');
  if (serverPages.length > 0) {
    console.log(`  Bundling ${serverPages.length} server-mode pages...`);
    const serverPagesDir = join(root, 'dist', 'server', 'pages');
    await mkdir(serverPagesDir, { recursive: true });

    for (const page of serverPages) {
      const absPath = resolve(root, page.filePath);
      const outFile = page.filePath.replace(/^src\/pages\//, '').replace(/\.tsx?$/, '.js');
      const outPath = join(serverPagesDir, outFile);
      await mkdir(join(outPath, '..'), { recursive: true });

      await esbuild({
        entryPoints: [absPath],
        bundle: true,
        format: 'esm',
        target: 'es2022',
        platform: 'node',
        outfile: outPath,
        jsx: 'automatic',
        jsxImportSource,
        plugins: [esmResolvePlugin],
        external: [],
      });

      console.log(`    ◈ ${page.urlPattern} → dist/server/pages/${outFile}`);
    }
  }

  // 3b. Bundle layout files used by server-mode pages
  if (manifest.layouts.length > 0 && serverPages.length > 0) {
    // Only compile layouts that are actually referenced by server-mode pages
    const usedLayoutPaths = new Set<string>();
    for (const page of serverPages) {
      if (page.layouts) {
        for (const lp of page.layouts) usedLayoutPaths.add(lp);
      }
    }

    const layoutsToCompile = manifest.layouts.filter(l => usedLayoutPaths.has(l.filePath));
    if (layoutsToCompile.length > 0) {
      console.log(`  Bundling ${layoutsToCompile.length} layout files...`);
      const serverPagesDir = join(root, 'dist', 'server', 'pages');
      await mkdir(serverPagesDir, { recursive: true });

      for (const layout of layoutsToCompile) {
        const absPath = resolve(root, layout.filePath);
        const outFile = layout.filePath.replace(/^src\/pages\//, '').replace(/\.tsx?$/, '.js');
        const outPath = join(serverPagesDir, outFile);
        await mkdir(join(outPath, '..'), { recursive: true });

        await esbuild({
          entryPoints: [absPath],
          bundle: true,
          format: 'esm',
          target: 'es2022',
          platform: 'node',
          outfile: outPath,
          jsx: 'automatic',
          jsxImportSource,
          plugins: [esmResolvePlugin],
          external: [],
        });

        console.log(`    ⊟ layout ${layout.dirPattern || '(root)'} → dist/server/pages/${outFile}`);
      }
    }
  }

  // 4. Build API routes + task entries
  console.log('  Building...');
  const result = await build(manifest, config, root);

  console.log(`  Server entry: ${result.serverEntry}`);
  console.log(`  Functions: ${result.functions.length} serverless bundles`);
  if (result.taskEntries.length > 0) {
    console.log(`  Tasks: ${result.taskEntries.length} task entries`);
  }

  // 5. Render static pages
  const staticPages = manifest.pages.filter(p => p.mode === 'static');
  if (staticPages.length > 0) {
    console.log(`  Rendering ${staticPages.length} static pages...`);

    const tmpDir = join(root, 'dist', '.page-tmp');
    await mkdir(tmpDir, { recursive: true });

    const loadModule = async (filePath: string) => {
      const absPath = resolve(root, filePath);
      const result = await esbuild({
        entryPoints: [absPath],
        bundle: true,
        format: 'esm',
        target: 'es2022',
        platform: 'node',
        write: false,
        outfile: 'page.mjs',
        jsx: 'automatic',
        jsxImportSource,
        plugins: [esmResolvePlugin],
        external: [],
      });
      const hash = Date.now().toString(36);
      const outPath = join(tmpDir, `${filePath.replace(/[/\\:]/g, '_')}_${hash}.mjs`);
      await writeFile(outPath, result.outputFiles[0].text);
      return import(pathToFileURL(outPath).href);
    };

    const outDir = join(root, 'dist');
    const rendered = await renderStaticPages(staticPages, loadModule, outDir);

    for (const page of rendered) {
      console.log(`    ◆ ${page.urlPattern} → ${page.outputPath.replace(root + '/', '')}`);
    }

    // Clean up temp files
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  if (config.adapter) {
    console.log(`  Adapter: ${config.adapter.name}`);
  }

  const elapsed = Date.now() - startTime;
  console.log(`\n  Build complete in ${elapsed}ms\n`);

  // Print route table
  console.log('  Routes:');
  for (const route of manifest.api) {
    const methods = route.methods.join(', ');
    const icon = route.kind === 'serverless' ? 'λ' : route.kind === 'hot' ? '●' : '⏳';
    console.log(`    ${icon} ${methods.padEnd(18)} ${route.urlPattern.padEnd(30)} ${route.kind}`);
  }

  for (const page of manifest.pages) {
    const icon = page.mode === 'static' ? '◆' : page.mode === 'server' ? '◈' : page.mode === 'client' ? '◇' : '⬡';
    console.log(`    ${icon} ${'PAGE'.padEnd(18)} ${page.urlPattern.padEnd(30)} ${page.mode}`);
  }

  console.log();
}
