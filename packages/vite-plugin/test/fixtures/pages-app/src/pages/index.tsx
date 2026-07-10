/**
 * Landing `/` — static page (pre-rendered, zero client JS).
 */
export const page = {
  mode: 'static' as const,
  title: 'Pages App — Home',
  meta: [{ name: 'description', content: 'Static landing page' }],
};

export default function HomePage() {
  return (
    <main class="home">
      <h1>Pages App Home</h1>
      <p data-testid="static-marker">This is a static page rendered on the fly in dev.</p>
    </main>
  );
}
