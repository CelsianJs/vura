import { describe, it, expect } from 'vitest';
import { validateRailwayConfig, scriptPathFromStartCommand } from './assert-railway-config.mjs';

// ─── Unit tests for the railway.json validator ───────────────────────────────
//
// The regression these guard is real and was shipped: a railway.json whose
// dockerfilePath and startCommand were written against the project root while
// the Dockerfile they point at expects `dist/` as the build context. The image
// builds and exits 0, then crash-loops on Cannot find module.

/** A deploy root laid out the way `vura build` emits dist/. */
const distRoot = '/app/dist';
const distFiles = new Set([
  '/app/dist/Dockerfile',
  '/app/dist/server/entry.js',
  '/app/dist/package.json',
]);
const distExists = (p) => distFiles.has(p);

/** The project root: dist/ is a subdirectory, so nothing is at the top level. */
const projectRoot = '/app';
const projectFiles = new Set([
  '/app/package.json',
  '/app/dist/Dockerfile',
  '/app/dist/server/entry.js',
]);
const projectExists = (p) => projectFiles.has(p);

const soundConfig = {
  $schema: 'https://railway.com/railway.schema.json',
  build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
  deploy: {
    startCommand: 'node server/entry.js',
    healthcheckPath: '/api/health',
    sleepApplication: false,
    numReplicas: 1,
  },
};

describe('scriptPathFromStartCommand', () => {
  it('finds the entry in a plain node invocation', () => {
    expect(scriptPathFromStartCommand('node server/entry.js')).toBe('server/entry.js');
  });

  it('skips node flags to find the entry', () => {
    expect(scriptPathFromStartCommand('node --enable-source-maps server/entry.mjs')).toBe('server/entry.mjs');
  });

  it('returns null when no JS entry is named', () => {
    expect(scriptPathFromStartCommand('npm start')).toBeNull();
  });
});

describe('validateRailwayConfig', () => {
  it('passes for a config whose paths resolve inside the deploy root', () => {
    expect(validateRailwayConfig(soundConfig, distRoot, distExists)).toEqual([]);
  });

  it('catches the shipped defect: paths written for the wrong build context', () => {
    // Exactly what the guide used to say: upload the project root, point
    // dockerfilePath at dist/Dockerfile, start `node server/entry.js`.
    const broken = {
      ...soundConfig,
      build: { builder: 'DOCKERFILE', dockerfilePath: 'dist/Dockerfile' },
    };
    const failures = validateRailwayConfig(broken, projectRoot, projectExists);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('deploy.startCommand entry');
    expect(failures[0]).toContain('server/entry.js');
  });

  it('rejects a dockerfilePath that is not in the deploy root', () => {
    const broken = { ...soundConfig, build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile.prod' } };
    expect(validateRailwayConfig(broken, distRoot, distExists)).toEqual([
      expect.stringContaining('build.dockerfilePath "Dockerfile.prod" does not exist'),
    ]);
  });

  it('rejects paths that escape the deploy root', () => {
    const broken = { ...soundConfig, build: { builder: 'DOCKERFILE', dockerfilePath: '../Dockerfile' } };
    expect(validateRailwayConfig(broken, distRoot, distExists)).toEqual([
      expect.stringContaining('escapes the deploy root'),
    ]);
  });

  it('rejects an absolute dockerfilePath', () => {
    const broken = { ...soundConfig, build: { builder: 'DOCKERFILE', dockerfilePath: '/Dockerfile' } };
    expect(validateRailwayConfig(broken, distRoot, distExists)).toEqual([
      expect.stringContaining('is absolute'),
    ]);
  });

  it('rejects a non-Dockerfile builder', () => {
    const broken = { ...soundConfig, build: { ...soundConfig.build, builder: 'RAILPACK' } };
    expect(validateRailwayConfig(broken, distRoot, distExists)).toEqual([
      expect.stringContaining('build.builder should be "DOCKERFILE"'),
    ]);
  });

  it('rejects a stale or foreign $schema', () => {
    const broken = { ...soundConfig, $schema: 'https://example.com/railway.schema.json' };
    expect(validateRailwayConfig(broken, distRoot, distExists)).toEqual([
      expect.stringContaining('$schema'),
    ]);
  });

  it('accepts the legacy railway.app schema host', () => {
    const legacy = { ...soundConfig, $schema: 'https://railway.app/railway.schema.json' };
    expect(validateRailwayConfig(legacy, distRoot, distExists)).toEqual([]);
  });

  it('requires a healthcheck path Railway can request', () => {
    const broken = { ...soundConfig, deploy: { ...soundConfig.deploy, healthcheckPath: 'api/health' } };
    expect(validateRailwayConfig(broken, distRoot, distExists)).toEqual([
      expect.stringContaining('healthcheckPath'),
    ]);
  });

  it('requires app sleeping off and a single replica for hot routes', () => {
    const broken = {
      ...soundConfig,
      deploy: { ...soundConfig.deploy, sleepApplication: true, numReplicas: 3 },
    };
    const failures = validateRailwayConfig(broken, distRoot, distExists);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('sleepApplication');
    expect(failures[1]).toContain('numReplicas');
  });

  it('reports a start command with no verifiable entry point', () => {
    const broken = { ...soundConfig, deploy: { ...soundConfig.deploy, startCommand: 'npm start' } };
    expect(validateRailwayConfig(broken, distRoot, distExists)).toEqual([
      expect.stringContaining('names no JS entry point'),
    ]);
  });

  it('rejects a non-object config', () => {
    expect(validateRailwayConfig(null, distRoot, distExists)).toEqual([
      'railway.json did not parse to an object',
    ]);
  });
});
