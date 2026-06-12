# create-vura

Scaffold a new [Vura](https://vura.io) project.

[![npm version](https://img.shields.io/npm/v/create-vura)](https://www.npmjs.com/package/create-vura)

## What it does

`create-vura` writes a ready-to-run Vura scaffold and installs dependencies. Dependency installation is part of a successful scaffold — if `npm install` fails (e.g. the `@celsian/` scope is not yet accessible to you), the command exits non-zero so the problem is not silently swallowed. Pass `--no-install` to write the files without installing.

## Usage

```sh
npm create vura@latest my-app
# skip dependency install
npm create vura@latest my-app -- --no-install
```

## Scaffold tree

```
my-app/
├── package.json
├── vura.config.js
├── tsconfig.json
├── .gitignore
└── src/
    ├── api/
    │   ├── hello.ts      # serverless GET route
    │   ├── health.ts     # health-check route
    │   ├── chat.ts       # hot WebSocket route (kind: 'hot')
    │   └── cleanup.ts    # task route (kind: 'task', cron)
    └── pages/
        ├── index.tsx
        ├── about.tsx
        └── dashboard.tsx
```

## Next steps

```sh
cd my-app
npm run dev    # starts Vite + API middleware
npm run build  # builds for production
```

## Documentation

_vura.io docs site launches with v0.5 — until then, see the repo README and CHANGELOG._

- [Quick start — /ladder/0-create/](https://vura.io/ladder/0-create/)
- [Scaffold reference — /reference/scaffold/](https://vura.io/ladder/0-create/)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
