import {
  evaluateCapabilities,
  ManifestValidationError,
  parseManifest,
  type ParsedManifest,
  type TargetCapabilities,
} from '@celsian/vura-contract';

/**
 * The existing Node build-and-serve pipeline, not a provider support matrix.
 * Build-time page modes require the CLI's static-render/client-bundle stage;
 * core build() alone does not prerender them. Dynamic hybrid pages retain their
 * documented literal-prerender-only limitation.
 *
 * Compute support means function/task artifacts plus in-process hot/task
 * dispatch. It does not promise isolated functions, machine provisioning,
 * resource enforcement, or an external scheduler. Adapters must negotiate their
 * own capabilities; this declaration cannot authorize a deployment target.
 * Scheduled execution is for task routes; raw schedule metadata on a non-task
 * route is preserved but does not register a cron job in the existing runtime.
 * Keep this explicit: adding a contract feature must not silently enable it.
 */
const NODE_CAPABILITIES: TargetCapabilities = {
  name: 'Vura Node build-and-serve pipeline',
  supportedFeatures: [
    // build.ts + runtime/api-app.ts; smoke-build.test.ts, server-entry-runtime.test.ts
    'api', 'function-compute', 'dedicated-compute',
    // static-render.ts + CLI build + server staticDirs; whatfw-integration.test.ts,
    // production-static-smoke.test.ts and packed self-host audit page-mode flows.
    'static-pages', 'client-pages', 'hybrid-pages',
    // runtime/pages.ts; server-pages.test.ts, runtime-pages.test.ts
    'server-pages', 'layouts', 'loaders', 'legacy-server-data',
    // build.ts + runtime/actions.ts + runtime/middleware.ts; corresponding tests
    'actions', 'middleware',
    // runtime/ws-upgrade.ts, pages.ts, cache.ts; hot-routes.test.ts,
    // streaming-ssr.test.ts, streaming.test.ts, runtime-cache.test.ts
    'websocket', 'streaming', 'isr',
    // runtime/tasks.ts + server.ts in-process cron; runtime-tasks.test.ts,
    // task-entry.test.ts (bundled function task invocation)
    'tasks', 'scheduled-tasks',
  ],
};

/** Reader-first rollout: current scanner artifacts are deliberately unversioned. */
export function readNodeManifest(input: unknown): ParsedManifest {
  const manifest = parseManifest(input, { allowLegacy: true });
  const compatibility = evaluateCapabilities(manifest, NODE_CAPABILITIES);
  if (!compatibility.compatible) throw new ManifestValidationError(compatibility.diagnostics);
  return manifest;
}
