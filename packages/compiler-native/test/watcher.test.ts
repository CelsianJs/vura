/**
 * The napi 3 migration rewrote the watcher's threadsafe-function plumbing
 * (ErrorStrategy::Fatal became the `false` callee-handled generic), and the
 * scanner tests never touch it. A green scanner suite says nothing about
 * whether the callback still reaches JavaScript, so this exercises the real
 * OS watcher end to end.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { watchDirectory } = require('../index.js');

const dirs: string[] = [];
const handles: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try {
      handle.stop();
    } catch {
      // A handle stopped by the test itself throws nothing, but a failed test
      // may leave one in an unknown state; cleanup must not mask the failure.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vura-watch-'));
  dirs.push(dir);
  return dir;
}

/** Resolves on the first event, or rejects once the OS has clearly had enough time. */
function nextEvent(dir: string, timeoutMs = 5000): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no watcher event within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const handle = watchDirectory(dir, (eventType: string, path: string) => {
      clearTimeout(timer);
      resolve([eventType, path]);
    });
    handles.push(handle);
  });
}

describe('watchDirectory', () => {
  it('delivers a change event to the JavaScript callback', async () => {
    const dir = freshDir();
    const pending = nextEvent(dir);

    // The watcher registers asynchronously; a write issued in the same tick is
    // routinely missed on macOS.
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(dir, 'page.tsx'), 'export default () => null;\n');

    const [eventType, path] = await pending;
    expect(typeof eventType).toBe('string');
    expect(eventType.length).toBeGreaterThan(0);
    expect(path).toContain('page.tsx');
  });

  it('stops delivering events after stop()', async () => {
    const dir = freshDir();
    const seen: string[] = [];
    const handle = watchDirectory(dir, (_e: string, path: string) => {
      seen.push(path);
    });

    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(dir, 'before.tsx'), 'a\n');
    await new Promise((r) => setTimeout(r, 800));
    expect(seen.length).toBeGreaterThan(0);

    handle.stop();
    const countAtStop = seen.length;

    writeFileSync(join(dir, 'after.tsx'), 'b\n');
    await new Promise((r) => setTimeout(r, 800));
    expect(seen.length).toBe(countAtStop);
  });
});
