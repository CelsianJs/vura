/**
 * Vura Streaming Response Helpers
 *
 * Utilities for common streaming patterns:
 *   - reply.stream(readableStream)  — pipe a readable stream to response
 *   - reply.sse(channel)           — Server-Sent Events with proper headers
 *   - reply.file(path, options)    — stream a file with range request support
 *
 * All helpers handle proper cleanup on client disconnect.
 */

import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, normalize } from 'node:path';
import { Readable } from 'node:stream';

// Re-exported rather than defined here so that the two helpers which need no
// filesystem can be bundled for Cloudflare and Lambda while this module, which
// does, stays out of those bundles. ./streaming-headers.ts says why the split
// falls where it does.
export { getMimeType, parseRangeHeader } from './streaming-headers.js';
import { getMimeType, parseRangeHeader } from './streaming-headers.js';

// ─── Types ───

/**
 * Options for streaming a file response.
 */
export interface FileStreamOptions {
  /** MIME content type (auto-detected from extension if omitted) */
  contentType?: string;
  /** Enable range request support (default: true) */
  ranges?: boolean;
  /** Cache-Control header value */
  cacheControl?: string;
  /** Custom headers to set */
  headers?: Record<string, string>;
  /** Download filename (triggers Content-Disposition: attachment) */
  download?: string;
  /**
   * Root directory for path traversal protection.
   * When set, the resolved filePath must be within this directory.
   * Strongly recommended when serving user-requested files.
   */
  root?: string;
}

/**
 * An SSE channel for sending Server-Sent Events.
 */
export interface SSEChannel {
  /** Send a named event with data */
  send(event: string, data: unknown, id?: string): void;
  /** Send a data-only message (no event name) */
  sendData(data: unknown, id?: string): void;
  /** Send a comment (for keepalive) */
  comment(text: string): void;
  /** Set the retry interval for the client */
  retry(ms: number): void;
  /** Close the SSE connection */
  close(): void;
  /** Whether the connection is still open */
  readonly isOpen: boolean;
  /** Register a callback for when the client disconnects */
  onClose(fn: () => void): void;
}

/**
 * A minimal ServerResponse interface — matches Node's http.ServerResponse
 * without importing the full http module as a type dependency.
 */
export interface StreamableResponse {
  writeHead(statusCode: number, headers?: Record<string, string | number>): void;
  write(chunk: string | Buffer): boolean;
  end(data?: string | Buffer): void;
  on(event: string, fn: (...args: unknown[]) => void): void;
  readonly writableEnded: boolean;
  readonly headersSent: boolean;
}

/**
 * A minimal IncomingMessage interface for range header parsing.
 */
export interface StreamableRequest {
  headers: Record<string, string | string[] | undefined>;
}

// ─── Stream Helper ───

/**
 * Pipe a Readable stream to the response with proper cleanup.
 *
 * @example
 * ```ts
 * const stream = fs.createReadStream('data.csv');
 * await streamResponse(res, stream, {
 *   statusCode: 200,
 *   headers: { 'content-type': 'text/csv' },
 * });
 * ```
 */
export async function streamResponse(
  res: StreamableResponse,
  readable: Readable,
  options: {
    statusCode?: number;
    headers?: Record<string, string | number>;
  } = {},
): Promise<void> {
  const statusCode = options.statusCode ?? 200;
  const headers = options.headers ?? {};

  if (!res.headersSent) {
    res.writeHead(statusCode, headers);
  }

  // Handle client disconnect — destroy the source stream
  res.on('close', () => {
    if (!readable.destroyed) {
      readable.destroy();
    }
  });

  return new Promise<void>((resolve, reject) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      if (!res.writableEnded) {
        res.end();
      }
      resolve();
    };

    readable.on('data', (chunk: Buffer | string) => {
      if (!res.writableEnded) {
        const canContinue = res.write(chunk);
        // Handle backpressure: pause the source until the destination drains
        if (!canContinue) {
          readable.pause();
          res.on('drain', () => {
            if (!readable.destroyed) {
              readable.resume();
            }
          });
        }
      }
    });

    readable.on('end', done);

    readable.on('close', () => {
      // Stream was destroyed (e.g. client disconnect)
      done();
    });

    readable.on('error', (err: Error & { code?: string }) => {
      if (resolved) return;
      // ERR_STREAM_PREMATURE_CLOSE is expected on client disconnect
      if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        done();
      } else {
        resolved = true;
        if (!res.writableEnded) {
          res.end();
        }
        reject(err);
      }
    });
  });
}

// ─── SSE Helper ───

/**
 * Create a Server-Sent Events channel.
 *
 * Sets proper headers and returns a channel object for sending events.
 * Handles keepalive and cleanup on client disconnect.
 *
 * @example
 * ```ts
 * const channel = createSSEChannel(res);
 * channel.send('message', { text: 'Hello!' });
 * channel.send('update', { count: 42 }, 'evt-1');
 *
 * // When done:
 * channel.close();
 * ```
 */
