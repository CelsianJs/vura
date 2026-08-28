/**
 * The runtime shim, checked against the documentation that sends users to it.
 *
 * `runtime-shim.ts` holds an allowlist of the `@celsian/vura-core` exports a
 * project's server file may import. A public export missing from that list
 * works perfectly under `vura dev`, which transforms modules in place and never
 * builds the shim, and then fails `vura build` with
 * `No matching export in "vura-core-runtime-shim:@celsian/vura-core"`.
 *
 * The shim's own doc comment already warned that this happens. It then happened
 * to eleven more symbols in one release cycle: getLogger, createLogger,
 * cookieSession, jwt, createJWTGuard, enqueue and the five streaming helpers.
 * Every one of them is shown in the docs as the way to do the thing it does, so
 * the entire documented auth story, the logging story, task enqueue and file
 * streaming could not be built. A list re-checked by hand each release is the
 * defect; the test below is the fix.
 *
 * It reads the docs rather than restating them, so a symbol becomes covered the
 * moment somebody documents it, and it proves the claim by running the real
 * bundler over a real import of every documented name.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  vuraCoreRuntimeShimContents,
  coreModuleExt,
  CORE_PACKAGE_DIR,
} from '../src/runtime-shim.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOCS_PAGES = join(REPO_ROOT, 'docs-site', 'pages');

/**
 * Every value imported from `@celsian/vura-core` anywhere in the docs, with the
 * pages that show it.
 *
 * Type-only imports are skipped: they are erased before a bundler resolves
 * anything and cannot fail a build. Everything else counts, because the docs do
 * not mark which snippets are server files and a reader will not either.
 */
function documentedImports(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const pattern = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]@celsian\/vura-core['"]/g;

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.md') ? [path] : [];
    });

  for (const file of walk(DOCS_PAGES)) {
    const page = file.slice(DOCS_PAGES.length + 1);
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      if (match[1]) continue;
      for (const specifier of match[2]!.split(',')) {
        const trimmed = specifier.trim();
        if (!trimmed || /^type\s/.test(trimmed)) continue;
        const name = trimmed.split(/\s+as\s+/)[0]!.trim();
        if (!name) continue;
        const pages = found.get(name) ?? [];
        if (!pages.includes(page)) pages.push(page);
        found.set(name, pages);
      }
    }
  }
  return found;
}

