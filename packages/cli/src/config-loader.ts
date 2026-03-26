/**
 * Load then.config.ts from the project root.
 *
 * Supports:
 *   - then.config.ts (TypeScript)
 *   - then.config.js (JavaScript)
 *   - then.config.mjs (ESM)
 *
 * Falls back to default config if no file exists.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ThenConfig } from '@then/core';

const CONFIG_FILES = ['then.config.ts', 'then.config.js', 'then.config.mjs'];

export async function loadConfig(projectRoot: string): Promise<ThenConfig> {
  const root = resolve(projectRoot);

  for (const filename of CONFIG_FILES) {
    const configPath = join(root, filename);
    if (!existsSync(configPath)) continue;

    // For .ts files, we need to use a loader or compile first.
    // For now, support .js and .mjs directly. TypeScript support
    // will come via the Vite plugin or tsx loader.
    if (filename.endsWith('.ts')) {
      // Try dynamic import with tsx if available
      try {
        const mod = await import(pathToFileURL(configPath).href);
        return { root, ...normalizeConfig(mod.default ?? mod) };
      } catch {
        console.warn(`  ⚠ Found ${filename} but could not import it. Using defaults.`);
        console.warn(`    Install tsx globally for TypeScript config support.`);
        continue;
      }
    }

    const mod = await import(pathToFileURL(configPath).href);
    return { root, ...normalizeConfig(mod.default ?? mod) };
  }

  // No config file found — return defaults
  return { root };
}

function normalizeConfig(raw: unknown): Partial<ThenConfig> {
  if (!raw || typeof raw !== 'object') return {};
  return raw as Partial<ThenConfig>;
}
