/**
 * Vura Configuration
 *
 * vura.config.js defines the project's deployment target, page defaults, and API settings.
 */

import type { RouteKind, PageMode } from './manifest.js';

export interface ThenAdapter {
  name: string;
  /** Generate deployment artifacts from the build output */
  buildEnd(ctx: AdapterBuildContext): Promise<void>;
}

export interface AdapterBuildContext {
  /** Path to the built server entry */
  serverEntry: string;
  /** Path to client static assets */
  clientDir: string;
  /** The route manifest */
  manifest: import('./manifest.js').RouteManifest;
  /** Project root */
  projectRoot: string;
  /** Output directory */
  outDir: string;
}

export interface ThenConfig {
  /** Project root directory (auto-detected) */
  root?: string;

  /** Pages configuration */
  pages?: {
    /** Directory containing page components (default: src/pages) */
    dir?: string;
    /** Default rendering mode for pages (default: static) */
    defaultMode?: PageMode;
  };

  /** API configuration */
  api?: {
    /** Directory containing API route files (default: src/api) */
    dir?: string;
    /** Default deployment kind for API routes (default: serverless) */
    defaultKind?: RouteKind;
  };

  /** Deployment adapter */
  adapter?: ThenAdapter;

  /** Vite config overrides */
  vite?: Record<string, unknown>;
}

/**
 * Define a Vura config with type safety.
 *
 * @example
 * ```ts
 * // vura.config.js
 * import { defineConfig } from '@celsian/vura-core';
 * import { lambdaAdapter } from '@celsian/vura-adapter-lambda';
 *
 * export default defineConfig({
 *   api: { defaultKind: 'serverless' },
 *   adapter: lambdaAdapter({ region: 'us-east-1' }),
 * });
 * ```
 */
export function defineConfig(config: ThenConfig): ThenConfig {
  return config;
}
