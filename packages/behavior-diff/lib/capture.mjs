// lib/capture.mjs — HTTP fixture capture logic
// Hits each route in the config and records observable HTTP behavior.

import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, writeFileSync, renameSync } from 'node:fs';
import { routeKey } from './diff.mjs';
import { validateCommandsConfig, runCommandsCapture } from './cli-capture.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 1024 * 1024;
const OMITTED_HEADERS = new Set([
  'date', 'etag', 'x-request-id', 'x-trace-id', 'keep-alive', 'connection', 'transfer-encoding',
  'set-cookie', 'www-authenticate', 'proxy-authenticate', 'authorization', 'proxy-authorization',
]);

/** Normalize response headers into a sorted lowercase map, omitting volatile transport and credential headers. */
export function normalizeResponseHeaders(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== 'function') return out;
  const pairs = [];
  headers.forEach((value, key) => {
    const k = String(key).toLowerCase();
    if (OMITTED_HEADERS.has(k)) return;
    pairs.push([k, String(value).trim()]);
  });
  pairs.sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of pairs) out[k] = v;
  return out;
}

/** Read a fetch Response body up to `maxBytes` without buffering unbounded responses in memory. */
export async function readBoundedBody(res, maxBytes = MAX_BODY_BYTES) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    const buf = Buffer.from(text, 'utf8');
    if (buf.length > maxBytes) {
      return { text: buf.subarray(0, maxBytes).toString('utf8'), bytes: buf.length, truncated: true };
    }
    return { text, bytes: buf.length, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      total += buf.length;
      if (total > maxBytes) {
        const remaining = maxBytes - (total - buf.length);
        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
        truncated = true;
        try { await reader.cancel(); } catch {}
        break;
      }
      chunks.push(buf);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes: total, truncated };
}

function routePathHasDotDot(p) {
  return p.split('/').includes('..');
}

/**
 * Validate a capture config object.
 * Returns an array of error strings (empty = valid).
 */
export function validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    errors.push('config must be a JSON object');
    return errors;
  }

  const hasRoutes = config.routes !== undefined;
  const hasCommands = config.commands !== undefined;

  let parsedBase = null;
  if (hasRoutes || !hasCommands || config.baseUrl !== undefined) {
    if (!config.baseUrl || typeof config.baseUrl !== 'string') {
      errors.push('config.baseUrl must be a non-empty string');
    } else {
      try {
        parsedBase = new URL(config.baseUrl);
        if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
          errors.push(`config.baseUrl must use http: or https: scheme: ${config.baseUrl}`);
          parsedBase = null;
        }
      } catch {
        errors.push(`config.baseUrl is not a valid URL: ${config.baseUrl}`);
      }
    }
  }

  if (hasRoutes || !hasCommands) {
    if (!Array.isArray(config.routes) || config.routes.length === 0) {
      errors.push('config.routes must be a non-empty array');
    } else {
      // Snapshots are compared by routeKey(route) (see compare.mjs), so two
      // probes of the same route without distinct scenario ids cannot both be observed —
      // the later one silently replaces the earlier. Refuse the config up front
      // rather than capture a snapshot compare will reject or, worse, collapse.
      const seen = new Set();
      for (const [i, route] of config.routes.entries()) {
        if (!route || typeof route !== 'object') {
          errors.push(`config.routes[${i}] must be an object`);
          continue;
        }
        if (route.id !== undefined && (typeof route.id !== 'string' || route.id.trim() === '')) {
          errors.push(`config.routes[${i}].id must be a non-empty string when provided`);
        }
        // trim() on both, matching loadSnapshot: a whitespace-only method or
        // path would capture "successfully" into a snapshot compare then rejects.
        if (typeof route.method !== 'string' || route.method.trim() === '') {
          errors.push(`config.routes[${i}].method must be a non-empty string`);
        }
        if (typeof route.path !== 'string' || route.path.trim() === '') {
          errors.push(`config.routes[${i}].path must be a non-empty string`);
        } else if (!route.path.startsWith('/') || route.path.startsWith('//') || routePathHasDotDot(route.path)) {
          errors.push(`config.routes[${i}].path must start with "/" and not contain "//" or "..": ${route.path}`);
        } else if (parsedBase) {
          const resolved = new URL(route.path, parsedBase);
          if (resolved.origin !== parsedBase.origin) {
            errors.push(`config.routes[${i}].path resolves outside baseUrl origin: ${route.path}`);
          }
        }
        const idValid = route.id === undefined || (typeof route.id === 'string' && route.id.trim() !== '');
        if (typeof route.method === 'string' && typeof route.path === 'string' && idValid) {
          const key = routeKey(route);
          if (seen.has(key)) {
            errors.push(`config.routes[${i}] duplicates an earlier "${key}" route — duplicate routes are compared by method+path only and would silently collapse`);
          }
          seen.add(key);
        }
      }
    }
  }

  if (hasCommands) {
    errors.push(...validateCommandsConfig(config.commands));
  }

  return errors;
}

