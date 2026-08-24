import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { MATRIX_SCHEMA_VERSION } from './spec.mjs';

export const FIXTURE_OWNERSHIP_MARKER = '.vura-build-matrix-owned.json';
const FIXTURE_OWNER = 'vura-build-matrix';
const FIXTURE_OWNER_SCHEMA_VERSION = 1;

export async function generateFixture({ repoRoot, outputRoot, spec }) {
  const fixtureRoot = join(outputRoot, spec.id);
  await prepareOwnedFixtureDirectory(fixtureRoot, spec.id);
  const versions = await resolveToolVersions(repoRoot);
  await writeJson(join(fixtureRoot, 'package.json'), {
    name: `vura-benchmark-${spec.id}`,
    private: true,
    type: 'module',
    dependencies: {
      '@celsian/vura-core': versions.core,
      'what-framework': versions.whatFramework,
    },
    devDependencies: { '@celsian/vura-cli': versions.cli },
  });
  await writeFile(join(fixtureRoot, 'vura.config.ts'), [
    "import { defineConfig } from '@celsian/vura-core';",
    '',
    'export default defineConfig({});',
    '',
  ].join('\n'), 'utf8');

  await generatePages(fixtureRoot, spec);
  await generateApi(fixtureRoot, spec);
  const asset = await generateAsset(fixtureRoot, spec);
  const sourceChecksum = await checksumDirectory(fixtureRoot, {
    exclude: (path) => path === 'benchmark-contract.json' || path.startsWith('dist/'),
  });
  const contract = {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    id: spec.id,
    size: spec.size,
    workload: spec.workload,
    seed: spec.seed,
    counts: spec.counts,
    asset,
    versions,
    sourceChecksum,
  };
  await writeJson(join(fixtureRoot, 'benchmark-contract.json'), contract);
  return { fixtureRoot, contract };
}

export async function prepareOwnedFixtureDirectory(fixtureRoot, cellId) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cellId)) {
    throw new Error(`invalid build-matrix cell id: ${cellId}`);
  }
  let existing = null;
  try {
    existing = await lstat(fixtureRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`refusing to replace unowned fixture path for ${cellId}`);
    }
    let marker = null;
    try {
      marker = JSON.parse(await readFile(join(fixtureRoot, FIXTURE_OWNERSHIP_MARKER), 'utf8'));
    } catch {
      throw new Error(`refusing to recursively delete unowned fixture directory for ${cellId}`);
    }
    const owned = marker?.schemaVersion === FIXTURE_OWNER_SCHEMA_VERSION
      && marker?.owner === FIXTURE_OWNER
      && marker?.cellId === cellId;
    if (!owned) throw new Error(`refusing to recursively delete unowned fixture directory for ${cellId}`);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
  await mkdir(fixtureRoot, { recursive: false });
  await writeJson(join(fixtureRoot, FIXTURE_OWNERSHIP_MARKER), {
    schemaVersion: FIXTURE_OWNER_SCHEMA_VERSION,
    owner: FIXTURE_OWNER,
    cellId,
  });
}

export async function validateFixtureSource(fixtureRoot) {
  const contract = JSON.parse(await readFile(join(fixtureRoot, 'benchmark-contract.json'), 'utf8'));
  const sourceChecksum = await checksumDirectory(fixtureRoot, {
    exclude: (path) => path === 'benchmark-contract.json' || path.startsWith('dist/'),
  });
  if (sourceChecksum !== contract.sourceChecksum) {
    throw new Error(`source checksum mismatch for ${contract.id}`);
  }
  return contract;
}

