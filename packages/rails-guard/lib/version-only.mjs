// #228 — version-only manifest edits are not rail edits.
//
// A lockstep release rewrites every versioned package.json and host manifest in
// the repo. rails-guard sees those as ordinary file edits, so ANY live rail
// covering a versioned path failed on EVERY release — including rails belonging
// to genuinely in-flight tickets, which completing tickets cannot and should not
// fix. See docs/adr/0012-version-only-rail-exemption.md.
//
// ── WHY THE CANONICAL-FORM PRECONDITION EXISTS ──────────────────────────────
//
// Two earlier designs were built and both were rejected by cross-model
// prosecution, in MIRROR-IMAGE ways:
//
//   Walking JSON.parse output   — the parser is LOSSY, so documents that differ
//                                 compared equal: duplicate keys (last wins),
//                                 float precision (…992 vs …993), -0, 1e400 →
//                                 Infinity → "null", key order, [x] vs {"0":x}.
//                                 PARSE CANNOT SEE FIDELITY.
//
//   Comparing raw lines          — text has no idea which object encloses a
//                                 line. `"version"` indented two spaces inside
//                                 `scripts` is an npm LIFECYCLE COMMAND, not the
//                                 package version, and read as top-level.
//                                 TEXT CANNOT SEE STRUCTURE.
//
// Neither can be patched into the other's strength. So require BOTH at once,
// with one precondition:
//
//   *** each side must be byte-identical to JSON.stringify(parse(it), null, 2)
//       plus a trailing newline — its own canonical re-serialisation. ***
//
// That single check collapses the entire first class. A duplicate key does not
// survive a round trip, so the text differs and the file denies. So does a
// precision-losing number, a reordered key, a `-0`, a non-finite value, and any
// non-canonical formatting. What remains is a document whose PARSE IS PROVABLY
// FAITHFUL to its bytes — and on such a document, comparing by structural PATH
// is sound, which closes the second class.
//
// This costs nothing in practice: `scripts/release.mjs` writes manifests with
// exactly `JSON.stringify(obj, null, 2)`, so every manifest in this repo is
// already canonical. A manifest that is not simply fails closed.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST_BASENAMES = new Set(['package.json', 'plugin.json', 'marketplace.json']);

const DEP_FIELDS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

// npm's own limits (node-semver). A string exceeding them is NOT parsed as a
// version — npm classifies it as a dist-tag, which resolves to whatever that tag
// points at. Matching semver's grammar alone was not enough.
const MAX_LENGTH = 256;
const MAX_SAFE_COMPONENT_LENGTH = 16;

const NUM = '0|[1-9]\\d*';
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const PRE = `(?:-${PRE_ID}(?:\\.${PRE_ID})*)`;
const BUILD = '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)';
const SEMVER = `(?:${NUM})\\.(?:${NUM})\\.(?:${NUM})${PRE}?${BUILD}?`;

const VERSION_RE = new RegExp(`^${SEMVER}$`);
const RANGE_RE = new RegExp(`^([\\^~]?)(${SEMVER})$`);

/** A valid npm scoped name in this workspace. */
const ADLC_PKG = /^@adlc\/[a-z0-9][a-z0-9._-]*$/;

/** True when `file`'s basename is a manifest the exemption can apply to. */
export function isManifestFile(file) {
  if (typeof file !== 'string' || file === '') return false;
  return MANIFEST_BASENAMES.has(file.split('/').pop());
}

function manifestKind(file) {
  if (typeof file !== 'string') return null;
  const basename = file.split('/').pop();
  return MANIFEST_BASENAMES.has(basename) ? basename : null;
}

/**
 * Parse `text` ONLY if it is its own canonical re-serialisation.
 *
 * This is the load-bearing precondition. Returning the parsed value is a proof
 * obligation discharged: every later step may rely on the parse being a faithful
 * account of the bytes, because anything the parser would have silently dropped
 * or coerced makes the round trip differ and lands here as null.
 */
