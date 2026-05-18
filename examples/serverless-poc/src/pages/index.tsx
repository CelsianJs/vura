/**
 * Home Page — Static (pre-rendered at build time)
 *
 * Uses JSX with automatic transform (jsxImportSource).
 * When What Framework is installed: uses what-framework/jsx-runtime
 * Otherwise: uses @celsian/vura-core/jsx-runtime (built-in fallback)
 */

export const page = {
  mode: 'static',
  title: 'ThenJS App — Home',
};

export default function HomePage() {
  return (
    <div className="app">
      <header style={{ padding: '2rem', textAlign: 'center' }}>
        <h1>Welcome to ThenJS</h1>
        <p style={{ color: '#666', fontSize: '1.2rem' }}>
          The meta-framework powered by What Framework + CelsianJS
        </p>
      </header>

      <main style={{ maxWidth: '800px', margin: '0 auto', padding: '2rem' }}>
        <section>
          <h2>API Routes</h2>
          <ul>
            <li><code>GET /api/hello</code> — Hello world</li>
            <li><code>GET /api/users</code> — List users</li>
            <li><code>POST /api/users</code> — Create user</li>
            <li><code>GET /api/health</code> — Health check</li>
          </ul>
        </section>

        <section style={{ marginTop: '2rem' }}>
          <h2>Architecture</h2>
          <p>Built with:</p>
          <ul>
            <li><strong>What Framework</strong> — Signal-based UI with SSR</li>
            <li><strong>CelsianJS</strong> — Lightweight backend framework</li>
            <li><strong>Celsian Platform</strong> — Deploy to CF Workers, Lambda, or Fly.io</li>
          </ul>
        </section>
      </main>

      <footer style={{ textAlign: 'center', padding: '2rem', color: '#999' }}>
        <p>Deployed with Celsian</p>
      </footer>
    </div>
  );
}