export async function validateBuildOutput(fixtureRoot, contract) {
  const manifestPath = join(fixtureRoot, 'dist', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const observed = {
    pages: {
      static: manifest.pages.filter((route) => route.mode === 'static').length,
      client: manifest.pages.filter((route) => route.mode === 'client').length,
      server: manifest.pages.filter((route) => route.mode === 'server').length,
      hybrid: manifest.pages.filter((route) => route.mode === 'hybrid').length,
    },
    api: {
      function: manifest.api.filter((route) => route.kind === 'serverless').length,
      dedicated: manifest.api.filter((route) => route.kind === 'hot').length,
      task: manifest.api.filter((route) => route.kind === 'task').length,
    },
    features: {
      websocket: manifest.api.filter((route) => route.hasWebsocket === true).length,
      streaming: manifest.api.filter((route) => route.config?.benchmarkFeature === 'streaming').length,
    },
  };
  if (JSON.stringify(observed) !== JSON.stringify(contract.counts)) {
    throw new Error(`manifest counts do not match the ${contract.id} contract`);
  }
  if (manifest.api.some((route) => route.kind === 'edge')) {
    throw new Error(`edge placement is forbidden in ${contract.id}`);
  }

  let asset = { files: 0, bytes: 0, checksum: null };
  if (contract.asset.files > 0) {
    const outputAsset = join(fixtureRoot, 'dist', 'public', 'benchmark.bin');
    const info = await stat(outputAsset);
    asset = { files: 1, bytes: info.size, checksum: await checksumFile(outputAsset) };
  }
  if (JSON.stringify(asset) !== JSON.stringify(contract.asset)) {
    throw new Error(`asset output does not match the ${contract.id} contract`);
  }
  const outputChecksum = await checksumDirectory(join(fixtureRoot, 'dist'), {
    transform: (path, contents) => {
      if (path !== 'manifest.json') return contents;
      const parsed = JSON.parse(contents.toString('utf8'));
      delete parsed.timestamp;
      return Buffer.from(JSON.stringify(parsed));
    },
  });
  return { observed, asset, outputChecksum };
}

export async function resolveToolVersions(repoRoot) {
  const [cli, core, whatFramework] = await Promise.all([
    readPackageVersion(join(repoRoot, 'packages', 'cli', 'package.json')),
    readPackageVersion(join(repoRoot, 'packages', 'core', 'package.json')),
    readPackageVersion(join(repoRoot, 'node_modules', 'what-framework', 'package.json')),
  ]);
  return { cli, core, whatFramework };
}

export async function checksumDirectory(root, options = {}) {
  const files = await listFiles(root);
  const hash = createHash('sha256');
  for (const absolutePath of files) {
    const path = relative(root, absolutePath).replaceAll('\\', '/');
    if (options.exclude?.(path)) continue;
    const contents = await readFile(absolutePath);
    const transformed = options.transform?.(path, contents) ?? contents;
    hash.update(path).update('\0').update(transformed).update('\0');
  }
  return hash.digest('hex');
}

async function generatePages(fixtureRoot, spec) {
  for (const mode of ['static', 'client', 'server', 'hybrid']) {
    const count = spec.counts.pages[mode];
    for (let index = 0; index < count; index += 1) {
      const isRoot = mode === 'static' && index === 0;
      const name = isRoot ? 'index' : `${mode}-${String(index + 1).padStart(3, '0')}`;
      const target = join(fixtureRoot, 'src', 'pages', `${name}.tsx`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, pageSource({ mode, index, seed: spec.seed }), 'utf8');
    }
  }
}

async function generateApi(fixtureRoot, spec) {
  for (const [kind, count] of Object.entries(spec.counts.api)) {
    for (let index = 0; index < count; index += 1) {
      const target = join(fixtureRoot, 'src', 'api', kind, `${String(index + 1).padStart(3, '0')}.ts`);
      await mkdir(dirname(target), { recursive: true });
      const websocket = kind === 'dedicated' && index === 0 && spec.counts.features.websocket === 1;
      const streaming = kind === 'dedicated' && index === 1 && spec.counts.features.streaming === 1;
      await writeFile(target, apiSource({ kind, index, seed: spec.seed, websocket, streaming }), 'utf8');
    }
  }
}

async function generateAsset(fixtureRoot, spec) {
  if (spec.asset.files === 0) return { files: 0, bytes: 0, checksum: null };
  const target = join(fixtureRoot, 'public', 'benchmark.bin');
  await mkdir(dirname(target), { recursive: true });
  const chunk = createHash('sha256').update(spec.seed).digest();
  const bytes = spec.asset.bytes;
  const source = Readable.from((function* deterministicChunks() {
    let remaining = bytes;
    while (remaining > 0) {
      const repetitions = Math.min(Math.floor(64 * 1024 / chunk.length), Math.ceil(remaining / chunk.length));
      const block = Buffer.allocUnsafe(repetitions * chunk.length);
      for (let index = 0; index < repetitions; index += 1) chunk.copy(block, index * chunk.length);
      const output = block.subarray(0, Math.min(block.length, remaining));
      remaining -= output.length;
      yield output;
    }
  })());
  await pipeline(source, createWriteStream(target, { flags: 'wx', mode: 0o644 }));
  return { files: 1, bytes, checksum: await checksumFile(target) };
}

function pageSource({ mode, index, seed }) {
  const serverData = mode === 'server'
    ? "\nexport async function getServerData() { return { generated: 'deterministic' }; }\n"
    : '';
  const props = mode === 'server' ? 'props: { generated: string }' : '';
  const content = mode === 'server' ? '{props.generated}' : `{${JSON.stringify(`${seed}:page:${mode}:${index}`)}}`;
  return `export const page = { mode: '${mode}' as const, title: 'Benchmark ${mode} ${index + 1}' };\n${serverData}\nexport default function BenchmarkPage(${props}) {\n  return <main><h1>Benchmark ${mode} ${index + 1}</h1><p>${content}</p></main>;\n}\n`;
}

function apiSource({ kind, index, seed, websocket, streaming }) {
  const routeKind = kind === 'function' ? 'serverless' : kind === 'dedicated' ? 'hot' : 'task';
  const feature = streaming ? ", benchmarkFeature: 'streaming'" : '';
  const method = kind === 'task' ? 'POST' : 'GET';
  const response = streaming
    ? "return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream')); controller.close(); } }));"
    : `return Response.json({ ok: true, seed: ${JSON.stringify(seed)}, route: ${index + 1} });`;
  const websocketExport = websocket ? '\nexport function websocket(_peer: unknown): void {}\n' : '';
  return `export const route = { kind: '${routeKind}' as const${feature} };\n\nexport function ${method}(): Response {\n  ${response}\n}\n${websocketExport}`;
}

async function checksumFile(path) {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

async function listFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await visit(root);
  return output.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

async function readPackageVersion(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(`package version missing from ${basename(path)}`);
  }
  return parsed.version;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
