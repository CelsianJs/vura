import {
  evaluateCapabilities,
  ManifestValidationError,
  parseManifest,
  type ManifestIssue,
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
 * Scheduled execution is only for task routes; admission rejects schedules on
 * other route kinds because the Node runtime would never register their cron.
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
  const scheduleIssues: ManifestIssue[] = [];
  manifest.api.forEach((route, index) => {
    if (route.kind !== 'task' && typeof route.config.schedule === 'string') {
      scheduleIssues.push({
        path: `$.api[${index}].config.schedule`,
        code: 'unsupported_feature',
        message: "Vura Node schedules only task routes: use kind: 'task' or remove config.schedule.",
      });
    }
  });
  if (scheduleIssues.length > 0) throw new ManifestValidationError(scheduleIssues);
  return manifest;
}
