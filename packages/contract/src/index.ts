/** Pure data contract: no runtime, compiler, filesystem, or platform imports. */
export type RouteKind = 'serverless' | 'hot' | 'task';
export type PageMode = 'static' | 'server' | 'client' | 'hybrid';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface ApiRoute {
  filePath: string;
  urlPattern: string;
  methods: HttpMethod[];
  kind: RouteKind;
  hasWebsocket?: boolean;
  config: Record<string, unknown>;
}

export interface PageRoute {
  filePath: string;
  urlPattern: string;
  mode: PageMode;
  layout?: string;
  layouts?: string[];
  hasLoader: boolean;
  hasGetServerData: boolean;
  config: Record<string, unknown>;
}

export interface LayoutRoute {
  filePath: string;
  dirPattern: string;
}

export interface ActionModule {
  filePath: string;
  moduleId: string;
  exports: string[];
}

/** Unversioned shape retained for existing source consumers and producers. */
export interface RouteManifest {
  api: ApiRoute[];
  pages: PageRoute[];
  layouts: LayoutRoute[];
  middleware?: string;
  actions?: ActionModule[];
  timestamp: string;
}

export const SCHEMA_VERSION = 1 as const;
export const MANIFEST_FEATURES = [
  'api', 'static-pages', 'server-pages', 'client-pages', 'hybrid-pages',
  'layouts', 'actions', 'middleware', 'loaders', 'legacy-server-data',
  'websocket', 'streaming', 'isr', 'tasks', 'scheduled-tasks',
  'function-compute', 'dedicated-compute',
] as const;
export type ManifestFeature = typeof MANIFEST_FEATURES[number];

export interface ManifestV1 extends RouteManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  requiredFeatures: ManifestFeature[];
}

export type ParsedManifest = RouteManifest | ManifestV1;
/** Type guard for an already validated manifest (not an alternative validator). */
export function isVersionedManifest(manifest: ParsedManifest): manifest is ManifestV1 {
  return 'schemaVersion' in manifest && manifest.schemaVersion === SCHEMA_VERSION;
}
export interface ParseManifestOptions { allowLegacy?: boolean }
export interface ManifestIssue {
  path: string;
  code: 'invalid_type' | 'invalid_value' | 'unsupported_version' | 'missing_version' |
    'unknown_feature' | 'missing_feature' | 'invalid_json' | 'unsupported_feature';
  message: string;
}
export type ManifestValidationResult =
  | { success: true; manifest: ParsedManifest }
  | { success: false; issues: ManifestIssue[] };

export class ManifestValidationError extends Error {
  readonly issues: ManifestIssue[];
  constructor(issues: ManifestIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
    this.name = 'ManifestValidationError';
    this.issues = issues;
  }
}

