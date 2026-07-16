/**
 * @celsian/vura-compiler — dependency-free JavaScript fallback compiler.
 *
 * Route metadata is intentionally parsed as a restricted static literal. The
 * scanner never imports or evaluates an application module, which keeps build
 * discovery deterministic and prevents config files from executing code.
 */

export type StaticConfigPrimitive = string | number | boolean | null;
export type StaticConfigValue = StaticConfigPrimitive | StaticConfigValue[] | StaticConfigObject;
export interface StaticConfigObject {
  [key: string]: StaticConfigValue;
}

export type LegacyRouteKind = 'serverless' | 'hot' | 'task';
export type ComputeClass = 'edge' | 'function' | 'dedicated';
export type FunctionMemory = '1gb' | '4gb' | '6gb' | '8gb' | '12gb';
export type EdgeEligibility = 'pending';

export interface RouteComputeRequest {
  class?: ComputeClass;
  memory?: FunctionMemory | '128mb' | string;
  cpu?: number;
}

export interface NormalizedRouteCompute {
  /** Requested runtime class. Edge remains gated by `edgeEligibility`. */
  class: ComputeClass;
  memory?: FunctionMemory | '128mb' | string | number;
  cpu?: number;
  /** Effective fallback while a requested Edge endpoint is not eligible. */
  effectiveClass?: 'function' | 'dedicated';
  effectiveMemory?: FunctionMemory | string | number;
  requestedClass?: 'edge';
  requestedMemory?: '128mb';
  edgeEligibility?: EdgeEligibility;
}

export interface ScanResult {
  methods: string[];
  kind: LegacyRouteKind;
  hasDefaultExport: boolean;
  hasGetServerData: boolean;
  pageMode: string | null;
  config: StaticConfigObject;
}

export interface TransformResult {
  code: string;
  map: string | null;
}

export class StaticConfigParseError extends SyntaxError {
  readonly line: number;
  readonly column: number;

  constructor(source: string, index: number, context: string, message: string) {
    const before = source.slice(0, Math.max(0, index));
    const lines = before.split(/\r?\n/);
    const line = lines.length;
    const column = (lines.at(-1)?.length ?? 0) + 1;
    super(`[VURA_CONFIG] ${context} config at ${line}:${column}: ${message}`);
    this.name = 'StaticConfigParseError';
    this.line = line;
    this.column = column;
  }
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
const FUNCTION_MEMORY = new Set<FunctionMemory>(['1gb', '4gb', '6gb', '8gb', '12gb']);
const ROUTE_KINDS = new Set<LegacyRouteKind>(['serverless', 'hot', 'task']);
const PAGE_PRESENTATION_KEYS = new Set(['styles']);
const OMIT_DYNAMIC_VALUE = Symbol('omit-dynamic-static-config-value');
type ParsedConfigValue = StaticConfigValue | typeof OMIT_DYNAMIC_VALUE;

/**
 * Replace strings, templates, and comments with spaces while preserving source
 * offsets and newlines. Regex checks can then find export syntax without being
 * fooled by examples inside comments or string literals.
 */
export function maskNonCode(source: string): string {
  const chars = source.split('');
  let state: 'code' | 'single' | 'double' | 'template' | 'regex' | 'line-comment' | 'block-comment' = 'code';
  let escaped = false;
  let regexCharacterClass = false;

  for (let i = 0; i < chars.length; i++) {
    const char = source[i]!;
    const next = source[i + 1];

    if (state === 'code') {
      if (char === '/' && next === '/') {
        chars[i] = chars[i + 1] = ' ';
        state = 'line-comment';
        i++;
      } else if (char === '/' && next === '*') {
        chars[i] = chars[i + 1] = ' ';
        state = 'block-comment';
        i++;
      } else if (char === "'") {
        chars[i] = ' ';
        state = 'single';
      } else if (char === '"') {
        chars[i] = ' ';
        state = 'double';
      } else if (char === '`') {
        chars[i] = ' ';
        state = 'template';
      } else if (char === '/' && canStartRegexLiteral(source, i)) {
        chars[i] = ' ';
        state = 'regex';
        regexCharacterClass = false;
      }
      continue;
    }

    if (char !== '\n' && char !== '\r') chars[i] = ' ';

    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        chars[i + 1] = ' ';
        state = 'code';
        i++;
      }
      continue;
    }

