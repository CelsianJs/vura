/**
 * ThenJS Build Pipeline
 *
 * Takes a route manifest and produces deployment-ready output:
 * 1. Server bundle (Node.js app that handles API routes + SSR pages + tasks)
 * 2. Client bundle (static assets for CDN)
 * 3. Function bundles (one per serverless route, for Lambda/Workers)
 * 4. Task entries (one per task route, for serverless task execution)
 *
 * The adapter then takes these artifacts and generates platform-specific config.
 *
 * NOTE ON CODE DUPLICATION:
 * This file contains inline string constants (RENDER_TO_STRING_CODE, MATCH_ROUTE_CODE,
 * PARSE_BODY_CODE, etc.) that duplicate logic also found in:
 *   - packages/core/src/static-render.ts (builtinRenderToString, wrapDocument, escapeHtml)
 *   - packages/core/src/match.ts (compilePattern, matchRoute)
 *   - packages/core/src/body-parser.ts (parseNodeBody)
 *
 * This duplication is INTENTIONAL. The generated server entry must be fully self-contained
 * with zero @then/core dependency — it runs on bare Fly/Railway/VPS/Lambda where only
 * the dist/ bundle is deployed. The dev server and Vite plugin import from @then/core
 * directly (no duplication there), but build output must inline everything.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import type { RouteManifest, ApiRoute, PageRoute } from './manifest.js';
import type { ThenConfig, AdapterBuildContext } from './config.js';

// ─── Inline .env Loader (embedded in generated server code) ───

const DOTENV_CODE = [
  '// Load .env files: .env.local > .env.{NODE_ENV} > .env',
  '// Later files do not override earlier ones or existing env vars',
  '(function _loadEnv() {',
  "  const fs = require('node:fs');",
  "  const path = require('node:path');",
  "  const dir = path.dirname(new URL(import.meta.url).pathname);",
  "  const nodeEnv = process.env.NODE_ENV || 'production';",
  "  const files = ['.env.local', '.env.' + nodeEnv, '.env'];",
  '  for (const f of files) {',
  '    try {',
  "      const content = fs.readFileSync(path.resolve(dir, '..', f), 'utf-8');",
  "      for (const line of content.split('\\n')) {",
  '        const t = line.trim();',
  "        if (!t || t.startsWith('#')) continue;",
  "        const eq = t.indexOf('=');",
  '        if (eq === -1) continue;',
  '        const key = t.slice(0, eq).trim();',
  '        let val = t.slice(eq + 1).trim();',
  '        if ((val.startsWith(\'"\') && val.endsWith(\'"\')) || (val.startsWith("\'") && val.endsWith("\'"))) val = val.slice(1, -1);',
  '        if (process.env[key] === undefined) process.env[key] = val;',
  '      }',
  '    } catch (_) {}',
  '  }',
  '})();',
].join('\n');

// ─── Inline Logger Code (embedded in generated server code) ───

const LOGGER_CODE = [
  '// Structured logger',
  "const _logLevel = { debug: 0, info: 1, warn: 2, error: 3 };",
  "const _minLogLevel = _logLevel[process.env.THEN_LOG_LEVEL || 'info'] || 1;",
  "const _logFormat = process.env.THEN_LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'pretty');",
  '',
  'function _log(level, msg, data) {',
  '  if (_logLevel[level] < _minLogLevel) return;',
  "  const entry = { level, msg, timestamp: new Date().toISOString(), ...data };",
  "  if (_logFormat === 'json') {",
  '    process.stdout.write(JSON.stringify(entry) + "\\n");',
  '  } else {',
  '    const colors = { debug: "\\x1b[36m", info: "\\x1b[32m", warn: "\\x1b[33m", error: "\\x1b[31m" };',
  '    const reset = "\\x1b[0m"; const dim = "\\x1b[2m";',
  '    const { level: _l, msg: _m, timestamp: _t, ...rest } = entry;',
  '    const extra = Object.keys(rest).length > 0 ? " " + dim + JSON.stringify(rest) + reset : "";',
  '    process.stdout.write(dim + entry.timestamp.slice(11, 23) + reset + " " + colors[level] + level.toUpperCase().padEnd(5) + reset + " " + msg + extra + "\\n");',
  '  }',
  '}',
  '',
  'function _generateRequestId() {',
  '  try { return require("node:crypto").randomUUID(); }',
  '  catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); }',
  '}',
].join('\n');

// ─── Generated Code Fragments ───
// These are strings of JavaScript that get emitted into generated entry files.
// Using regular strings (not template literals) to avoid escaping issues.

const MATCH_ROUTE_CODE = [
  'function matchRoute(pathname, method) {',
  '  for (const route of routes) {',
  '    if (!route.methods.includes(method)) continue;',
  '    const paramNames = [];',
  "    let regexStr = '';",
  '    let i = 0;',
  '    while (i < route.pattern.length) {',
  "      if (route.pattern[i] === ':' && i > 0 && route.pattern[i-1] === '/') {",
  "        let name = ''; i++;",
  '        while (i < route.pattern.length && /[a-zA-Z0-9_]/.test(route.pattern[i])) { name += route.pattern[i]; i++; }',
  "        paramNames.push(name); regexStr += '([^/]+)';",
  "      } else if (route.pattern[i] === '*') {",
  "        paramNames.push('*'); regexStr += '(.*)'; i++;",
  '      } else {',
  '        const ch = route.pattern[i];',
  "        if ('.+?^${}()|[]\\\\'.includes(ch)) regexStr += '\\\\' + ch;",
  '        else regexStr += ch;',
  '        i++;',
  '      }',
  '    }',
  "    const match = pathname.match(new RegExp('^' + regexStr + '$'));",
  '    if (match) {',
  '      const params = {};',
  '      paramNames.forEach((name, idx) => { try { params[name] = decodeURIComponent(match[idx + 1]); } catch { params[name] = match[idx + 1]; } });',
  '      return { route, params };',
  '    }',
  '  }',
  '  return null;',
  '}',
].join('\n');

const MATCH_PAGE_ROUTE_CODE = [
  'function matchPageRoute(pathname) {',
  '  for (const page of pageRoutes) {',
  '    const paramNames = [];',
  "    let regexStr = '';",
  '    let i = 0;',
  '    while (i < page.pattern.length) {',
  "      if (page.pattern[i] === ':' && i > 0 && page.pattern[i-1] === '/') {",
  "        let name = ''; i++;",
  '        while (i < page.pattern.length && /[a-zA-Z0-9_]/.test(page.pattern[i])) { name += page.pattern[i]; i++; }',
  "        paramNames.push(name); regexStr += '([^/]+)';",
  "      } else if (page.pattern[i] === '*') {",
  "        paramNames.push('*'); regexStr += '(.*)'; i++;",
  '      } else {',
  '        const ch = page.pattern[i];',
  "        if ('.+?^${}()|[]\\\\'.includes(ch)) regexStr += '\\\\' + ch;",
  '        else regexStr += ch;',
  '        i++;',
  '      }',
  '    }',
  "    const match = pathname.match(new RegExp('^' + regexStr + '$'));",
  '    if (match) {',
  '      const params = {};',
  '      paramNames.forEach((name, idx) => { try { params[name] = decodeURIComponent(match[idx + 1]); } catch { params[name] = match[idx + 1]; } });',
  '      return { page, params };',
  '    }',
  '  }',
  '  return null;',
  '}',
].join('\n');

const PARSE_BODY_CODE = [
  'const _parsedBodySize = parseInt(process.env.THEN_MAX_BODY_SIZE || "1048576", 10);',
  'const MAX_BODY_SIZE = (_parsedBodySize > 0 && !isNaN(_parsedBodySize)) ? _parsedBodySize : 1048576; // default 1MB',
  '',
  'function parseBody(req) {',
  '  return new Promise((resolve, reject) => {',
  "    if (req.method === 'GET' || req.method === 'HEAD') return resolve(null);",
  '',
  '    // Pre-check Content-Length before starting to buffer',
  "    const cl = req.headers['content-length'];",
  '    if (cl != null) {',
  '      const declared = parseInt(cl, 10);',
  '      if (!isNaN(declared) && declared > MAX_BODY_SIZE) {',
  '        req.destroy();',
  '        reject(new Error("Content-Length exceeds limit"));',
  '        return;',
  '      }',
  '    }',
  '',
  '    let size = 0;',
  "    const chunks = [];",
  "    req.on('data', (chunk) => {",
  '      size += chunk.length;',
  '      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error("Body too large")); return; }',
  '      chunks.push(chunk);',
  '    });',
  "    req.on('error', () => resolve(null));",
  "    req.on('end', () => {",
  "      const data = Buffer.concat(chunks).toString();",
  '      if (!data) return resolve(null);',
  "      const ct = req.headers['content-type'] || '';",
  "      if (ct.includes('application/json')) {",
  '        try { resolve(JSON.parse(data)); } catch { resolve(null); }',
  "      } else if (ct.includes('application/x-www-form-urlencoded')) {",
  '        resolve(Object.fromEntries(new URLSearchParams(data)));',
  '      } else {',
  '        resolve(data);',
  '      }',
  '    });',
  '  });',
  '}',
].join('\n');

// ─── Inline SSR Renderer (embedded in generated server code) ───

const RENDER_TO_STRING_CODE = [
  'function renderToString(vnode) {',
  "  if (vnode == null || typeof vnode === 'boolean') return '';",
  "  if (typeof vnode === 'string') return escapeHtml(vnode);",
  "  if (typeof vnode === 'number') return String(vnode);",
  "  if (typeof vnode === 'function' && !vnode.type && !vnode.tag) return renderToString(vnode());",
  '  if (Array.isArray(vnode)) return vnode.map(renderToString).join(\'\');',
  '  const type = vnode.type || vnode.tag;',
  '  const { props = {}, children } = vnode;',
  "  if (typeof type === 'function') return renderToString(type({ ...props, children }));",
  "  if (typeof type === 'string') {",
  "    const attrs = renderAttrs(props);",
  '    const tag = type;',
  "    const voids = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);",
  '    if (voids.has(tag)) return \'<\' + tag + attrs + \'>\';',
  "    let childHtml = '';",
  '    if (props.dangerouslySetInnerHTML) childHtml = props.dangerouslySetInnerHTML.__html || \'\';',
  '    else if (children != null) {',
  '      childHtml = Array.isArray(children) ? children.map(renderToString).join(\'\') : renderToString(children);',
  '    }',
  "    return '<' + tag + attrs + '>' + childHtml + '</' + tag + '>';",
  '  }',
  "  if ((!type || typeof type === 'symbol') && children) {",
  "    return Array.isArray(children) ? children.map(renderToString).join('') : renderToString(children);",
  '  }',
  "  return '';",
  '}',
  '',
  'function renderAttrs(props) {',
  "  let result = '';",
  '  for (const [key, value] of Object.entries(props)) {',
  "    if (key === 'children' || key === 'dangerouslySetInnerHTML') continue;",
  "    if (key.startsWith('on') && key.length > 2) continue;",
  '    if (value == null || value === false) continue;',
  "    const attrName = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key;",
  "    if (value === true) { result += ' ' + attrName; }",
  "    else if (key === 'style' && typeof value === 'object') {",
  "      const css = Object.entries(value).map(([p, v]) => p.replace(/[A-Z]/g, m => '-' + m.toLowerCase()) + ': ' + v).join('; ');",
  '      result += \' style="\' + escapeHtml(css) + \'"\';',
  '    } else {',
  '      result += \' \' + attrName + \'="\' + escapeHtml(String(value)) + \'"\';',
  '    }',
  '  }',
  '  return result;',
  '}',
  '',
  'function escapeHtml(str) {',
  "  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');",
  '}',
].join('\n');

const WRAP_DOCUMENT_CODE = [
  'function wrapDocument(bodyHtml, opts) {',
  '  const metaTags = (opts.meta || []).map(m => \'<meta \' + Object.entries(m).map(([k, v]) => k + \'="\' + escapeHtml(v) + \'"\').join(\' \') + \'>\').join(\'\\n    \');',
  '  const styleTags = (opts.styles || []).map(s => s.startsWith(\'http\') ? \'<link rel="stylesheet" href="\' + s + \'">\' : \'<style>\' + s + \'</style>\').join(\'\\n    \');',
  '  const scriptTags = (opts.scripts || []).map(s => \'<script type="module" src="\' + s + \'"></script>\').join(\'\\n    \');',
  "  return '<!DOCTYPE html>\\n<html lang=\"en\">\\n<head>\\n    <meta charset=\"UTF-8\">\\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\\n    <title>' + escapeHtml(opts.title || 'ThenJS App') + '</title>\\n    ' + metaTags + '\\n    ' + styleTags + '\\n    ' + (opts.head || '') + '\\n</head>\\n<body>\\n    <div id=\"app\">' + bodyHtml + '</div>\\n    ' + scriptTags + '\\n</body>\\n</html>';",
  '}',
].join('\n');

// ─── ISR Cache Code (inline in server entry) ───

const ISR_CACHE_CODE = [
  '// ISR cache: LRU Map of url → { html, timestamp, revalidateMs }',
  'const _isrCache = new Map();',
  'const _isrRevalidating = new Set();',
  'const ISR_MAX_ENTRIES = 1000;',
  '// TTL multiplier: entries are hard-expired after revalidateMs * ISR_TTL_FACTOR',
  'const ISR_TTL_FACTOR = Math.max(parseFloat(process.env.THEN_ISR_TTL_FACTOR || "3") || 3, 1);',
  '// Background cleanup interval (default: 60 seconds)',
  'const _parsedCleanupInterval = parseInt(process.env.THEN_ISR_CLEANUP_INTERVAL || "60000", 10);',
  'const ISR_CLEANUP_INTERVAL_MS = (_parsedCleanupInterval > 0 && !isNaN(_parsedCleanupInterval)) ? _parsedCleanupInterval : 60000;',
  '',
  'function isrGet(key) {',
  '  const entry = _isrCache.get(key);',
  '  if (!entry) return null;',
  '  const age = Date.now() - entry.timestamp;',
  '  // Hard TTL: remove entries that are far past their revalidation window',
  '  if (age > entry.revalidateMs * ISR_TTL_FACTOR) {',
  '    _isrCache.delete(key);',
  '    return null;',
  '  }',
  '  // LRU: move to end',
  '  _isrCache.delete(key);',
  '  _isrCache.set(key, entry);',
  '  return { html: entry.html, stale: age > entry.revalidateMs };',
  '}',
  '',
  'function isrSet(key, html, revalidateMs) {',
  '  _isrCache.set(key, { html, timestamp: Date.now(), revalidateMs });',
  '  _isrRevalidating.delete(key);',
  '  // Evict oldest entries if over limit',
  '  while (_isrCache.size > ISR_MAX_ENTRIES) {',
  '    const oldest = _isrCache.keys().next().value;',
  '    _isrCache.delete(oldest);',
  '  }',
  '}',
  '',
  '// Background cleanup: periodically remove stale entries that have exceeded their TTL',
  'function _isrCleanup() {',
  '  const now = Date.now();',
  '  for (const [key, entry] of _isrCache) {',
  '    const age = now - entry.timestamp;',
  '    if (age > entry.revalidateMs * ISR_TTL_FACTOR) {',
  '      _isrCache.delete(key);',
  '    }',
  '  }',
  '}',
  '',
  '// Start background cleanup interval',
  'if (ISR_CLEANUP_INTERVAL_MS > 0) {',
  '  const _isrCleanupTimer = setInterval(_isrCleanup, ISR_CLEANUP_INTERVAL_MS);',
  '  if (_isrCleanupTimer.unref) _isrCleanupTimer.unref();',
  '}',
].join('\n');

// ─── Task Runner Code (inline in server entry) ───

const TASK_RUNNER_CODE = [
  '// In-memory task queue',
  'const _taskQueue = [];',
  'const _taskResults = new Map();',
  'const _TASK_MAX_RESULTS = 10000;',
  'let _taskIdCounter = 1;',
  'let _taskProcessing = false;',
  '',
  'function enqueueTask(taskName, input) {',
  '  const id = String(_taskIdCounter++);',
  "  const job = { id, taskName, input, status: 'pending', attempt: 0, createdAt: Date.now() };",
  '  _taskQueue.push(job);',
  '  _taskResults.set(id, job);',
  '  _evictTaskResults();',
  '  processQueue();',
  '  return id;',
  '}',
  '',
  'function _evictTaskResults() {',
  '  if (_taskResults.size <= _TASK_MAX_RESULTS) return;',
  '  const iter = _taskResults.entries();',
  '  let toRemove = _taskResults.size - _TASK_MAX_RESULTS;',
  '  while (toRemove-- > 0) {',
  '    const next = iter.next();',
  '    if (next.done) break;',
  "    if (next.value[1].status === 'completed' || next.value[1].status === 'failed') _taskResults.delete(next.value[0]);",
  '  }',
  '}',
  '',
  'async function processQueue() {',
  '  if (_taskProcessing) return;',
  '  _taskProcessing = true;',
  '  try {',
  '    while (_taskQueue.length > 0) {',
  '      const job = _taskQueue.shift();',
  '      const taskDef = taskRoutes.find(t => t.name === job.taskName);',
  '      if (!taskDef) {',
  "        job.status = 'failed'; job.error = 'Unknown task: ' + job.taskName;",
  '        continue;',
  '      }',
  '      const maxRetries = taskDef.config.retries || 0;',
  '      const timeoutMs = taskDef.config.timeout || 30000;',
  "      job.status = 'running';",
  '      job.attempt++;',
  '      try {',
  '        const handlerFn = taskDef.handlers.POST;',
  "        if (typeof handlerFn !== 'function') throw new Error('Task must export POST handler');",
  '        let timer;',
  '        const result = await Promise.race([',
  '          handlerFn({ taskId: job.id, input: job.input, attempt: job.attempt }).then(r => { clearTimeout(timer); return r; }),',
  "          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Task timeout')), timeoutMs); }),",
  '        ]);',
  "        job.status = 'completed'; job.result = result;",
  '      } catch (err) {',
  '        if (job.attempt <= maxRetries) {',
  "          job.status = 'pending';",
  '          const backoff = 100 * Math.pow(2, job.attempt);',
  '          setTimeout(() => { _taskQueue.push(job); processQueue(); }, backoff);',
  '        } else {',
  "          job.status = 'failed'; job.error = err.message;",
  '        }',
  '      }',
  '    }',
  '  } finally {',
  '    _taskProcessing = false;',
  '  }',
  '}',
  '',
  '// Cron scheduler',
  'const _cronJobs = [];',
  'let _cronLastFired = new Map();',
  '',
  'function registerCron(taskName, schedule) {',
  '  _cronJobs.push({ taskName, schedule, fields: parseCron(schedule) });',
  '}',
  '',
  'function startCron() {',
  '  if (_cronJobs.length > 0) { const _cronTimer = setInterval(checkCron, 60000); if (_cronTimer.unref) _cronTimer.unref(); checkCron(); }',
  '}',
  '',
  'const _cronRanges = [{ min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 }, { min: 1, max: 12 }, { min: 0, max: 7 }];',
  '',
  'function _validateCronField(field, min, max) {',
  "  if (field === '*') return true;",
  "  if (field.includes(',')) return field.split(',').every(f => _validateCronField(f.trim(), min, max));",
  "  if (field.includes('/')) {",
  "    if (field.split('/').length > 2) return false;",
  "    const [range, stepStr] = field.split('/');",
  '    const step = parseInt(stepStr, 10);',
  '    if (isNaN(step) || step <= 0) return false;',
  "    if (range === '*') return true;",
  "    if (range.includes('-') && range.indexOf('-') > 0) {",
  "      const [lo, hi] = range.split('-').map(Number);",
  '      return !isNaN(lo) && !isNaN(hi) && lo >= min && hi <= max && lo <= hi;',
  '    }',
  '    const val = parseInt(range, 10);',
  '    return !isNaN(val) && val >= min && val <= max;',
  '  }',
  "  if (field.includes('-') && field.indexOf('-') > 0) {",
  "    const [lo, hi] = field.split('-').map(Number);",
  '    return !isNaN(lo) && !isNaN(hi) && lo >= min && hi <= max && lo <= hi;',
  '  }',
  '  const val = parseInt(field, 10);',
  '  return !isNaN(val) && val >= min && val <= max;',
  '}',
  '',
  'function parseCron(expr) {',
  "  const parts = expr.trim().split(/\\s+/);",
  '  if (parts.length !== 5) return null;',
  '  for (let i = 0; i < 5; i++) {',
  '    if (!_validateCronField(parts[i], _cronRanges[i].min, _cronRanges[i].max)) return null;',
  '  }',
  '  return { minute: parts[0], hour: parts[1], dayOfMonth: parts[2], month: parts[3], dayOfWeek: parts[4] };',
  '}',
  '',
  'function cronFieldMatches(field, value) {',
  "  if (field === '*') return true;",
  "  if (field.includes(',')) return field.split(',').some(f => cronFieldMatches(f.trim(), value));",
  "  if (field.includes('/')) {",
  "    const [range, stepStr] = field.split('/');",
  '    const step = parseInt(stepStr, 10);',
  '    if (isNaN(step) || step <= 0) return false;',
  "    if (range === '*') return value % step === 0;",
  "    if (range.includes('-')) {",
  "      const [min, max] = range.split('-').map(Number);",
  '      return value >= min && value <= max && (value - min) % step === 0;',
  '    }',
  '    return value % step === 0;',
  '  }',
  "  if (field.includes('-')) {",
  "    const [min, max] = field.split('-').map(Number);",
  '    return value >= min && value <= max;',
  '  }',
  '  return parseInt(field, 10) === value;',
  '}',
  '',
  'function checkCron() {',
  '  const now = new Date();',
  '  const minuteKey = now.getFullYear() * 525960 + now.getMonth() * 43800 + now.getDate() * 1440 + now.getHours() * 60 + now.getMinutes();',
  '  for (const job of _cronJobs) {',
  '    if (!job.fields) continue;',
  '    if (_cronLastFired.get(job.taskName) === minuteKey) continue;',
  '    if (cronFieldMatches(job.fields.minute, now.getMinutes()) &&',
  '        cronFieldMatches(job.fields.hour, now.getHours()) &&',
  '        cronFieldMatches(job.fields.dayOfMonth, now.getDate()) &&',
  '        cronFieldMatches(job.fields.month, now.getMonth() + 1) &&',
  '        cronFieldMatches(job.fields.dayOfWeek, now.getDay())) {',
  '      _cronLastFired.set(job.taskName, minuteKey);',
  '      enqueueTask(job.taskName, { _cron: true, _schedule: job.schedule });',
  '    }',
  '  }',
  '}',
].join('\n');

// ─── Inline Static File Serving Code (embedded in generated server code) ───

const STATIC_FILE_CODE = [
  '// Static file serving for public/ directory',
  "const _mimeTypes = {",
  "  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',",
  "  '.mjs': 'application/javascript', '.json': 'application/json',",
  "  '.txt': 'text/plain', '.xml': 'application/xml',",
  "  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',",
  "  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',",
  "  '.ico': 'image/x-icon', '.avif': 'image/avif',",
  "  '.mp4': 'video/mp4', '.webm': 'video/webm',",
  "  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',",
  "  '.woff': 'font/woff', '.woff2': 'font/woff2',",
  "  '.ttf': 'font/ttf', '.otf': 'font/otf',",
  "  '.pdf': 'application/pdf', '.zip': 'application/zip',",
  "  '.wasm': 'application/wasm',",
  "};",
  "",
  "const _fs = require('node:fs');",
  "const _pathMod = require('node:path');",
  "const _publicDir = _pathMod.resolve(_pathMod.dirname(new URL(import.meta.url).pathname), '..', 'public');",
  "",
  "function _getMimeType(fp) {",
  "  const ext = _pathMod.extname(fp).toLowerCase();",
  "  return _mimeTypes[ext] || 'application/octet-stream';",
  "}",
  "",
  "function _tryServeStatic(pathname, method, nodeRes) {",
  "  if (method !== 'GET' && method !== 'HEAD') return false;",
  "  const safePath = pathname.replace(/\\.\\./g, '');",
  "  const filePath = _pathMod.normalize(_pathMod.resolve(_publicDir, '.' + safePath));",
  "  if (!filePath.startsWith(_publicDir + _pathMod.sep) && filePath !== _publicDir) return false;",
  "  try {",
  "    const st = _fs.statSync(filePath);",
  "    if (!st.isFile()) return false;",
  "    const ct = _getMimeType(filePath);",
  "    nodeRes.writeHead(200, { 'content-type': ct, 'content-length': st.size.toString(), 'cache-control': 'public, max-age=31536000, immutable' });",
  "    if (method === 'HEAD') { nodeRes.end(); return true; }",
  "    const stream = _fs.createReadStream(filePath);",
  "    stream.pipe(nodeRes);",
  "    stream.on('error', () => { if (!nodeRes.writableEnded) nodeRes.end(); });",
  "    return true;",
  "  } catch (_) { return false; }",
  "}",
].join('\n');

// ─── Inline Validation Code (embedded in generated server code) ───

const VALIDATION_CODE = [
  '// Request validation (Zod-compatible .safeParse() interface)',
  'function _validateRequest(req, schema) {',
  '  const errors = [];',
  '  if (schema.body) {',
  '    const r = schema.body.safeParse(req.parsedBody);',
  '    if (!r.success) errors.push({ target: "body", issues: r.error.issues.map(i => ({ path: i.path.join("."), message: i.message, ...(i.code ? { code: i.code } : {}) })) });',
  '    else req.parsedBody = r.data;',
  '  }',
  '  if (schema.query) {',
  '    const r = schema.query.safeParse(req.query);',
  '    if (!r.success) errors.push({ target: "query", issues: r.error.issues.map(i => ({ path: i.path.join("."), message: i.message, ...(i.code ? { code: i.code } : {}) })) });',
  '    else req.query = r.data;',
  '  }',
  '  if (schema.params) {',
  '    const r = schema.params.safeParse(req.params);',
  '    if (!r.success) errors.push({ target: "params", issues: r.error.issues.map(i => ({ path: i.path.join("."), message: i.message, ...(i.code ? { code: i.code } : {}) })) });',
  '    else req.params = r.data;',
  '  }',
  '  if (errors.length > 0) {',
  '    const issueCount = errors.reduce((a, e) => a + e.issues.length, 0);',
  '    const targets = errors.map(e => e.target);',
  '    return { statusCode: 400, body: { error: "Validation failed: " + issueCount + " issue(s) in " + targets.join(", "), code: "VALIDATION_ERROR", details: errors } };',
  '  }',
  '  req.validated = { body: req.parsedBody, query: req.query, params: req.params };',
  '  return null;',
  '}',
].join('\n');

// ─── Inline Hook Execution Code (embedded in generated server code) ───

const HOOKS_CODE = [
  '// Lifecycle hook execution (inlined for self-contained server)',
  'async function _runHooks(hookArr, ...args) {',
  '  if (!hookArr) return;',
  '  for (const fn of hookArr) { await fn(...args); }',
  '}',
  '',
  'async function _executeWithHooks(req, reply, handlerFn, routeHooks) {',
  '  const _hookStart = performance.now();',
  '  let _hookStatus = 200;',
  '  let _hookHadError = false;',
  '  try {',
  '    // onRequest hooks',
  '    if (routeHooks && routeHooks.onRequest) {',
  '      await _runHooks(routeHooks.onRequest, req, reply);',
  '    }',
  '    // Handler',
  '    await handlerFn(req, reply);',
  '  } catch (err) {',
  '    _hookHadError = true;',
  '    _hookStatus = (err && err.statusCode) ? err.statusCode : 500;',
  '    // onError hooks',
  '    if (routeHooks && routeHooks.onError) {',
  '      try { await _runHooks(routeHooks.onError, err, req, reply); }',
  '      catch (hookErr) { err = hookErr; }',
  '    }',
  '    if (!_hookHadError) throw err; // re-propagate if no error hooks handled it',
  '  } finally {',
  '    // onResponse hooks',
  '    const _hookDur = Math.round((performance.now() - _hookStart) * 100) / 100;',
  '    if (routeHooks && routeHooks.onResponse) {',
  '      try { await _runHooks(routeHooks.onResponse, req, reply, { statusCode: _hookStatus, durationMs: _hookDur, hadError: _hookHadError }); }',
  '      catch (_) { /* onResponse errors are silenced */ }',
  '    }',
  '  }',
  '  return { statusCode: _hookStatus, hadError: _hookHadError };',
  '}',
].join('\n');

