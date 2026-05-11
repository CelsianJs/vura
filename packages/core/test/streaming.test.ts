import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { writeFileSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  streamResponse,
  createSSEChannel,
  streamFile,
  getMimeType,
  parseRangeHeader,
} from '../src/streaming.js';
import type { StreamableResponse, StreamableRequest } from '../src/streaming.js';

// ─── Test Helpers ───

function createMockResponse(): StreamableResponse & {
  _status: number;
  _headers: Record<string, string | number>;
  _chunks: string[];
  _ended: boolean;
  _closeCallbacks: Array<() => void>;
  _triggerClose: () => void;
} {
  let ended = false;
  let headersSent = false;
  const closeCallbacks: Array<() => void> = [];

  const res = {
    _status: 0,
    _headers: {} as Record<string, string | number>,
    _chunks: [] as string[],
    _ended: false,
    _closeCallbacks: closeCallbacks,

    writeHead(statusCode: number, headers?: Record<string, string | number>) {
      res._status = statusCode;
      if (headers) Object.assign(res._headers, headers);
      headersSent = true;
    },

    write(chunk: string | Buffer): boolean {
      res._chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    },

    end(data?: string | Buffer) {
      if (data) res._chunks.push(typeof data === 'string' ? data : data.toString());
      ended = true;
      res._ended = true;
    },

    on(event: string, fn: (...args: unknown[]) => void) {
      if (event === 'close') closeCallbacks.push(fn as () => void);
    },

    get writableEnded() { return ended; },
    get headersSent() { return headersSent; },

    _triggerClose() {
      for (const cb of closeCallbacks) cb();
    },
  };

  return res;
}

function createMockRequest(headers: Record<string, string> = {}): StreamableRequest {
  return { headers };
}

// ─── Temp File Helpers ───

