# Streaming responses

Vura API routes are handlers that receive `(req, reply)` and return a `Response`. To send a response incrementally — a large file, a generated feed, Server-Sent Events — return a **streaming** response instead of buffering the whole body in memory.

The `reply` object your handler already receives has everything you need. No extra imports.

```ts
// src/api/feed.ts
import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';

export function GET(req: CelsianRequest, reply: CelsianReply) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first chunk\n'));
      controller.enqueue(new TextEncoder().encode('second chunk\n'));
      controller.close();
    },
  });
  return reply.stream(body);
}
```

The client receives bytes as the stream produces them — the server never holds the full body at once.

---

## Streaming a page (SSR)

Pages stream too, and it is a one-line opt-in. Add `streaming: true` to a page's `page` export:

```tsx
// src/pages/dashboard.tsx
import { Suspense, createResource } from 'what-framework';

export const page = { mode: 'server', streaming: true, title: 'Dashboard' };

function Revenue() {
  const [data] = createResource(() => fetch('https://api.example.com/revenue').then(r => r.json()));
  return <p>{data()?.total}</p>;
}

export default function Dashboard() {
  return (
    <main>
      <h1>Dashboard</h1>
      <Suspense fallback={<p>Loading revenue...</p>}>
        <Revenue />
      </Suspense>
    </main>
  );
}
```

The browser receives `<head>` and everything up to the `<Suspense>` boundary immediately, so it can start fetching your stylesheets and scripts while the server is still waiting on `api.example.com`. The boundary's content is emitted in place once its resources resolve.

Without `streaming: true`, a page is rendered to a complete string and sent in one piece. Both are supported, and neither is a default you are stuck with: the flag is per page.

### What is settled before the first byte

The loader chain runs to completion **before** any of the document is written. That is deliberate. Once a byte is on the wire the status code is spent, so anything that needs to choose a status has to happen first:

```tsx
export const page = { mode: 'server', streaming: true };

export async function loader(ctx) {
  const post = await db.posts.find(ctx.params.id);
  if (!post) throw ctx.notFound();   // still a real 404
  return { post };
}
```

`throw ctx.notFound()` and `throw ctx.redirect('/login')` behave exactly as they do on a buffered page. A loader that throws for any other reason produces a 500, with nothing of the document sent.

After the first byte, that option is gone. A component that throws mid-render is caught by What, which substitutes an error comment and lets the rest of the document finish. If part of your page can fail and you want a visible fallback, wrap it in an `<ErrorBoundary>`.

### What streaming does not change

| | Buffered page | Streamed page |
|---|---|---|
| `loader` / `useLoaderData` | Yes | Yes, identical |
| Layout chain | Yes | Yes, identical |
| `notFound()` / `redirect()` | Yes | Yes, before the first byte |
| Serialized loader payload | Yes | Yes, after the body |
| Hydration of a `hybrid` page | Yes | Yes |
| ISR caching (`revalidate`) | Yes | **No** |

ISR is the one real exclusion. A response the server is still producing is not one the cache can store or a revalidation can replace, so a streamed page skips the cache entirely. If a page benefits more from being cached than from a fast first byte, leave `streaming` off.

`vura dev` serves streamed pages through the same code path as a build, so what you see locally is what you deploy.

### Requirements

Streaming SSR needs `what-framework` 0.13.4 or newer. Earlier versions reused resource keys across resolve passes, which could render one Suspense boundary's data inside another.

### Headers

A streamed page sends no `content-length`, because the length is not known until the last chunk. Vura deliberately does not set `transfer-encoding` itself: HTTP/2 forbids the header, and the Lambda adapter would echo it into the response payload. Leaving it off lets each host chunk the response its own way.

`x-accel-buffering: no` is sent so an nginx in front of your app does not buffer the response and undo the benefit.

---

## `reply.stream(readable)`

Pipe a Web `ReadableStream` to the client. Returns a `Response` you return from the handler.

```ts
reply.stream(readable: ReadableStream): Response
```

The default content type is `application/octet-stream`. Set your own with `reply.header()` **before** `.stream()` — an explicit `content-type` wins:

```ts
return reply
  .header('content-type', 'text/csv')
  .stream(csvStream);
```

`reply.header()` also lets you set `content-length`, `cache-control`, and any other header. It is chainable and returns the same `reply`.

---

## Server-Sent Events (SSE)

SSE is a plain streaming response with the `text/event-stream` content type and a body of `data: …\n\n` frames. Build the stream and return it through `reply.stream()`:

