import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, ChildLogger, createLogger, getLogger, setDefaultLogger } from '../src/logger.js';

describe('Logger', () => {
  it('creates with default config', () => {
    const logger = createLogger();
    expect(logger).toBeInstanceOf(Logger);
  });

  it('logs in JSON format', () => {
    const output: string[] = [];
    const logger = createLogger({
      format: 'json',
      write: (s) => output.push(s),
    });

    logger.info('test message', { key: 'value' });

    expect(output).toHaveLength(1);
    const entry = JSON.parse(output[0]);
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('test message');
    expect(entry.key).toBe('value');
    expect(entry.timestamp).toBeDefined();
  });

  it('logs in pretty format', () => {
    const output: string[] = [];
    const logger = createLogger({
      format: 'pretty',
      write: (s) => output.push(s),
    });

    logger.warn('something happened');

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('WARN');
    expect(output[0]).toContain('something happened');
  });

  it('respects log level filtering', () => {
    const output: string[] = [];
    const logger = createLogger({
      level: 'warn',
      format: 'json',
      write: (s) => output.push(s),
    });

    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');

    expect(output).toHaveLength(2);
    expect(JSON.parse(output[0]).level).toBe('warn');
    expect(JSON.parse(output[1]).level).toBe('error');
  });

  it('generates request IDs', () => {
    const logger = createLogger();
    const id1 = logger.generateRequestId();
    const id2 = logger.generateRequestId();

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
    // UUID format: 8-4-4-4-12
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('tracks request start and end', () => {
    const output: string[] = [];
    const logger = createLogger({
      format: 'json',
      write: (s) => output.push(s),
    });

    const ctx = logger.requestStart('GET', '/api/test');
    expect(ctx.requestId).toBeDefined();
    expect(ctx.method).toBe('GET');
    expect(ctx.path).toBe('/api/test');

    logger.requestEnd(ctx, 200);

    expect(output).toHaveLength(2);
    const start = JSON.parse(output[0]);
    const end = JSON.parse(output[1]);
    expect(start.msg).toBe('request start');
    expect(start.requestId).toBe(ctx.requestId);
    expect(end.msg).toBe('request end');
    expect(end.status).toBe(200);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs errors at error level for 5xx responses', () => {
    const output: string[] = [];
    const logger = createLogger({
      format: 'json',
      write: (s) => output.push(s),
    });

    const ctx = logger.requestStart('POST', '/api/fail');
    logger.requestEnd(ctx, 500);

    const end = JSON.parse(output[1]);
    expect(end.level).toBe('error');
  });

  it('logs warnings for 4xx responses', () => {
    const output: string[] = [];
    const logger = createLogger({
      format: 'json',
      write: (s) => output.push(s),
    });

    const ctx = logger.requestStart('GET', '/not-found');
    logger.requestEnd(ctx, 404);

    const end = JSON.parse(output[1]);
    expect(end.level).toBe('warn');
  });
});

describe('ChildLogger', () => {
  it('attaches requestId to all log entries', () => {
    const output: string[] = [];
    const logger = createLogger({
      format: 'json',
      write: (s) => output.push(s),
    });

    const child = logger.child('req-123');
    child.info('child message', { extra: true });

    const entry = JSON.parse(output[0]);
    expect(entry.requestId).toBe('req-123');
    expect(entry.msg).toBe('child message');
    expect(entry.extra).toBe(true);
  });

  it('supports all log levels', () => {
    const output: string[] = [];
    const logger = createLogger({
      format: 'json',
      level: 'debug',
      write: (s) => output.push(s),
    });

    const child = logger.child('req-456');
    child.debug('d');
    child.info('i');
    child.warn('w');
    child.error('e');

    expect(output).toHaveLength(4);
    expect(output.every(o => JSON.parse(o).requestId === 'req-456')).toBe(true);
  });
});

describe('getLogger / setDefaultLogger', () => {
  it('returns a singleton', () => {
    const a = getLogger();
    const b = getLogger();
    expect(a).toBe(b);
  });

  it('can be replaced', () => {
    const custom = createLogger({ level: 'error' });
    setDefaultLogger(custom);
    expect(getLogger()).toBe(custom);
  });
});
