# Build output

`vura build` writes everything into `dist/`. This page describes what ends up
where, and the one property of it that changes how you write code.

```
dist/
  server/
    entry.js            the server, self-contained
    package.json        { "type": "module" }
    pages/**            server and hybrid page modules, and their layouts
    api/**              API route modules
    actions/**          server action modules
    middleware.js       src/middleware.ts, if the project has one
  static/
    index.html          prerendered static and hybrid pages
    <route>/index.html
    _then/pages/*.js    browser bundles for client and hybrid pages, content-hashed
  functions/**          per-route bundles for serverless targets
  package.json          { "type": "module" } + pinned runtime dependencies
```

`dist/server/entry.js` is what `vura start` runs, and what a Dockerfile's
`CMD` points at. `dist/static/` is what a CDN serves.

---

## Each server module is bundled separately

This is worth knowing before you write anything that expects shared state.

`dist/server/entry.js` inlines its dependencies. The modules beside it (a page,
an API route, an action, middleware) are each bundled on their own, and each
resolves `@celsian/vura-core` through an internal shim that inlines **its own
copy** of the runtime. Every page and every layout is its own bundle.

The upside is that a serverless target can ship one route without the rest of
the application. The consequence is that **a module-level value is not shared
between them**.

```ts
// src/lib/cache.ts
export const cache = new Map();   // NOT one Map in a built app
```

A page and an API route that both import this get a `Map` each. In `vura dev`
they share one, because dev loads modules through Node's cache, so this is a
class of bug that only appears in production.

**For genuinely process-wide state, key it on a symbol:**

```ts
const KEY = Symbol.for('myapp.cache');
const store = globalThis as unknown as { [KEY]?: Map<string, unknown> };
export const cache = (store[KEY] ??= new Map());
```

`Symbol.for` returns the same symbol for the same string in every copy, so
every bundle reaches the same object. Vura's own loader context and action
registry work exactly this way.

For state that must survive a restart or be shared across instances, this is
still the wrong tool. Use a database, or Redis, or a [hot route](/ladder/4-hot)
if you want it in memory and addressable.

### `instanceof` across the boundary

The same split means a class from `@celsian/vura-core` is a different class
object in each bundle:

```ts
// in an API route
throw notFound('No such user');
```

```ts
// somewhere in the entry bundle
if (err instanceof HttpError) { … }   // false, for the error above
```

Vura handles this internally for the errors it raises: every `HttpError` carries
a `Symbol.for('vura.http-error')` brand, and Vura recognises its own errors by
that brand rather than by `instanceof`, so a thrown `HttpError` reaches the
client with the right status from any bundle. A registry symbol is the same
symbol in every copy, which is exactly what a class is not.

The reverse also holds: an error Vura did not construct does not carry the
brand, so a library error that happens to have a `statusCode` field cannot pick
its own HTTP status. It gets a sanitised 500.

If you write your own error class and compare it with `instanceof` across a page
and an API route, it will not match. Compare a discriminant field instead, or
use a registry symbol the way Vura does:

```ts
export class AppError extends Error {
  readonly kind = 'AppError' as const;
}

function isAppError(e: unknown): e is AppError {
  return e instanceof Error && (e as AppError).kind === 'AppError';
}
```

---

## What reaches the browser

Only two things: the content-hashed bundles under `dist/static/_then/pages/`,
and whatever is inlined in a prerendered HTML file.

A `static` page ships **no** framework JavaScript at all. A `client` or
`hybrid` page ships one bundle, built for the browser, which is where
`what-framework` is inlined (a browser has no module resolver).

Files under `src/actions/` are never opened for a browser bundle. An import
that lands there is replaced with a generated fetch stub before the bundler
reads the file, so a credential in an action module cannot reach the client.
See [server actions](/reference/actions).

Everything else on the server side keeps `what-framework` external, so a
running app holds one copy of the framework per process rather than one per
page.

---

## The generated `package.json` files

Three are written, and the difference between them matters for containers.

| File | Contents |
|---|---|
| `dist/package.json` | `{ "type": "module" }` **plus the runtime dependencies** the server bundles kept external, with the version pinned to what the project has installed |
| `dist/server/package.json` | `{ "type": "module" }` only |
| `dist/functions/package.json` | `{ "type": "module" }` only |

The two inner ones exist so Node treats those subtrees as ESM even when the
project itself has no `package.json` or defaults to CommonJS.

The one that carries dependencies is **`dist/package.json`**:

```json
{
  "type": "module",
  "dependencies": { "what-framework": "0.13.3" }
}
```

A Dockerfile that copies `dist/` and runs `npm install --omit=dev` from
`dist/` therefore installs exactly what `entry.js` needs. Running it from
`dist/server/` installs nothing, which is a container that starts and then dies
on its first request with `ERR_MODULE_NOT_FOUND`. The
[Docker guide](/self-host/docker) uses the correct path.

---

## Reproducing a problem

If something works in `vura dev` and not in a built app, the difference is
almost always one of the above: dev shares module instances and a build does
not. Build it and boot it:

```bash
vura build
node dist/server/entry.js
```

To see whether a value is inlined rather than imported, look for the import:

```bash
grep -c "from \"what-framework\"" dist/server/pages/*.js
```

A server page bundle should import it. If it has no imports at all, it inlined
a copy.
