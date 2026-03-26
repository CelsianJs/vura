/**
 * Dashboard Page — Client mode (SPA)
 *
 * Rendered entirely in the browser. Ships a JS bundle that
 * mounts the component with What Framework's reactive signals.
 * Use for admin panels, dashboards, interactive tools.
 */

export const page = {
  mode: 'client' as const,
  title: 'Dashboard — ThenJS Example',
};

export default function DashboardPage() {
  return (
    <div class="dashboard">
      <h1>Dashboard</h1>
      <p>
        This page runs entirely in the browser — all interactivity
        is handled by What Framework's signals and effects.
      </p>
      <p>
        In production, this page ships a JS bundle that calls
        <code> mount(&lt;DashboardPage /&gt;, '#app')</code> on load.
      </p>
      <p><a href="/">Back to Home</a></p>
    </div>
  );
}
