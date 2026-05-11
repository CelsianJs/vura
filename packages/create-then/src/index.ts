#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface CreateThenPackageMetadata {
  version?: string;
  thenScaffold?: {
    dependencies?: Record<string, string>;
    thenPackages?: string[];
  };
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function findPackageJson(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findWorkspacePackageVersion(packageName: string, createThenPackageJsonPath: string): string | null {
  const packagesDir = path.dirname(path.dirname(createThenPackageJsonPath));
  if (path.basename(packagesDir) !== 'packages') return null;

  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageJson = readJsonFile<{ name?: string; version?: string }>(path.join(packagesDir, entry.name, 'package.json'));
    if (packageJson?.name === packageName && packageJson.version) return packageJson.version;
  }

  return null;
}

function getScaffoldDependencyVersions(): Record<string, string> {
  const entryDir = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = findPackageJson(entryDir);
  if (!packageJsonPath) {
    throw new Error('Unable to locate create-then package metadata for scaffold dependency versions');
  }

  const packageJson = readJsonFile<CreateThenPackageMetadata>(packageJsonPath);
  const ownVersion = packageJson?.version;
  if (!packageJson || !ownVersion) {
    throw new Error(`${packageJsonPath} must define a version for scaffold dependency versions`);
  }

  const scaffoldDependencies = packageJson.thenScaffold?.dependencies ?? {};
  const whatFrameworkVersion = scaffoldDependencies['what-framework'];
  if (!whatFrameworkVersion) {
    throw new Error(`${packageJsonPath} must define thenScaffold.dependencies["what-framework"]`);
  }

  const thenPackages = packageJson.thenScaffold?.thenPackages ?? ['@then/core', '@then/cli'];
  const dependencies: Record<string, string> = { 'what-framework': whatFrameworkVersion };
  for (const packageName of thenPackages) {
    dependencies[packageName] = findWorkspacePackageVersion(packageName, packageJsonPath) ?? ownVersion;
  }

  return dependencies;
}

// ─── Colors ──────────────────────────────────────────────────────────
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

// ─── Argument Parsing ────────────────────────────────────────────────
interface Args {
  projectName: string | null;
  dryRun: boolean;
  noInstall: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let projectName: string | null = null;
  let dryRun = false;
  let noInstall = false;
  let help = false;

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-install') {
      noInstall = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (!arg.startsWith('-')) {
      projectName = arg;
    }
  }

  return { projectName, dryRun, noInstall, help };
}

// ─── Prompt ──────────────────────────────────────────────────────────
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Package Manager Detection ───────────────────────────────────────
function detectPackageManager(): 'pnpm' | 'yarn' | 'npm' {
  const userAgent = process.env.npm_config_user_agent ?? '';
  if (userAgent.startsWith('pnpm')) return 'pnpm';
  if (userAgent.startsWith('yarn')) return 'yarn';
  return 'npm';
}

