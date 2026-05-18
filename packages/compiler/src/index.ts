/**
 * @celsian/vura-compiler — Pure JS fallback compiler for Vura
 *
 * Same API surface as @celsian/vura-compiler-native but uses regex-based
 * static analysis instead of AST parsing. Good enough for most
 * projects, but the native compiler is 10-50x faster for large ones.
 */

// ─── Types (matching @celsian/vura-compiler-native) ───

export interface ScanResult {
  methods: string[];
  kind: string;
  hasDefaultExport: boolean;
  hasGetServerData: boolean;
  pageMode: string | null;
  config: Record<string, string | number | boolean>;
}

export interface TransformResult {
  code: string;
  map: string | null;
}

// ─── Route Scanner (regex-based) ───

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;

/**
 * Scan a route or page file using regex-based static analysis.
 * Extracted from @celsian/vura-core's manifest.ts for standalone use.
 */
export function scanRoute(source: string, _fileType: string): ScanResult {
  const methods: string[] = [];

  // Detect HTTP method exports
  for (const method of HTTP_METHODS) {
    const pattern = new RegExp(
      `export\\s+(?:async\\s+)?(?:function\\s+${method}|const\\s+${method}\\s*=)`,
    );
    if (pattern.test(source)) {
      methods.push(method);
    }
  }

  // Extract route config
  let kind = 'serverless';
  const config: Record<string, string | number | boolean> = {};

  const routeMatch = source.match(
    /export\s+const\s+route\s*=\s*\{([^}]+)\}/,
  );
  if (routeMatch) {
    extractKVPairs(routeMatch[1], config);
    if (typeof config.kind === 'string') {
      kind = config.kind;
    }
  }

  // Extract page config
  let pageMode: string | null = null;
  const pageMatch = source.match(
    /export\s+const\s+page\s*=\s*\{([^}]+)\}/,
  );
  if (pageMatch) {
    extractKVPairs(pageMatch[1], config);
    if (typeof config.mode === 'string') {
      pageMode = config.mode;
    }
  }

  // Detect default export
  const hasDefaultExport = /export\s+default\s+/.test(source);

  // Detect getServerData
  const hasGetServerData = /export\s+(?:async\s+)?function\s+getServerData|export\s+(?:const|let)\s+getServerData/.test(source);

  // Auto-detect server mode
  if (!pageMode && hasGetServerData) {
    pageMode = 'server';
  }
  if (!pageMode && (/import\s+.*from\s+['"]then\/server['"]/.test(source) || /useSWR|useQuery|useServerData/.test(source))) {
    pageMode = 'server';
  }

  return { methods, kind, hasDefaultExport, hasGetServerData, pageMode, config };
}

/**
 * Transform JSX source — delegates to esbuild in practice.
 * This is a passthrough that adds the import pragma.
 */
export function transformJsx(
  source: string,
  options: { jsxImportSource?: string; production?: boolean } = {},
): TransformResult {
  const importSource = options.jsxImportSource ?? 'what-framework';
  const importLine = options.production
    ? `import { template, insert, createComponent } from '${importSource}/server';\n`
    : `import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from '${importSource}/jsx-runtime';\n`;

  return {
    code: importLine + source,
    map: null,
  };
}

// ─── Helpers ───

function extractKVPairs(body: string, config: Record<string, string | number | boolean>): void {
  const kvPattern = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?)|(\btrue\b|\bfalse\b))/g;
  let match;
  while ((match = kvPattern.exec(body)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? (match[4] ? Number(match[4]) : match[5] === 'true');
    config[key] = value;
  }
}
