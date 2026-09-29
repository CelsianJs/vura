# Headers, redirects and 404 pages

Vura serves the static files of static sites, Vite apps and the prerendered pages of Vura apps from its edge. You can set response headers, add redirects and use your own 404 page. Headers and redirects go in `vura.json`, in your project's root directory.

Vura reads `headers` and `redirects` after your build command finishes, so your build can write them. One example is a Content-Security-Policy with script hashes. Every other `vura.json` key is read before the build.

## Headers

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": {
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains"
      }
    },
    {
      "source": "/assets/(.*)",
      "headers": { "Cache-Control": "public, max-age=31536000, immutable" }
    }
  ]
}
```

- Every rule whose `source` matches the request path applies, in order. If two rules set the same header, the later rule wins.
- Rules apply to everything served from static storage: pages, assets, the single-page app shell, 404 pages and redirects.
- Rules don't apply to responses from your server code: Function and Dedicated routes, and services. Set those headers in your app. Vercel applies `headers` to function responses too. Vura doesn't, so a value your server computes per request, such as a CSP nonce, is never overwritten.
- A rule's `Cache-Control` only applies to 200, 206 and 304 responses. A 404 or a redirect is never cached for a year by mistake.
- Header values must be printable ASCII. A curly quote (’) pasted from a document fails the build.

### Headers Vura sets

| Header | Default | Can a rule change it? |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Only to `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` | Yes, for example to `DENY` |
| `Strict-Transport-Security` | Not sent | Yes. HSTS stays off until you add it |
| `Cache-Control` | See "Caching" below | Yes |
| `Content-Type` | From the file extension | Yes |

A rule can't set these headers, and the build fails if one tries: `Cache-Tag`, `Server`, any `x-vura-*` header, `Set-Cookie`, `Location` (use `redirects`), `ETag`, `Content-Length`, `Content-Encoding`, `Content-Range`, `Transfer-Encoding`, `Connection`, `Keep-Alive`, `TE`, `Trailer`, `Upgrade`, `Proxy-Authenticate` and `Proxy-Authorization`.

## Redirects

```json
{
  "redirects": [
    { "source": "/old-pricing", "destination": "/pricing", "permanent": true },
    { "source": "/blog/:slug", "destination": "/posts/:slug" },
    { "source": "/docs/(.*)", "destination": "https://docs.example.com/$1", "permanent": true }
  ]
}
```

- Redirects run before your pages and API routes.
- On a project that runs [services](/platform/services), none of this page applies: every request goes straight to the service, before `vura.json` headers, redirects or the 404 page ever run. The service handles its own headers, redirects and missing routes.
- The first matching rule wins.
- `"permanent": true` sends `308`. Otherwise, which is the default, Vura sends `307`. Both keep the request method.
- `destination` is a path starting with `/` or an `https://` URL.
- The query string is kept, unless `destination` has its own `?`.
- Vura skips a redirect that would send a URL to itself. The build rejects a rule whose `destination` equals its `source`.
- `/__tasks/*` is reserved for Vura and is never redirected.

### Using parts of the path

| In `destination` | Is replaced by |
|---|---|
| `:name` | The `:name`, `:name*` or `:name+` part of `source` |
| `$1` to `$9` | The first to ninth captured part, in order, counting `(.*)` too |

`$0` isn't a token: it stays in `destination` as ordinary text.

With `:name*`, an empty match also drops the `/` in front of it. For example, with `/docs/:path*` → `/guide/:path*`, `/docs` goes to `/guide` and `/docs/a/b` goes to `/guide/a/b`. Parameters work in the path and query of `destination`, never in the host.

## Path patterns

`source` uses the same patterns in both lists.

| Pattern | Matches | Doesn't match |
|---|---|---|
| `/about` | `/about` | `/about/`, `/About`, `/about/team` |
| `/blog/:slug` | `/blog/hello` | `/blog`, `/blog/a/b` |
| `/docs/:path*` | `/docs`, `/docs/`, `/docs/a/b` | `/docsx` |
| `/docs/:path+` | `/docs/a`, `/docs/a/b` | `/docs`, `/docs/` |
| `/assets/(.*)` | `/assets/`, `/assets/app.js`, `/assets/a/b` | `/assets` |
| `/(.*)` | Every path | |
| `/:path+/` | `/docs/`, `/docs/install/` | `/`, `/docs` |

