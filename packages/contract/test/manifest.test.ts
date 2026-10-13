import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FEATURES, SCHEMA_VERSION, ManifestValidationError,
  deriveRequiredFeatures, evaluateCapabilities, isVersionedManifest,
  parseManifest, validateManifest,
  type ManifestV1, type RouteManifest,
} from '../src/index.js';

function empty(): RouteManifest {
  return { api: [], pages: [], layouts: [], timestamp: '2026-09-06T12:00:00.000Z' };
}

function realistic(): RouteManifest {
  return {
    api: [
      {
        filePath: 'src/api/chat.ts', urlPattern: '/api/chat', methods: ['GET'], kind: 'hot',
        hasWebsocket: true,
        config: { kind: 'hot', compute: { class: 'dedicated', size: 'small', memory: '512mb', cpu: 1 },
          machine: { memoryMb: 512, cpus: 1 }, custom: { queue: ['chat', 42, null] } },
      },
      {
        filePath: 'src/api/jobs/nightly.ts', urlPattern: '/api/jobs/nightly', methods: ['POST'], kind: 'task',
        config: { kind: 'task', schedule: '0 2 * * *', compute: { class: 'function', memory: '1gb' } },
      },
    ],
    pages: [{
      filePath: 'src/pages/blog/[slug].tsx', urlPattern: '/blog/:slug', mode: 'server',
      layout: 'src/pages/_layout.tsx', layouts: ['src/pages/_layout.tsx', 'src/pages/blog/_layout.tsx'],
      hasLoader: true, hasGetServerData: false,
      config: { mode: 'server', streaming: true, revalidate: 60, swr: 120, tags: 'posts,blog',
        metadata: { title: 'Blog', robots: false } },
    }, {
      filePath: 'src/pages/news.tsx', urlPattern: '/news', mode: 'server',
      hasLoader: false, hasGetServerData: false, config: { revalidate: 60 },
    }],
    layouts: [
      { filePath: 'src/pages/_layout.tsx', dirPattern: '' },
      { filePath: 'src/pages/blog/_layout.tsx', dirPattern: 'blog' },
    ],
    middleware: 'src/middleware.ts',
    actions: [{ filePath: 'src/actions/admin/users.ts', moduleId: 'admin/users', exports: ['create', 'deleteUser'] }],
    timestamp: '2026-09-06T12:00:00.000Z',
  };
}

function versioned(manifest = realistic()): ManifestV1 {
  return { ...manifest, schemaVersion: SCHEMA_VERSION, requiredFeatures: deriveRequiredFeatures(manifest) };
}