type ObjectValue = Record<string, unknown>;
const own = (value: ObjectValue, key: string): boolean => Object.hasOwn(value, key);
const isObject = (value: unknown): value is ObjectValue => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const routeKinds = ['serverless', 'hot', 'task'];
const pageModes = ['static', 'server', 'client', 'hybrid'];
const httpMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** Checks accumulate field-level diagnostics; they never strip unknown metadata. */
class Check {
  readonly issues: ManifestIssue[] = [];
  issue(path: string, message: string, code: ManifestIssue['code'] = 'invalid_value'): void {
    this.issues.push({ path, code, message });
  }
  object(value: unknown, path: string): value is ObjectValue {
    if (isObject(value)) return true;
    this.issue(path, 'Expected a plain object', 'invalid_type');
    return false;
  }
  string(value: unknown, path: string): value is string {
    if (typeof value === 'string' && value.length > 0) return true;
    this.issue(path, 'Expected a non-empty string', 'invalid_type');
    return false;
  }
  boolean(value: unknown, path: string): void {
    if (typeof value !== 'boolean') this.issue(path, 'Expected a boolean', 'invalid_type');
  }
  enum(value: unknown, allowed: readonly string[], path: string): void {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      this.issue(path, `Expected one of: ${allowed.join(', ')}`);
    }
  }
  array(value: unknown, path: string, visit: (item: unknown, path: string) => void): void {
    if (!Array.isArray(value)) {
      this.issue(path, 'Expected an array', 'invalid_type');
      return;
    }
    for (let index = 0; index < value.length; index++) visit(value[index], `${path}[${index}]`);
  }
  relativePath(value: unknown, path: string, allowEmpty = false): void {
    if (allowEmpty && value === '') return;
    if (!this.string(value, path)) return;
    if (/^[A-Za-z]:|[\u0000-\u001f]/.test(value) ||
        value.split(/[\\/]/).some(part => part === '' || part === '.' || part === '..')) {
      this.issue(path, 'Expected a project-relative path without empty, dot, or parent segments');
    }
  }
  url(value: unknown, path: string): void {
    if (!this.string(value, path)) return;
    if (!value.startsWith('/') || /[\\\s?#\u0000-\u001f]/.test(value) || value.includes('//') ||
        value.split('/').some(part => part === '.' || part === '..')) {
      this.issue(path, 'Expected an absolute URL pattern without query, fragment, or traversal');
    }
  }
  optional(object: ObjectValue, key: string, path: string, visit: (value: unknown, path: string) => void): void {
    if (own(object, key)) visit(object[key], `${path}.${key}`);
  }
  positive(value: unknown, path: string, integer = false): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
      this.issue(path, `Expected a positive ${integer ? 'integer' : 'finite number'}`);
    }
  }
  config(value: unknown, path: string, kind: 'api' | 'page'): void {
    if (!this.object(value, path)) return;
    if (kind === 'page') {
      this.optional(value, 'mode', path, (v, p) => this.enum(v, pageModes, p));
      this.optional(value, 'revalidate', path, (v, p) => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) this.issue(p, 'Expected a non-negative finite number');
      });
      this.optional(value, 'tags', path, (v, p) => {
        if (typeof v !== 'string') this.array(v, p, (item, itemPath) => { this.string(item, itemPath); });
      });
      this.optional(value, 'swr', path, (v, p) => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) this.issue(p, 'Expected a non-negative finite number');
      });
    } else {
      this.optional(value, 'kind', path, (v, p) => this.enum(v, routeKinds, p));
      this.optional(value, 'hot', path, (v, p) => this.boolean(v, p));
      this.optional(value, 'schedule', path, (v, p) => { this.string(v, p); });
      this.optional(value, 'machine', path, (v, p) => { this.compute(v, p, false); });
      this.optional(value, 'compute', path, (v, p) => { this.compute(v, p, true); });
    }
    this.optional(value, 'streaming', path, (v, p) => this.boolean(v, p));
  }
  compute(value: unknown, path: string, canonical: boolean): void {
    if (!this.object(value, path)) return;
    if (canonical) {
      this.optional(value, 'class', path, (v, p) => this.enum(v, ['function', 'dedicated'], p));
      this.optional(value, 'size', path, (v, p) => this.enum(v, ['nano', 'small', 'medium', 'large', 'xlarge', '2xlarge', '4xlarge'], p));
    }
    for (const key of ['cpu', 'cpus']) this.optional(value, key, path, (v, p) => this.positive(v, p, true));
    this.optional(value, 'memoryMb', path, (v, p) => this.positive(v, p));
    this.optional(value, 'memory', path, (v, p) => {
      if (value.class === 'function') this.enum(v, ['1gb', '4gb', '6gb', '8gb', '12gb'], p);
      else if (typeof v === 'number') this.positive(v, p);
      else this.string(v, p);
    });
  }
}

