// vura.io static build — rendered through What Framework (what-server's
// renderToString). Chrome (head/nav/sidebar/footer) is authored as What;
// page content comes from Markdown in pages/**/*.md → marked.parse.
// Landing page (pages/index.html) is raw HTML wrapped in nav+footer chrome.
// Output: dist/<clean-route>/index.html  (no .html in URLs).
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'what-framework/server';
import { h } from 'what-framework';
import { marked } from 'marked';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');

// ---------------------------------------------------------------------------
// Version — read from monorepo source of truth at build time so the nav
// badge never drifts from the released package.
// ---------------------------------------------------------------------------
function readVersion() {
  const candidates = [
    join(ROOT, '..', 'packages', 'core', 'package.json'),          // monorepo source of truth
    join(ROOT, 'node_modules', '@celsian', 'vura-core', 'package.json'), // npm pkg fallback
    join(ROOT, 'node_modules', 'what-framework', 'package.json'),   // last resort
  ];
  for (const p of candidates) {
    try {
      const { version } = JSON.parse(readFileSync(p, 'utf8'));
      if (version) return version;
    } catch { /* try next */ }
  }
  throw new Error(
    'docs-site build: could not resolve vura version — check packages/core/package.json'
  );
}
const VERSION = readVersion();
const BADGE = `v${VERSION}`;

// ---------------------------------------------------------------------------
// Sidebar nav data
// ---------------------------------------------------------------------------
const LADDER = [
  ['/ladder/0-create', '0 · Create an app'],
  ['/ladder/1-static', '1 · Static page'],
  ['/ladder/2-cache', '2 · Server + cache'],
  ['/ladder/3-api', '3 · API route'],
  ['/ladder/4-hot', '4 · Hot route'],
  ['/ladder/5-tasks', '5 · Background task'],
  ['/ladder/6-deploy', '6 · Deploy'],
];

const REFERENCE = [
  ['/reference/config', 'vura.config'],
  ['/reference/route-kinds', 'Route kinds'],
  ['/reference/page-modes', 'Page modes'],
  ['/reference/cli', 'CLI'],
  ['/reference/adapters', 'Adapters'],
];

const SELF_HOST = [
  ['/self-host', 'Overview'],
  ['/self-host/node-vps', 'Node / VPS'],
  ['/self-host/docker', 'Docker'],
  ['/self-host/fly', 'Fly.io'],
  ['/self-host/railway', 'Railway'],
  ['/self-host/cloudflare', 'Cloudflare Workers'],
  ['/self-host/lambda', 'AWS Lambda'],
];

// ---------------------------------------------------------------------------
// Chrome HTML snippets
// ---------------------------------------------------------------------------
const THEME_TOGGLE = `<button class="theme-toggle" aria-label="Toggle theme">
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
      <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
    </button>`;

const GITHUB_LINK = `<a href="https://github.com/CelsianJs/vura" class="nav-github" target="_blank" rel="noopener">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
      GitHub
    </a>`;

function navHtml() {
  return `
    <div class="nav-left">
      <a href="/" class="nav-logo">
        <span class="logo-name">Vura</span>
        <span class="logo-badge">${BADGE}</span>
      </a>
    </div>
    <div class="nav-right">
      ${GITHUB_LINK}
      ${THEME_TOGGLE}
    </div>
  `;
}

const FOOTER_INNER = `
    <span>MIT licensed — forever. See <a href="https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md" target="_blank" rel="noopener">GOVERNANCE.md</a></span>
    <span>Built with <a href="https://whatfw.com">What Framework</a></span>
  `;

