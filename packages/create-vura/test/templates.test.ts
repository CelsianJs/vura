import { describe, expect, it } from 'vitest';
import { getFiles } from '../src/index.js';

describe('create-vura templates', () => {
  it('pins generated dependencies instead of mixing latest ranges', () => {
    const files = getFiles('demo-app');
    const packageJson = JSON.parse(files['package.json']);

    expect(packageJson.dependencies).toEqual({
      'what-framework': '^0.8.1',
      '@celsian/vura-core': '0.2.0',
      '@celsian/vura-cli': '0.2.0',
    });
    expect(JSON.stringify(packageJson.dependencies)).not.toContain('latest');
  });

  it('does not claim the starter ships a CelsianJS integration', () => {
    const files = getFiles('demo-app');
    const starterText = Object.values(files).join('\n');

    expect(starterText).not.toContain('CelsianJS');
  });

  it('does not advertise unavailable deploy or dead public docs links', () => {
    const files = getFiles('demo-app');
    const packageJson = JSON.parse(files['package.json']);
    const starterText = Object.values(files).join('\n');

    expect(packageJson.scripts).not.toHaveProperty('deploy');
    expect(files).toHaveProperty('vura.config.js');
    expect(files).not.toHaveProperty('vura.config.ts');
    expect(starterText).not.toContain('thenjs.dev');
    expect(starterText).not.toContain('celsian.dev');
  });
});