// ─── Server Code (rewritten to include pages + tasks) ───

function generateServerCode(hasPages: boolean, hasTasks: boolean): string {
  const lines: string[] = [];

  lines.push("const port = parseInt(process.env.PORT || '3000', 10);");
  lines.push("const _shutdownTimeoutMs = parseInt(process.env.THEN_SHUTDOWN_TIMEOUT || '30000', 10);");
  lines.push('let _inFlightRequests = 0;');
  lines.push('let _isShuttingDown = false;');
  lines.push('');
  lines.push('const server = createServer(async (nodeReq, nodeRes) => {');
  lines.push('  // Reject new requests during shutdown');
  lines.push('  if (_isShuttingDown) {');
  lines.push("    nodeRes.writeHead(503, { 'content-type': 'application/json', 'connection': 'close' });");
  lines.push('    nodeRes.end(JSON.stringify({ error: "Service shutting down" }));');
  lines.push('    return;');
  lines.push('  }');
  lines.push('');
  lines.push('  _inFlightRequests++;');
  lines.push('  nodeRes.on("close", () => { _inFlightRequests--; });');
  lines.push('');
  lines.push('  const url = new URL(nodeReq.url || "/", "http://" + (nodeReq.headers.host || "localhost"));');
  lines.push("  const method = (nodeReq.method || 'GET').toUpperCase();");
  lines.push('  const _reqId = _generateRequestId();');
  lines.push('  const _reqStart = performance.now();');
  lines.push("  _log('info', 'request start', { requestId: _reqId, method, path: url.pathname });");
  lines.push('  nodeRes.on("finish", () => {');
  lines.push('    const _dur = Math.round((performance.now() - _reqStart) * 100) / 100;');
  lines.push("    const _lvl = nodeRes.statusCode >= 500 ? 'error' : nodeRes.statusCode >= 400 ? 'warn' : 'info';");
  lines.push("    _log(_lvl, 'request end', { requestId: _reqId, method, path: url.pathname, status: nodeRes.statusCode, durationMs: _dur });");
  lines.push('  });');
  lines.push('');
  lines.push("  if (url.pathname === '/__health') {");
  lines.push("    nodeRes.writeHead(200, { 'content-type': 'application/json' });");
  lines.push("    nodeRes.end(JSON.stringify({ ok: true, framework: 'ThenJS' }));");
  lines.push('    return;');
  lines.push('  }');
  lines.push('');
  lines.push('  // Serve static files from public/ directory');
  lines.push('  if (_tryServeStatic(url.pathname, method, nodeRes)) return;');

  // Task management endpoints (protected by THEN_TASK_SECRET env var or localhost-only)
  if (hasTasks) {
    lines.push('');
    lines.push("  if (url.pathname.startsWith('/__tasks')) {");
    lines.push('    const taskSecret = process.env.THEN_TASK_SECRET;');
    lines.push('    const remoteAddr = nodeReq.socket?.remoteAddress || "";');
    lines.push("    const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';");
    lines.push("    if (taskSecret && nodeReq.headers['authorization'] !== 'Bearer ' + taskSecret && !isLocal) {");
    lines.push("      nodeRes.writeHead(403, { 'content-type': 'application/json' });");
    lines.push('      nodeRes.end(JSON.stringify({ error: "Forbidden" }));');
    lines.push('      return;');
    lines.push('    }');
    lines.push('  }');
    lines.push('');
    lines.push("  if (url.pathname === '/__tasks' && method === 'GET') {");
    lines.push("    nodeRes.writeHead(200, { 'content-type': 'application/json' });");
    lines.push('    nodeRes.end(JSON.stringify({');
    lines.push('      tasks: taskRoutes.map(t => ({ name: t.name, schedule: t.config.schedule })),');
    lines.push('      queueLength: _taskQueue.length,');
    lines.push('      completedJobs: [..._taskResults.values()].filter(j => j.status === "completed").length,');
    lines.push('    }));');
    lines.push('    return;');
    lines.push('  }');
    lines.push('');
    lines.push("  if (url.pathname.startsWith('/__tasks/') && method === 'POST') {");
    lines.push("    const taskName = url.pathname.slice('/__tasks/'.length);");
    lines.push('    const body = await parseBody(nodeReq);');
    lines.push('    const taskId = enqueueTask(taskName, body && body.input);');
    lines.push("    nodeRes.writeHead(202, { 'content-type': 'application/json' });");
    lines.push('    nodeRes.end(JSON.stringify({ taskId, status: "queued" }));');
    lines.push('    return;');
    lines.push('  }');
    lines.push('');
    lines.push("  if (url.pathname.startsWith('/__tasks/') && method === 'GET') {");
    lines.push("    const taskId = url.pathname.slice('/__tasks/'.length);");
    lines.push('    const job = _taskResults.get(taskId);');
    lines.push('    if (!job) {');
    lines.push("      nodeRes.writeHead(404, { 'content-type': 'application/json' });");
    lines.push('      nodeRes.end(JSON.stringify({ error: "Task not found" }));');
    lines.push('      return;');
    lines.push('    }');
    lines.push("    nodeRes.writeHead(200, { 'content-type': 'application/json' });");
    lines.push('    nodeRes.end(JSON.stringify(job));');
    lines.push('    return;');
    lines.push('  }');
  }

  // API route matching (with hooks + validation)
  lines.push('');
  lines.push('  const match = matchRoute(url.pathname, method);');
  lines.push('  if (match) {');
  lines.push('    try {');
  lines.push('      const handlerFn = match.route.handlers[method];');
  lines.push("      if (typeof handlerFn !== 'function') {");
  lines.push("        nodeRes.writeHead(405, { 'content-type': 'application/json' });");
  lines.push('        nodeRes.end(JSON.stringify({ error: "Method Not Allowed" }));');
  lines.push('        return;');
  lines.push('      }');
  lines.push('');
  lines.push('      const body = await parseBody(nodeReq);');
  lines.push('      const req = {');
  lines.push('        method,');
  lines.push('        url: url.pathname,');
  lines.push('        headers: nodeReq.headers,');
  lines.push('        params: match.params,');
  lines.push('        query: Object.fromEntries(url.searchParams.entries()),');
  lines.push('        parsedBody: body,');
  lines.push('      };');
  lines.push('');
  lines.push('      // Validate request if route module exports a schema');
  lines.push('      const routeSchema = match.route.handlers.schema;');
  lines.push('      if (routeSchema) {');
  lines.push('        const valErr = _validateRequest(req, routeSchema);');
  lines.push('        if (valErr) {');
  lines.push("          nodeRes.writeHead(valErr.statusCode, { 'content-type': 'application/json' });");
  lines.push('          nodeRes.end(JSON.stringify(valErr.body));');
  lines.push('          return;');
  lines.push('        }');
  lines.push('      }');
  lines.push('');
  lines.push('      let statusCode = 200;');
  lines.push("      const headers = { 'content-type': 'application/json' };");
  lines.push('      const reply = {');
  lines.push('        status(code) { statusCode = code; return reply; },');
  lines.push('        header(name, value) { headers[name] = value; return reply; },');
  lines.push('        json(data) { nodeRes.writeHead(statusCode, headers); nodeRes.end(JSON.stringify(data)); return null; },');
  lines.push('        send(data) { nodeRes.writeHead(statusCode, headers); nodeRes.end(data); return null; },');
  lines.push('      };');
  lines.push('');
  lines.push('      // Extract route-level hooks if the module exports them');
  lines.push('      const routeHooks = match.route.handlers.hooks;');
  lines.push('');
  lines.push('      // Execute with hook lifecycle (onRequest -> handler -> onResponse, onError on failure)');
  lines.push('      const hookResult = await _executeWithHooks(req, reply, handlerFn, routeHooks);');
  lines.push('');
  lines.push('      // If hooks/handler errored and response was not sent, send structured error');
  lines.push('      if (hookResult.hadError && !nodeRes.writableEnded) {');
  lines.push("        const errStatus = hookResult.statusCode || 500;");
  lines.push("        nodeRes.writeHead(errStatus, { 'content-type': 'application/json' });");
  lines.push('        nodeRes.end(JSON.stringify({ error: "Internal Server Error", code: "HANDLER_ERROR" }));');
  lines.push('      }');
  lines.push('');
  lines.push('      // If handler returned a value and response not yet sent, auto-send');
  lines.push('      if (!nodeRes.writableEnded && !hookResult.hadError) {');
  lines.push('        nodeRes.writeHead(204);');
  lines.push('        nodeRes.end();');
  lines.push('      }');
  lines.push('    } catch (err) {');
  lines.push("      _log('error', 'Error in ' + method + ' ' + url.pathname, { error: err.message || String(err) });");
  lines.push('      if (!nodeRes.writableEnded) {');
  lines.push("        nodeRes.writeHead(500, { 'content-type': 'application/json' });");
  lines.push('        nodeRes.end(JSON.stringify({ error: "Internal Server Error", code: "HANDLER_ERROR" }));');
  lines.push('      }');
  lines.push('    }');
  lines.push('    return;');
  lines.push('  }');

  // Page route matching (server-mode pages)
  if (hasPages) {
    lines.push('');
    lines.push("  // Server-mode page rendering");
    lines.push("  if (method === 'GET') {");
    lines.push('    const pageMatch = matchPageRoute(url.pathname);');
    lines.push('    if (pageMatch) {');
    lines.push('      try {');
    lines.push('        const { page, params } = pageMatch;');
    lines.push('        const revalidateMs = page.config.revalidate ? page.config.revalidate * 1000 : 0;');
    lines.push('');
    lines.push('        // ISR: normalize cache key by sorting query params');
    lines.push('        url.searchParams.sort();');
    lines.push("        const cacheKey = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '');");
    lines.push('        if (revalidateMs > 0) {');
    lines.push('          const cached = isrGet(cacheKey);');
    lines.push('          if (cached) {');
    lines.push("            nodeRes.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-isr-cache': cached.stale ? 'STALE' : 'HIT' });");
    lines.push('            nodeRes.end(cached.html);');
    lines.push('            if (cached.stale && !_isrRevalidating.has(cacheKey)) {');
    lines.push('              // Deduplicated background re-render');
    lines.push('              _isrRevalidating.add(cacheKey);');
    lines.push("              renderPage(page, params, url).then(html => isrSet(cacheKey, html, revalidateMs)).catch(() => { _isrRevalidating.delete(cacheKey); });");
    lines.push('            }');
    lines.push('            return;');
    lines.push('          }');
    lines.push('        }');
    lines.push('');
    lines.push('        // Streaming SSR');
    lines.push('        if (page.config.stream) {');
    lines.push("          nodeRes.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'transfer-encoding': 'chunked' });");
    lines.push('          const html = await renderPage(page, params, url);');
    lines.push("          const headEnd = html.indexOf('</head>');");
    lines.push('          if (headEnd > 0) {');
    lines.push("            nodeRes.write(html.slice(0, headEnd + 7));");
    lines.push("            nodeRes.end(html.slice(headEnd + 7));");
    lines.push('          } else {');
    lines.push('            nodeRes.end(html);');
    lines.push('          }');
    lines.push('          return;');
    lines.push('        }');
    lines.push('');
    lines.push('        const html = await renderPage(page, params, url);');
    lines.push('');
    lines.push('        // ISR: cache the result');
    lines.push('        if (revalidateMs > 0) {');
    lines.push('          isrSet(cacheKey, html, revalidateMs);');
    lines.push('        }');
    lines.push('');
    lines.push("        nodeRes.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });");
    lines.push('        nodeRes.end(html);');
    lines.push('      } catch (err) {');
    lines.push("        console.error('[ThenJS] Page render error ' + url.pathname + ':', err);");
    lines.push('        if (!nodeRes.writableEnded) {');
    lines.push("          nodeRes.writeHead(500, { 'content-type': 'text/html' });");
    lines.push("          nodeRes.end('<h1>500 — Internal Server Error</h1>');");
    lines.push('        }');
    lines.push('      }');
    lines.push('      return;');
    lines.push('    }');
    lines.push('  }');
  }

  // 404 fallback
  lines.push('');
  lines.push("  nodeRes.writeHead(404, { 'content-type': 'application/json' });");
  lines.push('  nodeRes.end(JSON.stringify({ error: "Not Found", path: url.pathname }));');
  lines.push('});');
  lines.push('');
  lines.push('server.listen(port, () => {');
  lines.push("  console.log('ThenJS server listening on :' + port);");
  lines.push('});');
  lines.push('');
  lines.push('// ─── Graceful Shutdown ───');
  lines.push('');
  lines.push('function _gracefulShutdown(signal) {');
  lines.push('  if (_isShuttingDown) return;');
  lines.push('  _isShuttingDown = true;');
  lines.push("  _log('info', 'shutdown initiated', { signal, inFlight: _inFlightRequests });");
  lines.push('');
  lines.push('  // Stop accepting new connections');
  lines.push('  server.close(() => {');
  lines.push("    _log('info', 'server closed, all connections drained');");
  lines.push('    process.exit(0);');
  lines.push('  });');
  lines.push('');
  // Close cron timers if tasks exist
  if (hasTasks) {
    lines.push('  // Stop cron scheduler');
    lines.push('  _cronJobs.length = 0;');
  }
  lines.push('');
  lines.push('  // Force exit after timeout if connections refuse to drain');
  lines.push('  const _forceTimer = setTimeout(() => {');
  lines.push("    _log('warn', 'shutdown timeout, forcing exit', { inFlight: _inFlightRequests });");
  lines.push('    process.exit(1);');
  lines.push('  }, _shutdownTimeoutMs);');
  lines.push('  if (_forceTimer.unref) _forceTimer.unref();');
  lines.push('');
  lines.push('  // Poll for in-flight requests to finish');
  lines.push('  const _drainCheck = setInterval(() => {');
  lines.push('    if (_inFlightRequests <= 0) {');
  lines.push('      clearInterval(_drainCheck);');
  lines.push('      clearTimeout(_forceTimer);');
  lines.push("      _log('info', 'all requests drained, exiting');");
  lines.push('      process.exit(0);');
  lines.push('    }');
  lines.push('  }, 100);');
  lines.push('  if (_drainCheck.unref) _drainCheck.unref();');
  lines.push('}');
  lines.push('');
  lines.push("process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));");
  lines.push("process.on('SIGINT', () => _gracefulShutdown('SIGINT'));");

  return lines.join('\n');
}

