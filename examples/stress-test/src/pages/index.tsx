/**
 * Home Page — Static mode
 *
 * Pre-rendered at build time. Tests title, meta tags, styles, and scripts config.
 */

export const page = {
  mode: 'static' as const,
  title: 'Stress Test — ThenJS',
  meta: [
    { name: 'description', content: 'ThenJS integration stress test' },
    { name: 'author', content: 'ThenJS Team' },
  ],
  styles: ['body { font-family: sans-serif; margin: 2rem; }'],
  scripts: ['/app.js'],
};

export default function HomePage() {
  return (
    <div class="home">
      <header>
        <h1>ThenJS Stress Test</h1>
        <p>Comprehensive integration test covering all features.</p>
      </header>

      <nav>
        <a href="/about">About (static)</a>
        {' | '}
        <a href="/dashboard">Dashboard (client)</a>
        {' | '}
        <a href="/profile/testuser">Profile (server)</a>
        {' | '}
        <a href="/blog/hello-world">Blog (ISR)</a>
      </nav>

      <main>
        <section>
          <h2>Page Modes</h2>
          <ul>
            <li><strong>Static</strong> — this page. Pre-rendered HTML, zero JS.</li>
            <li><strong>Server</strong> — rendered per-request with getServerData.</li>
            <li><strong>Client</strong> — SPA mode, JS bundle for interactivity.</li>
          </ul>
        </section>

        <section>
          <h2>API Routes</h2>
          <ul>
            <li><code>GET /api/health</code> — hot (persistent)</li>
            <li><code>GET /api/users/:id</code> — serverless param extraction</li>
            <li><code>POST /api/echo</code> — body parsing echo</li>
            <li><code>POST /api/tasks/cleanup</code> — task route with retries</li>
            <li><code>POST /api/tasks/report</code> — scheduled task (cron)</li>
            <li><code>GET /api/error</code> — intentional error (no stack leak)</li>
          </ul>
        </section>
      </main>

      <footer>
        <p>Built with ThenJS</p>
      </footer>
    </div>
  );
}
