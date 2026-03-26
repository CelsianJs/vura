/**
 * Blog Page — Hybrid mode (static shell + islands)
 *
 * The page structure and content are pre-rendered as static HTML.
 * Interactive parts (search, comments) are wrapped in islands
 * that hydrate independently on the client.
 */

export const page = {
  mode: 'hybrid' as const,
  title: 'Blog — ThenJS Example',
};

const posts = [
  { slug: 'getting-started', title: 'Getting Started with ThenJS', date: '2026-03-01' },
  { slug: 'page-modes', title: 'Understanding Page Modes', date: '2026-03-05' },
  { slug: 'deploy-celsian', title: 'Deploying with Celsian', date: '2026-03-10' },
];

export default function BlogPage() {
  return (
    <div class="blog">
      <h1>Blog</h1>
      <p>
        This is a hybrid page — the post list is static HTML (zero JS),
        but interactive elements like search and comments would be islands
        that hydrate independently.
      </p>

      <ul class="post-list">
        {posts.map(post => (
          <li key={post.slug}>
            <a href={`/blog/${post.slug}`}>
              <strong>{post.title}</strong>
            </a>
            <time>{post.date}</time>
          </li>
        ))}
      </ul>

      <p><a href="/">Back to Home</a></p>
    </div>
  );
}