describe('manifest contract', () => {
  it('round-trips realistic current unversioned metadata with explicit compatibility', () => {
    const fixture = { ...realistic(), buildMetadata: { git: 'abc123', artifacts: ['server', 'static'] } };
    const json = JSON.stringify(fixture);
    expect(parseManifest(json, { allowLegacy: true })).toEqual(fixture);
    expect(JSON.stringify(parseManifest(json, { allowLegacy: true }))).toBe(json);
  });

  it('preserves omitted optional fields without defaulting or mutating the input', () => {
    const fixture = empty();
    const parsed = parseManifest(fixture, { allowLegacy: true });
    expect(parsed).toBe(fixture);
    expect(parsed).not.toHaveProperty('actions');
    expect(parsed).not.toHaveProperty('middleware');
    expect(parsed).not.toHaveProperty('schemaVersion');
    expect(isVersionedManifest(parsed)).toBe(false);
  });

  it('accepts explicit v1 without any legacy option and retains every field', () => {
    const fixture = versioned();
    expect(parseManifest(JSON.stringify(fixture))).toEqual(fixture);
    expect(isVersionedManifest(parseManifest(fixture))).toBe(true);
  });

  it('accepts an empty v1 manifest with no requirements', () => {
    expect(parseManifest(versioned(empty()))).toEqual(versioned(empty()));
  });

  it('fails closed on missing schema version by default', () => {
    const result = validateManifest(empty());
    expect(result).toMatchObject({ success: false, issues: [{ path: '$.schemaVersion', code: 'missing_version' }] });
    expect(() => parseManifest(empty())).toThrow(ManifestValidationError);
  });

  it.each([0, 2, 99, '1', null, undefined])('never downgrades explicit version %s to legacy', schemaVersion => {
    const fixture = { ...empty(), schemaVersion, requiredFeatures: [] };
    expect(validateManifest(fixture, { allowLegacy: true })).toMatchObject({
      success: false, issues: expect.arrayContaining([expect.objectContaining({ path: '$.schemaVersion', code: 'unsupported_version' })]),
    });
  });

  it('requires an explicit feature list in v1 and rejects unknown or duplicate features', () => {
    expect(() => parseManifest({ ...empty(), schemaVersion: 1 })).toThrow('$.requiredFeatures');
    expect(() => parseManifest({ ...versioned(empty()), requiredFeatures: ['future-unsafe-feature'] })).toThrow('Unknown required feature');
    expect(() => parseManifest({ ...versioned(empty()), requiredFeatures: ['api', 'api'] })).toThrow('Duplicate required feature');
  });

  it('does not ignore unknown feature requirements on legacy-shaped input', () => {
    expect(() => parseManifest({ ...empty(), requiredFeatures: ['future-feature'] }, { allowLegacy: true })).toThrow('Unknown required feature');
  });

  it('refuses underdeclared v1 features instead of silently adding them', () => {
    const fixture = versioned();
    fixture.requiredFeatures = fixture.requiredFeatures.filter(feature => feature !== 'actions');
    expect(() => parseManifest(fixture)).toThrow('$.requiredFeatures: Missing required feature: actions');
  });

  it('allows additional known requirements for behavior not visible to the scanner', () => {
    const fixture = versioned(empty());
    fixture.requiredFeatures = ['streaming'];
    expect(parseManifest(fixture)).toEqual(fixture);
    expect(evaluateCapabilities(fixture, { name: 'Minimal target', supportedFeatures: [] })).toMatchObject({
      compatible: false, unsupportedFeatures: ['streaming'],
    });
  });

  it('derives all visible requirements in stable registry order', () => {
    expect(deriveRequiredFeatures(realistic())).toEqual([
      'api', 'server-pages', 'layouts', 'actions', 'middleware', 'loaders',
      'websocket', 'streaming', 'isr', 'tasks', 'scheduled-tasks', 'function-compute', 'dedicated-compute',
    ]);
    const fixture = realistic();
    for (const mode of ['static', 'client', 'hybrid'] as const) {
      fixture.pages.push({ filePath: `src/pages/${mode}.tsx`, urlPattern: `/${mode}`, mode,
        hasLoader: false, hasGetServerData: true, config: {} });
    }
    expect(deriveRequiredFeatures(fixture)).toEqual([...MANIFEST_FEATURES]);
  });

  it('keeps task semantics separate from canonical compute placement', () => {
    const fixture = realistic();
    fixture.api = [{ ...fixture.api[1]!, config: { kind: 'task', hot: true, compute: { class: 'dedicated' } } }];
    expect(deriveRequiredFeatures(fixture)).toContain('tasks');
    expect(deriveRequiredFeatures(fixture)).toContain('dedicated-compute');
    expect(deriveRequiredFeatures(fixture)).not.toContain('function-compute');
    fixture.api[0]!.config.compute = { class: 'function', memory: '1gb' };
    expect(deriveRequiredFeatures(fixture)).toContain('function-compute');
    expect(deriveRequiredFeatures(fixture)).not.toContain('dedicated-compute');
  });

  it('does not demand ISR for no-cache, streaming, or build-time page modes', () => {
    const fixture = realistic();
    fixture.pages = [{ ...fixture.pages[1]!, config: { revalidate: 0 } }];
    expect(deriveRequiredFeatures(fixture)).not.toContain('isr');
    fixture.pages[0]!.config.swr = 60;
    expect(deriveRequiredFeatures(fixture)).toContain('isr');
    fixture.pages[0]!.config = { streaming: true, revalidate: 60 };
    expect(deriveRequiredFeatures(fixture)).toContain('streaming');
    expect(deriveRequiredFeatures(fixture)).not.toContain('isr');
    fixture.pages[0]!.mode = 'static';
    expect(deriveRequiredFeatures(fixture)).not.toContain('streaming');
    expect(deriveRequiredFeatures(fixture)).not.toContain('isr');
  });

  it('recognizes legacy placement signals without rewriting them', () => {
    const fixture = realistic();
    fixture.api = [{ ...fixture.api[1]!, config: { placement: 'hot', machine: { memoryMb: 512 } } }];
    expect(parseManifest(fixture, { allowLegacy: true })).toBe(fixture);
    expect(deriveRequiredFeatures(fixture)).toContain('dedicated-compute');
  });

  it.each(['legacy', 'v1'])('rejects contradictory resolved kind and compute before admitting a target (%s)', format => {
    for (const [kind, computeClass] of [['hot', 'function'], ['serverless', 'dedicated']] as const) {
      const fixture = empty();
      fixture.api = [{ filePath: 'src/api/x.ts', urlPattern: '/api/x', methods: ['GET'], kind,
        config: { compute: { class: computeClass } } }];
      const input = format === 'v1' ? versioned(fixture) : fixture;
      expect(() => parseManifest(input, { allowLegacy: true })).toThrow('$.api[0].config.compute.class');
      expect(() => evaluateCapabilities(input, { name: 'Functions only', supportedFeatures: ['api', 'function-compute'] }))
        .toThrow('Compute class conflicts with resolved route kind');
      expect(() => evaluateCapabilities(input, { name: 'All features', supportedFeatures: MANIFEST_FEATURES }))
        .toThrow('Compute class conflicts with resolved route kind');
    }
  });

  it.each(['legacy', 'v1'])('rejects incompatible declared workload and resolved kind (%s)', format => {
    for (const [kind, sourceKind] of [
      ['serverless', 'hot'], ['serverless', 'task'], ['hot', 'task'], ['task', 'serverless'], ['task', 'hot'],
    ] as const) {
      const fixture = empty();
      fixture.api = [{ filePath: 'src/api/x.ts', urlPattern: '/api/x', methods: ['GET'], kind,
        config: { kind: sourceKind } }];
      expect(() => parseManifest(format === 'v1' ? versioned(fixture) : fixture, { allowLegacy: true }))
        .toThrow('$.api[0].config.kind');
    }
  });

  it.each(['legacy', 'v1'])('preserves valid normalized source kind and independent task placement (%s)', format => {
    const fixture = empty();
    fixture.api = [
      { filePath: 'src/api/x.ts', urlPattern: '/api/x', methods: ['GET'], kind: 'hot',
        config: { kind: 'serverless', compute: { class: 'dedicated' } } },
      { filePath: 'src/api/a.ts', urlPattern: '/api/a', methods: ['POST'], kind: 'task',
        config: { kind: 'task', compute: { class: 'function', memory: '1gb' } } },
      { filePath: 'src/api/b.ts', urlPattern: '/api/b', methods: ['POST'], kind: 'task',
        config: { kind: 'task', hot: true, compute: { class: 'dedicated' } } },
      { filePath: 'src/api/c.ts', urlPattern: '/api/c', methods: ['POST'], kind: 'task', config: {} },
    ];
    const input = format === 'v1' ? versioned(fixture) : fixture;
    expect(parseManifest(input, { allowLegacy: true })).toBe(input);
    expect(evaluateCapabilities(input, { name: 'Verified fixture target', supportedFeatures: MANIFEST_FEATURES }).compatible).toBe(true);
  });

  it('refuses unsupported targets with actionable feature diagnostics', () => {
    const result = evaluateCapabilities(versioned(), { name: 'Test Worker', supportedFeatures: ['api', 'server-pages'] });
    expect(result.compatible).toBe(false);
    expect(result.unsupportedFeatures).toContain('websocket');
    expect(result.diagnostics).toContainEqual({ path: '$.requiredFeatures', code: 'unsupported_feature',
      message: 'Test Worker does not support required feature: websocket' });
    expect(evaluateCapabilities(versioned(), { name: 'Verified fixture target', supportedFeatures: MANIFEST_FEATURES }).compatible).toBe(true);
  });

  it('validates before capability evaluation, preventing unknown requirements from disappearing', () => {
    const malformed = { ...empty(), schemaVersion: 99, requiredFeatures: ['future'] };
    expect(() => evaluateCapabilities(malformed, { name: 'Test', supportedFeatures: MANIFEST_FEATURES })).toThrow('Unsupported schema version');
  });

  it.each(['../secrets.ts', '/etc/passwd', 'src/../secret.ts', 'C:\\secret.ts', '\\\\host\\share', 'src\\..\\secret.ts', 'src//api.ts', 'src\u0000/api.ts'])('rejects unsafe artifact path %s', filePath => {
    const fixture = realistic();
    fixture.api[0]!.filePath = filePath;
    expect(() => parseManifest(fixture, { allowLegacy: true })).toThrow('$.api[0].filePath');
  });

  it('preserves valid Windows scanner-relative file and layout paths', () => {
    const fixture = realistic();
    fixture.pages[0]!.filePath = 'src\\pages\\blog\\[slug].tsx';
    fixture.pages[0]!.layout = 'src\\pages\\_layout.tsx';
    fixture.layouts[1]!.dirPattern = 'blog\\archive';
    expect(parseManifest(fixture, { allowLegacy: true })).toEqual(fixture);
  });

  it.each(['api/foo', '/api/../foo', '/api//foo', '/api/foo?bar', '/api/foo#bar', '/api\\foo'])('rejects malformed URL pattern %s', urlPattern => {
    const fixture = realistic();
    fixture.api[0]!.urlPattern = urlPattern;
    expect(() => parseManifest(fixture, { allowLegacy: true })).toThrow('$.api[0].urlPattern');
  });

  it('validates malformed present fields in legacy mode rather than silently dropping them', () => {
    const fixture = { ...realistic(), actions: null, middleware: 123 };
    expect(validateManifest(fixture, { allowLegacy: true })).toMatchObject({ success: false, issues: expect.arrayContaining([
      expect.objectContaining({ path: '$.actions' }), expect.objectContaining({ path: '$.middleware' }),
    ]) });
    expect(() => parseManifest({ ...empty(), middleware: undefined }, { allowLegacy: true })).toThrow('$.middleware');
  });

  it('reports exact nested enum, boolean, config, and action field paths', () => {
    const fixture = { ...realistic(),
      api: [{ filePath: 'src/api/x.ts', urlPattern: '/api/x', kind: 'edge', methods: ['TRACE'], hasWebsocket: 'yes', config: { compute: { class: 'edge' } } }],
      pages: [{ filePath: 'src/pages/x.tsx', urlPattern: '/x', mode: 'edge', hasLoader: 'yes', hasGetServerData: false, config: { streaming: 'yes', revalidate: -1 } }],
      actions: [{ filePath: 'src/actions/x.ts', moduleId: '../x', exports: [false] }],
    };
    const result = validateManifest(fixture, { allowLegacy: true });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid fixture');
    expect(result.issues.map(issue => issue.path)).toEqual(expect.arrayContaining([
      '$.api[0].kind', '$.api[0].methods[0]', '$.api[0].hasWebsocket', '$.api[0].config.compute.class',
      '$.pages[0].mode', '$.pages[0].hasLoader', '$.pages[0].config.streaming', '$.pages[0].config.revalidate',
      '$.actions[0].moduleId', '$.actions[0].exports[0]',
    ]));
  });

  it('accepts array tags, optional old metadata, catch-all routes, and websocket-only hot routes', () => {
    const fixture = realistic();
    fixture.api[0]!.methods = [];
    fixture.pages[0]!.urlPattern = '/docs/*rest';
    fixture.pages[0]!.config.tags = ['docs', 'public'];
    delete fixture.pages[0]!.layout;
    delete fixture.pages[0]!.layouts;
    expect(parseManifest(fixture, { allowLegacy: true })).toEqual(fixture);
  });

  it.each(['{', null, [], 1])('returns diagnostics for non-manifests: %s', value => {
    expect(validateManifest(value).success).toBe(false);
  });
});
