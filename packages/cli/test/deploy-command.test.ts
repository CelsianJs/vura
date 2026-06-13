import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the platform adapter so the command's deploy call is observable without
// touching the network. The factory is hoisted by vitest, so the spy lives on
// the module mock and we read it back through a dynamic import in each test.
vi.mock('@celsian/vura-adapter-vura', () => ({
  deployToVura: vi.fn(async () => ({ deploymentId: 'dep_xyz', url: 'app.vura.io', status: 'ready' })),
}));

import { deployCommand } from '../src/commands/deploy.js';
import { deployToVura } from '@celsian/vura-adapter-vura';

const tempRoots = new Set<string>();

function withSilencedConsole(): () => void {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  return () => {
    console.log = log;
    console.error = error;
  };
}

describe('CLI deploy command', () => {
  let root: string;
  let cwd: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // realpathSync resolves the macOS /var → /private/var symlink so the path
    // matches process.cwd() after chdir.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'vura-cli-deploy-')));
    tempRoots.add(root);
    cwd = process.cwd();
    process.chdir(root);
    process.exitCode = undefined;
    delete process.env.VURA_TOKEN;
    delete process.env.VURA_API_URL;
    delete process.env.VURA_PROJECT_ID;
    vi.mocked(deployToVura).mockClear();
  });

  afterEach(() => {
    process.chdir(cwd);
    process.env = { ...savedEnv };
    process.exitCode = undefined;
    for (const r of tempRoots) {
      rmSync(r, { recursive: true, force: true });
      tempRoots.delete(r);
    }
  });

  function writeProjectLink(projectId: string): void {
    mkdirSync(join(root, '.vura'), { recursive: true });
    writeFileSync(join(root, '.vura', 'project.json'), JSON.stringify({ projectId, teamId: 't', teamSlug: 's' }));
  }

  function writeBuiltDist(): void {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'manifest.json'), JSON.stringify({ pages: [], api: [] }));
  }

  it('errors and instructs `vura build` when dist/manifest.json is missing', async () => {
    process.env.VURA_TOKEN = 'tok_abc';
    writeProjectLink('proj_1');

    const restore = withSilencedConsole();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await deployCommand([]);
    } finally {
      restore();
    }

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(deployToVura)).not.toHaveBeenCalled();
    const messages = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/vura build/);
  });

  it('resolves the token from VURA_TOKEN and deploys to production with --prod', async () => {
    process.env.VURA_TOKEN = 'tok_abc';
    process.env.VURA_API_URL = 'https://api.test';
    writeProjectLink('proj_42');
    writeBuiltDist();

    const restore = withSilencedConsole();
    try {
      await deployCommand(['--prod']);
    } finally {
      restore();
    }

    expect(process.exitCode).toBeFalsy();
    expect(vi.mocked(deployToVura)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(deployToVura).mock.calls[0][0];
    expect(call).toMatchObject({
      token: 'tok_abc',
      apiUrl: 'https://api.test',
      projectId: 'proj_42',
      production: true,
      distDir: join(root, 'dist'),
    });
  });

  it('reads the token from ~/.vura/credentials when VURA_TOKEN is unset', async () => {
    // Point HOME at a temp dir holding a credentials file.
    const fakeHome = mkdtempSync(join(tmpdir(), 'vura-home-'));
    tempRoots.add(fakeHome);
    mkdirSync(join(fakeHome, '.vura'), { recursive: true });
    writeFileSync(join(fakeHome, '.vura', 'credentials'), JSON.stringify({ token: 'tok_from_file', email: 'k@z.com' }));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    writeProjectLink('proj_7');
    writeBuiltDist();

    const restore = withSilencedConsole();
    try {
      await deployCommand([]);
    } finally {
      restore();
    }

    expect(vi.mocked(deployToVura)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(deployToVura).mock.calls[0][0];
    expect(call.token).toBe('tok_from_file');
    expect(call.production).toBeFalsy();
  });
});
