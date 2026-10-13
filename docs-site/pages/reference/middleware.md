# Middleware

Middleware runs before a request reaches anything else: before a static file is served, before an API route, before a page renders. It is one file, `src/middleware.ts`, and it is the place for the things that are true of many routes at once. An auth guard. A request id. A security header. A maintenance-mode switch.

```ts
// src/middleware.ts
import type { MiddlewareContext } from '@celsian/vura-core';

export const config = {
  matcher: ['/dashboard/:path*', '/settings'],
};

export default function middleware(ctx: MiddlewareContext) {
  if (!ctx.cookies.get('session')) {
    return ctx.redirect('/login');
  }
}
```

Vura discovers the file automatically. There is nothing to register.

---

## The contract

**Return a `Response` and it is the answer.** Nothing else runs: no route, no page, no static file.

**Return nothing and the request carries on.** Anything you set on `ctx.headers` is merged onto whatever the route eventually produces, including static files and prerendered pages.

That is the whole model. There is no `next()` to call and no chain to compose, because there is one middleware.

```ts
export default function middleware(ctx: MiddlewareContext) {
  ctx.headers.set('x-request-id', crypto.randomUUID());   // continues, header applied
  if (isBanned(ctx.request)) return ctx.deny(403);        // stops here
}
```

---

## `MiddlewareContext`

```ts
interface MiddlewareContext {
  request: Request;                            // the incoming request
  url: URL;                                    // parsed
  pathname: string;                            // url.pathname
  params: Record<string, string>;              // captured by the matcher
  query: Record<string, string | string[]>;    // parsed query string
  cookies: MiddlewareCookies;                  // get(name) / has(name)
  headers: Headers;                            // merged onto the response
  redirect(to: string, status?: number): Response;   // default 307
  deny(status?: number, body?: string): Response;    // default 403
}
```

`redirect()` and `deny()` **return** a response for you to return, so the exit is visible at the call site:

```ts
if (!session) return ctx.redirect('/login');       // 307 by default
if (!session) return ctx.redirect('/login', 302);  // or say which
if (!admin) return ctx.deny();                     // 403, empty body
if (!admin) return ctx.deny(401, 'Sign in first');
```

Headers you set before returning one of those come with it, so a request id is still on the redirect.

---

## The matcher

Without `config.matcher`, middleware runs for every request. With one, it runs only for the paths it names.

```ts
export const config = {
  matcher: ['/admin', '/team/:id', '/dashboard/:path*', '/assets/*'],
};
```

| Pattern | Matches | Does not match | Captures |
|---|---|---|---|
| `/admin` | `/admin` | `/admin/users`, `/admins` | |
| `/team/:id` | `/team/42` | `/team/42/settings` | `params.id` |
| `/dashboard/:path*` | `/dashboard`, `/dashboard/a/b` | `/dashboards` | `params.path` |
| `/assets/*` | `/assets`, `/assets/app.css` | `/other/app.css` | |

A single string works where you have one pattern: `matcher: '/admin'`.

**Two paths are never matched, whatever you write:** `/__vura/*` (the ISR revalidation webhook) and `/__tasks` (the task admin API). These are the framework's own control surfaces, and an auth guard that 401s your own cache purges is a long afternoon.

---

## Middleware and hooks

Vura has both, and they are for different things.

| | **Middleware** | **[Hooks](/reference/hooks)** |
|---|---|---|
| File | `src/middleware.ts` | `src/api/_hooks.ts` |
| Runs for | every request: pages, API routes, static files | API routes only |
| Runs when | before routing | around the handler |
| Can stop the request | yes, by returning a `Response` | via `onRequest` |
| Sees the response | no | yes, in `onResponse` |

Use middleware to decide **whether** a request proceeds. Use hooks for what happens **around** an API handler: timing, logging the status code, error reporting.

---

## Where it runs

Middleware runs in `vura dev` and in the Node server `vura build` produces, which covers self-hosted Node, Docker, Fly and Railway.

It does **not** yet run in the Cloudflare Workers or AWS Lambda adapters. Those adapters support API routes and server-rendered pages, but they do not execute this middleware before routing, so a guard written here would not be consulted. If you deploy to those targets today, enforce authorization in the API handler or page loader that accesses protected data.

---

## Errors

A middleware that throws produces a 500, logged like any other server error. It does not fail open: a request that hits a broken middleware is not quietly allowed through.

In `vura dev`, a middleware that fails to compile is reported on every request and the request continues, so a syntax error mid-edit does not take the dev server down. That is a dev-only behaviour, and the terminal says so each time.