// ─── File Templates ──────────────────────────────────────────────────
export function getFiles(projectName: string): Record<string, string> {
  return {
    'package.json': JSON.stringify(
      {
        name: projectName,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: {
          dev: 'vura dev',
          build: 'vura build',
        },
        dependencies: getScaffoldDependencyVersions(),
      },
      null,
      2
    ) + '\n',

    'then.config.js': `import { defineConfig } from '@then/core';

export default defineConfig({});
`,

    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          jsx: 'react-jsx',
          jsxImportSource: 'what-framework',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src'],
      },
      null,
      2
    ) + '\n',

    '.gitignore': `node_modules/
dist/
.then/
*.log
.DS_Store
`,

    'src/api/hello.ts': `import type { ThenRequest, ThenReply } from '@then/core';

export const route = { kind: 'serverless' };

export function GET(req: ThenRequest, reply: ThenReply) {
  return reply.json({ message: 'Hello from ThenJS!' });
}
`,

    'src/api/health.ts': `import type { ThenRequest, ThenReply } from '@then/core';

export const route = { kind: 'hot' };

export function GET(req: ThenRequest, reply: ThenReply) {
  return reply.json({ status: 'ok', uptime: process.uptime() });
}
`,

    'src/pages/index.tsx': `export const page = { mode: 'static', title: 'Home — ${projectName}' };

export default function HomePage() {
  return (
    <div class="home">
      <h1>Welcome to ThenJS</h1>
      <p>Built with What Framework + ThenJS API routes</p>
      <nav>
        <a href="/about">About</a>
        {' | '}
        <a href="/dashboard">Dashboard</a>
      </nav>
    </div>
  );
}
`,

    'src/pages/about.tsx': `export const page = { mode: 'static', title: 'About — ${projectName}' };

export default function AboutPage() {
  return (
    <div class="about">
      <h1>About</h1>
      <p>This project was scaffolded with <code>create-then</code>.</p>
      <p>
        ThenJS is a full-stack meta-framework combining{' '}
        <strong>What Framework</strong> for the UI with file-based API routes.
      </p>
      <nav>
        <a href="/">Home</a>
        {' | '}
        <a href="/dashboard">Dashboard</a>
      </nav>
    </div>
  );
}
`,

    'src/pages/dashboard.tsx': `import { useSignal } from 'what-framework';

export const page = { mode: 'client', title: 'Dashboard — ${projectName}' };

export default function DashboardPage() {
  const count = useSignal(0);

  return (
    <div class="dashboard">
      <h1>Dashboard</h1>
      <p>This page runs in client mode — fully interactive.</p>
      <div class="counter">
        <button onClick={() => count.set(count() - 1)}>-</button>
        <span>{() => count()}</span>
        <button onClick={() => count.set(count() + 1)}>+</button>
      </div>
      <nav>
        <a href="/">Home</a>
        {' | '}
        <a href="/about">About</a>
      </nav>
    </div>
  );
}
`,
  };
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`
${bold('create-then')} — Scaffold a new ThenJS project

${bold('Usage:')}
  npm create then@latest ${dim('[project-name]')}
  pnpm create then@latest ${dim('[project-name]')}
  npx create-then ${dim('[project-name]')}

${bold('Options:')}
  --dry-run      Print what would be created without writing files
  --no-install   Write files but skip dependency installation
  -h, --help     Show this help message
`);
    process.exit(0);
  }

  console.log();
  console.log(bold(cyan('  create-then')) + dim(' — scaffold a new ThenJS project'));
  console.log();

  // 1. Get project name
  let projectName = args.projectName;
  if (!projectName) {
    projectName = await prompt(cyan('  Project name: '));
    if (!projectName) {
      console.log(red('  Error: Project name is required.'));
      process.exit(1);
    }
  }

  // Sanitize: lowercase, replace spaces with hyphens
  projectName = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '');
  if (!projectName) {
    console.log(red('  Error: Invalid project name.'));
    process.exit(1);
  }

  const targetDir = path.resolve(process.cwd(), projectName);

  // 2. Check if directory exists
  if (fs.existsSync(targetDir) && !args.dryRun) {
    const contents = fs.readdirSync(targetDir);
    if (contents.length > 0) {
      console.log(red(`  Error: Directory "${projectName}" already exists and is not empty.`));
      process.exit(1);
    }
  }

  // 3. Generate files
  const files = getFiles(projectName);

  if (args.dryRun) {
    console.log(yellow('  --dry-run mode: no files will be created.\n'));
    console.log(bold(`  Would create project in: ${targetDir}\n`));
    console.log(bold('  Files:'));
    for (const filePath of Object.keys(files).sort()) {
      console.log(green(`    ${projectName}/${filePath}`));
    }
    console.log();
    console.log(dim(`  Total: ${Object.keys(files).length} files`));
    console.log();
    return;
  }

  console.log(dim(`  Creating project in ${targetDir}\n`));

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(targetDir, filePath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf-8');
    console.log(green('  +') + ` ${filePath}`);
  }

  // 4. Install dependencies
  const pm = detectPackageManager();
  console.log();

  if (args.noInstall) {
    console.log(yellow('  Skipping dependency install (--no-install). Run install manually after package scope access is available.\n'));
  } else {
    console.log(dim(`  Installing dependencies with ${pm}...\n`));

    try {
      execFileSync(pm, ['install'], {
        cwd: targetDir,
        stdio: 'inherit',
      });
    } catch {
      console.error(red('\n  Error: Failed to install dependencies. The scaffold was created, but installation must succeed unless --no-install is explicitly passed.'));
      console.error(dim('  Rerun with --no-install only for scaffolding-only inspection, or fix package registry/scope access and run install manually in the project.\n'));
      process.exit(1);
    }
  }

  // 5. Print next steps
  console.log();
  console.log(bold(green('  Done! ')) + `Your ThenJS project is ready.\n`);
  console.log(bold('  Next steps:\n'));
  console.log(`    cd ${projectName}`);
  console.log(`    ${pm === 'npm' ? 'npm run' : pm} dev\n`);
  console.log(dim('  Docs: https://github.com/zvndev/vura#readme'));
  console.log();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  });
}
