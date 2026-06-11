# Node / VPS

**What you'll have at the end:** a Vura app running as a managed `systemd` service on any Linux VPS, with Caddy as a reverse proxy providing HTTPS and WebSocket passthrough.

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

After `npm run build`, `dist/server/entry.js` is the unified server.

### 2. Copy to the server

```sh
rsync -a dist/ user@your-server:/srv/my-app/dist/
rsync package.json user@your-server:/srv/my-app/
```

Or push via git and build on the server directly.

### 3. Install production dependencies on the server

```sh
cd /srv/my-app
npm install --omit=dev --no-audit --no-fund
```

If `dist/package.json` exists (emitted when hot routes are present), run `npm install` inside `dist/` as well:

```sh
cd /srv/my-app/dist && npm install --omit=dev --no-audit --no-fund && cd /srv/my-app
```

### 4. Smoke-test the server manually

```sh
PORT=3000 NODE_ENV=production node dist/server/entry.js
```

Expected output:

```
[vura] listening on port 3000
```

Open a second terminal and verify:

```sh
curl -fsS http://localhost:3000/api/hello
```

Expected: a JSON response from the hello route.

For WebSocket smoke-test (requires `wscat` or equivalent):

```sh
wscat -c ws://localhost:3000/api/chat
> ping
< You: ping
```

Then `Ctrl-C` the server.

### 5. Create the systemd unit

```ini
# /etc/systemd/system/my-app.service
[Unit]
Description=Vura app — my-app
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/my-app
ExecStart=/usr/bin/node dist/server/entry.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=VURA_REVALIDATE_SECRET=change-me

[Install]
WantedBy=multi-user.target
```

Enable and start:

```sh
sudo systemctl daemon-reload
sudo systemctl enable my-app
sudo systemctl start my-app
sudo systemctl status my-app
```

### 6. Add a reverse proxy with Caddy

Caddy handles HTTPS automatically and passes WebSocket upgrades through transparently.

```
# /etc/caddy/Caddyfile
your-domain.com {
  reverse_proxy localhost:3000
}
```

The three-liner is sufficient — Caddy's default `reverse_proxy` handles `Upgrade: websocket` headers without any extra directives.

Reload Caddy:

```sh
sudo systemctl reload caddy
```

---

## Smoke test

```sh
# Static page
curl -fsS https://your-domain.com/ | grep -q '<h1'

# API route
curl -fsS https://your-domain.com/api/hello

# WebSocket
wscat -c wss://your-domain.com/api/chat
```

Expected: the static page returns HTML with an `<h1`, the API route returns JSON, and the WebSocket connection stays open (send a message to verify echo or broadcast).

---

> **CI-tested:** this guide is verified by the `node-vps` job in `.github/workflows/selfhost.yml`. The job boots the built server on `PORT=3000`, curls `/`, curls `/api/hello`, and opens a WebSocket to `/api/chat` (verifying the Welcome message). It does **not** test systemd or Caddy configuration — those require a real Linux host.

---

## Route kind support

All kinds: serverless, hot (WebSocket), task / cron.
