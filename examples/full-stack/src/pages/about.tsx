/**
 * About Page — Static mode
 */

export const page = {
  mode: 'static' as const,
  title: 'About — ThenJS Example',
};

export default function AboutPage() {
  return (
    <div class="about">
      <h1>About This Example</h1>
      <p>
        This is a full-stack ThenJS application demonstrating all four page modes
        and three API route kinds working together.
      </p>

      <h2>Architecture</h2>
      <dl>
        <dt>Frontend</dt>
        <dd>What Framework — signal-based UI with JSX, islands architecture, SSR</dd>

        <dt>Backend</dt>
        <dd>CelsianJS — lightweight req/reply handlers with WebSocket and task support</dd>

        <dt>Meta-framework</dt>
        <dd>ThenJS — file-based routing, build pipeline, multi-provider deployment</dd>

        <dt>Platform</dt>
        <dd>Celsian — managed deployment, edge routing, scaling, previews</dd>
      </dl>

      <p><a href="/">Back to Home</a></p>
    </div>
  );
}
