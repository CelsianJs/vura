/**
 * The `@celsian/jwt` half of Vura's auth surface, kept apart from `auth.ts`.
 *
 * `jwt` and `createJWTGuard` are Celsian's, re-exported so a Vura app has one
 * import path for auth. They are in their own module because of what they drag
 * with them: `@celsian/jwt` imports `CelsianError` from `@celsian/core`, whose
 * package root reaches `node:fs`, `node:fs/promises`, `node:path` and
 * `node:http`. Under esbuild's `platform: 'neutral'` — the mode both serverless
 * adapters bundle a route in — that is four unresolvable imports, so any module
 * these two share becomes unbuildable for Cloudflare and Lambda along with
 * them. `cookieSession` used to share `auth.ts` with them and was unbuildable
 * for exactly that reason, on top of its own `node:crypto` use.
 *
 * So these stay in the server group of the runtime shim, and `cookieSession`
 * moved to the group the adapters bundle. The blocker is not `jose`, which
 * `@celsian/jwt` builds on: stub `@celsian/core` down to nothing but a
 * `CelsianError` class and the same neutral build of `@celsian/jwt` succeeds at
 * 69 KB with no `node:` import left in it, jose and all. The one import is the
 * whole of it. `@celsian/core` publishing a subpath for its errors, or
 * `@celsian/jwt` not needing the package root to throw, would make these two
 * portable without a line changing here. Vura shipping that stub itself was the
 * other option and was rejected: it would put a counterfeit `@celsian/core` in
 * front of any route that legitimately imports the real one, and a stand-in
 * `CelsianError` fails the `instanceof` checks upstream makes against its own. `test/runtime-shim.test.ts` pins which side of the line each one is on,
 * so if that upstream change lands, the test says so.
 */

export { jwt, createJWTGuard } from '@celsian/jwt';