/**
 * Capture one route. Returns a result record.
 */
async function captureRoute(baseUrl, route, timeoutMs) {
  const { method, path, body, headers } = route;
  const id = typeof route.id === 'string' && route.id.trim() !== '' ? route.id.trim() : undefined;
  const idField = id !== undefined ? { id } : {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const baseObj = new URL(baseUrl);
    if (baseObj.protocol !== 'http:' && baseObj.protocol !== 'https:') {
      throw new Error(`unsupported baseUrl protocol: ${baseObj.protocol}`);
    }
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || routePathHasDotDot(path)) {
      throw new Error(`invalid route path: ${path}`);
    }
    const targetObj = new URL(path, baseObj);
    if (targetObj.origin !== baseObj.origin) {
      throw new Error(`route path escapes baseUrl origin: ${path}`);
    }
    const url = targetObj.href;

    const init = {
      method: method.toUpperCase(),
      headers: headers ?? {},
      redirect: 'manual',
      signal: controller.signal,
    };

    if (body !== undefined) {
      if (typeof body === 'object') {
        init.body = JSON.stringify(body);
        init.headers = { 'Content-Type': 'application/json', ...init.headers };
      } else {
        init.body = String(body);
      }
    }

    const res = await fetch(url, init);
    const status = res.status;
    const contentType = res.headers.get('content-type') ?? '';
    const responseHeaders = normalizeResponseHeaders(res.headers);
    const { text, bytes, truncated } = await readBoundedBody(res, MAX_BODY_BYTES);

    let parsedBody;
    if (!truncated && (contentType.includes('application/json') || contentType.includes('+json'))) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        // Fall back to text hash if body isn't valid JSON despite content-type
        parsedBody = { textHash: sha256hex(text), bytes };
      }
    } else {
      parsedBody = { textHash: sha256hex(text), bytes, ...(truncated ? { truncated: true } : {}) };
    }

    return { ...idField, method: method.toUpperCase(), path, status, contentType, headers: responseHeaders, body: parsedBody };
  } catch (err) {
    const message = err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message;
    return { ...idField, method: method.toUpperCase(), path, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a full capture for the given config.
 * Returns { baseUrl?, capturedAt, routes?: [...], commands?: [...] }
 */
export async function runCapture(config, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const snapshot = {};
  if (config.baseUrl !== undefined) {
    snapshot.baseUrl = config.baseUrl;
  }
  snapshot.capturedAt = new Date().toISOString();

  if (Array.isArray(config.routes)) {
    const results = [];
    for (const route of config.routes) {
      const result = await captureRoute(config.baseUrl, route, timeoutMs);
      results.push(result);
    }
    snapshot.routes = results;
  }

  if (Array.isArray(config.commands)) {
    snapshot.commands = await runCommandsCapture(config.commands, timeoutMs);
  }

  return snapshot;
}

/**
 * Count how many routes/commands in a snapshot returned a real observation
 * (i.e. were reachable — no transport/spawn/timeout error recorded).
 * An entry is "reachable" iff it has no `.error` field.
 */
export function reachableCount(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  let count = 0;
  if (Array.isArray(snapshot.routes)) {
    count += snapshot.routes.filter((r) => !r.error).length;
  }
  if (Array.isArray(snapshot.commands)) {
    count += snapshot.commands.filter((c) => !c.error).length;
  }
  return count;
}

/**
 * Write a capture snapshot to a file.
 */
export function writeSnapshot(snapshot, outPath) {
  const tmpPath = `${outPath}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(tmpPath, 'wx');
  try {
    writeFileSync(fd, JSON.stringify(snapshot, null, 2), 'utf8');
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, outPath);
}
function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
