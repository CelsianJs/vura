/**
 * Vura Logger — Structured logging with request tracing.
 *
 * Features:
 * - Log levels: debug, info, warn, error
 * - Request ID generation (crypto.randomUUID)
 * - JSON format in production, pretty-print in dev
 * - Request lifecycle logging (start/end with duration)
 * - Configurable via environment or programmatic config
 *
 * Environment variables:
 *   THEN_LOG_LEVEL — Minimum log level (debug | info | warn | error). Default: info
 *   THEN_LOG_FORMAT — Output format (json | pretty). Default: auto (json in production, pretty in dev)
 *   NODE_ENV — When "production", defaults to json format
 *
 * This module imports nothing. That is a requirement, not a coincidence: the
 * docs show `getLogger()` in `src/api/_hooks.ts` and in route handlers, and a
 * route handler is bundled per function by the Cloudflare and Lambda adapters.
 * Cloudflare bundles with esbuild's `platform: 'neutral'` and no Node externals,
 * where `import { randomUUID } from 'node:crypto'` does not resolve at all
 * ("Could not resolve node:crypto"), so the logger had to be kept out of the
 * adapter half of the runtime shim and `getLogger` was unusable in exactly the
 * files the docs put it in. It used node:crypto for one thing: a request id.
 * `crypto.randomUUID()` from Web Crypto does the same job and exists in every
 * runtime Vura supports, so the constraint is gone rather than documented.
 *
 * `process` gets the same treatment. A Worker has no `process` global unless
 * `nodejs_compat` is on, and this file reads three env vars and writes to
 * stdout, so an unguarded read is a TypeError the first time anything
 * constructs a Logger. Both accesses go through the helpers below.
 */

/** The `process` global, where the runtime has one. Workers do not. */
interface ProcessLike {
  env?: Record<string, string | undefined>;
  stdout?: { write?: (output: string) => void };
}

function nodeProcess(): ProcessLike | undefined {
  // Reading a missing property off globalThis is undefined; reading a missing
  // bare identifier is a ReferenceError. That is the whole reason for this.
  return (globalThis as { process?: ProcessLike }).process;
}

function env(name: string): string | undefined {
  return nodeProcess()?.env?.[name];
}

/** stdout where there is one, console where there is not. */
function defaultWrite(output: string): void {
  const write = nodeProcess()?.stdout?.write;
  if (write) {
    write.call(nodeProcess()!.stdout, output);
    return;
  }
  // Workers have no stdout; console.log is what reaches `wrangler tail`. Each
  // entry already ends in a newline and console.log adds its own.
  console.log(output.endsWith('\n') ? output.slice(0, -1) : output);
}

// ─── Types ───

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'pretty';

export interface LogEntry {
  level: LogLevel;
  msg: string;
  timestamp: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface LoggerConfig {
  /** Minimum log level (default: 'info') */
  level?: LogLevel;
  /** Output format — 'json' for structured, 'pretty' for human-readable (default: auto) */
  format?: LogFormat;
  /** Custom write function (default: process.stdout.write) */
  write?: (output: string) => void;
}

export interface RequestLogContext {
  requestId: string;
  method: string;
  path: string;
  startTime: number;
}

// ─── Constants ───

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m',  // cyan
  info: '\x1b[32m',   // green
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

// ─── Logger ───

export class Logger {
  private minLevel: number;
  private format: LogFormat;
  private writeFn: (output: string) => void;

  constructor(config: LoggerConfig = {}) {
    const envLevel = env('THEN_LOG_LEVEL') as LogLevel | undefined;
    const envFormat = env('THEN_LOG_FORMAT') as LogFormat | undefined;
    const isProduction = env('NODE_ENV') === 'production';

    const level = config.level ?? envLevel ?? 'info';
    this.minLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    this.format = config.format ?? envFormat ?? (isProduction ? 'json' : 'pretty');
    this.writeFn = config.write ?? defaultWrite;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('debug', msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log('info', msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('warn', msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log('error', msg, data);
  }

  /**
   * Generate a new request ID using Web Crypto's crypto.randomUUID().
   *
   * Web Crypto rather than node:crypto so this module resolves in a Worker
   * bundle; see the note at the top of the file.
   */
  generateRequestId(): string {
    return crypto.randomUUID();
  }

  /**
   * Start tracking a request. Returns context to pass to `requestEnd()`.
   */
  requestStart(method: string, path: string, requestId?: string): RequestLogContext {
    const ctx: RequestLogContext = {
      requestId: requestId ?? this.generateRequestId(),
      method,
      path,
      startTime: performance.now(),
    };

    this.info('request start', {
      requestId: ctx.requestId,
      method: ctx.method,
      path: ctx.path,
    });

    return ctx;
  }

  /**
   * Log request completion with status and duration.
   */
  requestEnd(ctx: RequestLogContext, statusCode: number): void {
    const duration = Math.round((performance.now() - ctx.startTime) * 100) / 100;

    const level: LogLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    this.log(level, 'request end', {
      requestId: ctx.requestId,
      method: ctx.method,
      path: ctx.path,
      status: statusCode,
      durationMs: duration,
    });
  }

  /**
   * Create a child logger that attaches a requestId to all log entries.
   */
  child(requestId: string): ChildLogger {
    return new ChildLogger(this, requestId);
  }

  // ─── Internal ───

  log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < this.minLevel) return;

    const entry: LogEntry = {
      level,
      msg,
      timestamp: new Date().toISOString(),
      ...data,
    };

    const output = this.format === 'json'
      ? this.formatJson(entry)
      : this.formatPretty(entry);

    this.writeFn(output);
  }

  private formatJson(entry: LogEntry): string {
    return JSON.stringify(entry) + '\n';
  }

  private formatPretty(entry: LogEntry): string {
    const color = LEVEL_COLORS[entry.level];
    const levelTag = `${color}${entry.level.toUpperCase().padEnd(5)}${RESET}`;
    const time = `${DIM}${entry.timestamp.slice(11, 23)}${RESET}`;

    const { level: _level, msg, timestamp: _ts, ...rest } = entry;
    const extra = Object.keys(rest).length > 0
      ? ` ${DIM}${JSON.stringify(rest)}${RESET}`
      : '';

    return `${time} ${levelTag} ${msg}${extra}\n`;
  }
}

// ─── Child Logger (scoped to a request) ───

export class ChildLogger {
  constructor(
    private parent: Logger,
    private requestId: string,
  ) {}

  debug(msg: string, data?: Record<string, unknown>): void {
    this.parent.log('debug', msg, { requestId: this.requestId, ...data });
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.parent.log('info', msg, { requestId: this.requestId, ...data });
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.parent.log('warn', msg, { requestId: this.requestId, ...data });
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.parent.log('error', msg, { requestId: this.requestId, ...data });
  }
}

// ─── Default Instance ───

let _defaultLogger: Logger | null = null;

/**
 * Get the default logger instance.
 * Created on first access with environment-based config.
 */
export function getLogger(): Logger {
  if (!_defaultLogger) {
    _defaultLogger = new Logger();
  }
  return _defaultLogger;
}

/**
 * Create a new Logger with custom config.
 */
export function createLogger(config?: LoggerConfig): Logger {
  return new Logger(config);
}

/**
 * Replace the default logger instance (useful for testing or custom setup).
 */
export function setDefaultLogger(logger: Logger): void {
  _defaultLogger = logger;
}
