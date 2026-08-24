export const MATRIX_SCHEMA_VERSION = 1;
export const MATRIX_SEED = 'vura-build-matrix-v1';
export const SIZE_NAMES = Object.freeze(['small', 'medium', 'large']);
export const WORKLOAD_NAMES = Object.freeze(['static', 'function', 'dedicated', 'task', 'hybrid']);

const ASSET_BYTES = Object.freeze({
  small: 100 * 1024,
  medium: 5 * 1024 * 1024,
  large: 50 * 1024 * 1024,
});

const EMPTY_COUNTS = Object.freeze({
  pages: { static: 0, client: 0, server: 0, hybrid: 0 },
  api: { function: 0, dedicated: 0, task: 0 },
  features: { websocket: 0, streaming: 0 },
});

const HYBRID_COUNTS = Object.freeze({
  small: {
    pages: { static: 1, client: 1, server: 1, hybrid: 1 },
    api: { function: 1, dedicated: 1, task: 2 },
    features: { websocket: 0, streaming: 0 },
  },
  medium: {
    pages: { static: 3, client: 3, server: 2, hybrid: 2 },
    api: { function: 10, dedicated: 5, task: 5 },
    features: { websocket: 1, streaming: 0 },
  },
  large: {
    pages: { static: 15, client: 15, server: 10, hybrid: 10 },
    api: { function: 50, dedicated: 25, task: 25 },
    features: { websocket: 1, streaming: 1 },
  },
});

const LINEAR_COUNTS = Object.freeze({ small: 1, medium: 10, large: 50 });

export const MATRIX_SPECS = Object.freeze(SIZE_NAMES.flatMap((size) => WORKLOAD_NAMES.map((workload) => {
  const counts = structuredClone(EMPTY_COUNTS);
  let assetBytes = 0;
  if (workload === 'static') {
    counts.pages.static = LINEAR_COUNTS[size];
    assetBytes = ASSET_BYTES[size];
  } else if (workload === 'function') {
    counts.api.function = LINEAR_COUNTS[size];
  } else if (workload === 'dedicated') {
    counts.api.dedicated = LINEAR_COUNTS[size];
    counts.features.websocket = size === 'small' ? 0 : 1;
    counts.features.streaming = size === 'large' ? 1 : 0;
  } else if (workload === 'task') {
    counts.api.task = LINEAR_COUNTS[size];
  } else {
    Object.assign(counts, structuredClone(HYBRID_COUNTS[size]));
    assetBytes = ASSET_BYTES[size];
  }
  return Object.freeze({
    id: `${size}-${workload}`,
    size,
    workload,
    seed: `${MATRIX_SEED}:${size}:${workload}`,
    asset: Object.freeze({ files: assetBytes > 0 ? 1 : 0, bytes: assetBytes }),
    counts: deepFreeze(counts),
  });
})));

export function getMatrixSpec(id) {
  const spec = MATRIX_SPECS.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`unknown matrix cell: ${id}`);
  return spec;
}

export function selectMatrixSpecs(value = 'all') {
  if (!value || value === 'all') return [...MATRIX_SPECS];
  const ids = String(value).split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error('at least one matrix cell is required');
  return ids.map(getMatrixSpec);
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}
