import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = resolve(__dirname, '../../..');
const createThenBin = join(repoRoot, 'packages/create-vura/dist/index.js');

describe('create-vura install failures', () => {
  it('exits non-zero when dependency installation fails without --no-install', () => {
    execFileSync(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', join(repoRoot, 'packages/create-vura')], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    expect(existsSync(createThenBin)).toBe(true);

    const root = mkdtempSync(join(tmpdir(), 'create-vura-install-fail-'));
    try {
      const res = spawnSync(process.execPath, [createThenBin, 'failing-app'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_config_user_agent: 'npm/10.0.0 node/v22.0.0',
          npm_config_registry: 'http://127.0.0.1:9/',
          npm_config_fetch_retries: '0',
          npm_config_fetch_timeout: '1000',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          NO_PROXY: '127.0.0.1',
        },
      });

      expect(res.status).not.toBe(0);
      expect(`${res.stdout}\n${res.stderr}`).toContain('installation must succeed unless --no-install is explicitly passed');
      expect(existsSync(join(root, 'failing-app', 'package.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
