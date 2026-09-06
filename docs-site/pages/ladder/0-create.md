# Rung 0 — Create: your first running app

You need a working app.

## Prerequisites

Node 20 or 22. Any package manager (npm, pnpm, or yarn).

## Create the project

```sh
npm create vura@latest my-app
cd my-app
npm run dev
# → Server listening on http://127.0.0.1:3000
```

pnpm and yarn work the same way:

```sh
pnpm create vura@latest my-app
# or
yarn create vura my-app
```

## What you got

Running `create-vura` emits twelve files:

```
my-app/
├── package.json
├── vura.config.js
├── tsconfig.json
├── .gitignore
└── src/
    ├── styles.ts          ← shared style strings the pages import
    ├── pages/
    │   ├── index.tsx      ← static home page
    │   ├── about.tsx      ← static about page
    │   └── dashboard.tsx  ← client-interactive page (signals)
    └── api/
        ├── hello.ts       ← serverless GET /api/hello
        ├── health.ts      ← serverless GET /api/health (uptime)
        ├── chat.ts        ← hot-route WebSocket /api/chat
        └── cleanup.ts     ← task route (nightly cron)
```

The home page, as emitted by `create-vura`:

```tsx
// src/pages/index.tsx
export const page = { mode: 'static', title: 'Home — my-app' };

export default function HomePage() {
  return (
    <div class="home">
      <h1>Welcome to Vura</h1>
      <p>Built with What Framework + Vura API routes</p>
      <nav>
        <a href="/about">About</a>
        {' | '}
        <a href="/dashboard">Dashboard</a>
      </nav>
    </div>
  );
}
```

The hello API, as emitted:

```ts
// src/api/hello.ts
import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';

export const route = { kind: 'serverless' };

export function GET(req: CelsianRequest, reply: CelsianReply) {
  return reply.json({ message: 'Hello from Vura!' });
}
```

A static page, a serverless route, a hot WebSocket route, and a cron task — all in the same project, with no glue.

## A note on page modes

Two modes appear in the scaffold:

| mode | what ships |
|---|---|
| `static` | pre-rendered HTML at build time, zero JS |
| `client` | fully interactive; What Framework signals |

The dashboard page uses `mode: 'client'` with a `useSignal` counter — that is the only page that ships JavaScript.

For per-request rendering, add a `server` page; caching is introduced in rung 2.

## Next

**[Rung 1 — Static page →](/ladder/1-static/)**