/** Validate JSON text or an already-decoded object without changing its fields. */
export function validateManifest(input: unknown, options: ParseManifestOptions = {}): ManifestValidationResult {
  const check = new Check();
  let value: unknown = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input); }
    catch { return { success: false, issues: [{ path: '$', code: 'invalid_json', message: 'Invalid manifest JSON' }] }; }
  }
  if (!check.object(value, '$')) return { success: false, issues: check.issues };
  const versioned = own(value, 'schemaVersion');
  if (versioned && value.schemaVersion !== SCHEMA_VERSION) {
    check.issue('$.schemaVersion', 'Unsupported schema version; expected 1', 'unsupported_version');
  } else if (!versioned && !options.allowLegacy) {
    check.issue('$.schemaVersion', 'Missing schema version; legacy input requires allowLegacy: true', 'missing_version');
  }
  check.array(value.api, '$.api', (route, path) => {
    if (!check.object(route, path)) return;
    check.relativePath(route.filePath, `${path}.filePath`);
    check.url(route.urlPattern, `${path}.urlPattern`);
    check.enum(route.kind, routeKinds, `${path}.kind`);
    check.array(route.methods, `${path}.methods`, (method, p) => check.enum(method, httpMethods, p));
    check.optional(route, 'hasWebsocket', path, (v, p) => check.boolean(v, p));
    check.config(route.config, `${path}.config`, 'api');
    if (isObject(route.config)) {
      const compute = isObject(route.config.compute) ? route.config.compute : {};
      if ((route.kind === 'hot' && compute.class === 'function') ||
          (route.kind === 'serverless' && compute.class === 'dedicated')) {
        check.issue(`${path}.config.compute.class`, 'Compute class conflicts with resolved route kind');
      }
      // The compiler preserves source config.kind, so serverless -> hot is a
      // valid dedicated-placement normalization. Task semantics never change.
      const sourceKind = route.config.kind;
      if (typeof sourceKind === 'string' && routeKinds.includes(sourceKind) &&
          ((sourceKind === 'task') !== (route.kind === 'task') ||
            (sourceKind === 'hot' && route.kind !== 'hot'))) {
        check.issue(`${path}.config.kind`, 'Declared workload conflicts with resolved route kind');
      }
    }
    if (route.hasWebsocket === true && route.kind !== 'hot') check.issue(`${path}.hasWebsocket`, 'WebSocket routes require kind: hot');
  });
  check.array(value.pages, '$.pages', (page, path) => {
    if (!check.object(page, path)) return;
    check.relativePath(page.filePath, `${path}.filePath`);
    check.url(page.urlPattern, `${path}.urlPattern`);
    check.enum(page.mode, pageModes, `${path}.mode`);
    check.boolean(page.hasLoader, `${path}.hasLoader`);
    check.boolean(page.hasGetServerData, `${path}.hasGetServerData`);
    check.optional(page, 'layout', path, (v, p) => check.relativePath(v, p));
    check.optional(page, 'layouts', path, (v, p) => check.array(v, p, (item, itemPath) => check.relativePath(item, itemPath)));
    check.config(page.config, `${path}.config`, 'page');
    if (isObject(page.config) && own(page.config, 'mode') && page.config.mode !== page.mode) {
      check.issue(`${path}.config.mode`, 'Declared page mode conflicts with resolved mode');
    }
  });
  check.array(value.layouts, '$.layouts', (layout, path) => {
    if (!check.object(layout, path)) return;
    check.relativePath(layout.filePath, `${path}.filePath`);
    check.relativePath(layout.dirPattern, `${path}.dirPattern`, true);
  });
  check.optional(value, 'middleware', '$', (v, p) => check.relativePath(v, p));
  check.optional(value, 'actions', '$', (actions, path) => check.array(actions, path, (action, actionPath) => {
    if (!check.object(action, actionPath)) return;
    check.relativePath(action.filePath, `${actionPath}.filePath`);
    check.relativePath(action.moduleId, `${actionPath}.moduleId`);
    check.array(action.exports, `${actionPath}.exports`, (name, p) => { check.string(name, p); });
  }));
  if (check.string(value.timestamp, '$.timestamp') && !Number.isFinite(Date.parse(value.timestamp))) {
    check.issue('$.timestamp', 'Expected a parseable date-time string');
  }
  if (versioned || own(value, 'requiredFeatures')) {
    const seen = new Set<string>();
    check.array(value.requiredFeatures, '$.requiredFeatures', (feature, path) => {
      if (typeof feature !== 'string' || !MANIFEST_FEATURES.some(known => known === feature)) {
        check.issue(path, 'Unknown required feature', 'unknown_feature');
      } else if (seen.has(feature)) check.issue(path, 'Duplicate required feature');
      else seen.add(feature);
    });
  }
  if (check.issues.length > 0) return { success: false, issues: check.issues };
  // Every consumed field above was checked; the cast retains extension metadata.
  const manifest = value as unknown as ParsedManifest;
  if (versioned || own(value, 'requiredFeatures')) {
    const declared = value.requiredFeatures as ManifestFeature[];
    for (const feature of deriveRequiredFeatures(manifest)) {
      if (!declared.includes(feature)) check.issue('$.requiredFeatures', `Missing required feature: ${feature}`, 'missing_feature');
    }
  }
  return check.issues.length > 0 ? { success: false, issues: check.issues } : { success: true, manifest };
}

