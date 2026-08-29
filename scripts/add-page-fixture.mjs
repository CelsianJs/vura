#!/usr/bin/env node
/**
 * add-page-fixture.mjs <target-dir>
 *
 * Add a server-mode page with a loader to a scaffolded app.
 *
 * The default `create-vura` template has a static page, a static page and a
 * client page — and no server-mode page at all. That is why the self-host CI
 * could go green for months on Cloudflare and Lambda while neither target
 * served a single page: the only surface those jobs curled was /api/hello, and
 * the scaffold had nothing that would have exposed the rest even if they had.
 *
 * This page is the one that cannot pass by accident. It renders per request,
 * it runs a loader, it embeds the loader payload, and its `loadedAt` differs
 * between two requests only if the loader really ran for each of them.
 *
 * Usage (CI scaffold job, after create-vura):
 *   node scripts/add-page-fixture.mjs /tmp/app
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';

const [, , targetDir] = process.argv;
if (!targetDir) {
  console.error('Usage: node scripts/add-page-fixture.mjs <target-dir>');
  process.exit(1);
}

const absTarget = isAbsolute(targetDir) ? targetDir : resolve(process.cwd(), targetDir);
if (!existsSync(absTarget)) {
  console.error(`Target directory does not exist: ${absTarget}`);
  process.exit(1);
}

export const PAGE_SOURCE = `import { useLoaderData } from '@celsian/vura-core';

export const page = { mode: 'server', title: 'Posts' };

export async function loader() {
  return { message: 'hello-from-the-loader', loadedAt: new Date().toISOString() };
}

export default function PostsPage() {
  const data = useLoaderData();
  return (
    <div class="posts">
      <h1>Posts</h1>
      <p>LOADED:{data.message}</p>
      <p>AT:{data.loadedAt}</p>
    </div>
  );
}
`;

const pagesDir = join(absTarget, 'src', 'pages');
await mkdir(pagesDir, { recursive: true });
await writeFile(join(pagesDir, 'posts.tsx'), PAGE_SOURCE);
console.log(`OK: added server-mode page fixture to ${join('src', 'pages', 'posts.tsx')} in ${absTarget}`);