function parseCanonical(text) {
  if (typeof text !== 'string') return null;
  // UTF-8 DECODING IS NOT INJECTIVE. Every invalid byte decodes to U+FFFD, so
  // two files whose bytes genuinely differ — 0x80 in one, 0x81 in the other —
  // arrive here as the same string and compared equal. Requiring the text to
  // re-encode to itself proves the decode lost nothing, which is what makes the
  // rest of this function an argument about the FILE rather than about a string
  // that merely resembles it.
  // REDUNDANT, deliberately. Canonical equality below also rejects anything
  // unencodable (JSON.stringify escapes a lone surrogate, so the round trip
  // differs), which is why no test can distinguish this line's removal. Kept as
  // an explicit statement of the contract at the point it is relied on.
  if (Buffer.from(text, 'utf8').toString('utf8') !== text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // Only a plain object can be a manifest.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  let canonical;
  try {
    canonical = JSON.stringify(parsed, null, 2) + '\n';
  } catch {
    return null; // circular is impossible from JSON.parse, but never assume
  }
  if (canonical !== text) return null;
  return parsed;
}

/** A version npm would actually parse as a version, not classify as a tag. */
function isVersion(value) {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return false;
  if (!VERSION_RE.test(value)) return false;
  const [core] = value.split(/[-+]/);
  for (const part of core.split('.')) {
    // REDUNDANT with the MAX_SAFE_INTEGER check below — any component longer
    // than 16 digits already exceeds it — but kept because it is npm's own
    // stated limit and would still hold if the numeric check were relaxed.
    if (part.length > MAX_SAFE_COMPONENT_LENGTH) return false;
    if (Number(part) > Number.MAX_SAFE_INTEGER) return false;
  }
  return true;
}

/** Split a dependency range into operator and version, or null. */
function splitRange(value) {
  if (typeof value !== 'string') return null;
  const m = RANGE_RE.exec(value);
  // The isVersion half is currently unreachable: lockstep forces a range's
  // version to equal the manifest version, which is itself validated, so a range
  // cannot be invalid while its manifest is valid. Kept because it makes
  // splitRange correct standalone rather than only in its current caller.
  if (!m || !isVersion(m[2])) return null;
  return { operator: m[1], version: m[2] };
}

/**
 * Every leaf path in a canonical object, as JSON-encoded path arrays mapped to
 * their values. Containers are recorded too, so an added or removed key is a
 * differing entry rather than something inferred from the leaves.
 */
function walk(value, path, out) {
  if (value !== null && typeof value === 'object') {
    const isArray = Array.isArray(value);
    const keys = isArray ? value.map((_, i) => String(i)) : Object.keys(value);
    out.set(`K${JSON.stringify(path)}`, JSON.stringify([isArray ? 'A' : 'O', keys]));
    for (const key of keys) walk(value[key], [...path, key], out);
    return;
  }
  out.set(`V${JSON.stringify(path)}`, JSON.stringify(value));
}

/**
 * Is this the package's own version — the real top-level member, determined
 * STRUCTURALLY rather than by indentation?
 */
function isPackageVersionPath(path) {
  return path.length === 1 && path[0] === 'version';
}

/**
 * Marketplace manifests additionally version their metadata and each entry.
 *
 * `plugins` must be a REAL ARRAY on both sides. A numeric-looking key is not an
 * index: `{"plugins": {"0": {...}}}` produced the same path as `[{...}]`, and
 * the container-kind record cannot help because the shape is unchanged between
 * revisions — it is wrong in both.
 */
function isMarketplaceVersionPath(path, before, after) {
  if (path.length === 2 && path[0] === 'metadata' && path[1] === 'version') return true;
  if (path.length !== 3 || path[0] !== 'plugins' || path[2] !== 'version') return false;
  if (!/^\d+$/.test(path[1])) return false;
  return Array.isArray(before.plugins) && Array.isArray(after.plugins);
}

/**
 * Is this an internal dependency range? The enclosing field must be one of the
 * four real dependency fields — `config["@adlc/core"]` is not a dependency, and
 * a consumer can read it.
 */
function isAdlcRangePath(path) {
  return path.length === 2 && DEP_FIELDS.has(path[0]) && ADLC_PKG.test(path[1]);
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

/**
 * True when the ONLY differences between two manifest revisions are version
 * fields and lockstep @adlc/* dependency repins.
 *
 * @param {string|null|undefined} beforeText manifest at the freeze baseline
 * @param {string|null|undefined} afterText  manifest at HEAD
 * @param {string} [file] manifest path; scopes which version paths are legal
 * @returns {boolean} exempt — false on any doubt whatsoever
 */
export function isVersionOnlyChange(beforeText, afterText, file) {
  const kind = manifestKind(file);
  if (kind === null) return false;

  // THE PRECONDITION. Everything below depends on it.
  const before = parseCanonical(beforeText);
  const after = parseCanonical(afterText);
  if (before === null || after === null) return false;

  const beforeMap = new Map();
  const afterMap = new Map();
  walk(before, [], beforeMap);
  walk(after, [], afterMap);

  let versionChanged = false;
  const repins = [];

  for (const key of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    if (beforeMap.get(key) === afterMap.get(key)) continue;
    // A container's shape changed — a key added, removed, or reordered. This is
    // a second lock: a differing `K` entry would also fall through to the path
    // test below and be denied there, since no container path is ever an
    // eligible version or range path. Removing it therefore fails no test, which
    // is expected. It is kept so that a future eligible-path change cannot
    // accidentally make a structural edit exempt.
    if (key.startsWith('K')) return false;

    const path = JSON.parse(key.slice(1));
    const from = valueAt(before, path);
    const to = valueAt(after, path);

    const versionPath = isPackageVersionPath(path)
      || (kind === 'marketplace.json' && isMarketplaceVersionPath(path, before, after));

    if (versionPath) {
      if (!isVersion(from) || !isVersion(to)) return false;
      if (isPackageVersionPath(path)) versionChanged = true;
      continue;
    }

    if (isAdlcRangePath(path)) {
      const rFrom = splitRange(from);
      const rTo = splitRange(to);
      if (!rFrom || !rTo) return false;
      // The release tool PRESERVES each range's operator; a style change widens
      // or narrows what resolves and is not a repin.
      if (rFrom.operator !== rTo.operator) return false;
      repins.push({ from: rFrom, to: rTo });
      continue;
    }

    return false; // any other differing path
  }

  // LOCKSTEP MUST BE COMPLETE, NOT INCREMENTAL. Only inspecting ranges that
  // CHANGED let a package finish a bump with mixed internal versions: leave one
  // `@adlc/*` range at the old version and it is simply never consulted, so the
  // manifest ends up declaring 1.5.1 while depending on 1.5.0 of a sibling. A
  // release is all-or-nothing, so every internal range is checked, changed or
  // not, on both sides.
  if (versionChanged) {
    const oldVersion = before.version;
    const newVersion = after.version;
    if (!isVersion(oldVersion) || !isVersion(newVersion)) return false;
    for (const [root, expected] of [[before, oldVersion], [after, newVersion]]) {
      for (const field of DEP_FIELDS) {
        const deps = root[field];
        if (deps === undefined) continue;
        if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) return false;
        for (const [name, range] of Object.entries(deps)) {
          if (!ADLC_PKG.test(name)) continue;
          const split = splitRange(range);
          if (!split || split.version !== expected) return false;
        }
      }
    }
  }

  if (repins.length > 0) {
    // LOCKSTEP, on BOTH sides. Checking only the new target let a range cross a
    // major boundary during a legitimate bump (^0.1.0 → ^1.5.1), and checking
    // only that "a version changed" let a redirect ride along. A repin must move
    // FROM the old version TO the new one, exactly as release.mjs writes it.
    const oldVersion = before.version;
    const newVersion = after.version;
    if (!isVersion(oldVersion) || !isVersion(newVersion)) return false;
    // Intentionally redundant with the from/to comparison below: if the version
    // did not move then oldVersion === newVersion, so a range satisfying both
    // ends did not move either and would not be in `repins`. Kept as a second
    // lock so that weakening either one alone cannot open a redirect. No test
    // can distinguish its removal today, and that is expected — it is defence in
    // depth, not a distinct behaviour.
    // REDUNDANT since the completeness pass landed: that pass already requires
    // every baseline range to equal the OLD version and every result range the
    // NEW one, so a repin cannot appear without the version having moved.
    if (!versionChanged || oldVersion === newVersion) return false;
    // REDUNDANT with the completeness pass, which checks EVERY internal range on
    // both sides rather than only the ones that changed. Kept as a second lock:
    // if completeness were ever narrowed back to changed ranges, this still
    // pins the endpoints of those.
    for (const { from, to } of repins) {
      if (from.version !== oldVersion || to.version !== newVersion) return false;
    }
  }

  return true;
}

const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Resolve baseline and candidate (head) contents for a manifest path under full
 * mode, attribute, and encoding verification (matching bin/rails-guard.mjs).
 * Pinned to immutable git object revisions to prevent working-tree divergence attacks.
 * Fails closed (returns null) on any deviation, error, or unreadable content.
 *
 * @param {object} options
 * @param {string} options.base git ref of freeze baseline
 * @param {string} [options.head='HEAD'] git ref of candidate revision
 * @param {string} [options.cwd] working directory
 * @param {string} options.file repo-relative path to manifest
 * @returns {{before: string, after: string} | null}
 */
export function resolveManifestRevisionPair({ base, head = 'HEAD', cwd = process.cwd(), file }) {
  if (typeof file !== 'string' || file === '') return null;
  if (Buffer.from(file, 'utf8').toString('utf8') !== file) return null;
  if (typeof base !== 'string' || !base.trim()) return null;
  if (typeof head !== 'string' || !head.trim()) return null;

  try {
    const attrRes = spawnSync('git', ['check-attr', 'filter', 'ident', 'working-tree-encoding', '--', file], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    if (attrRes.status !== 0 || !attrRes.stdout) return null;
    for (const line of attrRes.stdout.split('\n')) {
      if (!line.trim()) continue;
      const value = line.slice(line.lastIndexOf(': ') + 2).trim();
      if (value !== 'unspecified' && value !== 'unset') return null;
    }

    const lsBaseRes = spawnSync('git', ['--literal-pathspecs', 'ls-tree', base, '--', file], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    if (lsBaseRes.status !== 0 || !lsBaseRes.stdout) return null;
    const baseMode = lsBaseRes.stdout.trim().split(/\s+/)[0];
    if (baseMode !== '100644' && baseMode !== '100755') return null;

    const lsHeadRes = spawnSync('git', ['--literal-pathspecs', 'ls-tree', head, '--', file], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    if (lsHeadRes.status !== 0 || !lsHeadRes.stdout) return null;
    const headMode = lsHeadRes.stdout.trim().split(/\s+/)[0];
    if (headMode !== '100644' && headMode !== '100755') return null;
    if (baseMode !== headMode) return null;

    const decode = (buf) => {
      const text = buf.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(buf)) return null;
      return text;
    };

    const showBaseRes = spawnSync('git', ['show', `${base}:${file}`], {
      cwd,
      encoding: 'buffer',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    if (showBaseRes.status !== 0 || !showBaseRes.stdout) return null;
    const before = decode(showBaseRes.stdout);
    if (before === null) return null;

    const showHeadRes = spawnSync('git', ['show', `${head}:${file}`], {
      cwd,
      encoding: 'buffer',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    if (showHeadRes.status !== 0 || !showHeadRes.stdout) return null;
    const after = decode(showHeadRes.stdout);
    if (after === null) return null;

    return { before, after };
  } catch {
    return null;
  }
}
