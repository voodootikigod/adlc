// lib/compare.mjs — load and compare two capture snapshots

import { readFileSync } from 'node:fs';
import { diffRoute, routeKey, isJsonBody } from './diff.mjs';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Load and parse a snapshot file.
 * Throws with a descriptive message on failure.
 */
export function loadSnapshot(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read snapshot file "${filePath}": ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`snapshot file "${filePath}" is not valid JSON: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.routes)) {
    throw new Error(`snapshot file "${filePath}" is missing required .routes array`);
  }
  if (parsed.routes.length === 0) {
    throw new Error(`snapshot file "${filePath}" has empty routes array`);
  }
  for (const [i, route] of parsed.routes.entries()) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new Error(`snapshot file "${filePath}" route at index ${i} is not an object`);
    }
    if (typeof route.method !== 'string' || route.method.trim() === '') {
      throw new Error(`snapshot file "${filePath}" route at index ${i} lacks non-empty string method`);
    }
    if (typeof route.path !== 'string' || route.path.trim() === '') {
      throw new Error(`snapshot file "${filePath}" route at index ${i} lacks non-empty string path`);
    }
    // capture writes exactly one of {status, contentType, body} or {error}.
    // diffRoute compares whatever is there, so two entries carrying NEITHER
    // (no HTTP result was ever captured) diff as identical — a false green.
    if (route.error !== undefined && typeof route.error !== 'string') {
      throw new Error(`snapshot file "${filePath}" route at index ${i} has a non-string error`);
    }
    // fetch() only ever yields an integer HTTP status in 100..599; anything
    // else (-1, 0, 999) is a failed or hand-made capture, not an observation.
    if (route.status !== undefined && !(Number.isInteger(route.status) && route.status >= 100 && route.status <= 599)) {
      throw new Error(`snapshot file "${filePath}" route at index ${i} has an invalid HTTP status (expected an integer 100-599): ${JSON.stringify(route.status)}`);
    }
    const hasError = typeof route.error === 'string' && route.error.trim() !== '';
    const hasStatus = route.status !== undefined;
    if (!hasError && !hasStatus) {
      throw new Error(`snapshot file "${filePath}" route at index ${i} records no observation (neither an integer status nor a non-empty error string)`);
    }
    if (hasError && hasStatus) {
      throw new Error(`snapshot file "${filePath}" route at index ${i} records both an error and a status`);
    }
    // A captured response is {status, contentType, body} — always all three
    // (see capture.mjs). A status-only entry compares missing contentType and
    // body as equal on both sides, so a changed body would read as identical.
    if (hasStatus && (typeof route.contentType !== 'string' || !Object.hasOwn(route, 'body'))) {
      throw new Error(`snapshot file "${filePath}" route at index ${i} is an incomplete observation (a captured response carries status, contentType and body)`);
    }
    // Non-JSON bodies are compared by hash (diffRoute), and a body without a
    // textHash compares null === null — two different malformed text bodies
    // would read as identical. capture writes {textHash, bytes} for text.
    if (hasStatus && !isJsonBody(route)) {
      const b = route.body;
      const wellFormed = !!b && typeof b === 'object' && !Array.isArray(b)
        && typeof b.textHash === 'string' && SHA256_HEX.test(b.textHash)
        && Number.isInteger(b.bytes) && b.bytes >= 0;
      if (!wellFormed) {
        throw new Error(`snapshot file "${filePath}" route at index ${i} has a malformed text body (expected {textHash: <sha256 hex>, bytes: <integer >= 0>} for content-type ${JSON.stringify(route.contentType)})`);
      }
    }
  }
  // compareSnapshots keys each side on routeKey() alone, so two entries sharing a
  // key silently collapse to the LAST one — a changed duplicate hidden behind an
  // unchanged duplicate reads as identical (false green). Refuse the snapshot.
  const seen = new Set();
  for (const [i, route] of parsed.routes.entries()) {
    const key = routeKey(route);
    if (seen.has(key)) {
      throw new Error(`snapshot file "${filePath}" route at index ${i} duplicates an earlier "${key}" entry — a duplicate key would be silently collapsed by compare`);
    }
    seen.add(key);
  }
  return parsed;
}

/**
 * Compare two snapshots.
 * Returns { identical, changed, unreachable, onlyInBefore, onlyInAfter }.
 *
 * `unreachable` holds routes that errored on BOTH sides (dead in before and
 * after). These are surfaced separately so an all-error before/after pair can
 * never be reported as a clean "identical" pass through the P6 human gate.
 */
export function compareSnapshots(before, after) {
  const beforeMap = new Map();
  for (const r of before.routes) {
    beforeMap.set(routeKey(r), r);
  }

  const afterMap = new Map();
  for (const r of after.routes) {
    afterMap.set(routeKey(r), r);
  }

  const allKeys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const identical = [];
  const changed = [];
  const unreachable = [];
  const onlyInBefore = [];
  const onlyInAfter = [];

  for (const key of allKeys) {
    const b = beforeMap.get(key);
    const a = afterMap.get(key);

    if (b && !a) {
      onlyInBefore.push(key);
    } else if (a && !b) {
      onlyInAfter.push(key);
    } else {
      const diff = diffRoute(b, a);
      if (diff === null) {
        identical.push(key);
      } else if (diff.unreachable) {
        unreachable.push({ route: diff.route, error: diff.error });
      } else {
        changed.push(diff);
      }
    }
  }

  return { identical, changed, unreachable, onlyInBefore, onlyInAfter };
}
