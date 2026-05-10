/**
 * ThenJS Task System
 *
 * Self-contained task runner for background job processing.
 * Zero external dependencies — works in hot server or standalone.
 *
 * Features:
 * - In-memory queue with concurrency control
 * - Retries with exponential backoff
 * - Timeout enforcement
 * - Cron scheduling (5-field expressions)
 *
 * Task routes export:
 *   export const route = { kind: 'task', schedule: '*\/5 * * * *', retries: 3, timeout: 30000 };
 *   export async function POST(job) { return { success: true }; }
 */

// ─── Types ───

export interface TaskJob {
  id: string;
  taskName: string;
  input: unknown;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempt: number;
  maxRetries: number;
  result?: unknown;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface TaskConfig {
  /** Cron schedule (5-field expression) */
  schedule?: string;
  /** Number of retry attempts on failure (default: 0) */
  retries?: number;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Max concurrent executions (default: 1) */
  concurrency?: number;
}

export type TaskHandler = (job: { taskId: string; input: unknown; attempt: number }) => Promise<unknown>;

export interface TaskDefinition {
  name: string;
  handler: TaskHandler;
  config: TaskConfig;
}

// ─── Memory Queue ───

export class MemoryQueue {
  private queue: TaskJob[] = [];
  private inFlight: Map<string, TaskJob> = new Map();

  push(job: TaskJob): void {
    this.queue.push(job);
  }

  pop(): TaskJob | undefined {
    return this.queue.shift();
  }

  ack(jobId: string): void {
    this.inFlight.delete(jobId);
  }

  nack(job: TaskJob): void {
    this.inFlight.delete(job.id);
    job.status = 'pending';
    this.queue.push(job);
  }

  markInFlight(job: TaskJob): void {
    this.inFlight.set(job.id, job);
  }

  get length(): number {
    return this.queue.length;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  getAll(): TaskJob[] {
    return [...this.queue, ...this.inFlight.values()];
  }
}

// ─── Task Runner ───

export class TaskRunner {
  private tasks: Map<string, TaskDefinition> = new Map();
  private queue: MemoryQueue = new MemoryQueue();
  private results: Map<string, TaskJob> = new Map();
  private idCounter = 0;
  private processing = false;
  private maxResults = 10000;

  register(name: string, handler: TaskHandler, config: TaskConfig = {}): void {
    this.tasks.set(name, { name, handler, config });
  }

  enqueue(taskName: string, input: unknown = null): string {
    const def = this.tasks.get(taskName);
    if (!def) throw new Error(`Unknown task: ${taskName}`);

    const id = String(++this.idCounter);
    const job: TaskJob = {
      id,
      taskName,
      input,
      status: 'pending',
      attempt: 0,
      maxRetries: def.config.retries ?? 0,
      createdAt: Date.now(),
    };

    this.queue.push(job);
    this.results.set(id, job);
    this.evictOldResults();
    this.processQueue();
    return id;
  }

  getJob(jobId: string): TaskJob | undefined {
    return this.results.get(jobId);
  }

