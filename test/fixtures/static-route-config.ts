export interface RouteConfigFixture {
  name: string;
  source: string;
  expectedKind: 'serverless' | 'hot' | 'task';
  expectedConfig: Record<string, unknown>;
}

const functionMemoryProfiles = ['1gb', '4gb', '6gb', '8gb', '12gb'] as const;

/**
 * Public route-config behavior shared by the fallback compiler and the core
 * manifest scanner. Keep this corpus implementation-agnostic: consumers must
 * agree on the complete parsed structure, not just a few selected fields.
 */
export const validRouteConfigFixtures: RouteConfigFixture[] = [
  {
    name: 'function task with numeric separators and nested compute metadata',
    source: `
      export const route = {
        kind: 'task',
        compute: {
          class: 'function',
          memory: '4gb',
          cpu: 2,
          limits: { burst: true, shares: 1_024, jitter: -0.25 },
        },
        timeout: 60_000,
        retries: 3,
      };
      export async function POST() {}
    `,
    expectedKind: 'task',
    expectedConfig: {
      kind: 'task',
      compute: {
        class: 'function',
        memory: '4gb',
        cpu: 2,
        limits: { burst: true, shares: 1024, jitter: -0.25 },
      },
      timeout: 60000,
      retries: 3,
    },
  },
  {
    name: 'legacy hot machine config normalized to dedicated',
    source: `
      export const route = {
        kind: 'hot',
        machine: {
          memory: '8gb',
          cpu: 4,
          architecture: 'x86_64',
        },
        timeout: 120_000,
      };
      export function GET() {}
    `,
    expectedKind: 'hot',
    expectedConfig: {
      kind: 'hot',
      machine: {
        memory: '8gb',
        cpu: 4,
        architecture: 'x86_64',
        memoryMb: 8192,
        cpus: 4,
      },
      timeout: 120000,
      compute: {
        memory: '8gb',
        cpu: 4,
        architecture: 'x86_64',
        class: 'dedicated',
      },
    },
  },
  {
    name: 'legacy task runtime normalized to dedicated compute',
    source: `
      export const route = {
        kind: 'task',
        runtime: 'hot',
        schedule: '*/15 * * * *',
      };
      export async function POST() {}
    `,
    expectedKind: 'task',
    expectedConfig: {
      kind: 'task',
      runtime: 'hot',
      schedule: '*/15 * * * *',
      compute: { class: 'dedicated' },
    },
  },
  {
    name: 'canonical dedicated endpoint maps to the legacy hot runtime kind',
    source: `
      export const route = {
        compute: { class: 'dedicated', memory: '12gb', cpu: 6 },
      };
      export function GET() {}
    `,
    expectedKind: 'hot',
    expectedConfig: {
      compute: { class: 'dedicated', memory: '12gb', cpu: 6 },
      machine: { memoryMb: 12288, cpus: 6 },
    },
  },
  {
    name: 'edge source intent remains a pending request on safe function compute',
    source: `
      export const route = {
        compute: { class: 'edge', memory: '128mb' },
      };
      export function GET() {}
    `,
    expectedKind: 'serverless',
    expectedConfig: {
      compute: {
        class: 'edge',
        memory: '128mb',
        effectiveClass: 'function',
        effectiveMemory: '1gb',
        requestedClass: 'edge',
        requestedMemory: '128mb',
        edgeEligibility: 'pending',
      },
    },
  },
  {
    name: 'undeclared endpoint defaults to one-gibibyte function compute',
    source: `export function GET() {}`,
    expectedKind: 'serverless',
    expectedConfig: {
      compute: { class: 'function', memory: '1gb' },
    },
  },
  {
    name: 'canonical dedicated task emits legacy hot sizing compatibility',
    source: `
      export const route = {
        kind: 'task',
        compute: { class: 'dedicated', memory: '12gb', cpu: 6 },
      };
      export function POST() {}
    `,
    expectedKind: 'task',
    expectedConfig: {
      kind: 'task',
      compute: { class: 'dedicated', memory: '12gb', cpu: 6 },
      machine: { memoryMb: 12288, cpus: 6 },
      hot: true,
    },
  },
  {
    name: 'arrays null comments escapes and const assertions remain static',
    source: `
      export const route = {
        // The native and JavaScript scanners must preserve the complete value.
        tags: ['api', null, true, -2.5] as const,
        metadata: {
          label: 'hot\\npath',
          thresholds: [0.25, 1_000, 1e3],
        } as const,
      } as const;
      export function GET() {}
    `,
    expectedKind: 'serverless',
    expectedConfig: {
      tags: ['api', null, true, -2.5],
      metadata: {
        label: 'hot\npath',
        thresholds: [0.25, 1000, 1000],
      },
      compute: { class: 'function', memory: '1gb' },
    },
  },
  ...functionMemoryProfiles.map((memory) => ({
    name: `accepted Function memory profile ${memory}`,
    source: `export const route = { compute: { class: 'function', memory: '${memory}' } }; export function GET() {}`,
    expectedKind: 'serverless' as const,
    expectedConfig: { compute: { class: 'function', memory } },
  })),
];

