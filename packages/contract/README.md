# @celsian/vura-contract

The dependency-free wire contract for Vura route manifests. This package exports
data types, validation, requirement discovery, and capability evaluation. It does
not import Vura's compiler, runtime, filesystem, Node built-ins, or a platform SDK.
Its ESM entry works in Node 20/22 and ES2022 browser/worker environments.

## Read and negotiate

```ts
import {
  parseManifest,
  evaluateCapabilities,
  type TargetCapabilities,
} from '@celsian/vura-contract';

// Transitional readers explicitly opt into historical unversioned manifests.
const manifest = parseManifest(jsonText, { allowLegacy: true });
const target: TargetCapabilities = {
  name: 'Example static-only target',
  supportedFeatures: ['static-pages'],
};
const compatibility = evaluateCapabilities(manifest, target);
if (!compatibility.compatible) {
  throw new Error(compatibility.diagnostics.map(issue => issue.message).join('\n'));
}
```

This example is a hypothetical target, not a claim about any deployed provider.
The caller supplies an evidence-backed capability list for the exact reader,
build adapter, runtime, and service configuration it is deploying. A successful
evaluation only establishes that those declared capabilities cover the manifest;
it does not prove that the target implementation actually works. Missing support
MUST stop admission/build/deployment at the relevant boundary. It MUST NOT become
a warning followed by silent loss of pages, actions, or other required behavior.

## Schema 1 (normative)

`ManifestV1` has `schemaVersion: 1`, a required `requiredFeatures` array, and the
complete existing `RouteManifest` fields:

- `api`: source-relative file path, URL pattern, HTTP methods, resolved `kind`,
  optional `hasWebsocket`, and complete raw `config`.
- `pages`: source-relative file path, URL pattern, rendering `mode`, optional
  singular `layout` and ordered `layouts`, `hasLoader`, `hasGetServerData`, and
  complete raw `config`.
- `layouts`: source-relative file path and covered relative `dirPattern` (empty
  string denotes the root).
- Optional `middleware` source path and optional `actions` with source path,
  module ID, and exported names in original order.
- `timestamp`: a parseable date-time string. Producers SHOULD use ISO 8601 UTC.

Schema version and npm package version are independent. Package `0.8.2` introduces
schema `1`; compatible package releases need not change the schema number.

`parseManifest` accepts JSON text or a decoded object, returns `ParsedManifest`,
and throws `ManifestValidationError` with `issues: { path, code, message }[]` on
failure. `validateManifest` is the non-throwing equivalent with a discriminated
`success` result. `isVersionedManifest` narrows an **already validated** result to
`ManifestV1`; it is not a validator.

Readers MUST reject missing schema versions unless they explicitly use
`allowLegacy: true`. Compatibility accepts the current historical unversioned
DTO shape; it does not invent defaults for missing required fields. Optional
omissions remain absent. An explicitly supplied version other than numeric `1`
MUST fail, even with legacy compatibility enabled. `null`, `"1"`, and an explicit
`undefined` version are not legacy manifests.

Readers preserve all fields, including raw config and unknown extension metadata;
validation does not reconstruct a reduced object or discard fields. Decoded
object input is returned by reference, unchanged. Wire data MUST be JSON data;
callers providing decoded objects are responsible for not supplying executable
objects, cycles, or other non-JSON values. Extensions MUST NOT alter the meaning
of known fields. New behavior requiring support MUST also declare a known
required feature, or use a new schema understood by its readers.

Recognized fields are validated when present, including optional booleans,
arrays, config enums, numeric cache settings, compute resource types, and task
schedule strings. Unknown config keys are retained, not interpreted. Page tags
accept the runtime's string-array or comma-separated-string forms. The contract
does not validate cron syntax, machine provisioning rules, or provider-specific
config. It does not normalize compute requests; that belongs to the compiler.

File/layout paths MUST be relative, with no drive prefix, empty segment, control
character, or `.`/`..` segment. Both POSIX and Windows scanner-relative separators
are accepted and preserved. URL patterns MUST begin with `/` and contain no
query, fragment, backslash, whitespace, empty internal segment, or dot traversal.
Parameters (`:id`) and catch-alls (`*rest`) are preserved. Consumers still own
filesystem containment, symlink checks, URL decoding, and destination-specific
normalization; syntactic validation is not a filesystem sandbox.

## Required features (normative)

