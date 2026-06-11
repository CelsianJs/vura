import { describe, it, expect, vi } from 'vitest';
import {
  MemoryQueue,
  TaskRunner,
  CronScheduler,
  parseCron,
  cronFieldMatches,
  createTaskRunner,
  createCronScheduler,
} from '../src/tasks.js';
import { generateServerEntry, generateTaskEntry } from '../src/build.js';
import type { RouteManifest, ApiRoute } from '../src/manifest.js';

// ─── MemoryQueue ───

describe('MemoryQueue', () => {
  it('push and pop in FIFO order', () => {
    const queue = new MemoryQueue();
    const job1 = { id: '1', taskName: 'test', input: null, status: 'pending' as const, attempt: 0, maxRetries: 0, createdAt: Date.now() };
    const job2 = { id: '2', taskName: 'test', input: null, status: 'pending' as const, attempt: 0, maxRetries: 0, createdAt: Date.now() };

    queue.push(job1);
    queue.push(job2);

    expect(queue.length).toBe(2);
    expect(queue.pop()).toBe(job1);
    expect(queue.pop()).toBe(job2);
    expect(queue.length).toBe(0);
  });

  it('tracks in-flight jobs', () => {
    const queue = new MemoryQueue();
    const job = { id: '1', taskName: 'test', input: null, status: 'pending' as const, attempt: 0, maxRetries: 0, createdAt: Date.now() };

    queue.push(job);
    const popped = queue.pop()!;
    queue.markInFlight(popped);

    expect(queue.inFlightCount).toBe(1);
    queue.ack('1');
    expect(queue.inFlightCount).toBe(0);
  });

  it('nack re-queues a job', () => {
    const queue = new MemoryQueue();
    const job = { id: '1', taskName: 'test', input: null, status: 'running' as const, attempt: 1, maxRetries: 3, createdAt: Date.now() };

    queue.markInFlight(job);
    expect(queue.inFlightCount).toBe(1);

    queue.nack(job);
    expect(queue.inFlightCount).toBe(0);
    expect(queue.length).toBe(1);
    expect(job.status).toBe('pending');
  });
});

// ─── TaskRunner ───

describe('TaskRunner', () => {
  it('registers and executes tasks', async () => {
    const runner = createTaskRunner();
    const handler = vi.fn().mockResolvedValue({ success: true });

    runner.register('my-task', handler);
    const jobId = runner.enqueue('my-task', { data: 'hello' });

    // Wait for async processing
    await new Promise(r => setTimeout(r, 50));

    const job = runner.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.status).toBe('completed');
    expect(job!.result).toEqual({ success: true });
    expect(handler).toHaveBeenCalledWith({
      taskId: jobId,
      input: { data: 'hello' },
      attempt: 1,
    });
  });

  it('retries on failure', async () => {
    const runner = createTaskRunner();
    let callCount = 0;
    const handler = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) throw new Error('fail');
      return { success: true };
    });

    runner.register('retry-task', handler, { retries: 3, timeout: 5000 });
    const jobId = runner.enqueue('retry-task');

    // Wait for retries (exponential backoff)
    await new Promise(r => setTimeout(r, 2000));

    const job = runner.getJob(jobId);
    expect(job!.status).toBe('completed');
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('fails after exhausting retries', async () => {
    const runner = createTaskRunner();
    const handler = vi.fn().mockRejectedValue(new Error('always fails'));

    runner.register('fail-task', handler, { retries: 1, timeout: 5000 });
    const jobId = runner.enqueue('fail-task');

    // Wait for retries
    await new Promise(r => setTimeout(r, 1000));

    const job = runner.getJob(jobId);
    expect(job!.status).toBe('failed');
    expect(job!.error).toBe('always fails');
  });

  it('enforces timeout', async () => {
    const runner = createTaskRunner();
    const handler = vi.fn().mockImplementation(
      () => new Promise(r => setTimeout(r, 5000))
    );

    runner.register('slow-task', handler, { timeout: 100 });
    const jobId = runner.enqueue('slow-task');

    await new Promise(r => setTimeout(r, 300));

    const job = runner.getJob(jobId);
    expect(job!.status).toBe('failed');
    expect(job!.error).toContain('timeout');
  });

  it('throws for unknown task', () => {
    const runner = createTaskRunner();
    expect(() => runner.enqueue('unknown')).toThrow('Unknown task: unknown');
  });

  it('reports stats', () => {
    const runner = createTaskRunner();
    runner.register('t1', async () => ({}));
    runner.register('t2', async () => ({}));

    const stats = runner.getStats();
    expect(stats.tasks).toEqual(['t1', 't2']);
  });
});