    if (state === 'regex') {
      if (char === '\n' || char === '\r') {
        state = 'code';
        regexCharacterClass = false;
        continue;
      }
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '[') regexCharacterClass = true;
      else if (char === ']') regexCharacterClass = false;
      else if (char === '/' && !regexCharacterClass) state = 'code';
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if ((state === 'single' && char === "'") ||
        (state === 'double' && char === '"') ||
        (state === 'template' && char === '`')) {
      state = 'code';
    }
  }

  return chars.join('');
}

function canStartRegexLiteral(source: string, slashIndex: number): boolean {
  let index = slashIndex - 1;
  while (index >= 0 && /\s/.test(source[index]!)) index--;
  if (index < 0) return true;
  const previous = source[index]!;
  if ('([{,:;=!?&|+-*%^~<>'.includes(previous)) return true;
  if (/[\w$]/.test(previous)) {
    const end = index + 1;
    while (index >= 0 && /[\w$]/.test(source[index]!)) index--;
    return new Set([
      'return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof',
      'in', 'of', 'yield', 'await', 'else', 'do',
    ]).has(source.slice(index + 1, end));
  }
  return false;
}

class StaticLiteralParser {
  constructor(
    private readonly source: string,
    private index: number,
    private readonly context: string,
    private readonly omitIdentifierReferences = false,
  ) {}

  parseValue(omitIdentifierReferences = this.omitIdentifierReferences): ParsedConfigValue {
    this.skipTrivia();
    const char = this.source[this.index];
    if (char === '{') return this.parseObject(omitIdentifierReferences);
    if (char === '[') return this.parseArray(omitIdentifierReferences);
    if (char === "'" || char === '"') return this.parseString();
    if (char === '`') this.fail('template literals are not allowed');
    if (char === '-' || char === '.' || (char !== undefined && /\d/.test(char))) {
      return this.parseNumber();
    }
    if (char !== undefined && /[A-Za-z_$]/.test(char)) {
      const start = this.index;
      const identifier = this.parseIdentifier();
      if (identifier === 'true') return true;
      if (identifier === 'false') return false;
      if (identifier === 'null') return null;
      if (omitIdentifierReferences) return OMIT_DYNAMIC_VALUE;
      this.fail('identifiers are not allowed as values', start);
    }
    this.fail(`expected a static literal, found ${JSON.stringify(char ?? 'end of input')}`);
  }

  private parseObject(omitIdentifierReferences: boolean): StaticConfigObject {
    const result: StaticConfigObject = {};
    this.index++;
    this.skipTrivia();
    if (this.source[this.index] === '}') {
      this.index++;
      return result;
    }

    while (this.index < this.source.length) {
      this.skipTrivia();
      if (this.source.startsWith('...', this.index)) {
        this.fail('spread properties are not allowed');
      }
      if (this.source[this.index] === '[') {
        this.fail('computed properties are not allowed');
      }

      const key = this.source[this.index] === "'" || this.source[this.index] === '"'
        ? this.parseString()
        : this.parseIdentifier();
      if (typeof key !== 'string' || key.length === 0) {
        this.fail('object keys must be identifiers or string literals');
      }

      this.skipTrivia();
      if (this.source[this.index] !== ':') {
        this.fail('object properties must use key: literal syntax');
      }
      this.index++;
      const omitPropertyReference = omitIdentifierReferences ||
        (this.context === 'page' && PAGE_PRESENTATION_KEYS.has(key));
      const value = this.parseValue(omitPropertyReference);
      this.skipConstAssertion();
      if (value !== OMIT_DYNAMIC_VALUE) result[key] = value;

      this.skipTrivia();
      const separator = this.source[this.index];
      if (separator === '}') {
        this.index++;
        return result;
      }
      if (separator !== ',') {
        this.fail('expected a comma or closing brace');
      }
      this.index++;
      this.skipTrivia();
      if (this.source[this.index] === '}') {
        this.index++;
        return result;
      }
    }

    this.fail('unterminated object literal');
  }

