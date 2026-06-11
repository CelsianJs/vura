import { describe, it, expect } from 'vitest';
import { compileRoutes, matchApiPath, compilePageRoutes, matchPageRoute } from '../src/match.js';
import type { ApiRoute, PageRoute } from '../src/manifest.js';

const apiRoutes: ApiRoute[] = [
  { filePath: 'src/api/hello.ts', urlPattern: '/api/hello', methods: ['GET'], kind: 'serverless', config: {} },
  { filePath: 'src/api/users/index.ts', urlPattern: '/api/users', methods: ['GET', 'POST'], kind: 'serverless', config: {} },
  { filePath: 'src/api/users/[id].ts', urlPattern: '/api/users/:id', methods: ['GET', 'PUT', 'DELETE'], kind: 'hot', config: {} },
  { filePath: 'src/api/posts/[postId]/comments/[commentId].ts', urlPattern: '/api/posts/:postId/comments/:commentId', methods: ['GET'], kind: 'serverless', config: {} },
  { filePath: 'src/api/assets.ts', urlPattern: '/api/assets/*', methods: ['GET'], kind: 'serverless', config: {} },
];

const pageRoutes: PageRoute[] = [
  { filePath: 'src/pages/index.tsx', urlPattern: '/', mode: 'server', config: {} },
  { filePath: 'src/pages/about.tsx', urlPattern: '/about', mode: 'static', config: {} },
  { filePath: 'src/pages/blog/[slug].tsx', urlPattern: '/blog/:slug', mode: 'server', config: {} },
  { filePath: 'src/pages/docs/[...path].tsx', urlPattern: '/docs/*', mode: 'static', config: {} },
];

describe('compileRoutes', () => {
  it('compiles routes for reuse', () => {
    const compiled = compileRoutes(apiRoutes);
    expect(compiled).toHaveLength(apiRoutes.length);
    expect(compiled[0]).toHaveProperty('regex');
    expect(compiled[0]).toHaveProperty('paramNames');
  });

  it('produces stable output for the same input', () => {
    const a = compileRoutes(apiRoutes);
    const b = compileRoutes(apiRoutes);
    expect(a.map(r => r.regex.source)).toEqual(b.map(r => r.regex.source));
  });
});

describe('matchApiPath', () => {
  it('returns true for an exact static match', () => {
    expect(matchApiPath(apiRoutes, '/api/hello')).toBe(true);
  });

  it('returns false for a non-existent path', () => {
    expect(matchApiPath(apiRoutes, '/api/nonexistent')).toBe(false);
  });

  it('returns true regardless of HTTP method', () => {
    // /api/hello only has GET, but matchApiPath is method-agnostic
    expect(matchApiPath(apiRoutes, '/api/hello')).toBe(true);
  });

  it('matches :param patterns', () => {
    expect(matchApiPath(apiRoutes, '/api/users/42')).toBe(true);
    expect(matchApiPath(apiRoutes, '/api/users/abc-xyz')).toBe(true);
  });

  it('matches wildcard patterns', () => {
    expect(matchApiPath(apiRoutes, '/api/assets/images/logo.png')).toBe(true);
    expect(matchApiPath(apiRoutes, '/api/assets/')).toBe(true);
  });

  it('does not match partial paths', () => {
    expect(matchApiPath(apiRoutes, '/api/hell')).toBe(false);
    expect(matchApiPath(apiRoutes, '/api/hello/extra')).toBe(false);
  });

  it('works with pre-compiled routes', () => {
    const compiled = compileRoutes(apiRoutes);
    expect(matchApiPath(compiled, '/api/users/99')).toBe(true);
    expect(matchApiPath(compiled, '/not/found')).toBe(false);
  });

  it('escapes regex-special characters in static segments', () => {
    const specialRoutes: ApiRoute[] = [
      { filePath: 'test.ts', urlPattern: '/api/v1.0/status', methods: ['GET'], kind: 'serverless', config: {} },
    ];
    expect(matchApiPath(specialRoutes, '/api/v1.0/status')).toBe(true);
    // dot must be literal — /api/v1X0/status should NOT match
    expect(matchApiPath(specialRoutes, '/api/v1X0/status')).toBe(false);
  });
});

describe('compilePageRoutes', () => {
  it('compiles page routes into regex matchers', () => {
    const compiled = compilePageRoutes(pageRoutes);
    expect(compiled).toHaveLength(pageRoutes.length);
    expect(compiled[0]).toHaveProperty('regex');
    expect(compiled[0]).toHaveProperty('paramNames');
    expect(compiled[0]).toHaveProperty('page');
  });
});

describe('matchPageRoute', () => {
  it('matches the root page', () => {
    const result = matchPageRoute(pageRoutes, '/');
    expect(result).not.toBeNull();
    expect(result!.page.filePath).toBe('src/pages/index.tsx');
    expect(result!.params).toEqual({});
  });

  it('matches a static page', () => {
    const result = matchPageRoute(pageRoutes, '/about');
    expect(result).not.toBeNull();
    expect(result!.page.filePath).toBe('src/pages/about.tsx');
  });

  it('extracts :param from page routes', () => {
    const result = matchPageRoute(pageRoutes, '/blog/my-post');
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ slug: 'my-post' });
  });

  it('URL-decodes page params', () => {
    const result = matchPageRoute(pageRoutes, '/blog/hello%20world');
    expect(result).not.toBeNull();
    expect(result!.params.slug).toBe('hello world');
  });

  it('matches catch-all page routes', () => {
    const result = matchPageRoute(pageRoutes, '/docs/api/reference/foo');
    expect(result).not.toBeNull();
    expect(result!.params['*']).toBe('api/reference/foo');
  });

  it('returns null for unmatched paths', () => {
    expect(matchPageRoute(pageRoutes, '/not-a-page')).toBeNull();
  });

  it('works with pre-compiled page routes', () => {
    const compiled = compilePageRoutes(pageRoutes);
    const result = matchPageRoute(compiled, '/blog/test-slug');
    expect(result).not.toBeNull();
    expect(result!.params.slug).toBe('test-slug');
  });
});