function sidebarHtml(activePath) {
  function renderGroup(items) {
    return items
      .map(([href, label]) => {
        const active =
          activePath === href ||
          (href !== '/' && activePath.startsWith(href + '/'));
        return `      <li><a href="${href}"${active ? ' class="active"' : ''}>${label}</a></li>`;
      })
      .join('\n');
  }
  return `
    <div class="sidebar-section">
      <div class="sidebar-heading">Ladder</div>
      <ul class="sidebar-nav">
${renderGroup(LADDER)}
      </ul>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-heading">Reference</div>
      <ul class="sidebar-nav">
${renderGroup(REFERENCE)}
      </ul>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-heading">Self-host</div>
      <ul class="sidebar-nav">
${renderGroup(SELF_HOST)}
      </ul>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// <head> template
// ---------------------------------------------------------------------------
function headHtml(title, { description, canonical } = {}) {
  const pageTitle = title ? `${title} — Vura` : 'Vura';
  const descTag = description
    ? `\n  <meta name="description" content="${description}">`
    : '';
  const canonicalTag = canonical
    ? `\n  <link rel="canonical" href="${canonical}">`
    : '';
  return `<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>${descTag}${canonicalTag}
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>V</text></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <script src="/theme.js"></script>
</head>`;
}

// ---------------------------------------------------------------------------
// Page render via What's renderToString
// ---------------------------------------------------------------------------
function renderDocPage({ title, route, contentHtml }) {
  const nav = renderToString(
    h('nav', { class: 'site-nav', dangerouslySetInnerHTML: { __html: navHtml() } })
  );
  const sidebarInner = sidebarHtml(route);
  const layout = renderToString(
    h('div', { class: 'layout' },
      h('aside', { class: 'sidebar', dangerouslySetInnerHTML: { __html: sidebarInner } }),
      h('main', { class: 'content', dangerouslySetInnerHTML: { __html: contentHtml } })
    )
  );
  const footer = renderToString(
    h('footer', { class: 'site-footer', dangerouslySetInnerHTML: { __html: FOOTER_INNER } })
  );
  return `<!DOCTYPE html>
<html lang="en">
${headHtml(title)}
<body>
  ${nav}
  ${layout}
  ${footer}
</body>
</html>
`;
}

function renderLandingPage({ title, bodyInner, description, canonical }) {
  const nav = renderToString(
    h('nav', { class: 'site-nav', dangerouslySetInnerHTML: { __html: navHtml() } })
  );
  const body = renderToString(
    h('div', { class: 'landing-body', dangerouslySetInnerHTML: { __html: bodyInner } })
  );
  const footer = renderToString(
    h('footer', { class: 'site-footer no-sidebar', dangerouslySetInnerHTML: { __html: FOOTER_INNER } })
  );
  return `<!DOCTYPE html>
<html lang="en">
${headHtml(title || null, { description, canonical })}
<body>
  ${nav}
  ${body}
  ${footer}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Write helper: dist/<route>/index.html
// ---------------------------------------------------------------------------
function write(routePath, html) {
  const dir = join(DIST, routePath.replace(/^\//, ''));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
}

function copyAsset(rel) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) {
    console.warn(`  ! asset not found, skipping: ${rel}`);
    return;
  }
  const dest = join(DIST, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

// ---------------------------------------------------------------------------
// Synchronous recursive walk of pages/
// ---------------------------------------------------------------------------
function walkPagesSync(dir, routeBase) {
  let count = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += walkPagesSync(join(dir, entry.name), `${routeBase}/${entry.name}`);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const slug = entry.name.replace(/\.md$/, '');
      const route = slug === 'index' ? (routeBase || '/') : `${routeBase}/${slug}`;
      const src = readFileSync(join(dir, entry.name), 'utf8');
      // Extract title from first h1
      const titleMatch = src.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : route.split('/').pop() || 'Vura';
      const contentHtml = marked.parse(src);
      const html = renderDocPage({ title, route, contentHtml });
      write(route, html);
      count++;
      console.log(`  ✓ ${route}`);
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

for (const a of ['styles.css', 'theme.js']) copyAsset(a);
console.log('✓ assets copied');

let total = 0;
const PAGES_DIR = join(ROOT, 'pages');

// Landing page — raw HTML, nav+footer chrome only (no sidebar)
const landingPath = join(PAGES_DIR, 'index.html');
if (existsSync(landingPath)) {
  const src = readFileSync(landingPath, 'utf8');
  const h1Match = src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  // Strip tags repeatedly until stable: a single pass can leave a re-assembled
  // tag behind (e.g. "<scr<b>ipt") — CodeQL js/incomplete-multi-character-sanitization.
  let titleText = h1Match ? h1Match[1] : '';
  for (let prev; titleText !== prev; ) {
    prev = titleText;
    titleText = titleText.replace(/<[^>]*>/g, '');
  }
  const pageTitle = titleText.trim() || null;
  const html = renderLandingPage({
    title: pageTitle === 'Vura' ? null : pageTitle,
    bodyInner: src,
    // Landing-page head metadata (Task 3).
    // Title is handled separately above via h1 extraction; title tag is set
    // explicitly below via the full sentence form so it differs from the h1.
    description: 'Static pages, cached SSR, typed APIs, websockets, and background tasks in one project. Self-host anywhere or deploy in one command. MIT, forever.',
    canonical: 'https://vura.io/',
  });
  // Override title to the full sentence form required by Task 3.
  const finalHtml = html.replace(
    /<title>[^<]*<\/title>/,
    '<title>Vura — The framework for apps that outgrow serverless</title>',
  );
  write('/', finalHtml);
  total++;
  console.log('  ✓ /  (landing)');
}

// Markdown pages
total += walkPagesSync(PAGES_DIR, '');

console.log(`\nbuilt ${total} page(s) → dist/`);