// ─── Page Render Helper (inline in server entry) ───

const RENDER_PAGE_CODE = [
  'async function renderPage(page, params, url) {',
  '  const mod = page.module;',
  '  const Component = mod.default;',
  '  const pageConfig = mod.page || {};',
  '  let serverData = {};',
  '',
  "  if (typeof mod.getServerData === 'function') {",
  '    serverData = await mod.getServerData({',
  '      params,',
  '      url: url.pathname,',
  '      query: Object.fromEntries(url.searchParams.entries()),',
  '    });',
  '  }',
  '',
  '  let vnode = Component({ ...serverData, params });',
  '',
  '  // Wrap in layout chain if layouts are defined (innermost first iteration)',
  '  if (page.layouts && page.layouts.length > 0) {',
  '    for (let li = page.layouts.length - 1; li >= 0; li--) {',
  '      const LayoutComponent = page.layouts[li].default;',
  "      if (typeof LayoutComponent === 'function') {",
  '        vnode = LayoutComponent({ children: vnode, params });',
  '      }',
  '    }',
  '  }',
  '',
  '  const bodyHtml = renderToString(vnode);',
  '',
  '  return wrapDocument(bodyHtml, {',
  "    title: pageConfig.title || 'ThenJS App',",
  '    meta: pageConfig.meta || [],',
  '    styles: pageConfig.styles || [],',
  '    scripts: pageConfig.scripts || [],',
  "    head: pageConfig.head || '',",
  '  });',
  '}',
].join('\n');