describe('the @celsian/vura-core runtime shim', () => {
  it('finds the documented imports it is meant to check', () => {
    const documented = documentedImports();
    // A silent extraction failure would make every assertion below vacuous, so
    // the reader is pinned first. These four are load-bearing docs: if one of
    // them stops being shown, the docs changed and this test should be read
    // again rather than quietly widened.
    expect(documented.size).toBeGreaterThan(20);
    for (const name of ['defineConfig', 'getLogger', 'cookieSession', 'enqueue']) {
      expect(documented.get(name), `${name} should appear in the docs`).toBeTruthy();
    }
  });

  it('exports every symbol the docs tell a server file to import', async () => {
    const documented = documentedImports();
    const names = [...documented.keys()].sort();

    const dir = mkdtempSync(join(tmpdir(), 'vura-shim-'));
    try {
      const entry = join(dir, 'entry.ts');
      writeFileSync(
        entry,
        `import { ${names.join(', ')} } from '@celsian/vura-core';\n` +
          `export default [${names.join(', ')}];\n`,
      );

      const { build: esbuild } = await import('esbuild');
      // The same plugin core's builder installs, so a pass here means the
      // symbol survives a real `vura build` rather than a stand-in for one.
      const shimPlugin = {
        name: 'vura-core-runtime-shim',
        setup(build: any) {
          build.onResolve({ filter: /^@celsian\/vura-core$/ }, () => ({
            path: '@celsian/vura-core',
            namespace: 'vura-core-runtime-shim',
          }));
          build.onLoad({ filter: /.*/, namespace: 'vura-core-runtime-shim' }, () => ({
            loader: 'js',
            resolveDir: CORE_PACKAGE_DIR,
            contents: vuraCoreRuntimeShimContents({ packageDir: CORE_PACKAGE_DIR }),
          }));
        },
      };

      let missing: string[] = [];
      try {
        await esbuild({
          entryPoints: [entry],
          bundle: true,
          write: false,
          format: 'esm',
          platform: 'node',
          external: ['what-framework', 'what-framework/*'],
          logLevel: 'silent',
          plugins: [shimPlugin],
        });
      } catch (error) {
        // esbuild's own failure serialises to several screens of location
        // objects. Reduce it to the names, which is the whole answer: each one
        // is a documented import that `vura build` would reject.
        const errors = (error as { errors?: { text: string }[] }).errors ?? [];
        missing = errors.map(e => e.text.match(/for import "([^"]+)"/)?.[1] ?? e.text);
        if (missing.length === 0) throw error;
      }

      expect(
        missing,
        `documented in ${missing.map(name => documented.get(name)?.join(', ')).join(' | ')} ` +
          'but absent from the runtime-shim allowlist',
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves its re-export specifiers to modules that exist', () => {
    // coreModuleExt picks `ts` in the monorepo and `js` in the published dist.
    // A wrong guess turns every export in that group into a build failure, so
    // the extension is checked rather than assumed.
    expect(coreModuleExt('logger')).toBe(coreModuleExt('errors'));
    const source = vuraCoreRuntimeShimContents({ packageDir: CORE_PACKAGE_DIR });
    for (const match of source.matchAll(/from '\.\/([^']+)'/g)) {
      expect(
        readFileSync(join(CORE_PACKAGE_DIR, match[1]!), 'utf8').length,
        `${match[1]} should be readable`,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps the Node built-in groups out of an adapter function bundle', () => {
    // Lambda and Cloudflare pass includeServerRuntime: false. Cloudflare
    // bundles with platform 'neutral' and no Node externals, so anything
    // reaching node:fs or node:crypto must stay in the server group or every
    // Worker build breaks.
    const functionBundle = vuraCoreRuntimeShimContents({
      packageDir: CORE_PACKAGE_DIR,
      includeServerRuntime: false,
    });
    for (const nodeBackedModule of ['auth', 'streaming', 'runtime/server']) {
      expect(functionBundle).not.toContain(`./${nodeBackedModule}.`);
    }
    // enqueue is pure fetch and the logger now imports nothing at all, so both
    // belong in the adapter half too.
    expect(functionBundle).toContain('enqueue');
    expect(functionBundle).toContain('getLogger');
  });

  it('bundles the adapter half for a Worker with no Node built-ins left in it', async () => {
    // The list above is a claim about what the group *contains*. This is the
    // claim it stands for: esbuild resolving that group the way the Cloudflare
    // adapter does. `platform: 'neutral'` with no externals is the exact
    // configuration under which `import { randomUUID } from 'node:crypto'`
    // fails with "Could not resolve node:crypto", which is what kept getLogger
    // out of the group and out of `src/api/_hooks.ts` with it.
    const dir = mkdtempSync(join(tmpdir(), 'vura-shim-worker-'));
    try {
      const entry = join(dir, 'entry.ts');
      writeFileSync(
        entry,
        `import { getLogger, createLogger, enqueue, badRequest } from '@celsian/vura-core';\n` +
          `export default [getLogger, createLogger, enqueue, badRequest];\n`,
      );

      const { build: esbuild } = await import('esbuild');
      const result = await esbuild({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'esm',
        target: 'es2022',
        platform: 'neutral',
        external: ['what-framework', 'what-framework/*'],
        logLevel: 'silent',
        plugins: [
          {
            name: 'vura-core-runtime-shim',
            setup(build: any) {
              build.onResolve({ filter: /^@celsian\/vura-core$/ }, () => ({
                path: '@celsian/vura-core',
                namespace: 'vura-core-runtime-shim',
              }));
              build.onLoad({ filter: /.*/, namespace: 'vura-core-runtime-shim' }, () => ({
                loader: 'js',
                resolveDir: CORE_PACKAGE_DIR,
                contents: vuraCoreRuntimeShimContents({
                  packageDir: CORE_PACKAGE_DIR,
                  includeServerRuntime: false,
                }),
              }));
            },
          },
        ],
      });

      // A bundle that resolved is not proof on its own: a leftover `node:`
      // import would have failed the build, so check the output as well and
      // the assertion stays true if the externals ever loosen.
      const output = result.outputFiles![0]!.text;
      expect(output).not.toMatch(/from\s*["']node:/);
      expect(output).toContain('randomUUID');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
