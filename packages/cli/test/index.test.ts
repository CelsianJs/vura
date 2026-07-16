import { afterEach, describe, expect, it, vi } from 'vitest';

const { deployCommand } = vi.hoisted(() => ({ deployCommand: vi.fn(async () => undefined) }));

vi.mock('../src/commands/deploy.js', () => ({ deployCommand }));

import { run } from '../src/index.js';

afterEach(() => {
  deployCommand.mockClear();
  vi.restoreAllMocks();
});

describe('CLI help routing', () => {
  it('prints help without executing a subcommand', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(['deploy', '--help']);

    expect(deployCommand).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('vura deploy [--prod]');
  });
});
