// #228 — version-only manifest edits are not rail edits.
//
// A lockstep release rewrites every versioned package.json and host manifest in
// the repo. rails-guard sees those as ordinary file edits, so ANY live rail
// covering a versioned path fails on EVERY release — including rails belonging
// to genuinely in-flight tickets, which completing tickets cannot and should not
// fix. See docs/adr/0012-version-only-rail-exemption.md.
//
// A rail exists to stop an agent editing frozen BEHAVIOUR mid-build. A version
// bump changes no behaviour: it is a mechanical, tool-generated rewrite of one
// field, applied uniformly, already gated by scripts/release.mjs's own drift and
// publish-metadata checks.
//
// EVERYTHING here fails closed. The exemption applies only when the change is
// provably nothing but version fields; any parse failure, any unrecognised
// differing path, any value that is not a plain version string, and any
// structural change (added/removed/reordered keys) denies the exemption and the
// edit is reported as an ordinary rail violation.

const MANIFEST_BASENAMES = new Set(['package.json', 'plugin.json', 'marketplace.json']);

const DEP_FIELDS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

// Exact semver. Deliberately strict: no ranges, no URLs, no paths, no empty.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// A dependency range as scripts/release.mjs writes it: caret, tilde, or exact.
const RANGE = /^[\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** True when `file`'s basename is a manifest the exemption can apply to. */
export function isManifestFile(file) {
  if (typeof file !== 'string' || file === '') return false;
  const basename = file.split('/').pop();
  return MANIFEST_BASENAMES.has(basename);
}

// A manifest nested deeper than this is not a lockstep version bump. Capping the
// walk keeps `collect` from exhausting the stack on hostile input; exceeding the
// cap denies the exemption rather than throwing.
const MAX_DEPTH = 100;

class TooDeep extends Error {}

/**
 * Walk `value`, recording every leaf under its full path AND the shape of every
 * container. Recording container shape is what makes additions, removals, and
 * reordering visible as differing paths rather than slipping through because each
 * surviving leaf happened to match.
 *
 * Two details are load-bearing and must not be "tidied":
 *
 *  - Keys are recorded in DECLARATION ORDER, never sorted. Object key order is
 *    behaviour in a manifest: Node resolves conditional `exports` first-match-wins,
 *    so reordering `{"node":…,"default":…}` changes which module loads while every
 *    leaf value stays identical. Sorting here made that reorder invisible.
 *  - The container KIND is recorded alongside the keys. Without it `[{…}]` and
 *    `{"0":{…}}` produce identical records, so an array could be swapped for an
 *    object (or vice versa) undetected.
 */
function collect(value, path, out, depth = 0) {
  if (depth > MAX_DEPTH) throw new TooDeep();
  if (value !== null && typeof value === 'object') {
    const isArray = Array.isArray(value);
    const keys = isArray ? value.map((_, i) => String(i)) : Object.keys(value);
    out.set(`K${JSON.stringify(path)}`, JSON.stringify([isArray ? 'A' : 'O', keys]));
    for (const key of keys) {
      collect(value[key], [...path, key], out, depth + 1);
    }
    return;
  }
  out.set(`V${JSON.stringify(path)}`, JSON.stringify(value));
}

/** Is this leaf path one the exemption recognises? */
function isVersionPath(path) {
  // package.json / plugin.json: top-level version
  if (path.length === 1 && path[0] === 'version') return true;
  // marketplace.json: metadata.version
  if (path.length === 2 && path[0] === 'metadata' && path[1] === 'version') return true;
  // marketplace.json: plugins[i].version
  if (path.length === 3 && path[0] === 'plugins' && /^\d+$/.test(path[1]) && path[2] === 'version') {
    return true;
  }
  return false;
}

/** Is this leaf path an @adlc/* dependency range the bump repins in lockstep? */
function isAdlcRangePath(path) {
  return path.length === 2 && DEP_FIELDS.has(path[0]) && path[1].startsWith('@adlc/');
}

function valueAt(root, path) {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function parseObject(text) {
  if (typeof text !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // Only a plain object can be a manifest. Arrays/scalars/null are refused so a
  // wholesale document-shape change can never read as version-only.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * True when the ONLY differences between two manifest revisions are version
 * fields and lockstep @adlc/* dependency repins.
 *
 * @param {string|null|undefined} beforeText manifest at the freeze baseline
 * @param {string|null|undefined} afterText  manifest at HEAD
 * @returns {boolean} exempt — false on any doubt whatsoever
 */
export function isVersionOnlyChange(beforeText, afterText) {
  const before = parseObject(beforeText);
  const after = parseObject(afterText);
  // A missing side means the file was added or deleted. Neither is a version bump.
  if (before === null || after === null) return false;

  const beforeLeaves = new Map();
  const afterLeaves = new Map();
  try {
    collect(before, [], beforeLeaves);
    collect(after, [], afterLeaves);
  } catch {
    return false; // too deep, or any other walk failure → not exempt
  }

  const allKeys = new Set([...beforeLeaves.keys(), ...afterLeaves.keys()]);

  for (const key of allKeys) {
    if (beforeLeaves.get(key) === afterLeaves.get(key)) continue;

    // A container's key set changed → something was added, removed, or reordered.
    // Never exempt: this is the structural change the whole guard exists to catch.
    if (key.startsWith('K')) return false;

    const path = JSON.parse(key.slice(1));
    const isVersion = isVersionPath(path);
    const isRange = isAdlcRangePath(path);
    if (!isVersion && !isRange) return false;

    const from = valueAt(before, path);
    const to = valueAt(after, path);
    // Both sides must be plain strings of the expected shape. This is what stops
    // a payload — a path, a git URL, an object — riding in on an allowed path.
    if (typeof from !== 'string' || typeof to !== 'string') return false;
    const pattern = isVersion ? VERSION : RANGE;
    if (!pattern.test(from) || !pattern.test(to)) return false;
  }

  return true;
}
