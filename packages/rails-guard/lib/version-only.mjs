// #228 — version-only manifest edits are not rail edits.
//
// A lockstep release rewrites every versioned package.json and host manifest in
// the repo. rails-guard sees those as ordinary file edits, so ANY live rail
// covering a versioned path failed on EVERY release — including rails belonging
// to genuinely in-flight tickets, which completing tickets cannot and should not
// fix. See docs/adr/0012-version-only-rail-exemption.md.
//
// ── WHY THIS COMPARES TEXT AND NOT PARSED JSON ──────────────────────────────
//
// The first two implementations walked `JSON.parse` output and compared values.
// Cross-model prosecution rejected both, because `JSON.parse` is LOSSY BY
// DESIGN and every loss is a place where two different documents compare equal:
//
//   duplicate keys      {"a":1,"a":2}      → last wins; the first is erased
//   float precision     9007199254740993   → 9007199254740992
//   -0 / Infinity       1e400              → Infinity, stringifies as "null"
//   key order           behaviour for `exports`, invisible after sorting
//   array vs object     [x] and {"0":x}    → identical after a naive walk
//
// Patching them one at a time is unbounded: the tail is however lossy the parser
// is, and the parser is not ours. So the security decision no longer depends on
// parse fidelity at all.
//
// Instead: a lockstep bump changes ONLY version LINES, and nothing else about
// the file. Verified against this repo — bumping a package rewrites exactly its
// `"version"` line and its `"@adlc/*"` dependency lines, nothing more. So the
// rule is simply:
//
//   same line count, and every line that differs must be a version line on BOTH
//   sides, with identical indentation, key, quoting and trailing comma.
//
// Anything else on a changed line — a smuggled field, a reformat, an inserted or
// deleted line, a reordering — fails the positional comparison and denies. The
// parser's losses become irrelevant because the parser is not consulted.

const MANIFEST_BASENAMES = new Set(['package.json', 'plugin.json', 'marketplace.json']);

// NOTE: a line-level check cannot see which object encloses a member, so an
// `@adlc/*` key is treated as a repin wherever it appears rather than only under
// dependencies/devDependencies/peerDependencies/optionalDependencies. This is a
// deliberate trade for not trusting the parser. It is not a widening in
// practice: the value on such a line is still forced to be a valid range whose
// version equals this manifest's own new version, so the only thing it can
// become is the number every other line already moved to.

// npm's own limits (see node-semver): a string exceeding them is NOT parsed as a
// version, it is classified as a dist-tag — which would resolve to whatever that
// tag points at. Matching semver's grammar alone was not enough.
const MAX_LENGTH = 256;
const MAX_SAFE_COMPONENT_LENGTH = 16;

const NUM = '0|[1-9]\\d*';
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const PRE = `(?:-${PRE_ID}(?:\\.${PRE_ID})*)`;
const BUILD = '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)';
const SEMVER = `(?:${NUM})\\.(?:${NUM})\\.(?:${NUM})${PRE}?${BUILD}?`;

const VERSION_RE = new RegExp(`^${SEMVER}$`);
const RANGE_RE = new RegExp(`^([\\^~]?)(${SEMVER})$`);

// A valid npm scoped name in this workspace.
const ADLC_PKG = /^@adlc\/[a-z0-9][a-z0-9._-]*$/;

