/**
 * Blog Post Page — Server mode with ISR (Incremental Static Regeneration)
 *
 * Cached for 5 seconds, then revalidated in background.
 * Tests ISR cache hit/miss/stale behavior.
 */

export const page = {
  mode: 'server' as const,
  title: 'Blog Post',
  revalidate: 5,
};

export async function getServerData(ctx: { params: Record<string, string>; url: string; query: Record<string, string> }) {
  const slug = ctx.params.slug || 'untitled';
  return {
    slug,
    title: slug.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    content: `This is the content of the blog post "${slug}". Rendered at ${new Date().toISOString()}.`,
    category: ctx.query.category || 'general',
    renderedAt: new Date().toISOString(),
  };
}

export default function BlogPostPage(props: {
  slug: string;
  title: string;
  content: string;
  category: string;
  renderedAt: string;
  params: Record<string, string>;
}) {
  return (
    <div class="blog-post">
      <article>
        <h1>{props.title}</h1>
        <p class="meta">
          Slug: {props.slug} | Category: {props.category} | Rendered: {props.renderedAt}
        </p>
        <div class="content">
          <p>{props.content}</p>
        </div>
      </article>

      <p><a href="/">Back to Home</a></p>
    </div>
  );
}
