import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  invalidRouteConfigFixtures,
  invalidPageConfigFixtures,
  scannerFalsePositiveFixtures,
  validPageConfigFixtures,
  validRouteConfigFixtures,
} from '../../../test/fixtures/static-route-config.js';

const require = createRequire(import.meta.url);
const { scanRoute } = require('../index.js') as {
  scanRoute(source: string, fileType: string): {
    methods: string[];
    kind: 'serverless' | 'hot' | 'task';
    hasDefaultExport: boolean;
    hasGetServerData: boolean;
    pageMode: string | null;
    config: Record<string, unknown>;
  };
};

describe('native scanRoute static config parity', () => {
  it.each(validRouteConfigFixtures)(
    'parses shared fixture: $name',
    ({ source, expectedKind, expectedConfig }) => {
      const result = scanRoute(source, 'ts');
      expect(result.kind).toBe(expectedKind);
      expect(result.config).toEqual(expectedConfig);
    },
  );

  it.each(invalidRouteConfigFixtures)(
    'rejects unsafe shared fixture: $name',
    ({ source, message }) => {
      expect(() => scanRoute(source, 'ts')).toThrow(message);
      expect(() => scanRoute(source, 'ts')).toThrow(/route config at \d+:\d+/);
    },
  );

  it.each(validPageConfigFixtures)(
    'preserves shared page fixture: $name',
    ({ source, expectedMode, expectedConfig }) => {
      const result = scanRoute(source, 'tsx');
      expect(result.pageMode).toBe(expectedMode);
      expect(result.config).toEqual(expectedConfig);
    },
  );

  it.each(invalidPageConfigFixtures)(
    'rejects unsafe shared page fixture: $name',
    ({ source, message }) => {
      expect(() => scanRoute(source, 'tsx')).toThrow(message);
      expect(() => scanRoute(source, 'tsx')).toThrow(/page config at \d+:\d+/);
    },
  );

  it.each(scannerFalsePositiveFixtures)(
    'ignores scanner false positive: $name',
    ({ source }) => {
      const result = scanRoute(source, 'ts');
      expect(result.methods).toEqual([]);
      expect(result.config).toEqual({});
    },
  );

  it('preserves shorthand kind and schedule exports', () => {
    const result = scanRoute(
      `
        export const kind = 'task';
        export const schedule = '*/5 * * * *';
        export async function POST() {}
      `,
      'ts',
    );

    expect(result.kind).toBe('task');
    expect(result.config).toEqual({
      kind: 'task',
      schedule: '*/5 * * * *',
      compute: { class: 'function', memory: '1gb' },
    });
  });

  it('omits page presentation identifiers without evaluating them', () => {
    const result = scanRoute(
      `
        import { baseStyles } from './styles.js';
        export const page = {
          mode: 'server',
          revalidate: 60,
          styles: [baseStyles],
        } as const;
        export default function Page() { return null; }
      `,
      'tsx',
    );

    expect(result.pageMode).toBe('server');
    expect(result.hasDefaultExport).toBe(true);
    expect(result.config).toEqual({ mode: 'server', revalidate: 60 });
  });

  it('keeps non-route modules free of synthesized compute config', () => {
    expect(scanRoute('export function helper() {}', 'ts')).toMatchObject({
      methods: [],
      kind: 'serverless',
      pageMode: null,
      config: {},
    });
  });

  it('returns HTTP methods in the fallback compiler order', () => {
    const result = scanRoute(
      `
        export const POST = () => undefined;
        export function GET() {}
        export const DELETE = () => undefined;
      `,
      'ts',
    );
    expect(result.methods).toEqual(['GET', 'POST', 'DELETE']);
  });
});
