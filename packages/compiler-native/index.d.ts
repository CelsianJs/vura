/**
 * @celsian/vura-compiler-native — Rust-powered compiler for Vura
 *
 * Provides 10-50x faster route scanning, JSX transforms, and file watching
 * compared to the pure JS fallback (@celsian/vura-compiler).
 */

export interface ScanResult {
  /** Exported HTTP methods (GET, POST, etc.) */
  methods: string[];
  /** Route kind: 'serverless' | 'hot' | 'task' */
  kind: string;
  /** Whether the file has a default export */
  hasDefaultExport: boolean;
  /** Whether the file exports getServerData */
  hasGetServerData: boolean;
  /** Page mode if applicable: 'static' | 'server' | 'client' | 'hybrid' */
  pageMode: string | null;
  /** Extracted config key-value pairs from route/page config */
  config: Record<string, string | number | boolean>;
}

export interface TransformResult {
  /** Transformed source code */
  code: string;
  /** Source map (JSON string) */
  map: string | null;
}

/**
 * Scan a route or page file using AST-based analysis.
 * Much more accurate than regex — handles all edge cases.
 *
 * @param source - File source code
 * @param fileType - "ts" | "tsx" | "js" | "jsx"
 */
export function scanRoute(source: string, fileType: string): ScanResult;

/**
 * Transform JSX to What Framework h() calls.
 *
 * @param source - File source code containing JSX
 * @param options - Transform options
 */
export function transformJsx(source: string, options?: {
  /** Import source for JSX factory (default: 'what-framework') */
  jsxImportSource?: string;
  /** Production mode: use template()/insert() instead of h() */
  production?: boolean;
}): TransformResult;

/**
 * Watch a directory for file changes using native OS APIs.
 * Returns a handle that can be used to stop watching.
 *
 * @param path - Directory to watch
 * @param callback - Called with (eventType, filePath) on changes
 */
export function watchDirectory(
  path: string,
  callback: (eventType: 'create' | 'modify' | 'remove', filePath: string) => void,
): WatcherHandle;

export interface WatcherHandle {
  /** Stop watching */
  stop(): void;
}