  private parseArray(omitIdentifierReferences: boolean): ParsedConfigValue {
    const result: StaticConfigValue[] = [];
    let hasDynamicValue = false;
    this.index++;
    this.skipTrivia();
    if (this.source[this.index] === ']') {
      this.index++;
      return result;
    }

    while (this.index < this.source.length) {
      if (this.source.startsWith('...', this.index)) {
        this.fail('array spreads are not allowed');
      }
      const value = this.parseValue(omitIdentifierReferences);
      if (value === OMIT_DYNAMIC_VALUE) hasDynamicValue = true;
      else result.push(value);
      this.skipConstAssertion();
      this.skipTrivia();
      const separator = this.source[this.index];
      if (separator === ']') {
        this.index++;
        return hasDynamicValue ? OMIT_DYNAMIC_VALUE : result;
      }
      if (separator !== ',') this.fail('expected a comma or closing bracket');
      this.index++;
      this.skipTrivia();
      if (this.source[this.index] === ']') {
        this.index++;
        return hasDynamicValue ? OMIT_DYNAMIC_VALUE : result;
      }
    }

    this.fail('unterminated array literal');
  }

  private parseIdentifier(): string {
    const start = this.index;
    const first = this.source[this.index];
    if (first === undefined || !/[A-Za-z_$]/.test(first)) {
      this.fail('object keys must be identifiers or string literals');
    }
    this.index++;
    while (this.index < this.source.length && /[\w$]/.test(this.source[this.index]!)) {
      this.index++;
    }
    return this.source.slice(start, this.index);
  }

  private parseString(): string {
    const quote = this.source[this.index]!;
    const start = this.index;
    this.index++;
    let value = '';

    while (this.index < this.source.length) {
      const char = this.source[this.index++]!;
      if (char === quote) return value;
      if (char === '\n' || char === '\r') this.fail('unterminated string literal', start);
      if (char !== '\\') {
        value += char;
        continue;
      }

      const escaped = this.source[this.index++];
      if (escaped === undefined) this.fail('unterminated string escape', start);
      const simpleEscapes: Record<string, string> = {
        n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v',
        '0': '\0', '\\': '\\', "'": "'", '"': '"',
      };
      if (escaped in simpleEscapes) {
        value += simpleEscapes[escaped]!;
      } else if (escaped === '\n') {
        // JavaScript line continuation contributes no character.
      } else if (escaped === '\r') {
        if (this.source[this.index] === '\n') this.index++;
      } else if (escaped === 'x') {
        value += String.fromCharCode(this.parseHexDigits(2));
      } else if (escaped === 'u') {
        if (this.source[this.index] === '{') {
          this.index++;
          const hexStart = this.index;
          while (/[0-9A-Fa-f]/.test(this.source[this.index] ?? '')) this.index++;
          const raw = this.source.slice(hexStart, this.index);
          if (!raw || this.source[this.index] !== '}') this.fail('invalid Unicode escape', hexStart);
          this.index++;
          value += String.fromCodePoint(Number.parseInt(raw, 16));
        } else {
          value += String.fromCharCode(this.parseHexDigits(4));
        }
      } else {
        value += escaped;
      }
    }

    this.fail('unterminated string literal', start);
  }