`requiredFeatures` MUST contain every requirement discoverable from the manifest.
Unknown feature names and duplicates fail validation. Extra **known** requirements
are allowed for behavior not discoverable from static metadata. A legacy manifest
that includes `requiredFeatures` is checked by the same rules; compatibility does
not ignore an unknown requirement. Omitted legacy lists are derived on evaluation.

`deriveRequiredFeatures` takes a validated `RouteManifest` and returns requirements
in `MANIFEST_FEATURES` registry order without mutating the manifest:

| Feature | Evidence in the manifest |
| --- | --- |
| `api` | At least one API route |
| `static-pages`, `server-pages`, `client-pages`, `hybrid-pages` | Corresponding page mode |
| `layouts` | Layout records or a page layout/chain |
| `actions` | At least one action module |
| `middleware` | Middleware path |
| `loaders` | Any page has `hasLoader: true` (including build-time loaders) |
| `legacy-server-data` | Any page has `hasGetServerData: true` |
| `websocket` | An API route has `hasWebsocket: true` (requires `kind: hot`) |
| `streaming` | API or server-mode page config declares `streaming: true` |
| `isr` | Non-streaming server page with positive `revalidate`, or numeric `revalidate` plus positive `swr` |
| `tasks` | API route has `kind: task` |
| `scheduled-tasks` | API config declares a schedule string |
| `function-compute`, `dedicated-compute` | API route's compute placement, resolved as below |

`revalidate: 0` without positive stale-while-revalidate (`swr`) always regenerates,
so it does not require an ISR cache. Server streaming bypasses ISR even when
`revalidate` is declared. Build-time page modes do not use the server's streaming
or ISR paths. These rules describe the existing runtime's actual behavior rather
than requiring support for inactive settings; the raw settings remain preserved.
Requirements describe the complete build-and-serve pipeline, not just request-time
execution. Runtime imports and arbitrary application behavior cannot be inferred
from manifest metadata; producers must explicitly declare additional requirements.

Workload semantics and compute placement are separate axes. `kind: task` denotes
task work, not a claim that it must run on a function or dedicated machine. The
canonical `config.compute.class` (`function` or `dedicated`) takes precedence for
placement. When it is absent, historical `kind: hot`, `config.hot: true`, a `hot`
runtime/placement/target marker, or nonempty `config.machine` implies dedicated
placement. Other API routes imply function placement. This reproduces the existing
compiler's compatibility direction without rewriting old fields or introducing a
second compute normalization implementation. Resource profiles are not features.
Resolved `hot` routes cannot declare function compute, and resolved `serverless`
routes cannot declare dedicated compute. A present source `config.kind` must
preserve task workload semantics and cannot turn a declared hot route into a
serverless route. The compiler-valid source `config.kind: serverless` with resolved
`kind: hot` is retained: dedicated placement can cause that normalization. Tasks
remain valid on either compute class, including historical omitted config fields.

`evaluateCapabilities` revalidates the manifest (with legacy compatibility), unions
derived and declared requirements, and returns `compatible`, `requiredFeatures`,
`unsupportedFeatures`, and field-path `diagnostics`. Invalid manifests throw;
unsupported targets return `compatible: false`. No built-in provider support matrix
is shipped: support must be proven by the caller, not guessed from provider names.

## Rolling deployment and rollback

The first adoption step is **reader-first**, not a producer format switch:

1. Release the contract package and migrate readers to it with explicit legacy
   compatibility, preserving the full DTO through every intermediate service.
2. Verify packed consumer installations and real fixtures on every build,
   dashboard, admission, worker, and runtime reader. Add each target's tested
   capabilities and enforce refusal before any destructive deployment action.
3. Only after all active and rollback readers understand schema 1, enable
   versioned producer output with a complete feature list in a separate rollout.
4. Measure remaining legacy artifacts and deliberately decide any later cutoff.

This package does not switch producers or impose a legacy deadline. Rollback may
restore unversioned producer output while upgraded readers retain compatibility.
Do not roll a reader back to a version incapable of reading already-emitted schema
1 artifacts. Never strip an unknown schema version or feature list to force a
new artifact through the legacy path.

## Development verification

From the repository root (Node 22 toolchain):

```sh
corepack pnpm exec tsc -b packages/contract
corepack pnpm exec vitest run packages/contract/test
```

The source tsconfig excludes ambient Node types and browser globals. Production
exports have no imports or dependencies; all tests use repository development
tools only.
