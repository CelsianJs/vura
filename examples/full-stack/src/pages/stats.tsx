/**
 * Stats Page — Server mode with getServerData
 *
 * Rendered per-request on the server. Fetches fresh data
 * on each request via getServerData().
 */

export const page = {
  mode: 'server' as const,
  title: 'Server Stats — ThenJS Example',
  revalidate: 60, // ISR: cache for 60 seconds
};

export async function getServerData(ctx: { params: Record<string, string>; url: string; query: Record<string, string> }) {
  // In a real app, this would fetch from a database or external API
  return {
    serverTime: new Date().toISOString(),
    requestUrl: ctx.url,
    nodeVersion: process.version,
    memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };
}

export default function StatsPage(props: {
  serverTime: string;
  requestUrl: string;
  nodeVersion: string;
  memoryUsage: number;
  params: Record<string, string>;
}) {
  return (
    <div class="stats">
      <h1>Server Stats</h1>
      <p>This page is rendered per-request on the server with ISR caching (60s).</p>

      <table>
        <tbody>
          <tr>
            <td><strong>Server Time</strong></td>
            <td>{props.serverTime}</td>
          </tr>
          <tr>
            <td><strong>Request URL</strong></td>
            <td>{props.requestUrl}</td>
          </tr>
          <tr>
            <td><strong>Node Version</strong></td>
            <td>{props.nodeVersion}</td>
          </tr>
          <tr>
            <td><strong>Memory Usage</strong></td>
            <td>{props.memoryUsage} MB</td>
          </tr>
        </tbody>
      </table>

      <p><a href="/">Back to Home</a></p>
    </div>
  );
}
