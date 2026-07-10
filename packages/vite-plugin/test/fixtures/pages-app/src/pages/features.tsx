/**
 * `/features` — a second static page.
 */
export const page = {
  mode: 'static' as const,
  title: 'Pages App — Features',
};

export default function FeaturesPage() {
  return (
    <main class="features">
      <h1>Features</h1>
      <ul>
        <li data-testid="feature-item">Static pages</li>
        <li>Client pages</li>
        <li>Serverless + hot API</li>
      </ul>
    </main>
  );
}
