// lib/diff.mjs — structural JSON diff engine (pure functions, no side effects)
// Returns a list of change descriptors: { path, type, before, after }

const MAX_PATHS = 50;

/**
 * Recursively diff two JSON values, collecting change descriptors.
 * @param {*} before
 * @param {*} after
 * @param {string} path - dot-notation path prefix
 * @param {Array} changes - accumulator (mutated internally only)
 * @returns {Array<{path, type, before, after}>}
 */
function collectChanges(before, after, path, changes, limit) {
  if (limit !== undefined && changes.length >= limit) return changes;

  // Identical (primitive or same reference)
  if (before === after) return changes;

  const beforeType = typeOf(before);
  const afterType = typeOf(after);

  // Type mismatch — report as a single valueChanged
  if (beforeType !== afterType) {
    changes.push({ path: path || '(root)', type: 'typeChanged', before, after });
    return changes;
  }

  if (beforeType === 'array') {
    diffArrays(before, after, path, changes, limit);
    return changes;
  }

  if (beforeType === 'object') {
    diffObjects(before, after, path, changes, limit);
    return changes;
  }

  // Primitive inequality
  if (before !== after) {
    changes.push({ path: path || '(root)', type: 'valueChanged', before, after });
  }

  return changes;
}

function diffArrays(before, after, path, changes, limit) {
  if (before.length !== after.length) {
    changes.push({
      path: path || '(root)',
      type: 'arrayLengthChanged',
      before: before.length,
      after: after.length,
    });
  }
  const len = Math.min(before.length, after.length);
  for (let i = 0; i < len; i++) {
    if (limit !== undefined && changes.length >= limit) break;
    const elemPath = `${path}[${i}]`;
    collectChanges(before[i], after[i], elemPath, changes, limit);
    // Cap: only report first divergent index details then stop array recursion
    if (changes.length > 0) {
      const lastWasForThisIndex = changes[changes.length - 1].path.startsWith(elemPath);
      if (lastWasForThisIndex) break; // found first divergent index, stop drilling further into array
    }
  }
}

function diffObjects(before, after, path, changes, limit) {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (limit !== undefined && changes.length >= limit) break;
    const keyPath = path ? `${path}.${key}` : key;
    if (!(key in before)) {
      changes.push({ path: keyPath, type: 'keyAdded', after: after[key] });
    } else if (!(key in after)) {
      changes.push({ path: keyPath, type: 'keyRemoved', before: before[key] });
    } else {
      collectChanges(before[key], after[key], keyPath, changes, limit);
    }
  }
}

function typeOf(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

/**
 * Diff two JSON body values.
 * Returns { changes, capped, total } where capped is true if MAX_PATHS was hit,
 * changes is capped to MAX_PATHS, and total is the full count of changes found.
 */
export function diffJson(before, after) {
  const allChanges = [];
  collectChanges(before, after, '', allChanges, undefined);
  const total = allChanges.length;
  const capped = total > MAX_PATHS;
  return { changes: allChanges.slice(0, MAX_PATHS), capped, total };
}

/**
 * Produce a per-route diff comparing a before-capture entry to an after-capture entry.
 * Returns a change descriptor object or null if identical.
 */
export function diffRoute(beforeEntry, afterEntry) {
  const diffs = [];

  if (beforeEntry.error && afterEntry.error) {
    if (beforeEntry.error !== afterEntry.error) {
      diffs.push({ field: 'error', before: beforeEntry.error, after: afterEntry.error });
    }
    return diffs.length ? { route: routeKey(beforeEntry), diffs } : null;
  }

  if (beforeEntry.error || afterEntry.error) {
    diffs.push({
      field: 'error',
      before: beforeEntry.error ?? null,
      after: afterEntry.error ?? null,
    });
    return { route: routeKey(beforeEntry), diffs };
  }

  if (beforeEntry.status !== afterEntry.status) {
    diffs.push({ field: 'status', before: beforeEntry.status, after: afterEntry.status });
  }

  if (normalizeContentType(beforeEntry.contentType) !== normalizeContentType(afterEntry.contentType)) {
    diffs.push({ field: 'contentType', before: beforeEntry.contentType, after: afterEntry.contentType });
  }

  // Body diff: prefer structural for JSON, hash-based for text
  const beforeBody = beforeEntry.body;
  const afterBody = afterEntry.body;

  if (isJsonBody(beforeEntry) && isJsonBody(afterEntry)) {
    const { changes, capped, total } = diffJson(beforeBody, afterBody);
    if (changes.length > 0) {
      diffs.push({ field: 'body', type: 'json', changes, capped, total });
    }
  } else {
    // Text: compare by hash
    const beforeHash = beforeBody?.textHash ?? null;
    const afterHash = afterBody?.textHash ?? null;
    if (beforeHash !== afterHash) {
      diffs.push({
        field: 'body',
        type: 'text',
        before: { textHash: beforeHash, bytes: beforeBody?.bytes },
        after: { textHash: afterHash, bytes: afterBody?.bytes },
      });
    }
  }

  return diffs.length ? { route: routeKey(beforeEntry), diffs } : null;
}

function isJsonBody(entry) {
  const ct = entry.contentType ?? '';
  return ct.includes('application/json') || ct.includes('+json');
}

function normalizeContentType(ct) {
  if (!ct) return '';
  // Strip parameters like charset
  return ct.split(';')[0].trim().toLowerCase();
}

export function routeKey(entry) {
  return `${entry.method} ${entry.path}`;
}