// A JSON object member on its own line, as JSON.stringify(o, null, 2) writes it.
// Captures indent, key, value and trailing comma so all four can be compared.
const MEMBER_LINE = /^(\s*)"((?:[^"\\]|\\.)*)": "((?:[^"\\]|\\.)*)"(,?)$/;

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
 * A version string npm would actually parse as a version — not merely one that
 * matches semver's grammar. Length and component-size limits are npm's, and a
 * string that violates them is treated as a dist-tag instead.
 */
function isVersion(value) {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return false;
  if (!VERSION_RE.test(value)) return false;
  const [core] = value.split(/[-+]/);
  for (const part of core.split('.')) {
    if (part.length > MAX_SAFE_COMPONENT_LENGTH) return false;
    if (Number(part) > Number.MAX_SAFE_INTEGER) return false;
  }
  return true;
}

/** Split a dependency range into its operator and version, or null. */
function splitRange(value) {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return null;
  const m = RANGE_RE.exec(value);
  if (!m) return null;
  if (!isVersion(m[2])) return null;
  return { operator: m[1], version: m[2] };
}

/** Parse a member line into its parts, or null if it is not a plain member. */
function parseMember(line) {
  const m = MEMBER_LINE.exec(line);
  if (!m) return null;
  return { indent: m[1], key: m[2], value: m[3], comma: m[4] };
}

/**
 * True when the ONLY differences between two manifest revisions are version
 * lines and lockstep @adlc/* dependency repins.
 *
 * @param {string|null|undefined} beforeText manifest at the freeze baseline
 * @param {string|null|undefined} afterText  manifest at HEAD
 * @param {string} [file] manifest path; scopes which version lines are legal
 * @returns {boolean} exempt — false on any doubt whatsoever
 */
export function isVersionOnlyChange(beforeText, afterText, file) {
  if (typeof beforeText !== 'string' || typeof afterText !== 'string') return false;
  const kind = manifestKind(file);
  if (kind === null) return false;

  const beforeLines = beforeText.split('\n');
  const afterLines = afterText.split('\n');

  // A lockstep bump never adds, removes, or moves a line. Differing line counts
  // mean an insertion, deletion, or reformat — none of which is a version bump.
  if (beforeLines.length !== afterLines.length) return false;

  let newManifestVersion = null;   // the top-level "version" this file moved to
  let versionChanged = false;
  const repins = [];               // {operator, version} for each changed range

  for (let i = 0; i < beforeLines.length; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) {
      // Still need the top-level version even when it is on an unchanged line,
      // so a dependency repin can be checked against it.
      const m = parseMember(a);
      if (m && m.key === 'version' && m.indent === '  ') newManifestVersion = m.value;
      continue;
    }

    const mb = parseMember(b);
    const ma = parseMember(a);
    // Both sides must be plain single-member lines. A changed line that is not
    // one — a brace, an array element, anything multi-key — is never exempt.
    if (!mb || !ma) return false;
    // Structure around the value must be untouched: same nesting, same key, same
    // trailing comma. Only the value itself may move.
    if (mb.indent !== ma.indent || mb.key !== ma.key || mb.comma !== ma.comma) return false;

    if (ma.key === 'version') {
      // Nested `version` members are marketplace concepts (metadata.version,
      // plugins[i].version). In any other manifest only the top-level one moves.
      if (kind !== 'marketplace.json' && ma.indent !== '  ') return false;
      if (!isVersion(mb.value) || !isVersion(ma.value)) return false;
      versionChanged = true;
      if (ma.indent === '  ') newManifestVersion = ma.value;
      continue;
    }

    if (ADLC_PKG.test(ma.key)) {
      const rb = splitRange(mb.value);
      const ra = splitRange(ma.value);
      if (!rb || !ra) return false;
      // The release tool PRESERVES each range's operator. A change of style —
      // exact to caret, caret to tilde — widens or narrows what resolves and is
      // not a repin.
      if (rb.operator !== ra.operator) return false;
      repins.push(ra);
      continue;
    }

    return false; // a changed line that is neither a version nor an @adlc repin
  }

  if (repins.length > 0) {
    // LOCKSTEP IS AN INVARIANT. Without it, `@adlc/core: ^1.0.0 → ^9.0.0` was
    // exempt even with no version change — a dependency redirection through an
    // allowed line. Every repin must target this manifest's OWN new version, and
    // that version must genuinely have moved.
    if (!versionChanged || newManifestVersion === null) return false;
    if (repins.some((r) => r.version !== newManifestVersion)) return false;
  }

  return true;
}
