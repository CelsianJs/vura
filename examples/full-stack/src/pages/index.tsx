/**
 * Home Page — Static mode
 *
 * Pre-rendered at build time. Zero JS shipped to the client.
 * Perfect for marketing pages, landing pages, docs.
 */

export const page = {
  mode: 'static' as const,
  title: 'ThenJS Full-Stack Example',
  meta: [
    { name: 'description', content: 'A full-stack ThenJS app with What Framework + CelsianJS' },
  ],
};

export default function HomePage() {
  return (
    <div class="home">
      <header>
        <h1>ThenJS Full-Stack Example</h1>
        <p>What Framework (frontend) + CelsianJS (backend)</p>
      </header>

      <nav>
        <a href="/about">About (static)</a>
        {' | '}
        <a href="/dashboard">Dashboard (client)</a>
        {' | '}
        <a href="/blog">Blog (hybrid)</a>
      </nav>

      <main>
        <section>
          <h2>Page Modes</h2>
          <ul>
            <li><strong>Static</strong> — this page. Pre-rendered HTML, zero JS.</li>
            <li><strong>Server</strong> — rendered per-request with dynamic data.</li>
            <li><strong>Client</strong> — SPA mode, fully interactive dashboard.</li>
            <li><strong>Hybrid</strong> — static shell with interactive islands.</li>
          </ul>
        </section>

        <section>
          <h2>API Routes</h2>
          <ul>
            <li><code>GET /api/hello</code> — serverless (CF Workers / Lambda)</li>
            <li><code>GET /api/users</code> — serverless CRUD</li>
            <li><code>GET /api/health</code> — hot server (stateful, persistent)</li>
          </ul>
        </section>
      </main>

      <footer>
        <p>Built with ThenJS — deployed with Celsian</p>
      </footer>
    </div>
  );
}