export function createSSEChannel(
  res: StreamableResponse,
  options: {
    /** Keepalive interval in ms (default: 30000, 0 to disable) */
    keepalive?: number;
    /** Custom headers */
    headers?: Record<string, string>;
  } = {},
): SSEChannel {
  const keepaliveMs = options.keepalive ?? 30000;
  const closeCallbacks: Array<() => void> = [];
  let open = true;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  // Set SSE headers
  if (!res.headersSent) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no', // Disable nginx buffering
      ...(options.headers ?? {}),
    });
  }

  // Handle client disconnect
  res.on('close', () => {
    open = false;
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    for (const cb of closeCallbacks) {
      try { cb(); } catch { /* absorb */ }
    }
  });

  // Keepalive: send a comment every N ms to keep the connection alive
  if (keepaliveMs > 0) {
    keepaliveTimer = setInterval(() => {
      if (open && !res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, keepaliveMs);
    // Don't hold the process open for keepalive
    if (keepaliveTimer && typeof (keepaliveTimer as any).unref === 'function') {
      (keepaliveTimer as any).unref();
    }
  }

  const channel: SSEChannel = {
    send(event: string, data: unknown, id?: string): void {
      if (!open || res.writableEnded) return;

      let msg = '';
      if (id) msg += `id: ${id}\n`;
      msg += `event: ${event}\n`;
      msg += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n`;
      msg += '\n';

      res.write(msg);
    },

    sendData(data: unknown, id?: string): void {
      if (!open || res.writableEnded) return;

      let msg = '';
      if (id) msg += `id: ${id}\n`;
      msg += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n`;
      msg += '\n';

      res.write(msg);
    },

    comment(text: string): void {
      if (!open || res.writableEnded) return;
      res.write(`: ${text}\n\n`);
    },

    retry(ms: number): void {
      if (!open || res.writableEnded) return;
      res.write(`retry: ${ms}\n\n`);
    },

    close(): void {
      open = false;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (!res.writableEnded) {
        res.end();
      }
    },

    get isOpen(): boolean {
      return open && !res.writableEnded;
    },

    onClose(fn: () => void): void {
      closeCallbacks.push(fn);
    },
  };

  return channel;
}

// ─── File Streaming ───

/**
 * Stream a file to the response with range request support.
 *
 * Handles:
 * - Content-Type auto-detection
 * - Range requests (206 Partial Content)
 * - Content-Disposition for downloads
 * - Proper cleanup on client disconnect
 *
 * @example
 * ```ts
 * await streamFile(req, res, '/data/video.mp4', {
 *   cacheControl: 'public, max-age=3600',
 * });
 * ```
 */
export async function streamFile(
  req: StreamableRequest,
  res: StreamableResponse,
  filePath: string,
  options: FileStreamOptions = {},
): Promise<void> {
  // Path traversal protection: resolve and jail the path
  const resolvedPath = resolve(normalize(filePath));

  if (options.root) {
    const resolvedRoot = resolve(normalize(options.root));
    let realFilePath: string;
    try {
      realFilePath = await realpath(resolvedPath);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }
      throw err;
    }
    const realRoot = await realpath(resolvedRoot);
    if (!realFilePath.startsWith(realRoot + '/') && realFilePath !== realRoot) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    filePath = realFilePath;
  }

  // Get file info
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }
    throw err;
  }

  if (!fileStats.isFile()) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not a file' }));
    return;
  }

  const fileSize = fileStats.size;
  const contentType = options.contentType ?? getMimeType(filePath);
  const enableRanges = options.ranges !== false;

  // Build headers
  const headers: Record<string, string | number> = {
    'content-type': contentType,
    'accept-ranges': enableRanges ? 'bytes' : 'none',
  };

  if (options.cacheControl) {
    headers['cache-control'] = options.cacheControl;
  }

  if (options.download) {
    // Sanitize filename to prevent header injection
    const safeName = options.download
      .replace(/["\\\r\n]/g, '_')
      .replace(/[^\x20-\x7E]/g, '_');
    headers['content-disposition'] = `attachment; filename="${safeName}"`;
  }

  if (options.headers) {
    Object.assign(headers, options.headers);
  }

  // Check for range request
  const rangeHeader = req.headers.range;
  if (enableRanges && typeof rangeHeader === 'string') {
    const range = parseRangeHeader(rangeHeader, fileSize);

    if (!range) {
      // Invalid range
      res.writeHead(416, {
        'content-range': `bytes */${fileSize}`,
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ error: 'Range Not Satisfiable' }));
      return;
    }

    const contentLength = range.end - range.start + 1;

    const rangeStream = createReadStream(filePath, {
      start: range.start,
      end: range.end,
    });

    await streamResponse(res, rangeStream, {
      statusCode: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${range.start}-${range.end}/${fileSize}`,
        'content-length': contentLength,
      },
    });
    return;
  }

  // Full file response
  headers['content-length'] = fileSize;
  const fileStream = createReadStream(filePath);

  await streamResponse(res, fileStream, {
    statusCode: 200,
    headers,
  });
}
