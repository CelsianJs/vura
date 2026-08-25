/**
 * Build-side support for server actions.
 *
 * Three things live here, and they are shared by `vura build` and `vura dev` so
 * the two cannot drift: the id derivation, the browser stub source, and the
 * esbuild plugin that swaps one for the other.
 *
 * The plugin is the security boundary. It answers `onResolve` for any import
 * that lands inside `src/actions/`, which means esbuild never reads the file
 * for a browser bundle — the module's imports are not followed, its constants
 * are not inlined, and a secret held in it cannot appear in client output
 * through any path. Filtering the file's *contents* after the fact would be a
 * weaker guarantee; not reading it is a total one.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Directory holding a project's server actions. */
export const ACTIONS_DIR = join('src', 'actions');

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];

/**
 * `src/actions/admin/users.ts` → `admin/users`.
 *
 * Always POSIX-separated: the id travels over the wire and appears in the
 * generated server entry, so it cannot carry a Windows backslash.
 */
export function actionModuleId(filePath: string): string {
  const normalized = filePath.split(sep).join('/');
  const withoutDir = normalized.replace(/^src\/actions\//, '');
  return withoutDir.replace(/\.(tsx?|jsx?|mts|mjs)$/, '');
}

/**
 * Resolve symlinks, or return the path unchanged when it does not exist.
 *
 * Both sides of the containment check below must be in the same form or the
 * check silently fails open. esbuild reports the *resolved* path of an importer
 * — on macOS `/tmp` is a symlink to `/private/tmp`, and a pnpm workspace, a
 * symlinked home directory or a Docker bind mount all do the same thing — while
 * the project root arrives as whatever the caller typed. Comparing the two
 * directly makes `relative()` return a `../../..` climb, the action file looks
 * like it lives outside `src/actions/`, and the plugin waves it through into
 * the browser bundle. That is the security boundary failing open, so it is
 * normalised here rather than trusted to be already normal.
 */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Resolve an import specifier the way esbuild would, but only far enough to
 * answer one question: does it land in `src/actions/`?
 *
 * Returns the resolved absolute file path, or null. Bare specifiers are never
 * action modules — a package named the same as a project directory is not an
 * action, and treating it as one would shadow a real dependency.
 */
export function resolveActionImport(
  specifier: string,
  resolveDir: string,
  actionsRoot: string,
): string | null {
  if (!specifier.startsWith('.') && !isAbsolute(specifier)) return null;

  const base = isAbsolute(specifier) ? specifier : resolve(resolveDir, specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map(ext => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map(ext => join(base, `index${ext}`)),
  ];

  const root = realpathOrSelf(actionsRoot);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (statSync(candidate).isDirectory()) continue;
    const real = realpathOrSelf(candidate);
    const rel = relative(root, real);
    // Inside the actions root, and not reached by climbing out of it.
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    return real;
  }
  return null;
}

/**
 * Extract the exported function names of an action module.
 *
 * Deliberately a source scan rather than an import: the manifest is built
 * before anything is bundled, and importing project modules to inspect them
 * would run application code at build time. Same policy as the API-route and
 * page scanners.
 */
export function extractActionExports(source: string): string[] {
  const names: string[] = [];
  const patterns = [
    // export async function name(   |   export function name(
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    // export const name = async (   |   export const name = function
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1]!;
      if (name !== 'default' && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

// ─── The browser stub ───

/** Virtual namespace holding the shared client transport. */
export const ACTION_RUNTIME_NAMESPACE = 'vura-action-runtime';
/** Virtual namespace holding one generated stub per action module. */
export const ACTION_STUB_NAMESPACE = 'vura-action-stub';

/** The endpoint both halves agree on. */
export const ACTION_ENDPOINT = '/__vura/action';

/**
 * The shared client transport, emitted once per browser bundle.
 *
 * Fetches a CSRF token lazily and caches it, because a static page is
 * prerendered at build time and cannot carry a per-session token in its HTML.
 * One extra round trip before the first action call, none after. A 403 retries
 * exactly once with a fresh token, which covers a restarted server or a cleared
 * cookie without turning a genuine rejection into a loop.
 */
export function actionRuntimeSource(): string {
  return `
const ENDPOINT = ${JSON.stringify(ACTION_ENDPOINT)};

let _token = null;
let _inflight = null;

function _fetchToken() {
  if (_inflight) return _inflight;
  _inflight = fetch(ENDPOINT, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
    .then(res => {
      if (!res.ok) throw new Error('[vura] could not obtain an action token (' + res.status + ')');
      return res.json();
    })
    .then(data => {
      _token = data.token;
      _inflight = null;
      return _token;
    })
    .catch(err => {
      _inflight = null;
      throw err;
    });
  return _inflight;
}

function _token_or_fetch() {
  return _token ? Promise.resolve(_token) : _fetchToken();
}

function _post(id, args, token) {
  return fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-vura-action': id,
      'x-vura-csrf': token,
    },
    body: JSON.stringify({ args }),
  });
}

export async function callAction(id, args) {
  let token = await _token_or_fetch();
  let res = await _post(id, args, token);

  if (res.status === 403) {
    // The cookie may have been cleared or the server restarted. One retry with
    // a freshly issued token; a second 403 is a real rejection.
    _token = null;
    token = await _fetchToken();
    res = await _post(id, args, token);
  }

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    const message = (payload && (payload.error || payload.message)) || 'Action failed';
    const error = new Error('[vura] ' + id + ': ' + message);
    error.status = res.status;
    if (payload && payload.code) error.code = payload.code;
    throw error;
  }

  return payload ? payload.result : undefined;
}
`;
}

/**
 * One stub module: the same export names as the real action file, each a thin
 * wrapper that names its id.
 *
 * A default export is not supported. An action is addressed by name on the
 * wire, and `default` is a name the author did not choose — requiring a named
 * export keeps the ids in the network tab readable and stable under renames of
 * the importing file.
 */
export function generateActionStub(moduleId: string, exportNames: string[]): string {
  const lines = [`import { callAction } from '${ACTION_RUNTIME_NAMESPACE}:runtime';`, ''];
  for (const name of exportNames) {
    const id = `${moduleId}#${name}`;
    lines.push(
      `export function ${name}(...args) {`,
      `  return callAction(${JSON.stringify(id)}, args);`,
      `}`,
      '',
    );
  }
  return lines.join('\n');
}

// ─── The plugin ───

export interface ActionsStubPluginOptions {
  /** Project root. `src/actions` is resolved beneath it. */
  projectRoot: string;
  /**
   * Reads an action module's source. Injectable so the plugin stays pure and
   * testable; defaults to reading the file.
   */
  readSource?: (absPath: string) => string;
}

/**
 * esbuild plugin: replace every `src/actions/` import in a browser bundle with
 * a generated fetch stub.
 *
 * Install this on client and hybrid page bundles only. A server bundle must
 * import the real module — that is the whole point of the split.
 */
export function vuraActionsStubPlugin(options: ActionsStubPluginOptions) {
  const realRoot = realpathOrSelf(options.projectRoot);
  const actionsRoot = join(realRoot, ACTIONS_DIR);
  const readSource =
    options.readSource ?? ((absPath: string) => readFileSync(absPath, 'utf8'));

  return {
    name: 'vura-actions-stub',
    setup(build: any) {
      // The shared transport, one copy per bundle.
      build.onResolve(
        { filter: new RegExp(`^${ACTION_RUNTIME_NAMESPACE}:runtime$`) },
        () => ({ path: 'runtime', namespace: ACTION_RUNTIME_NAMESPACE }),
      );
      build.onLoad(
        { filter: /.*/, namespace: ACTION_RUNTIME_NAMESPACE },
        () => ({ contents: actionRuntimeSource(), loader: 'js' }),
      );

      // Any import that lands in src/actions/ becomes a stub. Answering here
      // means esbuild never opens the real file for this bundle.
      build.onResolve({ filter: /.*/ }, (args: any) => {
        if (args.namespace === ACTION_STUB_NAMESPACE) return null;
        if (!existsSync(actionsRoot)) return null;
        const resolved = resolveActionImport(args.path, args.resolveDir ?? '', actionsRoot);
        if (!resolved) return null;
        return { path: resolved, namespace: ACTION_STUB_NAMESPACE };
      });

      build.onLoad({ filter: /.*/, namespace: ACTION_STUB_NAMESPACE }, (args: any) => {
        // `args.path` is already real-path normalised by resolveActionImport,
        // so the project root has to be too or the id comes out as a `../..`
        // climb instead of `todos`.
        const moduleId = actionModuleId(
          relative(realRoot, args.path).split(sep).join('/'),
        );
        const exportNames = extractActionExports(readSource(args.path));
        return {
          contents: generateActionStub(moduleId, exportNames),
          loader: 'js',
          resolveDir: options.projectRoot,
        };
      });
    },
  };
}