export const invalidRouteConfigFixtures = [
  {
    name: 'spread property',
    source: `export const route = { ...base, timeout: 1_000 };`,
    message: 'spread properties are not allowed',
  },
  {
    name: 'identifier value',
    source: `export const route = { timeout: DEFAULT_TIMEOUT };`,
    message: 'identifiers are not allowed as values',
  },
  {
    name: 'call expression',
    source: `export const route = { timeout: calculateTimeout() };`,
    message: 'identifiers are not allowed as values',
  },
  {
    name: 'template literal',
    source: 'export const route = { schedule: `0 ${hour} * * *` };',
    message: 'template literals are not allowed',
  },
  {
    name: 'computed property',
    source: `export const route = { ['timeout']: 1_000 };`,
    message: 'computed properties are not allowed',
  },
  {
    name: 'unsupported function memory',
    source: `export const route = { compute: { class: 'function', memory: '2gb' } };`,
    message: 'Function memory must be one of',
  },
  {
    name: 'edge cpu selection',
    source: `export const route = { compute: { class: 'edge', memory: '128mb', cpu: 1 } };`,
    message: 'Edge requests cannot select CPU',
  },
  {
    name: 'non-decimal numeric literal',
    source: `export const route = { timeout: 0x100 };`,
    message: 'invalid numeric literal',
  },
  {
    name: 'unknown route kind',
    source: `export const route = { kind: 'sometimes-hot' };`,
    message: "route.kind must be 'serverless', 'hot', or 'task'",
  },
  {
    name: 'non-string route kind',
    source: `export const route = { kind: true };`,
    message: "route.kind must be 'serverless', 'hot', or 'task'",
  },
  {
    name: 'non-string compute class',
    source: `export const route = { compute: { class: 12 } };`,
    message: "route.compute.class must be 'edge', 'function', or 'dedicated'",
  },
  {
    name: 'fractional cpu',
    source: `export const route = { compute: { class: 'dedicated', cpu: 1.5 } };`,
    message: 'route.compute.cpu must be a positive integer',
  },
  {
    name: 'non-positive cpu',
    source: `export const route = { compute: { class: 'function', cpu: 0 } };`,
    message: 'route.compute.cpu must be a positive integer',
  },
] as const;

export const validPageConfigFixtures = [
  ...['static', 'server', 'client', 'hybrid'].map((mode) => ({
    name: `quoted ${mode} page mode literal`,
    source: `export const page = { mode: '${mode}', title: 'Fixture' } as const; export default function Page() {}`,
    expectedMode: mode as 'static' | 'server' | 'client' | 'hybrid',
    expectedConfig: { mode, title: 'Fixture' },
  })),
  {
    name: 'explicit styles presentation reference is omitted',
    source: `import { baseStyles } from './styles.js'; export const page = { mode: 'static', styles: [baseStyles] };`,
    expectedMode: 'static' as const,
    expectedConfig: { mode: 'static' },
  },
];

export const invalidPageConfigFixtures = [
  {
    name: 'identifier-valued page mode',
    source: `const MODE = 'server'; export const page = { mode: MODE }; export default function Page() {}`,
    message: 'identifiers are not allowed as values',
  },
  {
    name: 'bare page mode identifier',
    source: `export const page = { mode: server }; export default function Page() {}`,
    message: 'identifiers are not allowed as values',
  },
  {
    name: 'identifier-valued revalidate',
    source: `const TTL = 60; export const page = { mode: 'server', revalidate: TTL };`,
    message: 'identifiers are not allowed as values',
  },
  {
    name: 'identifier-valued tags',
    source: `const TAGS = ['posts']; export const page = { mode: 'server', tags: TAGS };`,
    message: 'identifiers are not allowed as values',
  },
] as const;

export const scannerFalsePositiveFixtures = [
  {
    name: 'HTTP export text inside regex literal',
    source: `const routePattern = /export function GET/; export function helper() { return routePattern; }`,
  },
  {
    name: 'escaped slash and character class inside regex literal',
    source: String.raw`const routePattern = /[a-z\/]\/export const POST/gi; export const helper = true;`,
  },
] as const;
