// lib/compare.mjs — load and compare two capture snapshots

import { readFileSync } from 'node:fs';
import { diffRoute, routeKey } from './diff.mjs';

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
  return parsed;
}

/**
 * Compare two snapshots.
 * Returns { identical, changed, onlyInBefore, onlyInAfter, routeResults }
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
      } else {
        changed.push(diff);
      }
    }
  }

  return { identical, changed, onlyInBefore, onlyInAfter };
}
