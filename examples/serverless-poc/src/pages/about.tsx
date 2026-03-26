/**
 * About Page — Static
 */

export const page = {
  mode: 'static',
  title: 'About — ThenJS',
};

export default function AboutPage() {
  return (
    <div className="about">
      <h1>About ThenJS</h1>
      <p>
        ThenJS is a meta-framework that combines the best of{' '}
        <strong>What Framework</strong> for the frontend and{' '}
        <strong>CelsianJS</strong> for the backend.
      </p>

      <h2>How It Works</h2>
      <ol>
        <li>Write API routes in src/api/ with CelsianJS req/reply pattern</li>
        <li>Write pages in src/pages/ with What Framework JSX components</li>
        <li>Run <code>then build</code> to bundle everything</li>
        <li>Run <code>then deploy</code> to ship to Cloudflare, Lambda, or Fly.io</li>
      </ol>

      <p>
        <a href="/">Back to Home</a>
      </p>
    </div>
  );
}
