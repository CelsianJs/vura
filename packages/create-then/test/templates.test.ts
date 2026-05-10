import { describe, expect, it } from 'vitest';
import { getFiles } from '../src/index.js';

describe('create-then templates', () => {
  it('pins generated dependencies instead of mixing latest ranges', () => {
    const files = getFiles('demo-app');
    const packageJson = JSON.parse(files['package.json']);

    expect(packageJson.dependencies).toEqual({
      'what-framework': '^0.8.1',
      '@then/core': '0.1.0',
      '@then/cli': '0.1.0',
    });
    expect(JSON.stringify(packageJson.dependencies)).not.toContain('latest');
  });

  it('does not claim the starter ships a CelsianJS integration', () => {
    const files = getFiles('demo-app');
    const starterText = Object.values(files).join('\n');

    expect(starterText).not.toContain('CelsianJS');
  });
});
