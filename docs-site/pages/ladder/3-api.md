# Rung 3 — API route: a backend endpoint

You need a backend endpoint.

## Drop in a handler

Create any file in `src/api/`. The file path becomes the URL. Export named
functions for each HTTP method you want to handle:

```ts
// src/api/orders.ts
import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';

export const route = { kind: 'serverless' };

export async function GET(req: CelsianRequest, reply: CelsianReply) {
  const orders = await db.orders.list({ userId: req.query.userId });
  return reply.json(orders);
}

export async function POST(req: CelsianRequest, reply: CelsianReply) {
  const order = await db.orders.create(req.parsedBody);
  return reply.status(201).json(order);
}
```

`req.parsedBody` is the parsed JSON body. `req.query` is the querystring as
a plain object. `req.params` has path params for dynamic routes
(`src/api/orders/[id].ts` → `req.params.id`).

## It is serverless by default

Routes default to `kind: 'serverless'`. Serverless routes are stateless and
short-lived — the correct target for REST APIs, form handlers, and webhook
receivers. They run in-process in the Node production build and compile to a
standalone Worker entry for Cloudflare Workers.

## Validation with Zod

Export a `schema` object from the route file and Vura validates the request
automatically before your handler runs. Validation failures return a
`400 VALIDATION_FAILED` response with structured details — you never see
invalid input inside the handler:

```ts
// src/api/orders.ts
import { z } from 'zod';
import { defineSchema } from '@celsian/vura-core';
import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';

export const route = { kind: 'serverless' };

export const schema = defineSchema({
  body: z.object({
    item: z.string().min(1),
    qty: z.number().int().positive(),
  }),
  query: z.object({
    draft: z.coerce.boolean().optional(),
  }),
});

export async function POST(req: CelsianRequest, reply: CelsianReply) {
  // req.parsedBody is the validated+typed body ({ item: string; qty: number })
  // req.parsedQuery is the validated+coerced query ({ draft?: boolean }) —
  // z.coerce turned the raw "true" string into a real boolean.
  const { draft } = req.parsedQuery as { draft?: boolean };
  // req.query stays the raw strings (e.g. req.query.draft === 'true').
  const order = await db.orders.create(req.parsedBody);
  return reply.status(201).json(order);
}
```

`defineSchema` is a thin wrapper that infers the Zod output types so
`req.parsedBody` is the validated, typed body. Query params work the same
way: invalid requests get a 400, and the validated+coerced result is on
`req.parsedQuery` (numbers and booleans from `z.coerce` arrive as real
numbers and booleans). `req.query` is left untouched — it always holds the
raw string values from the URL. `zod` is a
peer dependency — install it once per project (`npm install zod`). Any
Zod-compatible library works.

## Calling an API route from a page

There is no generated RPC client. Call routes via `fetch` and share the
TypeScript types by hand — this is the honest pattern in Vura 0.4:

```ts
// src/lib/api.ts  — shared types and thin fetch wrappers
export interface Order {
  id: string;
  item: string;
  qty: number;
}

export async function createOrder(body: { item: string; qty: number }): Promise<Order> {
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /api/orders: ${res.status}`);
  return res.json() as Promise<Order>;
}
```

Import `createOrder` from both your pages and any server-side code that
needs it. The types flow without a code-generation step.

## Where routes run per adapter

| Target | Serverless route | Hot route |
|---|---|---|
| Node / VPS (default) | in-process | in-process |
| Cloudflare Workers | Worker entry | not supported — use VPS/Fly |
| AWS Lambda | Lambda handler | not supported |
| Fly.io | in-process | in-process |

Hot routes require a persistent process. When `vura build` detects a hot
route and the Cloudflare adapter is active, it emits a warning and excludes
the hot route from the Worker bundle.

## Next

**[Rung 4 — Hot route →](/ladder/4-hot/)**
