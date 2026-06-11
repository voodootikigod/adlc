// lib/capture.mjs — HTTP fixture capture logic
// Hits each route in the config and records observable HTTP behavior.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const DEFAULT_TIMEOUT_MS = 10_000;

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

  if (!config.baseUrl || typeof config.baseUrl !== 'string') {
    errors.push('config.baseUrl must be a non-empty string');
  } else {
    try {
      new URL(config.baseUrl);
    } catch {
      errors.push(`config.baseUrl is not a valid URL: ${config.baseUrl}`);
    }
  }

  if (!Array.isArray(config.routes) || config.routes.length === 0) {
    errors.push('config.routes must be a non-empty array');
  } else {
    for (const [i, route] of config.routes.entries()) {
      if (!route || typeof route !== 'object') {
        errors.push(`config.routes[${i}] must be an object`);
        continue;
      }
      if (!route.method || typeof route.method !== 'string') {
        errors.push(`config.routes[${i}].method must be a non-empty string`);
      }
      if (!route.path || typeof route.path !== 'string') {
        errors.push(`config.routes[${i}].path must be a non-empty string`);
      }
    }
  }

  return errors;
}

/**
 * Capture one route. Returns a result record.
 */
async function captureRoute(baseUrl, route, timeoutMs) {
  const { method, path, body, headers } = route;
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init = {
      method: method.toUpperCase(),
      headers: headers ?? {},
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

    let parsedBody;
    if (contentType.includes('application/json') || contentType.includes('+json')) {
      const text = await res.text();
      try {
        parsedBody = JSON.parse(text);
      } catch {
        // Fall back to text hash if body isn't valid JSON despite content-type
        parsedBody = { textHash: sha256hex(text), bytes: Buffer.byteLength(text, 'utf8') };
      }
    } else {
      const text = await res.text();
      parsedBody = { textHash: sha256hex(text), bytes: Buffer.byteLength(text, 'utf8') };
    }

    return { method: method.toUpperCase(), path, status, contentType, body: parsedBody };
  } catch (err) {
    const message = err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message;
    return { method: method.toUpperCase(), path, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a full capture for the given config.
 * Returns { baseUrl, capturedAt, routes: [...] }
 */
export async function runCapture(config, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const results = [];
  for (const route of config.routes) {
    const result = await captureRoute(config.baseUrl, route, timeoutMs);
    results.push(result);
  }
  return {
    baseUrl: config.baseUrl,
    capturedAt: new Date().toISOString(),
    routes: results,
  };
}

/**
 * Write a capture snapshot to a file.
 */
export function writeSnapshot(snapshot, outPath) {
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');
}

function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