// ─── Cron Parsing ───

describe('parseCron', () => {
  it('parses 5-field cron expression', () => {
    const result = parseCron('*/5 * * * *');
    expect(result).toEqual({
      minute: '*/5',
      hour: '*',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '*',
    });
  });

  it('returns null for invalid expression', () => {
    expect(parseCron('not a cron')).toBeNull();
    expect(parseCron('1 2 3')).toBeNull();
  });

  it('rejects out-of-range minute (0-59)', () => {
    expect(parseCron('60 * * * *')).toBeNull();
    expect(parseCron('99 * * * *')).toBeNull();
    expect(parseCron('-1 * * * *')).toBeNull();
  });

  it('rejects out-of-range hour (0-23)', () => {
    expect(parseCron('0 24 * * *')).toBeNull();
    expect(parseCron('0 25 * * *')).toBeNull();
  });

  it('rejects out-of-range day of month (1-31)', () => {
    expect(parseCron('0 0 0 * *')).toBeNull();
    expect(parseCron('0 0 32 * *')).toBeNull();
  });

  it('rejects out-of-range month (1-12)', () => {
    expect(parseCron('0 0 1 0 *')).toBeNull();
    expect(parseCron('0 0 1 13 *')).toBeNull();
  });

  it('rejects out-of-range day of week (0-7)', () => {
    expect(parseCron('0 0 * * 8')).toBeNull();
  });

  it('accepts valid boundary values', () => {
    expect(parseCron('0 0 1 1 0')).not.toBeNull();
    expect(parseCron('59 23 31 12 7')).not.toBeNull();
  });

  it('validates values inside ranges', () => {
    expect(parseCron('0-60 * * * *')).toBeNull();   // 60 exceeds minute max
    expect(parseCron('0-59 * * * *')).not.toBeNull();
  });

  it('validates values inside comma lists', () => {
    expect(parseCron('0,30,99 * * * *')).toBeNull();  // 99 exceeds minute max
    expect(parseCron('0,30,59 * * * *')).not.toBeNull();
  });

  it('validates step ranges', () => {
    expect(parseCron('0-60/5 * * * *')).toBeNull();   // 60 exceeds max
    expect(parseCron('0-55/5 * * * *')).not.toBeNull();
  });

  it('rejects */0 (step of zero)', () => {
    expect(parseCron('*/0 * * * *')).toBeNull();
  });

  it('rejects multi-slash fields like 1/2/3', () => {
    expect(parseCron('1/2/3 * * * *')).toBeNull();
  });
});

describe('cronFieldMatches', () => {
  it('matches wildcard', () => {
    expect(cronFieldMatches('*', 0)).toBe(true);
    expect(cronFieldMatches('*', 59)).toBe(true);
  });

  it('matches exact value', () => {
    expect(cronFieldMatches('5', 5)).toBe(true);
    expect(cronFieldMatches('5', 6)).toBe(false);
  });

  it('matches range', () => {
    expect(cronFieldMatches('1-5', 3)).toBe(true);
    expect(cronFieldMatches('1-5', 6)).toBe(false);
    expect(cronFieldMatches('1-5', 1)).toBe(true);
    expect(cronFieldMatches('1-5', 5)).toBe(true);
  });

  it('matches step values', () => {
    expect(cronFieldMatches('*/5', 0)).toBe(true);
    expect(cronFieldMatches('*/5', 5)).toBe(true);
    expect(cronFieldMatches('*/5', 10)).toBe(true);
    expect(cronFieldMatches('*/5', 3)).toBe(false);
  });

  it('matches comma-separated list', () => {
    expect(cronFieldMatches('1,5,10', 5)).toBe(true);
    expect(cronFieldMatches('1,5,10', 3)).toBe(false);
  });

  it('matches range with step', () => {
    expect(cronFieldMatches('0-30/10', 0)).toBe(true);
    expect(cronFieldMatches('0-30/10', 10)).toBe(true);
    expect(cronFieldMatches('0-30/10', 20)).toBe(true);
    expect(cronFieldMatches('0-30/10', 5)).toBe(false);
    expect(cronFieldMatches('0-30/10', 40)).toBe(false);
  });
});