  private parseHexDigits(length: number): number {
    const start = this.index;
    const raw = this.source.slice(start, start + length);
    if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(raw)) {
      this.fail('invalid hexadecimal escape', start);
    }
    this.index += length;
    return Number.parseInt(raw, 16);
  }

  private parseNumber(): number {
    const start = this.index;
    const raw = this.source.slice(start);
    const match = raw.match(/^-?(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.(?:\d(?:_?\d)*))(?:[eE][+-]?\d(?:_?\d)*)?/);
    if (!match) this.fail('invalid numeric literal', start);
    const literal = match[0];
    const next = this.source[start + literal.length];
    if (next !== undefined && !/[\s,}\]]/.test(next) && next !== '/') {
      this.fail('invalid numeric literal', start);
    }
    this.index += literal.length;
    const value = Number(literal.replaceAll('_', ''));
    if (!Number.isFinite(value)) this.fail('numeric literal must be finite', start);
    return value;
  }

  private skipTrivia(): void {
    while (this.index < this.source.length) {
      if (/\s/.test(this.source[this.index]!)) {
        this.index++;
        continue;
      }
      if (this.source.startsWith('//', this.index)) {
        this.index += 2;
        while (this.index < this.source.length && this.source[this.index] !== '\n') this.index++;
        continue;
      }
      if (this.source.startsWith('/*', this.index)) {
        const commentStart = this.index;
        const end = this.source.indexOf('*/', this.index + 2);
        if (end === -1) this.fail('unterminated block comment', commentStart);
        this.index = end + 2;
        continue;
      }
      break;
    }
  }

  /** Preserve the common TypeScript `value as const` static-literal form. */
  private skipConstAssertion(): void {
    this.skipTrivia();
    const assertion = /^as\s+const\b/.exec(this.source.slice(this.index));
    if (assertion) {
      this.index += assertion[0].length;
    }
  }

  private fail(message: string, index = this.index): never {
    throw new StaticConfigParseError(this.source, index, this.context, message);
  }
}

