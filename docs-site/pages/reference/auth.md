# Auth

Vura ships two authentication helpers from `@celsian/vura-core`: **signed cookie sessions** for stateful, browser-based logins, and **JWT** helpers for stateless bearer-token APIs. Both are thin, dependency-light building blocks — you own the login logic.

> **`cookieSession` runs everywhere. `jwt` and `createJWTGuard` are Node-only.**
>
> `cookieSession` signs with a portable HMAC-SHA-256 that needs no Node built-ins, so it works unchanged on the hot server, on Cloudflare Workers and in a Lambda function, including in `src/api/_hooks.ts`. Signatures are identical across all three, so a session cookie issued by one is accepted by the others and cookies issued before this change stay valid.
>
> `jwt` and `createJWTGuard` come from `@celsian/jwt`, which imports `@celsian/core`, and that package's root is a Node HTTP server. Importing either from a file the Cloudflare or Lambda adapter bundles (an `src/api/` route, or `src/api/_hooks.ts`) still fails the build with `No matching export in "vura-core-runtime-shim:@celsian/vura-core"`. They work on the hot server and anywhere else Node runs. On a Worker, verify tokens with a Web Crypto library such as `jose` directly.

---

## Cookie sessions

`cookieSession()` returns an `onRequest` hook that populates `req.session` with a signed, auto-persisted cookie. Register it in your [global hooks file](/reference/hooks) so it runs on every request.

```ts
// src/api/_hooks.ts
import { cookieSession } from '@celsian/vura-core';

export const onRequest = [
  cookieSession({ secret: process.env.SESSION_SECRET! }),
];
```

Now any route can read and write `req.session`. The cookie is committed automatically when the response is built — you never set a `Set-Cookie` header yourself:

```ts
// src/api/login.ts
export function POST(req: any, reply: any) {
  req.session.userId = '123';      // write session state
  return reply.json({ ok: true }); // Set-Cookie emitted automatically
}

// src/api/me.ts
export function GET(req: any) {
  return { userId: req.session.userId ?? null };
}
```

`Set-Cookie` is emitted only when the session **changed** — an unchanged session adds no header. To log out, clear the fields you set (e.g. `req.session = {}` via reassigning keys) so the session differs from what came in.

### Options

```ts
cookieSession(opts: CookieSessionOpts)
```

| Option | Type | Default | Effect |
|---|---|---|---|
| `secret` | `string` | — (required) | HMAC-SHA-256 signing secret. Must be **≥ 32 characters** — a shorter secret throws immediately at startup. |
| `cookieName` | `string` | `'vura_session'` | Name of the session cookie. |
| `cookie` | `CookieOptions` | see below | Cookie attributes, merged over the defaults `{ httpOnly: true, sameSite: 'lax', path: '/', secure: true }`. Pass `maxAge` for expiry. |

**`secure` defaults to `true`,** which matters on a plain-HTTP dev server: the browser accepts a `Secure` cookie over `http://localhost` and then never sends it back, so the session appears to reset on every request. Pass `cookie: { secure: false }` when you are serving plain HTTP.

Generate a secret with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### How it works

- The session is **signed, not encrypted**. Contents are HMAC-verified on read, so a tampered or forged cookie is rejected and yields a fresh empty session — but the data is readable by the client. **Never store secrets in the session.**
- Keep sessions small — **under 4 KB total**. A larger serialized cookie logs a warning.
- No expiry by default: a session is valid until you rotate `secret`. Pass `cookie.maxAge` (seconds) for a fixed lifetime.
- Prototype-poisoning keys (`__proto__`, `constructor`, `prototype`) are stripped on both read and write.

> **Pitfall — raw `Response` returns.** The cookie is committed on plain-object returns, string returns, and `reply.json` / `reply.html` / `reply.send`. A handler that returns a raw `new Response(...)` bypasses the commit path, so **no `Set-Cookie` is emitted** in that case. Use `reply.json()` (or return a plain object) from any route that changes the session.

---

## JWT

For stateless APIs authenticated by a `Bearer` token rather than a cookie, `@celsian/vura-core` re-exports the JWT helpers from `@celsian/jwt`:

```ts
import { jwt, createJWTGuard } from '@celsian/vura-core';
```

| Export | Purpose |
|---|---|
| `jwt({ secret, algorithms? })` | A plugin that decorates the app with `app.jwt.sign()` / `app.jwt.verify()`. Register it on a programmatic app: `app.register(jwt({ secret }))`. |
| `createJWTGuard(options?)` | A hook that verifies the `Authorization: Bearer <token>` header and populates `req.user` with the decoded payload. Pass `{ secret }` explicitly, or omit it to read the secret from a registered `jwt` plugin. |

Guarding routes with an explicit secret works as a global `onRequest` hook — the same convention as `cookieSession`:

```ts
// src/api/_hooks.ts
import { createJWTGuard } from '@celsian/vura-core';

export const onRequest = [
  createJWTGuard({ secret: process.env.JWT_SECRET! }),
];
```

Verified requests then expose the token payload on `req.user`. Signing tokens (`app.jwt.sign(...)`) and the plugin-registration form require direct access to the underlying app — see the [Programmatic server](/reference/server) reference for building an app with `createApiApp` / `createApp`.

> **Cookie session or JWT?** Use **cookie sessions** for classic web apps where the browser is the client (login form, server-rendered pages). Use **JWT** for machine-to-machine APIs and mobile clients that send a bearer token. They can coexist.