- Matching is case-sensitive, like file names.
- An exact path must match exactly, including a trailing slash.
- A pattern has at most one `(.*)`, `:name*` or `:name+`, and it must come last.
- Patterns match the path as the browser sent it. `%2F` is not a `/`. Non-ASCII text such as `/café` works as written: Vura percent-encodes it for you, and a `%xx` escape you type by hand is uppercased to match, so `/caf%c3%a9` still matches a request for `/caf%C3%A9`.
- Not supported: regular expressions (`:id(\\d+)`), optional parameters (`:name?`), a bare `*` (use `(.*)`) and `has`/`missing` conditions. The build names the part it can't use.

## Trailing slashes

`/pricing` and `/pricing/` both serve `pricing/index.html`. To keep one address per page, like Vercel's `"trailingSlash": false`, add this redirect:

```json
{ "redirects": [{ "source": "/:path+/", "destination": "/:path+", "permanent": true }] }
```

It sends `/pricing/` to `/pricing` and leaves `/` alone.

## 404 page

If your output has a `404.html` at its root, Vura serves it with status `404` whenever a page or file doesn't exist. Without one, Vura shows its own 404 page.

- This is for static and prerendered sites. `404.html` there is not a page of its own: `/404` also answers with status 404.
- A single-page app still serves its `index.html` shell for `/404` and any other path without a file extension, so client-side routing keeps working. `404.html` on an SPA only answers for a genuinely missing file, such as an old `/assets/app-1234abcd.js`.
- `/api/*` and `/__tasks/*` keep Vura's JSON 404, so API clients still get JSON.

## HEAD

A `HEAD` request to a static file, the SPA shell or the 404 page gets the same status, headers and caching a `GET` would, with no body. A Function, Dedicated or service route only answers `HEAD` when your own code handles it: Vura's edge never turns a `HEAD` into a `GET` for server code, only for static paths.

## Caching

| File | Cache-Control |
|---|---|
| Name with a content hash, such as `main-BNwSecox.js`, `index.a1b2c3d4.css` or `chunk-5XKQZ2LM.js` | `public, max-age=31536000, immutable` |
| Everything else, including HTML | `public, max-age=0, must-revalidate` |

Vura only treats a name as hashed when the hash looks random, so a file such as `settings.js` or `photo-20240101.jpg` is never cached for a year. A few real hashes look like words and keep revalidating. To cache a whole folder as immutable, add a `headers` rule like the `/assets/(.*)` example above.

## Headers written by your build

A strict Content-Security-Policy lists hashes of inline scripts, and those exist only after the build. Write them into `vura.json` at the end of your build, for example with `"build": "vite build && node scripts/write-csp.mjs"`:

```js
// scripts/write-csp.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(([, code]) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`);

const config = JSON.parse(readFileSync('vura.json', 'utf8'));
config.headers = (config.headers ?? []).filter((rule) => !('Content-Security-Policy' in rule.headers));
config.headers.push({
  source: '/(.*)',
  headers: {
    'Content-Security-Policy':
      `default-src 'self'; script-src 'self' ${hashes.join(' ')}; connect-src 'self' ${process.env.VITE_API_URL ?? ''}`.trim(),
  },
});
writeFileSync('vura.json', `${JSON.stringify(config, null, 2)}\n`);
```

If the file your build leaves behind breaks one of the rules on this page, the build fails with a message naming the rule, and the deploy is refused before it goes live.

## Limits

- 50 header rules and 50 redirects.
- Between 1 and 50 headers per rule (an empty rule fails the build), with each value up to 4,096 characters.
- `headers` and `redirects`, together with the rest of your build config, must fit in 64 KB. There's no separate cap per list.
- `source` up to 256 characters and 32 segments. `destination` up to 2,048 characters.

## Coming from vercel.json

| vercel.json | vura.json |
|---|---|
| `"headers": [{ "source": "/(.*)", "headers": [{ "key": "X-Frame-Options", "value": "DENY" }] }]` | `"headers": [{ "source": "/(.*)", "headers": { "X-Frame-Options": "DENY" } }]` |
| `"redirects"` with `permanent` | The same shape |
| `"trailingSlash": false` | The redirect under "Trailing slashes" |
| `"cleanUrls": true` | Not needed: `about.html` and `about/index.html` are both served at `/about` |
| `"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]` | Not needed: Vite apps get this automatically |
| Redirects between hosts, such as `www` to the bare domain | Set on the domain in the dashboard |
| `has`, `missing`, `statusCode`, regex patterns | Not supported |

## Where this applies

Headers and redirects come from builds that Vura runs from Git. `vura deploy` from the CLI uploads a finished `dist/` and doesn't read them. The 404 page and caching work for both. Each deployment keeps the rules it was built with, so a rollback also restores its headers and redirects.