```ts
// src/api/clock.ts
import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';

export function GET(req: CelsianRequest, reply: CelsianReply) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      const tick = () =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ now: Date.now() })}\n\n`),
        );
      tick();
      const timer = setInterval(tick, 1000);
      // Stop the interval when the client disconnects.
      req.signal?.addEventListener('abort', () => {
        clearInterval(timer);
        controller.close();
      });
    },
  });

  return reply
    .header('content-type', 'text/event-stream')
    .header('cache-control', 'no-cache')
    .stream(body);
}
```

> **For fan-out (one event, many clients), reach for a [hot route](/ladder/4-hot) instead.** A hot route holds a persistent WebSocket per client and can `broadcast()` to a room — a better fit than SSE for chat, presence, or live collaboration.

---

## Sending a file

`reply.sendFile()` streams a file from disk with the correct MIME type inferred from its extension.

```ts
sendFile(filePath: string, options?: { root?: string }): Promise<Response>
download(filePath: string, filename?: string): Promise<Response>
```

```ts
// Serve a file inline
return reply.sendFile('/var/data/report.pdf');

// Force a download with Content-Disposition: attachment
return reply.download('/var/data/report.pdf', 'Q3-report.pdf');
```

| Method | Behavior |
|---|---|
| `sendFile(path, { root })` | Streams the file inline. Content type inferred from the extension (falls back to `application/octet-stream`). Returns `404` if the file is missing. |
| `download(path, filename?)` | Same, but sets `Content-Disposition: attachment`. `filename` defaults to the file's base name and is sanitized against header injection. |

**Path-traversal protection.** When you pass `root`, `filePath` is resolved relative to it and any path that escapes the root is rejected with `403`. **Always set `root` when the path comes from user input:**

```ts
// req.params.name is untrusted — jail it under ./public/downloads
return reply.sendFile(req.params.name, { root: './public/downloads' });
```

---

## Low-level Node helpers

`@celsian/vura-core` also ships streaming utilities that operate directly on Node's `http.ServerResponse` — for custom servers, middleware, or code built on top of [`startVuraServer`](/reference/server) where you hold the raw `res`. In a normal API route, prefer the `reply` methods above; these are the escape hatch when you don't have a `reply`.

```ts
import {
  streamResponse,
  createSSEChannel,
  streamFile,
  getMimeType,
  parseRangeHeader,
} from '@celsian/vura-core';
```

### `streamResponse(res, readable, options?)`

Pipe a Node `Readable` to a Node response, with backpressure handling and cleanup on client disconnect.

```ts
await streamResponse(res, fs.createReadStream('data.csv'), {
  statusCode: 200,
  headers: { 'content-type': 'text/csv' },
});
```

### `streamFile(req, res, filePath, options?)`

Stream a file with **HTTP range-request** support (`206 Partial Content`) — the right tool for video and audio that needs seeking.

```ts
await streamFile(req, res, '/data/video.mp4', {
  cacheControl: 'public, max-age=3600',
});
```

`FileStreamOptions`:

| Option | Type | Default | Effect |
|---|---|---|---|
| `contentType` | `string` | auto (from extension) | Override the `Content-Type`. |
| `ranges` | `boolean` | `true` | Enable `Range` request support (`206` responses, `Accept-Ranges: bytes`). |
| `cacheControl` | `string` | unset | Value for the `Cache-Control` header. |
| `headers` | `Record<string, string>` | `{}` | Extra headers to set. |
| `download` | `string` | unset | Send as an attachment with this filename (sanitized). |
| `root` | `string` | unset | Jail the resolved path under this directory (`403` on escape). Set it whenever the path is user-supplied. |

### `createSSEChannel(res, options?)`

An SSE channel over a Node response. Sets the event-stream headers and manages keepalive pings.

```ts
const channel = createSSEChannel(res, { keepalive: 30000 });
channel.send('update', { count: 42 });      // named event
channel.sendData({ tick: 1 });               // data-only message
channel.comment('ping');                     // keepalive comment
channel.onClose(() => cleanup());
channel.close();
```

`SSEChannel`:

| Member | Description |
|---|---|
| `send(event, data, id?)` | Send a named event. Objects are JSON-stringified. |
| `sendData(data, id?)` | Send a data-only message (no `event:` field). |
| `comment(text)` | Send an SSE comment (`: text`) — useful for keepalive. |
| `retry(ms)` | Set the client's reconnection interval. |
| `close()` | End the stream. |
| `isOpen` | `true` while the connection is open. |
| `onClose(fn)` | Register a callback fired when the client disconnects. |

### Utilities

| Function | Returns |
|---|---|
| `getMimeType(filePath)` | The MIME type for a path's extension, or `application/octet-stream`. |
| `parseRangeHeader(header, fileSize)` | `{ start, end }` for a `Range` header, or `null` if invalid. Supports `bytes=200-400`, open-ended `bytes=500-`, and suffix `bytes=-500`. |
