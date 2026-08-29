/**
 * The two streaming helpers that are pure string work, split out so they can be
 * bundled for the serverless adapters.
 *
 * `streaming.ts` was excluded from the runtime-shim group both adapters bundle
 * because it reaches `node:fs`, and all five of its exports were assessed
 * together as having no Worker equivalent. Two of them never needed one.
 * `getMimeType` maps a file extension to a content type and `parseRangeHeader`
 * parses a `Range` header; neither touches a filesystem, a stream or a
 * response, and both answer questions a Worker asks all the time — an R2 or KV
 * object still needs a `Content-Type`, and a ranged request against one still
 * needs its byte offsets. They were unbuildable only because they shared a
 * module with `node:fs`.
 *
 * The other three stay behind, and not for the reason the group was given.
 * `streamFile` genuinely needs a filesystem. `streamResponse` and
 * `createSSEChannel` do not — but both write to a Node `ServerResponse`
 * (`writeHead`/`write`/`end`/`on('close')`) and pull from a Node `Readable`,
 * and a Worker handler is given neither: it is handed a `Request` and must
 * return a `Response`. workerd does have `ReadableStream` and
 * `TransformStream`, so the *capability* is there and an SSE channel built on
 * them works; what is missing is any object with these functions' signatures to
 * call them with. Bundling them anyway would turn a build error into a
 * `res.writeHead is not a function` on the first request, which is strictly
 * worse. Giving Workers server-sent events means a second, Web-shaped API, and
 * that is a feature rather than this fix.
 *
 * `streaming.ts` re-exports both of these, so every existing import path still
 * works and there is one definition of each.
 */

/**
 * Common MIME types for file streaming.
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
};

/**
 * `node:path`'s `extname`, without `node:path`.
 *
 * Importing the real one is what kept `getMimeType` out of a Worker bundle, for
 * a function whose whole job is to find the last dot. The edge cases are the
 * reason this is not a `split('.').pop()`: a dotfile has no extension
 * (`.bashrc` → `''`), a trailing dot is an empty extension (`a.` → `'.'`), and
 * a dot in a directory name is not the file's (`/a.b/c` → `''`). Both path
 * separators are honoured because a Windows-shaped path reaching a MIME lookup
 * should answer the same on either host. `test/streaming.test.ts` holds this to
 * `node:path`'s own answers rather than to this description.
 */
function extnameOf(filePath: string): string {
  let lastSep = -1;
  for (let i = filePath.length - 1; i >= 0; i--) {
    const ch = filePath.charCodeAt(i);
    if (ch === 47 /* / */ || ch === 92 /* \ */) { lastSep = i; break; }
  }
  const base = filePath.slice(lastSep + 1);
  const dot = base.lastIndexOf('.');
  // A leading dot names the file, it does not introduce an extension.
  if (dot <= 0) return '';
  return base.slice(dot);
}

/**
 * Detect MIME type from file extension.
 */
export function getMimeType(filePath: string): string {
  const ext = extnameOf(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Parse a Range header value.
 * Returns the start and end byte positions, or null if invalid.
 */
export function parseRangeHeader(
  rangeHeader: string,
  fileSize: number,
): { start: number; end: number } | null {
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  let start: number;
  let end: number;

  if (match[1] === '' && match[2] !== '') {
    // Suffix range: bytes=-500 (last 500 bytes)
    const suffix = parseInt(match[2], 10);
    if (isNaN(suffix) || suffix <= 0) return null;
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else if (match[1] !== '' && match[2] === '') {
    // Open-ended: bytes=500- (from 500 to end)
    start = parseInt(match[1], 10);
    if (isNaN(start)) return null;
    end = fileSize - 1;
  } else {
    // Explicit range: bytes=200-400
    start = parseInt(match[1], 10);
    end = parseInt(match[2], 10);
    if (isNaN(start) || isNaN(end)) return null;
  }

  // Validate
  if (start < 0 || end < start || start >= fileSize) return null;
  // Clamp end to file size
  if (end >= fileSize) end = fileSize - 1;

  return { start, end };
}