// ─── CronScheduler ───

describe('CronScheduler', () => {
  it('registers jobs and fires handler on match', () => {
    const fired: string[] = [];
    const scheduler = createCronScheduler((name) => fired.push(name));

    // Register a job that matches every minute
    scheduler.register('every-minute', '* * * * *');
    scheduler.tick();

    expect(fired).toContain('every-minute');
  });

  it('lists registered jobs', () => {
    const scheduler = createCronScheduler(() => {});
    scheduler.register('t1', '*/5 * * * *');
    scheduler.register('t2', '0 * * * *');

    const jobs = scheduler.getJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].taskName).toBe('t1');
    expect(jobs[0].schedule).toBe('*/5 * * * *');
  });

  it('throws for invalid cron expression', () => {
    const scheduler = createCronScheduler(() => {});
    expect(() => scheduler.register('bad', 'not valid')).toThrow('Invalid cron');
  });
});

// ─── Server Entry with Tasks ───

describe('server entry with task routes', () => {
  // Phase B (Task 5): the thin entry passes task routes as regular apiRoutes entries
  // to startVuraServer. Task admin endpoints (/__tasks) and cron scheduling are
  // deferred to Task 11 of the rebase plan.
  it('passes task routes to startVuraServer as apiRoutes with kind=task (thin entry)', () => {
    const manifest: RouteManifest = {
      api: [
        {
          filePath: 'src/api/hello.ts',
          urlPattern: '/api/hello',
          methods: ['GET'],
          kind: 'serverless',
          config: {},
        },
        {
          filePath: 'src/api/jobs/cleanup.ts',
          urlPattern: '/api/jobs/cleanup',
          methods: ['POST'],
          kind: 'task',
          config: { kind: 'task', schedule: '*/5 * * * *', retries: 3, timeout: 30000 },
        },
      ],
      pages: [],
      timestamp: new Date().toISOString(),
    };

    const entry = generateServerEntry(manifest, '/project');

    // Thin entry: task routes are wired into apiRoutes (silently skipped by
    // startVuraServer until Task 11 adds task admin support)
    expect(entry).toContain("import { startVuraServer } from '@celsian/vura-core'");
    expect(entry).toContain("apiRoutes: [");
    expect(entry).toContain("urlPattern: '/api/jobs/cleanup'");
    expect(entry).toContain("kind: 'task'");
    expect(entry).toContain("*/5 * * * *");
    // NOT inline task runner code — that lives in @celsian/vura-core (Task 11)
    expect(entry).not.toContain('enqueueTask');
    expect(entry).not.toContain('processQueue');
    expect(entry).not.toContain('registerCron');
  });

  it('skips task code when no task routes exist', () => {
    const manifest: RouteManifest = {
      api: [
        {
          filePath: 'src/api/hello.ts',
          urlPattern: '/api/hello',
          methods: ['GET'],
          kind: 'serverless',
          config: {},
        },
      ],
      pages: [],
      timestamp: new Date().toISOString(),
    };

    const entry = generateServerEntry(manifest, '/project');

    expect(entry).not.toContain('taskRoutes');
    expect(entry).not.toContain('enqueueTask');
  });
});

// ─── Task Entry Generator ───

describe('generateTaskEntry', () => {
  it('generates a self-contained task handler', () => {
    const route: ApiRoute = {
      filePath: 'src/api/jobs/cleanup.ts',
      urlPattern: '/api/jobs/cleanup',
      methods: ['POST'],
      kind: 'task',
      config: { kind: 'task', timeout: 15000 },
    };

    const entry = generateTaskEntry(route, '/project');

    expect(entry).toContain('export default');
    expect(entry).toContain('async fetch(request)');
    expect(entry).toContain('TIMEOUT_MS = 15000');
    expect(entry).toContain('Promise.race');
    expect(entry).toContain('taskId');
    expect(entry).toContain('attempt');
  });
});