export function parseManifest(input: unknown, options: ParseManifestOptions = {}): ParsedManifest {
  const result = validateManifest(input, options);
  if (!result.success) throw new ManifestValidationError(result.issues);
  return result.manifest;
}

/** Derive requirements from validated metadata, never from a provider name. */
export function deriveRequiredFeatures(manifest: RouteManifest): ManifestFeature[] {
  const features = new Set<ManifestFeature>();
  if (manifest.api.length > 0) features.add('api');
  if (manifest.layouts.length > 0 || manifest.pages.some(page => page.layout || page.layouts?.length)) features.add('layouts');
  if (manifest.actions?.length) features.add('actions');
  if (manifest.middleware) features.add('middleware');
  for (const route of manifest.api) {
    if (route.kind === 'task') features.add('tasks');
    if (typeof route.config.schedule === 'string') features.add('scheduled-tasks');
    if (route.hasWebsocket) features.add('websocket');
    if (route.config.streaming === true) features.add('streaming');
    const compute = isObject(route.config.compute) ? route.config.compute : {};
    const legacyDedicated = route.kind === 'hot' || route.config.hot === true ||
      ['runtime', 'placement', 'target'].some(key => route.config[key] === 'hot') ||
      (isObject(route.config.machine) && Object.keys(route.config.machine).length > 0);
    const dedicated = compute.class === 'dedicated' || (compute.class === undefined && legacyDedicated);
    features.add(dedicated ? 'dedicated-compute' : 'function-compute');
  }
  for (const page of manifest.pages) {
    const byMode: Record<PageMode, ManifestFeature> = {
      static: 'static-pages', server: 'server-pages', client: 'client-pages', hybrid: 'hybrid-pages',
    };
    features.add(byMode[page.mode]);
    if (page.hasLoader) features.add('loaders');
    if (page.hasGetServerData) features.add('legacy-server-data');
    if (page.mode === 'server') {
      if (page.config.streaming === true) features.add('streaming');
      else if (typeof page.config.revalidate === 'number' &&
          (page.config.revalidate > 0 || (typeof page.config.swr === 'number' && page.config.swr > 0))) features.add('isr');
    }
  }
  return MANIFEST_FEATURES.filter(feature => features.has(feature));
}

export interface TargetCapabilities {
  name: string;
  supportedFeatures: readonly ManifestFeature[];
}
export interface CapabilityEvaluation {
  compatible: boolean;
  requiredFeatures: ManifestFeature[];
  unsupportedFeatures: ManifestFeature[];
  diagnostics: ManifestIssue[];
}

/** False means refuse this target, not silently degrade. Invalid manifests throw. */
export function evaluateCapabilities(manifest: ParsedManifest, target: TargetCapabilities): CapabilityEvaluation {
  parseManifest(manifest, { allowLegacy: true });
  const declared = 'requiredFeatures' in manifest ? manifest.requiredFeatures as ManifestFeature[] : [];
  const required = new Set([...deriveRequiredFeatures(manifest), ...declared]);
  const requiredFeatures = MANIFEST_FEATURES.filter(feature => required.has(feature));
  const unsupportedFeatures = requiredFeatures.filter(feature => !target.supportedFeatures.includes(feature));
  return {
    compatible: unsupportedFeatures.length === 0,
    requiredFeatures,
    unsupportedFeatures,
    diagnostics: unsupportedFeatures.map(feature => ({
      path: '$.requiredFeatures', code: 'unsupported_feature', message: `${target.name} does not support required feature: ${feature}`,
    })),
  };
}
