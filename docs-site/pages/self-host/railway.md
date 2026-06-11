# Railway

**What you'll have at the end:** a Vura app deployed to Railway using a Dockerfile-based build. Railway injects the `PORT` environment variable, which the Vura server respects automatically.

Supports all route kinds: serverless, hot (WebSocket), task.

---

## Steps

### 1. Scaffold and build

```sh
npm create vura@latest my-app
cd my-app
npm install
npm run build
```

### 2. The Dockerfile

Use the same Dockerfile as the Docker guide. Create `dist/Dockerfile` if `vura build` did not emit it (no hot routes):

```dockerfile
# dist/Dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server/entry.js"]
```

Railway overrides `PORT` at runtime with its own injected value. The `ENV PORT=3000` in the Dockerfile is a fallback for local testing; Railway's injection takes precedence.

### 3. Add railway.json

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "dist/Dockerfile"
  },
  "deploy": {
    "startCommand": "node server/entry.js",
    "healthcheckPath": "/api/hello"
  }
}
```

Place this at the project root (not inside `dist/`). The `dockerfilePath` points to `dist/Dockerfile`; Railway uses the `dist/` directory as the Docker build context automatically when the Dockerfile is in `dist/`.

### 4. Deploy via Railway CLI

```sh
railway login
railway link    # link to an existing project, or create one in the Railway dashboard
railway up
```

Or push to the linked GitHub repo — Railway deploys on every push to the configured branch.

### 5. PORT note

Railway injects `PORT` as an environment variable at runtime. `dist/server/entry.js` reads `process.env.PORT` at startup. No code change is needed — the server binds to whatever port Railway provides.

### 6. Verify

```sh
curl -fsS https://your-app.railway.app/api/hello
```

---

## Smoke test

```sh
# Static page
curl -fsS https://your-app.railway.app/ | grep -q '<h1'

# API route
curl -fsS https://your-app.railway.app/api/hello

# WebSocket
wscat -c wss://your-app.railway.app/api/live/room
```

---

> **CI-tested:** Railway has no local emulator. This guide is Dockerfile-based, so the `docker` job in `.github/workflows/selfhost.yml` is its CI coverage — it builds the same Dockerfile, runs the container, and curls the smoke surface. The Railway-specific `railway.json` and `railway up` flow are **not** executed in CI; they require a Railway project and credentials.

---

## Route kind support

All kinds: serverless, hot (WebSocket), task / cron.
