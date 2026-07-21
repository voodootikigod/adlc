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

// STRICT semver, per semver.org's own BNF. The looser earlier form
// `-[0-9A-Za-z.-]+` accepted values npm does NOT read as versions:
// `1.2.3-a..b` (empty prerelease identifier) is classified by npm-package-arg as
// type=TAG, so it resolves to whatever that dist-tag points at — a dependency
// redirection wearing a version's clothes. Leading zeros are likewise invalid
// semver but matched `\d+`. Each identifier is now spelled out.
const NUM = '0|[1-9]\\d*';                                  // no leading zeros
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;      // non-empty
const PRE = `(?:-${PRE_ID}(?:\\.${PRE_ID})*)`;
const BUILD = '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)';   // non-empty
const CORE = `(?:${NUM})\\.(?:${NUM})\\.(?:${NUM})`;
const SEMVER = `${CORE}${PRE}?${BUILD}?`;

const VERSION = new RegExp(`^${SEMVER}$`);
// A dependency range as scripts/release.mjs writes it: caret, tilde, or exact.
const RANGE = new RegExp(`^[\\^~]?${SEMVER}$`);

// A valid scoped package name in this workspace. `startsWith('@adlc/')` also
// accepted `@adlc/` and `@adlc/foo/bar`, which npm rejects outright — a key npm
// cannot resolve is not a lockstep repin.
const ADLC_PKG = /^@adlc\/[a-z0-9][a-z0-9._-]*$/;

/** True when `file`'s basename is a manifest the exemption can apply to. */
export function isManifestFile(file) {
  if (typeof file !== 'string' || file === '') return false;
  const basename = file.split('/').pop();
  return MANIFEST_BASENAMES.has(basename);
}

/** The manifest kind, used to scope which version paths are legal where. */
function manifestKind(file) {
  if (typeof file !== 'string') return null;
  const basename = file.split('/').pop();
  return MANIFEST_BASENAMES.has(basename) ? basename : null;
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
  out.set(`V${JSON.stringify(path)}`, encodeLeaf(value));
}

/**
 * Encode a leaf so that DISTINCT values never share an encoding.
 *
 * `JSON.stringify` alone collides in ways JSON.parse creates for free:
 *   JSON.parse('1e400')  → Infinity, and JSON.stringify(Infinity) === 'null'
 *   so `1e400` and `null` both encoded as "null" and compared equal.
 *   JSON.stringify(-0) === '0', so 0 and -0 compared equal.
 * A collision here means a real difference is invisible and the change is
 * exempted. Type-tagging plus a non-lossy numeric form closes both.
 */
function encodeLeaf(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') {
    if (Number.isNaN(value)) return 'n:NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'n:+Inf' : 'n:-Inf';
    if (Object.is(value, -0)) return 'n:-0';
    return `n:${value}`;
  }
  if (type === 'string') return `s:${value}`;
  if (type === 'boolean') return `b:${value}`;
  return `?:${String(value)}`; // unreachable for JSON, encoded rather than dropped
}

/**
 * Is this leaf path one the exemption recognises, FOR THIS MANIFEST KIND?
 *
 * The kind matters. `metadata.version` and `plugins[i].version` are marketplace
 * concepts; accepting them inside a `package.json` widened the exemption to paths
 * that mean nothing there and that no release ever writes.
 */
function isVersionPath(path, kind) {
  // package.json / plugin.json / marketplace.json: top-level version
  if (path.length === 1 && path[0] === 'version') return true;
  if (kind !== 'marketplace.json') return false;
  if (path.length === 2 && path[0] === 'metadata' && path[1] === 'version') return true;
  if (path.length === 3 && path[0] === 'plugins' && /^\d+$/.test(path[1]) && path[2] === 'version') {
    return true;
  }
  return false;
}

/** Is this leaf path an @adlc/* dependency range the bump repins in lockstep? */
function isAdlcRangePath(path) {
  return path.length === 2 && DEP_FIELDS.has(path[0]) && ADLC_PKG.test(path[1]);
}

/** Strip a leading ^ or ~ to compare a range's target against a version. */
function rangeTarget(range) {
  return range.replace(/^[\^~]/, '');
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
 * @param {string} [file] manifest path, so version paths can be scoped to the
 *        manifest KIND. Omitted → only the universal top-level `version` is
 *        eligible, which is the conservative direction.
 * @returns {boolean} exempt — false on any doubt whatsoever
 */
export function isVersionOnlyChange(beforeText, afterText, file) {
  const before = parseObject(beforeText);
  const after = parseObject(afterText);
  // A missing side means the file was added or deleted. Neither is a version bump.
  if (before === null || after === null) return false;

  const kind = manifestKind(file);

  const beforeLeaves = new Map();
  const afterLeaves = new Map();
  try {
    collect(before, [], beforeLeaves);
    collect(after, [], afterLeaves);
  } catch {
    return false; // too deep, or any other walk failure → not exempt
  }

  const allKeys = new Set([...beforeLeaves.keys(), ...afterLeaves.keys()]);
  const changedRanges = [];

  for (const key of allKeys) {
    if (beforeLeaves.get(key) === afterLeaves.get(key)) continue;

    // A container's key set changed → something was added, removed, or reordered.
    // Never exempt: this is the structural change the whole guard exists to catch.
    if (key.startsWith('K')) return false;

    const path = JSON.parse(key.slice(1));
    const isVersion = isVersionPath(path, kind);
    const isRange = isAdlcRangePath(path);
    if (!isVersion && !isRange) return false;

    const from = valueAt(before, path);
    const to = valueAt(after, path);
    // Both sides must be plain strings of the expected shape. This is what stops
    // a payload — a path, a git URL, an object — riding in on an allowed path.
    if (typeof from !== 'string' || typeof to !== 'string') return false;
    const pattern = isVersion ? VERSION : RANGE;
    if (!pattern.test(from) || !pattern.test(to)) return false;
    if (isRange) changedRanges.push(to);
  }

  // LOCKSTEP IS AN INVARIANT, NOT A LABEL. Without this, `@adlc/core: ^1.0.0` →
  // `^9.0.0` was exempt even with no version change at all — a dependency
  // redirection through an allowed path, which is precisely what the value-shape
  // checks were meant to prevent. In a lockstep monorepo every repinned range
  // targets the manifest's OWN new version, so require exactly that.
  if (changedRanges.length > 0) {
    const declared = after.version;
    if (typeof declared !== 'string' || !VERSION.test(declared)) return false;
    if (changedRanges.some((range) => rangeTarget(range) !== declared)) return false;
  }

  return true;
}
