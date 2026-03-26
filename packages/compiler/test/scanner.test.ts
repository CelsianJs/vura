import { describe, it, expect } from 'vitest';
import { scanRoute, transformJsx } from '../src/index.js';

describe('scanRoute', () => {
  it('detects HTTP method exports', () => {
    const source = `
      export function GET(req, reply) { return reply.json({}); }
      export async function POST(req, reply) { return reply.json({}); }
    `;
    const result = scanRoute(source, 'ts');
    expect(result.methods).toEqual(['GET', 'POST']);
    expect(result.kind).toBe('serverless');
  });

  it('detects arrow function exports', () => {
    const source = `
      export const GET = (req, reply) => reply.json({});
      export const DELETE = async (req, reply) => reply.json({});
    `;
    const result = scanRoute(source, 'ts');
    expect(result.methods).toEqual(['GET', 'DELETE']);
  });

  it('extracts route config', () => {
    const source = `
      export const route = { kind: 'hot', timeout: 5000 };
      export function GET(req, reply) {}
    `;
    const result = scanRoute(source, 'ts');
    expect(result.kind).toBe('hot');
    expect(result.config.timeout).toBe(5000);
  });

  it('extracts task config', () => {
    const source = `
      export const route = { kind: 'task', schedule: '*/5 * * * *', retries: 3, timeout: 30000 };
      export async function POST(job) { return { success: true }; }
    `;
    const result = scanRoute(source, 'ts');
    expect(result.kind).toBe('task');
    expect(result.config.schedule).toBe('*/5 * * * *');
    expect(result.config.retries).toBe(3);
  });

  it('extracts page config', () => {
    const source = `
      export const page = { mode: 'server', revalidate: 60 };
      export default function Page() { return <div>Hello</div>; }
    `;
    const result = scanRoute(source, 'tsx');
    expect(result.pageMode).toBe('server');
    expect(result.config.revalidate).toBe(60);
    expect(result.hasDefaultExport).toBe(true);
  });

  it('detects getServerData', () => {
    const source = `
      export async function getServerData(ctx) { return {}; }
      export default function Page() { return <div>Hello</div>; }
    `;
    const result = scanRoute(source, 'tsx');
    expect(result.hasGetServerData).toBe(true);
    expect(result.pageMode).toBe('server');
  });

  it('detects default export', () => {
    const source = `export default function Component() {}`;
    expect(scanRoute(source, 'tsx').hasDefaultExport).toBe(true);
  });

  it('returns empty for non-route files', () => {
    const source = `export function helper() {}`;
    const result = scanRoute(source, 'ts');
    expect(result.methods).toEqual([]);
    expect(result.kind).toBe('serverless');
    expect(result.hasDefaultExport).toBe(false);
  });
});

describe('transformJsx', () => {
  it('prepends JSX runtime import in dev mode', () => {
    const result = transformJsx('<div>Hello</div>');
    expect(result.code).toContain("import { jsx as _jsx");
    expect(result.code).toContain("from 'what-framework/jsx-runtime'");
  });

  it('prepends template import in production mode', () => {
    const result = transformJsx('<div>Hello</div>', { production: true });
    expect(result.code).toContain('import { template, insert');
    expect(result.code).toContain("from 'what-framework/server'");
  });

  it('uses custom jsxImportSource', () => {
    const result = transformJsx('<div/>', { jsxImportSource: '@then/core' });
    expect(result.code).toContain("from '@then/core/jsx-runtime'");
  });
});
