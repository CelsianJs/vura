/**
 * What Framework Integration Tests
 *
 * Proves that each Vura page mode works with the real What Framework.
 * No faking — imports what-framework directly and renders real components.
 */

import { describe, it, expect } from 'vitest';

// Real What Framework imports
import { h } from 'what-framework';
import { renderToString, renderToStream, generateStaticPage, definePage, Island } from 'what-framework/server';

// ─── Helper: create JSX-like VNodes using h() ───
// In real projects, the JSX compiler transforms JSX → h() calls.
// We use h() directly here since tests can't go through the JSX transform.

describe('What Framework Integration — Page Modes', () => {

  describe('Static Mode (build-time HTML)', () => {
    it('renders a simple component to HTML string', () => {
      function HomePage() {
        return h('div', { class: 'home' },
          h('h1', null, 'Welcome to Vura'),
          h('p', null, 'Signal-based UI with SSR'),
        );
      }

      const html = renderToString(h(HomePage, null));
      expect(html).toContain('<div class="home">');
      expect(html).toContain('<h1>Welcome to Vura</h1>');
      expect(html).toContain('<p>Signal-based UI with SSR</p>');
      expect(html).toContain('</div>');
    });

    it('renders nested components', () => {
      function Header({ title }: { title: string }) {
        return h('header', null, h('h1', null, title));
      }

      function Layout({ children }: { children: any }) {
        return h('div', { class: 'layout' },
          h(Header, { title: 'My App' }),
          h('main', null, ...([].concat(children))),
        );
      }

      function Page() {
        return h(Layout, null,
          h('p', null, 'Page content'),
        );
      }

      const html = renderToString(h(Page, null));
      expect(html).toContain('<header><h1>My App</h1></header>');
      expect(html).toContain('<main><p>Page content</p></main>');
    });

    it('generates a full static page with document wrapper', () => {
      function AboutPage() {
        return h('div', null, h('h1', null, 'About'));
      }

      const page = definePage({
        mode: 'static',
        title: 'About — Vura',
        meta: { description: 'About Vura framework' },
        component: AboutPage,
      });

      const fullHtml = generateStaticPage(page);
      expect(fullHtml).toContain('<!DOCTYPE html>');
      expect(fullHtml).toContain('<title>About — Vura</title>');
      expect(fullHtml).toContain('<meta name="description" content="About Vura framework">');
      expect(fullHtml).toContain('<h1>About</h1>');
      // Static mode should NOT include client JS
      expect(fullHtml).not.toContain('client.js');
    });

    it('handles HTML attributes correctly', () => {
      function StyledComponent() {
        return h('div', {
          id: 'main',
          class: 'container mx-auto',
          'data-theme': 'dark',
        },
          h('a', { href: '/about', target: '_blank' }, 'About'),
          h('img', { src: '/logo.png', alt: 'Logo', width: '100' }),
        );
      }

      const html = renderToString(h(StyledComponent, null));
      expect(html).toContain('id="main"');
      expect(html).toContain('class="container mx-auto"');
      expect(html).toContain('data-theme="dark"');
      expect(html).toContain('href="/about"');
      expect(html).toContain('<img src="/logo.png"');
    });
  });

  describe('Server Mode (per-request SSR)', () => {
    it('renders with dynamic data passed as props', () => {
      interface User { name: string; email: string }

      function UserProfile({ user }: { user: User }) {
        return h('div', { class: 'profile' },
          h('h2', null, user.name),
          h('p', null, user.email),
        );
      }

      // Simulate server-side data fetching
      const userData: User = { name: 'Kirby', email: 'kirby@zvndev.com' };
      const html = renderToString(h(UserProfile, { user: userData }));

      expect(html).toContain('<h2>Kirby</h2>');
      expect(html).toContain('<p>kirby@zvndev.com</p>');
    });

    it('renders lists from server data', () => {
      function PostList({ posts }: { posts: { id: number; title: string }[] }) {
        return h('ul', null,
          ...posts.map(post =>
            h('li', { key: String(post.id) }, post.title)
          ),
        );
      }

      const posts = [
        { id: 1, title: 'Getting Started with Vura' },
        { id: 2, title: 'Server-Side Rendering Guide' },
        { id: 3, title: 'Deploying with Celsian' },
      ];

      const html = renderToString(h(PostList, { posts }));
      expect(html).toContain('<ul>');
      expect(html).toContain('<li>Getting Started with Vura</li>');
      expect(html).toContain('<li>Server-Side Rendering Guide</li>');
      expect(html).toContain('<li>Deploying with Celsian</li>');
    });

    it('renders conditional content', () => {
      function AuthGate({ isLoggedIn }: { isLoggedIn: boolean }) {
        return h('div', null,
          isLoggedIn
            ? h('p', null, 'Welcome back!')
            : h('a', { href: '/login' }, 'Sign in'),
        );
      }

      const loggedIn = renderToString(h(AuthGate, { isLoggedIn: true }));
      expect(loggedIn).toContain('Welcome back!');
      expect(loggedIn).not.toContain('Sign in');

      const loggedOut = renderToString(h(AuthGate, { isLoggedIn: false }));
      expect(loggedOut).toContain('Sign in');
      expect(loggedOut).not.toContain('Welcome back!');
    });
  });

  describe('Hybrid Mode (static shell + islands)', () => {
    it('renders static shell with island placeholder', () => {
      function Counter() {
        return h('button', null, 'Count: 0');
      }

      // The Island component wraps interactive pieces
      function HybridPage() {
        return h('div', { class: 'page' },
          h('h1', null, 'Dashboard'),
          h('p', null, 'This text is static HTML — zero JS.'),
          h(Island, {
            name: 'counter',
            props: { initial: 0 },
            mode: 'idle',
          },
            h(Counter, null),
          ),
        );
      }

      const html = renderToString(h(HybridPage, null));
      // Static content renders normally
      expect(html).toContain('<h1>Dashboard</h1>');
      expect(html).toContain('This text is static HTML');
      // Island gets a data-island marker for client hydration
      expect(html).toContain('data-island="counter"');
      expect(html).toContain('data-island-mode="idle"');
    });

    it('supports multiple hydration modes', () => {
      function SearchBar() {
        return h('input', { type: 'text', placeholder: 'Search...' });
      }

      function Comments() {
        return h('div', null, 'Comments section');
      }

      function Page() {
        return h('div', null,
          h(Island, { name: 'search', mode: 'load' },
            h(SearchBar, null),
          ),
          h(Island, { name: 'comments', mode: 'visible' },
            h(Comments, null),
          ),
        );
      }

      const html = renderToString(h(Page, null));
      expect(html).toContain('data-island-mode="load"');
      expect(html).toContain('data-island-mode="visible"');
    });
  });

  describe('Client Mode (SPA)', () => {
    it('generates page with client script', () => {
      function App() {
        return h('div', { id: 'root' }, h('p', null, 'Loading...'));
      }

      const page = definePage({
        mode: 'client',
        title: 'Dashboard — Vura',
        component: App,
        scripts: ['/assets/app.js'],
      });

      const fullHtml = generateStaticPage(page);
      expect(fullHtml).toContain('<!DOCTYPE html>');
      expect(fullHtml).toContain('<title>Dashboard — Vura</title>');
      // Client mode should include the client bootstrap script
      expect(fullHtml).toContain('client.js');
      // Should also include custom scripts
      expect(fullHtml).toContain('/assets/app.js');
      // Still renders the initial HTML (for fast first paint / SEO)
      expect(fullHtml).toContain('Loading...');
    });
  });

  describe('Chunked full HTML rendering', () => {
    it('yields full HTML in chunks via async iterator', async () => {
      function BigPage() {
        return h('div', null,
          h('h1', null, 'Streamed Page'),
          h('section', null,
            h('p', null, 'First section'),
          ),
          h('section', null,
            h('p', null, 'Second section'),
          ),
        );
      }

      const chunks: string[] = [];
      for await (const chunk of renderToStream(h(BigPage, null))) {
        chunks.push(chunk);
      }

      const fullHtml = chunks.join('');
      expect(fullHtml).toContain('<h1>Streamed Page</h1>');
      expect(fullHtml).toContain('First section');
      expect(fullHtml).toContain('Second section');
      // This only asserts chunked full HTML output, not progressive SSR.
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe('HTML Safety', () => {
    it('escapes user input in text content', () => {
      const userInput = '<script>alert("xss")</script>';
      function UnsafePage() {
        return h('p', null, userInput);
      }

      const html = renderToString(h(UnsafePage, null));
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes user input in attributes', () => {
      const evilAttr = '" onclick="alert(1)';
      function UnsafePage() {
        return h('div', { title: evilAttr }, 'Content');
      }

      const html = renderToString(h(UnsafePage, null));
      // The " should be escaped to &quot; so the attribute can't break out
      expect(html).toContain('&quot;');
      // Should NOT have an unescaped attribute boundary that allows injection
      // The rendered output should be: title="&quot; onclick=&quot;alert(1)"
      // which is safe — onclick is inside the title attribute value, not a real attribute
      expect(html).toMatch(/title="&quot; onclick=&quot;alert\(1\)"/);
    });
  });
});
