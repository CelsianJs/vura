import { describe, it, expect } from 'vitest';
import { matchRoute, compileRoutes } from '../src/match.js';
import type { ApiRoute } from '../src/manifest.js';

const routes: ApiRoute[] = [
  { filePath: 'src/api/hello.ts', urlPattern: '/api/hello', methods: ['GET'], kind: 'serverless', config: {} },
  { filePath: 'src/api/users/index.ts', urlPattern: '/api/users', methods: ['GET', 'POST'], kind: 'serverless', config: {} },
  { filePath: 'src/api/users/[id].ts', urlPattern: '/api/users/:id', methods: ['GET', 'PUT', 'DELETE'], kind: 'hot', config: {} },
  { filePath: 'src/api/posts/[postId]/comments/[commentId].ts', urlPattern: '/api/posts/:postId/comments/:commentId', methods: ['GET'], kind: 'serverless', config: {} },
  { filePath: 'src/api/assets.ts', urlPattern: '/api/assets/*', methods: ['GET'], kind: 'serverless', config: {} },
];

describe('matchRoute', () => {
  it('matches exact routes', () => {
    const result = matchRoute(routes, 'GET', '/api/hello');
    expect(result).not.toBeNull();
    expect(result!.route.filePath).toBe('src/api/hello.ts');
    expect(result!.params).toEqual({});
  });

  it('returns null for unmatched paths', () => {
    expect(matchRoute(routes, 'GET', '/api/nonexistent')).toBeNull();
  });

  it('filters by method', () => {
    expect(matchRoute(routes, 'DELETE', '/api/hello')).toBeNull();
    expect(matchRoute(routes, 'POST', '/api/users')).not.toBeNull();
  });

  it('extracts single param', () => {
    const result = matchRoute(routes, 'GET', '/api/users/42');
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ id: '42' });
  });

  it('extracts multiple params', () => {
    const result = matchRoute(routes, 'GET', '/api/posts/7/comments/99');
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ postId: '7', commentId: '99' });
  });

  it('matches wildcard routes', () => {
    const result = matchRoute(routes, 'GET', '/api/assets/images/logo.png');
    expect(result).not.toBeNull();
    expect(result!.params['*']).toBe('images/logo.png');
  });

  it('URL-decodes params', () => {
    const result = matchRoute(routes, 'GET', '/api/users/hello%20world');
    expect(result).not.toBeNull();
    expect(result!.params.id).toBe('hello world');
  });

  it('does not match partial paths', () => {
    expect(matchRoute(routes, 'GET', '/api/hello/extra')).toBeNull();
    expect(matchRoute(routes, 'GET', '/api/hell')).toBeNull();
  });

  it('is case-insensitive for methods', () => {
    expect(matchRoute(routes, 'get', '/api/hello')).not.toBeNull();
    expect(matchRoute(routes, 'Get', '/api/hello')).not.toBeNull();
  });

  it('escapes regex-special characters in patterns', () => {
    const specialRoutes: ApiRoute[] = [
      { filePath: 'test.ts', urlPattern: '/api/v1.0/status', methods: ['GET'], kind: 'serverless', config: {} },
    ];
    const result = matchRoute(specialRoutes, 'GET', '/api/v1.0/status');
    expect(result).not.toBeNull();
    // Should NOT match /api/v1X0/status (. must be literal)
    expect(matchRoute(specialRoutes, 'GET', '/api/v1X0/status')).toBeNull();
  });
});

describe('compileRoutes', () => {
  it('compiles routes for reuse', () => {
    const compiled = compileRoutes(routes);
    expect(compiled).toHaveLength(routes.length);
    expect(compiled[0]).toHaveProperty('regex');
    expect(compiled[0]).toHaveProperty('paramNames');
  });

  it('works with matchRoute when pre-compiled', () => {
    const compiled = compileRoutes(routes);
    const result = matchRoute(compiled, 'GET', '/api/users/42');
    expect(result).not.toBeNull();
    expect(result!.params.id).toBe('42');
  });
});