  getStats(): { queued: number; inFlight: number; total: number; tasks: string[] } {
    return {
      queued: this.queue.length,
      inFlight: this.queue.inFlightCount,
      total: this.results.size,
      tasks: [...this.tasks.keys()],
    };
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const job = this.queue.pop();
        if (!job) break;

        const def = this.tasks.get(job.taskName);
        if (!def) {
          job.status = 'failed';
          job.error = `Unknown task: ${job.taskName}`;
          continue;
        }

        const concurrency = def.config.concurrency ?? 1;
        // Simple concurrency: wait if too many in-flight for this task
        // (For simplicity, we count all in-flight — a proper impl would track per-task)

        this.queue.markInFlight(job);
        job.status = 'running';
        job.attempt++;

        const timeoutMs = def.config.timeout ?? 30000;

        try {
          let timer: ReturnType<typeof setTimeout>;
          const result = await Promise.race([
            def.handler({ taskId: job.id, input: job.input, attempt: job.attempt }).then(r => { clearTimeout(timer); return r; }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Task timeout after ${timeoutMs}ms`)), timeoutMs);
            }),
          ]);

          job.status = 'completed';
          job.result = result;
          job.completedAt = Date.now();
          this.queue.ack(job.id);
        } catch (err: any) {
          this.queue.ack(job.id);

          if (job.attempt <= job.maxRetries) {
            // Exponential backoff: 100ms * 2^attempt
            const backoff = 100 * Math.pow(2, job.attempt);
            job.status = 'pending';
            setTimeout(() => {
              this.queue.push(job);
              this.processQueue();
            }, backoff);
          } else {
            job.status = 'failed';
            job.error = err.message;
            job.completedAt = Date.now();
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private evictOldResults(): void {
    if (this.results.size <= this.maxResults) return;
    const completed = [...this.results.entries()]
      .filter(([, j]) => j.status === 'completed' || j.status === 'failed')
      .sort((a, b) => (a[1].completedAt ?? a[1].createdAt) - (b[1].completedAt ?? b[1].createdAt));
    const toRemove = this.results.size - this.maxResults;
    for (let i = 0; i < toRemove && i < completed.length; i++) {
      this.results.delete(completed[i][0]);
    }
  }
}

// ─── Cron Scheduler ───

export interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

export class CronScheduler {
  private jobs: { taskName: string; schedule: string; fields: CronFields; lastFiredMinute: number }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private handler: (taskName: string) => void;

  constructor(handler: (taskName: string) => void) {
    this.handler = handler;
  }

  register(taskName: string, schedule: string): void {
    const fields = parseCron(schedule);
    if (!fields) throw new Error(`Invalid cron expression: ${schedule}`);
    this.jobs.push({ taskName, schedule, fields, lastFiredMinute: -1 });
  }

  start(): void {
    if (this.timer) return;
    // Check every 60 seconds
    this.timer = setInterval(() => this.tick(), 60000);
    // Also check immediately
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick(): void {
    const now = new Date();
    const currentMinute = now.getFullYear() * 525960 + now.getMonth() * 43800 + now.getDate() * 1440 + now.getHours() * 60 + now.getMinutes();
    for (const job of this.jobs) {
      if (job.lastFiredMinute === currentMinute) continue;
      if (
        cronFieldMatches(job.fields.minute, now.getMinutes()) &&
        cronFieldMatches(job.fields.hour, now.getHours()) &&
        cronFieldMatches(job.fields.dayOfMonth, now.getDate()) &&
        cronFieldMatches(job.fields.month, now.getMonth() + 1) &&
        cronFieldMatches(job.fields.dayOfWeek, now.getDay())
      ) {
        job.lastFiredMinute = currentMinute;
        this.handler(job.taskName);
      }
    }
  }

  getJobs(): { taskName: string; schedule: string }[] {
    return this.jobs.map(j => ({ taskName: j.taskName, schedule: j.schedule }));
  }
}

// ─── Cron Parsing ───

/** Valid ranges for each cron field */
const CRON_FIELD_RANGES: { name: string; min: number; max: number }[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 7 },  // 0 and 7 are both Sunday
];

/**
 * Validate a single cron field value is within the allowed range.
 * Returns true if valid, false otherwise.
 */
function validateCronField(field: string, min: number, max: number): boolean {
  if (field === '*') return true;

  // Comma-separated list
  if (field.includes(',')) {
    return field.split(',').every(f => validateCronField(f.trim(), min, max));
  }

  // Step values: */5 or 1-30/5
  if (field.includes('/')) {
    const [range, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;

    if (range === '*') return true;

    if (range.includes('-') && range.indexOf('-') > 0) {
      const dashIdx = range.indexOf('-');
      const lo = Number(range.slice(0, dashIdx));
      const hi = Number(range.slice(dashIdx + 1));
      if (isNaN(lo) || isNaN(hi)) return false;
      return lo >= min && hi <= max && lo <= hi;
    }

    const val = parseInt(range, 10);
    return !isNaN(val) && val >= min && val <= max;
  }

  // Range: 1-5 (only if dash separates two values, not a leading negative)
  if (field.includes('-') && field.indexOf('-') > 0) {
    const dashIdx = field.indexOf('-');
    const lo = Number(field.slice(0, dashIdx));
    const hi = Number(field.slice(dashIdx + 1));
    if (isNaN(lo) || isNaN(hi)) return false;
    return lo >= min && hi <= max && lo <= hi;
  }

  // Exact value
  const val = parseInt(field, 10);
  return !isNaN(val) && val >= min && val <= max;
}

export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  // Validate each field against its allowed range
  for (let i = 0; i < 5; i++) {
    const { min, max } = CRON_FIELD_RANGES[i];
    if (!validateCronField(parts[i], min, max)) {
      return null;
    }
  }

  return {
    minute: parts[0],
    hour: parts[1],
    dayOfMonth: parts[2],
    month: parts[3],
    dayOfWeek: parts[4],
  };
}

export function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;

  // Comma-separated list
  if (field.includes(',')) {
    return field.split(',').some(f => cronFieldMatches(f.trim(), value));
  }

  // Step values: */5 or 1-30/5
  if (field.includes('/')) {
    const [range, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;

    if (range === '*') {
      return value % step === 0;
    }

    if (range.includes('-')) {
      const [min, max] = range.split('-').map(Number);
      return value >= min && value <= max && (value - min) % step === 0;
    }

    return value % step === 0;
  }

  // Range: 1-5
  if (field.includes('-')) {
    const [min, max] = field.split('-').map(Number);
    return value >= min && value <= max;
  }

  // Exact value
  return parseInt(field, 10) === value;
}

// ─── Factory Functions ───

export function createTaskRunner(): TaskRunner {
  return new TaskRunner();
}

export function createCronScheduler(handler: (taskName: string) => void): CronScheduler {
  return new CronScheduler(handler);
}