function exportAssignmentIndex(source: string, exportName: string): number | null {
  const masked = maskNonCode(source);
  const pattern = new RegExp(`\\bexport\\s+const\\s+${exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  const match = pattern.exec(masked);
  return match ? match.index + match[0].length : null;
}

function parseStaticExport(
  source: string,
  exportName: string,
  context: string,
  omitIdentifierReferences = false,
): { found: boolean; value?: ParsedConfigValue } {
  const index = exportAssignmentIndex(source, exportName);
  if (index === null) return { found: false };
  const parser = new StaticLiteralParser(source, index, context, omitIdentifierReferences);
  return { found: true, value: parser.parseValue() };
}

export function parseStaticObjectExport(
  source: string,
  exportName: string,
  context = exportName,
): StaticConfigObject | null {
  const parsed = parseStaticExport(source, exportName, context);
  if (!parsed.found) return null;
  if (!isStaticObject(parsed.value)) {
    const index = exportAssignmentIndex(source, exportName) ?? 0;
    throw new StaticConfigParseError(source, index, context, 'expected a plain object literal');
  }
  return parsed.value;
}

function validationError(source: string | undefined, key: string, message: string): never {
  if (source) {
    const masked = maskNonCode(source);
    const index = Math.max(0, masked.indexOf(key));
    throw new StaticConfigParseError(source, index, 'route', message);
  }
  throw new TypeError(`[VURA_CONFIG] route config: ${message}`);
}

function isStaticObject(value: ParsedConfigValue | undefined): value is StaticConfigObject {
  return value !== OMIT_DYNAMIC_VALUE && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: StaticConfigValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function assertCpu(value: StaticConfigValue | undefined, source?: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0)) {
    validationError(source, 'cpu', 'route.compute.cpu must be a positive integer');
  }
}

function memoryToMb(value: StaticConfigValue | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(gb|gib|mb|mib)$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return Math.floor(amount * (/^g/i.test(match[2]!) ? 1024 : 1));
}

function dedicatedMachineCompatibility(
  machine: StaticConfigObject,
  compute: StaticConfigObject,
): StaticConfigObject {
  const compatible: StaticConfigObject = { ...machine };
  const memoryMb = memoryToMb(compute.memory ?? compute.memoryMb);
  if (memoryMb !== undefined) compatible.memoryMb = memoryMb;
  const cpu = compute.cpu ?? compute.cpus;
  if (typeof cpu === 'number' && Number.isFinite(cpu) && cpu > 0) {
    compatible.cpus = cpu;
  }
  return compatible;
}

/**
 * Normalize the source contract while retaining legacy keys in `config` for
 * one compatibility window. `kind` remains the adapter-facing legacy route
 * kind; `config.compute` is the canonical platform contract.
 */
export function normalizeRouteConfig(
  input: StaticConfigObject,
  source?: string,
): { kind: LegacyRouteKind; config: StaticConfigObject } {
  const config: StaticConfigObject = { ...input };
  if (config.kind !== undefined && typeof config.kind !== 'string') {
    validationError(source, 'kind', "route.kind must be 'serverless', 'hot', or 'task'");
  }
  const sourceKind = optionalString(config.kind);
  if (sourceKind !== undefined && !ROUTE_KINDS.has(sourceKind as LegacyRouteKind)) {
    validationError(source, 'kind', "route.kind must be 'serverless', 'hot', or 'task'");
  }
  const kind = sourceKind as LegacyRouteKind | undefined ?? 'serverless';

  if (config.compute !== undefined && !isStaticObject(config.compute)) {
    validationError(source, 'compute', 'route.compute must be a plain object literal');
  }
  if (config.machine !== undefined && !isStaticObject(config.machine)) {
    validationError(source, 'machine', 'legacy route.machine must be a plain object literal');
  }

  const rawCompute = isStaticObject(config.compute) ? config.compute : {};
  const machine = isStaticObject(config.machine) ? config.machine : {};
  const explicitClass = optionalString(rawCompute.class);
  if (rawCompute.class !== undefined && explicitClass === undefined) {
    validationError(source, 'class', "route.compute.class must be 'edge', 'function', or 'dedicated'");
  }
  if (explicitClass !== undefined && !['edge', 'function', 'dedicated'].includes(explicitClass)) {
    validationError(source, 'class', "route.compute.class must be 'edge', 'function', or 'dedicated'");
  }

  const legacyDedicated = kind === 'hot' || config.hot === true ||
    ['runtime', 'placement', 'target'].some((key) => config[key] === 'hot') ||
    Object.keys(machine).length > 0;
  const requestedClass = (explicitClass ?? (legacyDedicated ? 'dedicated' : 'function')) as ComputeClass;

  if (kind === 'hot' && explicitClass && explicitClass !== 'dedicated') {
    validationError(source, 'class', "kind: 'hot' conflicts with a non-dedicated compute.class");
  }

  let compute: StaticConfigObject;
  if (requestedClass === 'edge') {
    const requestedMemory = rawCompute.memory ?? '128mb';
    if (requestedMemory !== '128mb') {
      validationError(source, 'memory', "Edge requests have fixed memory '128mb'; Function supports 1gb/4gb/6gb/8gb/12gb");
    }
    if (rawCompute.cpu !== undefined) {
      validationError(source, 'cpu', 'Edge requests cannot select CPU; request Function or Dedicated compute instead');
    }
    compute = {
      ...rawCompute,
      class: 'edge',
      memory: '128mb',
      effectiveClass: 'function',
      effectiveMemory: '1gb',
      requestedClass: 'edge',
      requestedMemory: '128mb',
      edgeEligibility: 'pending',
    };
  } else if (requestedClass === 'function') {
    const memory = rawCompute.memory ?? '1gb';
    if (typeof memory !== 'string' || !FUNCTION_MEMORY.has(memory as FunctionMemory)) {
      validationError(source, 'memory', "Function memory must be one of '1gb', '4gb', '6gb', '8gb', or '12gb'");
    }
    assertCpu(rawCompute.cpu, source);
    compute = { ...rawCompute, class: 'function', memory };
  } else {
    assertCpu(rawCompute.cpu ?? rawCompute.cpus ?? machine.cpu ?? machine.cpus, source);
    compute = { ...machine, ...rawCompute, class: 'dedicated' };
  }

  config.compute = compute;
  if (requestedClass === 'dedicated') {
    const compatibleMachine = dedicatedMachineCompatibility(machine, compute);
    if (Object.keys(compatibleMachine).length > 0) config.machine = compatibleMachine;
    const hasLegacyHotMarker = config.hot === true ||
      ['runtime', 'placement', 'target'].some((key) => config[key] === 'hot');
    if (kind === 'task' && !hasLegacyHotMarker) config.hot = true;
  }
  const effectiveKind: LegacyRouteKind = kind === 'task'
    ? 'task'
    : requestedClass === 'dedicated'
      ? 'hot'
      : 'serverless';
  return { kind: effectiveKind, config };
}

export function readRouteConfig(source: string): { kind: LegacyRouteKind; config: StaticConfigObject } {
  const route = parseStaticObjectExport(source, 'route', 'route');
  const config: StaticConfigObject = route ? { ...route } : {};

  if (!route) {
    const shorthand = parseStaticExport(source, 'kind', 'route kind');
    if (shorthand.found) {
      if (typeof shorthand.value !== 'string') {
        validationError(source, 'kind', 'exported route kind must be a string literal');
      }
      config.kind = shorthand.value;
    }
  }

  if (config.schedule === undefined) {
    const schedule = parseStaticExport(source, 'schedule', 'route schedule');
    if (schedule.found) {
      if (typeof schedule.value !== 'string') {
        validationError(source, 'schedule', 'exported task schedule must be a string literal');
      }
      config.schedule = schedule.value;
    }
  }

  return normalizeRouteConfig(config, source);
}

export function readPageConfig(source: string): StaticConfigObject {
  // Page modules may reference presentation values such as `styles:
  // [baseStyles]`. Those values are evaluated only when the renderer imports
  // the page; the manifest scanner omits them while keeping deployment-relevant
  // literals (mode, revalidate, tags, title) static and deterministic.
  const parsed = parseStaticExport(source, 'page', 'page');
  if (!parsed.found) return {};
  if (!isStaticObject(parsed.value)) {
    const index = exportAssignmentIndex(source, 'page') ?? 0;
    throw new StaticConfigParseError(source, index, 'page', 'expected a plain object literal');
  }
  return parsed.value;
}

export function scanRoute(source: string, _fileType: string): ScanResult {
  const code = maskNonCode(source);
  const methods: string[] = [];
  for (const method of HTTP_METHODS) {
    const pattern = new RegExp(
      `export\\s+(?:async\\s+)?(?:function\\s+${method}|const\\s+${method}\\s*=)`,
    );
    if (pattern.test(code)) methods.push(method);
  }

  const hasWebsocket = /export\s+(?:async\s+)?(?:function\s+websocket\b|const\s+websocket\s*=)/.test(code);
  const hasRouteConfig = exportAssignmentIndex(source, 'route') !== null || exportAssignmentIndex(source, 'kind') !== null;
  const route = methods.length > 0 || hasWebsocket || hasRouteConfig
    ? readRouteConfig(source)
    : { kind: 'serverless' as const, config: {} };

  const pageConfig = readPageConfig(source);
  const config: StaticConfigObject = { ...route.config, ...pageConfig };
  let pageMode = optionalString(pageConfig.mode) ?? null;

  const hasDefaultExport = /export\s+default\s+/.test(code);
  const hasGetServerData = /export\s+(?:async\s+)?function\s+getServerData|export\s+(?:const|let)\s+getServerData/.test(code);
  if (!pageMode && hasGetServerData) pageMode = 'server';
  if (!pageMode && (/import\s+.*from\s+['"]then\/server['"]/.test(source) || /useSWR|useQuery|useServerData/.test(code))) {
    pageMode = 'server';
  }

  return {
    methods,
    kind: route.kind,
    hasDefaultExport,
    hasGetServerData,
    pageMode,
    config,
  };
}

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