const TEST_DIR = join(tmpdir(), 'thenjs-streaming-test-' + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

function createTempFile(name: string, content: string): string {
  const filePath = join(TEST_DIR, name);
  writeFileSync(filePath, content);
  return filePath;
}

// ─── Tests ───

describe('getMimeType', () => {
  it('detects common web types', () => {
    expect(getMimeType('file.html')).toBe('text/html');
    expect(getMimeType('file.css')).toBe('text/css');
    expect(getMimeType('file.js')).toBe('application/javascript');
    expect(getMimeType('file.json')).toBe('application/json');
  });

  it('detects image types', () => {
    expect(getMimeType('photo.png')).toBe('image/png');
    expect(getMimeType('photo.jpg')).toBe('image/jpeg');
    expect(getMimeType('photo.webp')).toBe('image/webp');
    expect(getMimeType('icon.svg')).toBe('image/svg+xml');
  });

  it('detects media types', () => {
    expect(getMimeType('video.mp4')).toBe('video/mp4');
    expect(getMimeType('audio.mp3')).toBe('audio/mpeg');
  });

  it('detects font types', () => {
    expect(getMimeType('font.woff2')).toBe('font/woff2');
    expect(getMimeType('font.ttf')).toBe('font/ttf');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(getMimeType('file.xyz')).toBe('application/octet-stream');
    expect(getMimeType('file.bin')).toBe('application/octet-stream');
  });

  it('is case-insensitive', () => {
    expect(getMimeType('FILE.HTML')).toBe('text/html');
    expect(getMimeType('IMAGE.PNG')).toBe('image/png');
  });
});

describe('parseRangeHeader', () => {
  const fileSize = 1000;

  it('parses explicit range', () => {
    const range = parseRangeHeader('bytes=0-499', fileSize);
    expect(range).toEqual({ start: 0, end: 499 });
  });

  it('parses open-ended range', () => {
    const range = parseRangeHeader('bytes=500-', fileSize);
    expect(range).toEqual({ start: 500, end: 999 });
  });

  it('parses suffix range', () => {
    const range = parseRangeHeader('bytes=-200', fileSize);
    expect(range).toEqual({ start: 800, end: 999 });
  });

  it('clamps end to file size', () => {
    const range = parseRangeHeader('bytes=0-5000', fileSize);
    expect(range).toEqual({ start: 0, end: 999 });
  });

  it('returns null for invalid range format', () => {
    expect(parseRangeHeader('invalid', fileSize)).toBeNull();
    expect(parseRangeHeader('bytes=abc-def', fileSize)).toBeNull();
  });

  it('returns null when start > end', () => {
    expect(parseRangeHeader('bytes=500-100', fileSize)).toBeNull();
  });

  it('returns null when start >= fileSize', () => {
    expect(parseRangeHeader('bytes=1000-', fileSize)).toBeNull();
    expect(parseRangeHeader('bytes=2000-', fileSize)).toBeNull();
  });

  it('returns null for empty suffix', () => {
    expect(parseRangeHeader('bytes=-0', fileSize)).toBeNull();
  });
});

describe('streamResponse', () => {
  it('pipes a readable to the response', async () => {
    const res = createMockResponse();
    const readable = Readable.from(['hello', ' ', 'world']);

    await streamResponse(res, readable, {
      headers: { 'content-type': 'text/plain' },
    });

    expect(res._status).toBe(200);
    expect(res._chunks.join('')).toBe('hello world');
    expect(res._ended).toBe(true);
  });

  it('uses custom status code', async () => {
    const res = createMockResponse();
    const readable = Readable.from(['data']);

    await streamResponse(res, readable, { statusCode: 206 });

    expect(res._status).toBe(206);
  });

  it('destroys stream on client disconnect', async () => {
    const res = createMockResponse();
    const readable = new Readable({
      read() {
        // Simulate slow stream — don't push anything
      },
    });

    // Start streaming in background
    const streamPromise = streamResponse(res, readable);

    // Simulate client disconnect — this triggers the 'close' handler
    // which destroys the readable, which triggers an error event
    res._triggerClose();

    // The stream should be destroyed
    expect(readable.destroyed).toBe(true);

    // The destroyed readable will emit an error event that
    // resolves or rejects the promise. Wait for it.
    await streamPromise.catch(() => {});
  }, 2000);
});

describe('createSSEChannel', () => {
  it('sets proper SSE headers', () => {
    const res = createMockResponse();
    createSSEChannel(res, { keepalive: 0 });

    expect(res._status).toBe(200);
    expect(res._headers['content-type']).toBe('text/event-stream');
    expect(res._headers['cache-control']).toBe('no-cache');
    expect(res._headers['connection']).toBe('keep-alive');
  });

  it('sends named events', () => {
    const res = createMockResponse();
    const channel = createSSEChannel(res, { keepalive: 0 });

    channel.send('message', { text: 'Hello' });

    expect(res._chunks.length).toBe(1);
    expect(res._chunks[0]).toContain('event: message\n');
    expect(res._chunks[0]).toContain('data: {"text":"Hello"}\n');
  });

  it('sends events with IDs', () => {
    const res = createMockResponse();
    const channel = createSSEChannel(res, { keepalive: 0 });

    channel.send('update', { count: 1 }, 'evt-42');

    expect(res._chunks[0]).toContain('id: evt-42\n');
  });

  it('sends data-only messages', () => {
    const res = createMockResponse();
    const channel = createSSEChannel(res, { keepalive: 0 });

    channel.sendData('plain text');

    expect(res._chunks[0]).toBe('data: plain text\n\n');
    expect(res._chunks[0]).not.toContain('event:');
  });

  it('sends data-only messages with IDs', () => {
    const res = createMockResponse();
    const channel = createSSEChannel(res, { keepalive: 0 });

    channel.sendData({ key: 'value' }, 'data-1');

    expect(res._chunks[0]).toContain('id: data-1\n');
    expect(res._chunks[0]).toContain('data: {"key":"value"}\n');
  });

  it('sends comments', () => {
    const res = createMockResponse();
    const channel = createSSEChannel(res, { keepalive: 0 });

    channel.comment('keepalive check');

    expect(res._chunks[0]).toBe(': keepalive check\n\n');
  });

  it('sends retry directive', () => {
    const res = createMockResponse();
    const channel = createSSEChannel(res, { keepalive: 0 });

    channel.retry(5000);

    expect(res._chunks[0]).toBe('retry: 5000\n\n');
  });

  it('reports isOpen correctly', () => {
    const res = createMockResponse();
    const channel = createSSEChannel(res, { keepalive: 0 });

    expect(channel.isOpen).toBe(true);

    channel.close();
    expect(channel.isOpen).toBe(false);
  });

  it('calls onClose callbacks when client disconnects', () => {
    const res = createMockResponse();
    const channel = createSSEChannel(res, { keepalive: 0 });

    const callback = vi.fn();
    channel.onClose(callback);

    res._triggerClose();

    expect(callback).toHaveBeenCalledOnce();
    expect(channel.isOpen).toBe(false);
  });

  it('silently drops sends after close', () => {
    const res = createMockResponse();
    const channel = createSSEChannel(res, { keepalive: 0 });

    channel.close();
    channel.send('late', { data: true });

    // Only the end call, no extra data
    expect(res._chunks.length).toBe(0);
  });

  it('serializes objects as JSON', () => {
    const res = createMockResponse();
    const channel = createSSEChannel(res, { keepalive: 0 });

    channel.send('data', { nested: { a: 1 } });

    expect(res._chunks[0]).toContain('data: {"nested":{"a":1}}');
  });

  it('passes strings directly without JSON encoding', () => {
    const res = createMockResponse();
    const channel = createSSEChannel(res, { keepalive: 0 });

    channel.send('msg', 'plain text message');

    expect(res._chunks[0]).toContain('data: plain text message\n');
  });

  it('accepts custom headers', () => {
    const res = createMockResponse();
    createSSEChannel(res, {
      keepalive: 0,
      headers: { 'x-custom': 'value' },
    });

    expect(res._headers['x-custom']).toBe('value');
  });
});

describe('streamFile', () => {
  it('streams a file with auto-detected content type', async () => {
    const filePath = createTempFile('test.json', '{"hello":"world"}');
    const req = createMockRequest();
    const res = createMockResponse();

    await streamFile(req, res, filePath);

    expect(res._status).toBe(200);
    expect(res._headers['content-type']).toBe('application/json');
    expect(res._chunks.join('')).toContain('"hello"');
  });

  it('uses custom content type', async () => {
    const filePath = createTempFile('data.bin', 'binary data');
    const req = createMockRequest();
    const res = createMockResponse();

    await streamFile(req, res, filePath, { contentType: 'text/plain' });

    expect(res._headers['content-type']).toBe('text/plain');
  });

  it('returns 404 for missing files', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    await streamFile(req, res, join(TEST_DIR, 'nonexistent.txt'));

    expect(res._status).toBe(404);
  });

  it('sets Content-Length header', async () => {
    const content = 'Hello, World!';
    const filePath = createTempFile('hello.txt', content);
    const req = createMockRequest();
    const res = createMockResponse();

    await streamFile(req, res, filePath);

    expect(res._headers['content-length']).toBe(content.length);
  });

  it('handles range requests', async () => {
    const content = 'ABCDEFGHIJ'; // 10 bytes
    const filePath = createTempFile('range.txt', content);
    const req = createMockRequest({ range: 'bytes=0-4' });
    const res = createMockResponse();

    await streamFile(req, res, filePath);

    expect(res._status).toBe(206);
    expect(res._headers['content-range']).toBe('bytes 0-4/10');
    expect(res._headers['content-length']).toBe(5);
    expect(res._chunks.join('')).toBe('ABCDE');
  });

  it('handles open-ended range requests', async () => {
    const content = 'ABCDEFGHIJ';
    const filePath = createTempFile('range2.txt', content);
    const req = createMockRequest({ range: 'bytes=5-' });
    const res = createMockResponse();

    await streamFile(req, res, filePath);

    expect(res._status).toBe(206);
    expect(res._chunks.join('')).toBe('FGHIJ');
  });

  it('returns 416 for invalid range', async () => {
    const content = 'ABCDEFGHIJ';
    const filePath = createTempFile('range-bad.txt', content);
    const req = createMockRequest({ range: 'bytes=20-30' });
    const res = createMockResponse();

    await streamFile(req, res, filePath);

    expect(res._status).toBe(416);
  });

  it('sets Accept-Ranges header', async () => {
    const filePath = createTempFile('ranges.txt', 'content');
    const req = createMockRequest();
    const res = createMockResponse();

    await streamFile(req, res, filePath);

    expect(res._headers['accept-ranges']).toBe('bytes');
  });

  it('disables range requests when ranges: false', async () => {
    const filePath = createTempFile('no-range.txt', 'content');
    const req = createMockRequest({ range: 'bytes=0-2' });
    const res = createMockResponse();

    await streamFile(req, res, filePath, { ranges: false });

    expect(res._status).toBe(200); // full response, not 206
    expect(res._headers['accept-ranges']).toBe('none');
  });

  it('sets Cache-Control header', async () => {
    const filePath = createTempFile('cached.txt', 'cache me');
    const req = createMockRequest();
    const res = createMockResponse();

    await streamFile(req, res, filePath, { cacheControl: 'public, max-age=3600' });

    expect(res._headers['cache-control']).toBe('public, max-age=3600');
  });

  it('sets Content-Disposition for downloads', async () => {
    const filePath = createTempFile('report.csv', 'a,b,c');
    const req = createMockRequest();
    const res = createMockResponse();

    await streamFile(req, res, filePath, { download: 'report-2024.csv' });

    expect(res._headers['content-disposition']).toBe('attachment; filename="report-2024.csv"');
  });

  it('sets custom headers', async () => {
    const filePath = createTempFile('custom.txt', 'data');
    const req = createMockRequest();
    const res = createMockResponse();

    await streamFile(req, res, filePath, {
      headers: { 'x-file-version': '2' },
    });

    expect(res._headers['x-file-version']).toBe('2');
  });

  describe('path traversal protection', () => {
    it('blocks path traversal when root is set', async () => {
      // Create a file outside the root
      const outsideFile = createTempFile('secret.txt', 'top-secret-data');
      const subDir = join(TEST_DIR, 'public');
      mkdirSync(subDir, { recursive: true });
      const safeFile = join(subDir, 'safe.txt');
      writeFileSync(safeFile, 'safe content');

      const req = createMockRequest();
      const res = createMockResponse();

      // Try to escape the root using ../
      await streamFile(req, res, join(subDir, '../secret.txt'), { root: subDir });

      expect(res._status).toBe(403);
    });

    it('allows files within root', async () => {
      const subDir = join(TEST_DIR, 'public');
      mkdirSync(subDir, { recursive: true });
      const safeFile = join(subDir, 'ok.txt');
      writeFileSync(safeFile, 'allowed content');

      const req = createMockRequest();
      const res = createMockResponse();

      await streamFile(req, res, safeFile, { root: subDir });

      expect(res._status).toBe(200);
      expect(res._chunks.join('')).toContain('allowed content');
    });

    it('returns 404 for missing files when root is set', async () => {
      const subDir = join(TEST_DIR, 'public');
      mkdirSync(subDir, { recursive: true });

      const req = createMockRequest();
      const res = createMockResponse();

      await streamFile(req, res, join(subDir, 'nonexistent.txt'), { root: subDir });

      expect(res._status).toBe(404);
    });
  });

  describe('filename sanitization', () => {
    it('sanitizes quotes in download filename', async () => {
      const filePath = createTempFile('report.csv', 'data');
      const req = createMockRequest();
      const res = createMockResponse();

      await streamFile(req, res, filePath, { download: 'file"name.csv' });

      expect(res._headers['content-disposition']).toBe('attachment; filename="file_name.csv"');
    });

    it('sanitizes newlines in download filename', async () => {
      const filePath = createTempFile('report.csv', 'data');
      const req = createMockRequest();
      const res = createMockResponse();

      await streamFile(req, res, filePath, { download: 'file\r\nname.csv' });

      expect(res._headers['content-disposition']).toBe('attachment; filename="file__name.csv"');
    });

    it('sanitizes backslashes in download filename', async () => {
      const filePath = createTempFile('report.csv', 'data');
      const req = createMockRequest();
      const res = createMockResponse();

      await streamFile(req, res, filePath, { download: 'file\\name.csv' });

      expect(res._headers['content-disposition']).toBe('attachment; filename="file_name.csv"');
    });
  });
});
