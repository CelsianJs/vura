/**
 * About Page — Static mode with inline styles
 *
 * Tests style object rendering on elements (camelCase to kebab-case).
 */

export const page = {
  mode: 'static' as const,
  title: 'About — Stress Test',
};

export default function AboutPage() {
  const headerStyle = {
    backgroundColor: '#1a1a2e',
    color: '#eef',
    padding: '2rem',
    borderRadius: '8px',
    textAlign: 'center',
  };

  const cardStyle = {
    border: '1px solid #ccc',
    padding: '1.5rem',
    marginTop: '1rem',
    borderRadius: '4px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  };

  return (
    <div class="about" style={{ maxWidth: '800px', margin: '0 auto' }}>
      <div style={headerStyle}>
        <h1>About This Stress Test</h1>
        <p>Testing inline style rendering with camelCase-to-kebab conversion.</p>
      </div>

      <div style={cardStyle}>
        <h2>Architecture</h2>
        <dl>
          <dt style={{ fontWeight: 'bold', marginTop: '0.5rem' }}>Frontend</dt>
          <dd>What Framework — signal-based UI with JSX</dd>

          <dt style={{ fontWeight: 'bold', marginTop: '0.5rem' }}>Meta-framework</dt>
          <dd>ThenJS — file-based routing, build pipeline, multi-provider deployment</dd>
        </dl>
      </div>

      <div style={cardStyle}>
        <h2>Features Tested</h2>
        <ul>
          <li>Static pages with pre-rendering</li>
          <li>Server pages with getServerData</li>
          <li>Client (SPA) pages</li>
          <li>ISR with cache hit/miss/stale</li>
          <li>Hot API routes</li>
          <li>Serverless API routes with params</li>
          <li>Body parsing (JSON + form data)</li>
          <li>Task routes with retries and cron</li>
          <li>Error handling (no stack trace leaks)</li>
          <li>Malformed URI handling</li>
          <li>Inline style objects (camelCase to kebab-case)</li>
        </ul>
      </div>

      <p style={{ marginTop: '2rem' }}><a href="/">Back to Home</a></p>
    </div>
  );
}
