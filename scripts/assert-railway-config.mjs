#!/usr/bin/env node
/**
 * assert-railway-config.mjs <railway.json> <deploy-root>
 *
 * Assert that the railway.json from the Railway guide is valid AND that every
 * path it names resolves inside the directory Railway will actually use as the
 * Docker build context.
 *
 * Why this exists, specifically:
 *
 * Railway builds with the root of the source you upload as the build context.
 * It does NOT switch the context to the directory the Dockerfile lives in —
 * `dockerfilePath` is only the `-f` argument. The Dockerfile `vura build`
 * emits is written for a `dist/` context: `COPY . ./` means "copy dist/", and
 * `CMD ["node", "server/entry.js"]` means dist/server/entry.js.
 *
 * The guide used to tell you to upload the project root with
 * `dockerfilePath: "dist/Dockerfile"` and `startCommand: "node server/entry.js"`.
 * That image BUILDS, exits 0, and then crash-loops on
 * `Cannot find module '/app/server/entry.js'`, because relative to the project
 * root the entry is at dist/server/entry.js. A build that succeeds and serves
 * nothing is the exact defect class this whole workflow exists to catch, so
 * the check is a path-resolution check and not a schema check.
 *
 * What is asserted:
 *   $schema                  points at Railway's published schema
 *   build.builder            DOCKERFILE (the guide is Dockerfile-based)
 *   build.dockerfilePath     resolves to a real file inside the deploy root
 *   deploy.startCommand      names a JS entry that exists inside the deploy root
 *   deploy.healthcheckPath   an absolute request path (Railway fails the deploy
 *                            if it does not answer 200)
 *   deploy.sleepApplication  false — hot routes hold per-process WebSocket
 *                            state, so the container must not be stopped when
 *                            idle. Same rationale as auto_stop_machines = "off"
 *                            in the Fly guide.
 *   deploy.numReplicas       1 — that same state is per-process.
 *
 * Usage:
 *   node scripts/assert-railway-config.mjs app/dist/railway.json app/dist
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Extensions a Node entry point can carry. */
const JS_EXTENSIONS = ['.js', '.mjs', '.cjs'];

/**
 * Pulls the script path out of a start command such as `node server/entry.js`.
 * @param {string} command
 * @returns {string|null}
 */
export function scriptPathFromStartCommand(command) {
  const tokens = String(command).trim().split(/\s+/);
  return tokens.find((t) => JS_EXTENSIONS.some((ext) => t.endsWith(ext))) ?? null;
}

/**
 * @param {unknown} config   parsed railway.json
 * @param {string} rootDir   directory Railway will use as the build context
 * @param {(p: string) => boolean} [fileExists]
 * @returns {string[]} failure messages, empty when the config is sound
 */
export function validateRailwayConfig(config, rootDir, fileExists = existsSync) {
  const failures = [];
  const fail = (msg) => failures.push(msg);

  if (config === null || typeof config !== 'object') {
    return ['railway.json did not parse to an object'];
  }

  const schema = /** @type {Record<string, unknown>} */ (config).$schema;
  if (typeof schema !== 'string' || !/^https:\/\/railway\.(com|app)\/railway\.schema\.json$/.test(schema)) {
    fail(`$schema should be https://railway.com/railway.schema.json, got ${JSON.stringify(schema)}`);
  }

  const build = /** @type {Record<string, any>} */ (config).build ?? {};
  const deploy = /** @type {Record<string, any>} */ (config).deploy ?? {};

  if (build.builder !== 'DOCKERFILE') {
    fail(`build.builder should be "DOCKERFILE", got ${JSON.stringify(build.builder)}`);
  }

  /**
   * A path is only usable if it stays inside the upload root: Docker cannot
   * COPY from outside the context, and Railway cannot read outside it either.
   * @param {string} field
   * @param {string} value
   */
  const assertInsideRoot = (field, value) => {
    if (isAbsolute(value)) {
      fail(`${field} "${value}" is absolute; it must be relative to the deploy root`);
      return;
    }
    const abs = resolve(rootDir, value);
    const rel = relative(resolve(rootDir), abs);
    if (rel.startsWith('..')) {
      fail(`${field} "${value}" escapes the deploy root ${rootDir}`);
      return;
    }
    if (!fileExists(abs)) {
      fail(`${field} "${value}" does not exist in the deploy root ${rootDir} (looked for ${abs})`);
    }
  };

  if (typeof build.dockerfilePath !== 'string' || build.dockerfilePath === '') {
    fail('build.dockerfilePath is missing');
  } else {
    assertInsideRoot('build.dockerfilePath', build.dockerfilePath);
  }

  if (typeof deploy.startCommand !== 'string' || deploy.startCommand === '') {
    fail('deploy.startCommand is missing');
  } else {
    const script = scriptPathFromStartCommand(deploy.startCommand);
    if (script === null) {
      fail(`deploy.startCommand "${deploy.startCommand}" names no JS entry point to verify`);
    } else {
      assertInsideRoot('deploy.startCommand entry', script);
    }
  }

  if (typeof deploy.healthcheckPath !== 'string' || !deploy.healthcheckPath.startsWith('/')) {
    fail(`deploy.healthcheckPath should be an absolute request path, got ${JSON.stringify(deploy.healthcheckPath)}`);
  }

  if (deploy.sleepApplication !== false) {
    fail(
      `deploy.sleepApplication should be false — hot routes hold per-process WebSocket state, got ${JSON.stringify(deploy.sleepApplication)}`,
    );
  }

  if (deploy.numReplicas !== 1) {
    fail(
      `deploy.numReplicas should be 1 — hot-route state is per-process, got ${JSON.stringify(deploy.numReplicas)}`,
    );
  }

  return failures;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const [, , configPath, rootDir] = process.argv;
  if (!configPath || !rootDir) {
    console.error('Usage: node scripts/assert-railway-config.mjs <railway.json> <deploy-root>');
    process.exit(1);
  }

  if (!existsSync(configPath)) {
    console.error(`railway.json not found at ${configPath}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`railway.json at ${configPath} is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  const failures = validateRailwayConfig(parsed, rootDir);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    console.error(`\n${failures.length} railway.json assertion(s) failed.`);
    process.exit(1);
  }

  console.log(`railway.json OK — every path it names resolves inside ${rootDir}`);
}
