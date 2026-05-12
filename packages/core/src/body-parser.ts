/**
 * Shared Body Parser — single source of truth for request body parsing.
 *
 * Used by the dev server (dev.ts) and vite-plugin.
 * The generated production server in build.ts inlines its own version
 * since the output must be self-contained with no @celsian/then-core dependency.
 */

import type { IncomingMessage } from 'node:http';

/** Default max body size: 1MB */
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024;

export interface BodyParserOptions {
  /** Maximum body size in bytes (default: 1MB) */
  maxBodySize?: number;
}

/**
 * Parse the request body from a Node.js IncomingMessage.
 * Supports JSON and URL-encoded form data.
 * Returns null for GET/HEAD requests or empty bodies.
 */
export function parseNodeBody(
  req: IncomingMessage,
  options: BodyParserOptions = {},
): Promise<unknown> {
  const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;

  return new Promise((resolve, reject) => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return resolve(null);

    // Pre-check Content-Length before starting to buffer
    const contentLength = req.headers['content-length'];
    if (contentLength != null) {
      const declared = parseInt(contentLength, 10);
      if (!isNaN(declared) && declared > maxBodySize) {
        req.destroy();
        reject(new Error('Content-Length exceeds limit'));
        return;
      }
    }

    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodySize) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => resolve(null));
    req.on('end', () => {
      const data = Buffer.concat(chunks).toString();
      if (!data) return resolve(null);
      const ct = req.headers['content-type'] ?? '';
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        resolve(Object.fromEntries(new URLSearchParams(data)));
      } else {
        resolve(data);
      }
    });
  });
}