// ─── Server Entry Generator ───

/**
 * Generate a self-contained server entry for hot deployment.
 * Uses Node's built-in http module — no @celsian/core dependency required.
 * Runs on Fly/Railway/VPS/etc.
 */
export function generateServerEntry(manifest: RouteManifest, projectRoot: string): string {
  // Reset used var names for each server entry generation
  _usedVarNames.clear();

  const lines: string[] = [];
  const serverPages = manifest.pages.filter(p => p.mode === 'server' || p.mode === 'hybrid');
  const taskRoutes = manifest.api.filter(r => r.kind === 'task');
  const hasPages = serverPages.length > 0;
  const hasTasks = taskRoutes.length > 0;

  lines.push("import { createServer } from 'node:http';");

  // Load .env files before anything else reads process.env
  lines.push('');
  lines.push(DOTENV_CODE);

  // Pre-compute var names so each route/page gets a stable name
  const routeVarNames = new Map<string, string>();
  for (const route of manifest.api) {
    routeVarNames.set(route.filePath, routeToVarName(route));
  }
  const pageVarNames = new Map<string, string>();
  for (const page of serverPages) {
    pageVarNames.set(page.filePath, pageToVarName(page));
  }

  // Collect unique layout files used by server pages
  const layoutVarNames = new Map<string, string>();
  if (hasPages) {
    for (const page of serverPages) {
      if (page.layouts) {
        for (const layoutPath of page.layouts) {
          if (!layoutVarNames.has(layoutPath)) {
            layoutVarNames.set(layoutPath, layoutToVarName(layoutPath));
          }
        }
      }
    }
  }

  // Import API route handlers
  for (const route of manifest.api) {
    const varName = routeVarNames.get(route.filePath)!;
    const importPath = `./${relative('dist/server', join(projectRoot, route.filePath))}`.replace(/\.([mc])?tsx?$/, '.$1js').replace(/\\/g, '/');
    lines.push(`import * as ${varName} from '${importPath}';`);
  }

  // Import server-mode page modules
  for (const page of serverPages) {
    const varName = pageVarNames.get(page.filePath)!;
    const importPath = `./${relative('dist/server', join('dist/server/pages', page.filePath.replace(/^src\/pages\//, '')))}`.replace(/\.([mc])?tsx?$/, '.$1js').replace(/\\/g, '/');
    lines.push(`import * as ${varName} from '${importPath}';`);
  }

  // Import layout modules
  for (const [layoutPath, varName] of layoutVarNames) {
    const importPath = `./${relative('dist/server', join('dist/server/pages', layoutPath.replace(/^src\/pages\//, '')))}`.replace(/\.([mc])?tsx?$/, '.$1js').replace(/\\/g, '/');
    lines.push(`import * as ${varName} from '${importPath}';`);
  }

  // API routes table
  lines.push('');
  lines.push('const routes = [');
  for (const route of manifest.api) {
    const varName = routeVarNames.get(route.filePath)!;
    const methods = route.methods.map(m => `'${m}'`).join(', ');
    lines.push(`  { pattern: '${route.urlPattern}', methods: [${methods}], kind: '${route.kind}', handlers: ${varName} },`);
  }
  lines.push('];');

  // Page routes table
  if (hasPages) {
    lines.push('');
    lines.push('const pageRoutes = [');
    for (const page of serverPages) {
      const varName = pageVarNames.get(page.filePath)!;
      const configStr = JSON.stringify(page.config);
      const layoutsStr = page.layouts && page.layouts.length > 0
        ? `[${page.layouts.map(lp => layoutVarNames.get(lp)!).join(', ')}]`
        : 'null';
      lines.push(`  { pattern: '${page.urlPattern}', module: ${varName}, config: ${configStr}, layouts: ${layoutsStr} },`);
    }
    lines.push('];');
  }

  // Task routes table
  if (hasTasks) {
    lines.push('');
    lines.push('const taskRoutes = [');
    for (const route of taskRoutes) {
      const varName = routeVarNames.get(route.filePath)!;
      const taskName = route.urlPattern.replace(/^\/api\//, '').replace(/\//g, '.');
      const configStr = JSON.stringify(route.config);
      lines.push(`  { name: '${taskName}', handlers: ${varName}, config: ${configStr} },`);
    }
    lines.push('];');
  }

  // Inline utilities
  lines.push('');
  lines.push(LOGGER_CODE);
  lines.push('');
  lines.push(MATCH_ROUTE_CODE);
  lines.push('');
  lines.push(PARSE_BODY_CODE);

  // Inline static file serving
  lines.push('');
  lines.push(STATIC_FILE_CODE);

  // Inline validation and hook execution (always needed for API routes)
  lines.push('');
  lines.push(VALIDATION_CODE);
  lines.push('');
  lines.push(HOOKS_CODE);

  if (hasPages) {
    lines.push('');
    lines.push(MATCH_PAGE_ROUTE_CODE);
    lines.push('');
    lines.push(RENDER_TO_STRING_CODE);
    lines.push('');
    lines.push(WRAP_DOCUMENT_CODE);
    lines.push('');
    lines.push(ISR_CACHE_CODE);
    lines.push('');
    lines.push(RENDER_PAGE_CODE);
  }

  if (hasTasks) {
    lines.push('');
    lines.push(TASK_RUNNER_CODE);
    lines.push('');
    // Register cron jobs
    for (const route of taskRoutes) {
      const schedule = route.config.schedule as string | undefined;
      if (schedule) {
        const taskName = route.urlPattern.replace(/^\/api\//, '').replace(/\//g, '.');
        lines.push(`registerCron('${taskName}', '${schedule}');`);
      }
    }
    // Start cron AFTER all registrations
    lines.push('startCron();');
  }

  lines.push('');
  lines.push(generateServerCode(hasPages, hasTasks));

  return lines.join('\n');
}

// ─── Serverless Function Generator ───

/**
 * Generate a self-contained serverless function entry for a single API route.
 * No external dependencies — includes inline req/reply shim.
 */
export function generateFunctionEntry(route: ApiRoute, projectRoot: string): string {
  const importPath = `./${relative('dist/functions', join(projectRoot, route.filePath))}`.replace(/\.([mc])?tsx?$/, '.$1js').replace(/\\/g, '/');
  const varName = routeToVarName(route);

  return `import * as ${varName} from '${importPath}';

const handlers = { ${route.methods.map(m => `${m}: ${varName}.${m}`).join(', ')} };

function parseBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (!request.body) return Promise.resolve(null);
  if (ct.includes('application/json')) return request.json().catch(() => null);
  if (ct.includes('application/x-www-form-urlencoded')) return request.text().then(t => Object.fromEntries(new URLSearchParams(t)));
  return request.text();
}

// Worker-compatible fetch handler (Cloudflare Workers, Deno Deploy, etc.)
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const handlerFn = handlers[method];

    if (typeof handlerFn !== 'function') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: { 'content-type': 'application/json' } });
    }

    const body = await parseBody(request);
    const req = {
      method,
      url: url.pathname,
      headers: Object.fromEntries(request.headers.entries()),
      params: {},
      query: Object.fromEntries(url.searchParams.entries()),
      parsedBody: body,
    };

    let statusCode = 200;
    const responseHeaders = { 'content-type': 'application/json' };
    let responseBody = null;
    const reply = {
      status(code) { statusCode = code; return reply; },
      header(name, value) { responseHeaders[name] = value; return reply; },
      json(data) { responseBody = JSON.stringify(data); return null; },
      send(data) { responseBody = data; return null; },
    };

    const result = await handlerFn(req, reply);
    if (result instanceof Response) return result;
    if (responseBody !== null) return new Response(responseBody, { status: statusCode, headers: responseHeaders });
    if (result && typeof result === 'object') return new Response(JSON.stringify(result), { status: statusCode, headers: responseHeaders });
    return new Response(null, { status: 204 });
  },
};
`;
}

// ─── Task Entry Generator ───

/**
 * Generate a self-contained serverless entry for a task route.
 * Wraps the handler with timeout enforcement and retry metadata.
 */
export function generateTaskEntry(route: ApiRoute, projectRoot: string): string {
  const importPath = `./${relative('dist/functions', join(projectRoot, route.filePath))}`.replace(/\.([mc])?tsx?$/, '.$1js').replace(/\\/g, '/');
  const varName = routeToVarName(route);
  const timeoutMs = (route.config.timeout as number) || 30000;

  return `import * as ${varName} from '${importPath}';

const handler = ${varName}.POST;
const TIMEOUT_MS = ${timeoutMs};

function parseBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (!request.body) return Promise.resolve(null);
  if (ct.includes('application/json')) return request.json().catch(() => null);
  return request.text();
}

// Worker-compatible fetch handler for task execution
export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: { 'content-type': 'application/json' } });
    }

    const body = await parseBody(request);
    const taskId = body && body.taskId || String(Date.now());
    const attempt = body && body.attempt || 1;

    try {
      let timer;
      const result = await Promise.race([
        handler({ taskId, input: body && body.input, attempt }).then(r => { clearTimeout(timer); return r; }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Task timeout after ' + TIMEOUT_MS + 'ms')), TIMEOUT_MS); }),
      ]);

      return new Response(JSON.stringify({ taskId, attempt, status: 'completed', result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ taskId, attempt, status: 'failed', error: err.message }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  },
};
`;
}

// ─── Build Orchestrator ───

export interface BuildResult {
  serverEntry: string;
  functions: { route: ApiRoute; entryPath: string }[];
  taskEntries: { route: ApiRoute; entryPath: string }[];
  manifest: RouteManifest;
}

/**
 * Run the ThenJS build pipeline.
 *
 * 1. Generate server entry (for hot server deployment)
 * 2. Generate function entries (for serverless deployment)
 * 3. Generate task entries (for serverless task execution)
 * 4. Write manifest.json
 * 5. Run adapter.buildEnd() if configured
 */
export async function build(
  manifest: RouteManifest,
  config: ThenConfig,
  projectRoot: string,
): Promise<BuildResult> {
  const outDir = join(projectRoot, 'dist');
  const serverDir = join(outDir, 'server');
  const functionsDir = join(outDir, 'functions');

  // Ensure output directories
  await mkdir(serverDir, { recursive: true });
  await mkdir(functionsDir, { recursive: true });

  // 1. Generate server entry
  const serverEntryCode = generateServerEntry(manifest, projectRoot);
  const serverEntryPath = join(serverDir, 'entry.js');
  await writeFile(serverEntryPath, serverEntryCode);

  // 2. Generate function entries for serverless routes
  const functions: BuildResult['functions'] = [];
  const serverlessRoutes = manifest.api.filter(r => r.kind === 'serverless');

  for (const route of serverlessRoutes) {
    const funcName = route.urlPattern.replace(/[/:*]/g, '_').replace(/^_/, '');
    const funcDir = join(functionsDir, funcName);
    await mkdir(funcDir, { recursive: true });

    const entryCode = generateFunctionEntry(route, projectRoot);
    const entryPath = join(funcDir, 'index.js');
    await writeFile(entryPath, entryCode);

    functions.push({ route, entryPath });
  }

  // 3. Generate task entries for task routes
  const taskEntries: BuildResult['taskEntries'] = [];
  const taskRoutes = manifest.api.filter(r => r.kind === 'task');

  for (const route of taskRoutes) {
    const funcName = 'task_' + route.urlPattern.replace(/[/:*]/g, '_').replace(/^_/, '');
    const funcDir = join(functionsDir, funcName);
    await mkdir(funcDir, { recursive: true });

    const entryCode = generateTaskEntry(route, projectRoot);
    const entryPath = join(funcDir, 'index.js');
    await writeFile(entryPath, entryCode);

    taskEntries.push({ route, entryPath });
  }

  // 4. Write manifest
  await writeFile(
    join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  // 5. Run adapter if configured
  if (config.adapter) {
    const ctx: AdapterBuildContext = {
      serverEntry: serverEntryPath,
      clientDir: join(outDir, 'client'),
      manifest,
      projectRoot,
      outDir,
    };
    await config.adapter.buildEnd(ctx);
  }

  return { serverEntry: serverEntryPath, functions, taskEntries, manifest };
}

// ─── Helpers ───

const _usedVarNames = new Set<string>();

function routeToVarName(route: ApiRoute): string {
  let name = 'route_' + route.urlPattern
    .replace(/^\//, '')
    .replace(/[/:*\-]/g, '_')
    .replace(/_+/g, '_');
  const base = name;
  let i = 2;
  while (_usedVarNames.has(name)) { name = `${base}_${i++}`; }
  _usedVarNames.add(name);
  return name;
}

function pageToVarName(page: PageRoute): string {
  let name = 'page_' + (page.urlPattern === '/' ? 'index' : page.urlPattern
    .replace(/^\//, '')
    .replace(/[/:*\-]/g, '_')
    .replace(/_+/g, '_'));
  const base = name;
  let i = 2;
  while (_usedVarNames.has(name)) { name = `${base}_${i++}`; }
  _usedVarNames.add(name);
  return name;
}

function layoutToVarName(filePath: string): string {
  let name = 'layout_' + filePath
    .replace(/^src\/pages\//, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[/:*\-]/g, '_')
    .replace(/_+/g, '_');
  if (name === 'layout_' || name === 'layout__layout') name = 'layout_root';
  const base = name;
  let i = 2;
  while (_usedVarNames.has(name)) { name = `${base}_${i++}`; }
  _usedVarNames.add(name);
  return name;
}
