// lineage.mjs — segmented-repo detection and lineage-token resolution for the
// writer (T-MANIFEST-FOREST slice 3, docs/specs/segmented-gate-manifest.md §4.7/§7.1).
//
// Split from segment-writer.mjs (which owns the actual locked append) because
// this half is pure decision-making: "is this repo segmented" and "which
// segment file should the NEXT append target". Neither question touches the
// ledger lock.

import { lstatSync, writeFileSync, openSync, readSync, closeSync, unlinkSync, mkdirSync, constants as fsConstants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { git, sha256, ledgerPath, ADLC_DIR } from '@adlc/core';
import { segmentDirPath, segmentPath, discoverSegments, readRawLines, ulidOf } from './forest.mjs';
import { verifyChain } from './verify.mjs';
import { verifyEntrySig } from './sign.mjs';

const MARKER_NAME = '.store.json';
const LINEAGE_NAME = '.lineage';
const MARKER_FORMAT = 'adlc-manifest-segments';
const MARKER_VERSION = 1;

export function markerPath(dir) {
  return join(segmentDirPath(dir), MARKER_NAME);
}

export function lineagePath(dir) {
  return join(segmentDirPath(dir), LINEAGE_NAME);
}

// SECURITY (adversarial-review finding): `.store.json` is repository-tracked
// (unlike `.lineage`), so a malicious branch can commit it as a symlink to an
// unbounded source (e.g. a character device) — `isSegmentedRepo` runs on
// EVERY manifest append, so an unbounded `readFileSync` through such a link
// would hang or exhaust memory before the JSON parse ever gets a chance to
// fail. Read with `O_NOFOLLOW` (never follows a symlink — throws ELOOP
// instead) and a hard byte cap (a real marker/token is under 200 bytes; capping
// at 4 KiB is generous headroom, not a real limit on anything legitimate) into
// a fixed buffer, never `readFileSync`'s unbounded read. Reused for
// `.lineage`'s read for the identical reason: `.gitignore` does not stop a
// malicious branch from committing a file at an ignored path either.
const MAX_LOCAL_JSON_BYTES = 4096;
export function readBoundedJsonNoFollow(path) {
  // lstatSync FIRST, not just O_NOFOLLOW on the open (cross-platform finding):
  // O_NOFOLLOW's enforcement is not portable — it is not reliably honored by
  // Node's fs layer on Windows, where symlinks are reparse points handled
  // differently than POSIX symlinks, so an open() alone silently followed a
  // symlinked marker there. lstatSync + isSymbolicLink() is a portable,
  // OS-independent check; O_NOFOLLOW stays too for its atomicity on
  // platforms that do honor it (belt-and-suspenders, matching this file's
  // own write-side isSymlinkOrOtherNonRegular check).
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null; // missing — treat as absent
  }
  if (!st.isFile()) return null; // a symlink, directory, or other non-regular object — never followed
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null; // missing, a symlink, or otherwise unreadable — treat as absent
  }
  try {
    const buf = Buffer.alloc(MAX_LOCAL_JSON_BYTES);
    const bytesRead = readSync(fd, buf, 0, MAX_LOCAL_JSON_BYTES, 0);
    if (bytesRead >= MAX_LOCAL_JSON_BYTES) return null; // at/over the cap — refuse to guess whether it was truncated
    return JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function hasActivationMarker(dir) {
  const parsed = readBoundedJsonNoFollow(markerPath(dir));
  return Boolean(parsed) && typeof parsed === 'object'
    && parsed.format === MARKER_FORMAT && parsed.version === MARKER_VERSION;
}

function rootEndsInCutover(dir) {
  const raw = readRawLines(ledgerPath('manifest', dir));
  if (raw.length === 0) return false;
  try {
    const last = JSON.parse(raw.at(-1).line);
    return Boolean(last) && typeof last === 'object' && last.gate === 'manifest-cutover';
  } catch {
    return false; // malformed tail — verify() will fail this loudly elsewhere; not this predicate's job
  }
}

/**
 * Spec §4.7: a repo is segmented when the activation marker exists OR root's
 * last entry is the cutover entry — checked BOTH ways so losing one marker
 * (e.g. an operator deletes manifest.d/.store.json by hand) does not un-freeze
 * root. Readers never consult this; only the writer does.
 */
export function isSegmentedRepo(dir = ADLC_DIR) {
  return hasActivationMarker(dir) || rootEndsInCutover(dir);
}

// Crockford base32, mirrors packages/tickets/lib/ids.mjs's ticket-ULID encoder
// byte-for-byte (not imported: gate-manifest depends on nothing but
// @adlc/core, and a bare 26-char segment ULID is a different value shape than
// a `T-`-prefixed ticket id, so duplicating this ~15-line encoder is cheaper
// than adding a cross-package dependency for it).
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function encodeUlidPart(value, width) {
  let remaining = BigInt(value);
  let output = '';
  for (let i = 0; i < width; i += 1) {
    output = ULID_ALPHABET[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}

/** A bare 26-char uppercase Crockford-base32 ULID (spec §4.2) — no prefix. */
export function generateSegmentUlid(now = Date.now(), entropy = randomBytes(10)) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new RangeError('ULID timestamp out of range');
  if (!Buffer.isBuffer(entropy) || entropy.length !== 10) throw new TypeError('ULID entropy must be 10 bytes');
  const random = BigInt(`0x${entropy.toString('hex')}`);
  return `${encodeUlidPart(BigInt(now), 10)}${encodeUlidPart(random, 16)}`;
}

// spec §7.1: "slug is 1-40 chars of [a-z0-9-] derived from the creating
// branch name (non-conforming chars dropped, lowercased, collapsed; `segment`
// when derivation yields nothing)". Each run of non-conforming characters
// becomes a single `-` rather than vanishing outright — a literal drop would
// merge adjacent words together (`feat/cool` -> `featcool`), which is worse
// as a filename component than the standard slugify behavior this produces
// (`feat-cool`); "collapsed" then guards against a run of dashes this
// substitution (or an original run of real dashes) could otherwise leave.
export function deriveSlug(branchName) {
  const lowered = String(branchName ?? '').toLowerCase();
  const substituted = lowered.replace(/[^a-z0-9-]+/g, '-');
  const collapsed = substituted.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const truncated = collapsed.slice(0, 40).replace(/-+$/g, '');
  return truncated || 'segment';
}

/**
 * The current Git branch, or `null` for detached HEAD / no-repo — spec §7.1:
 * "detached HEAD never matches" a cached lineage token. `null` is also the
 * signal not to persist a new token (a token naming a branch we can't
 * identify would never match anything again anyway).
 */
export function currentBranch(cwd = process.cwd()) {
  try {
    const out = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === '' || out === 'HEAD' ? null : out;
  } catch {
    return null;
  }
}

// SECURITY (adversarial-review finding): a symlink planted at `.lineage`
// (e.g. pointing at a shell rc file outside the repo) must never be WRITTEN
// THROUGH — the written token embeds the branch name, and Git branch names
// can contain shell metacharacters, so following the link would be an
// arbitrary-file-overwrite / near-RCE primitive. `lstatSync` (never
// `existsSync`, which follows links — same rule forest.mjs's segment
// discovery already applies) checks the raw filesystem object before write;
// the read side's refusal is `readBoundedJsonNoFollow`'s `O_NOFOLLOW` above.
function isSymlinkOrOtherNonRegular(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return false; // does not exist — nothing to refuse
  }
  return !st.isFile();
}

function readLineageToken(dir) {
  const token = readBoundedJsonNoFollow(lineagePath(dir));
  if (!token || typeof token !== 'object') return null;
  if (typeof token.segment !== 'string' || typeof token.ulid !== 'string' || typeof token.branch !== 'string') return null;
  return token; // a corrupted/oversized/symlinked local token blocks nothing — mint a fresh segment instead
}

export function writeLineageToken(dir, token) {
  mkdirSync(segmentDirPath(dir), { recursive: true });
  const p = lineagePath(dir);
  if (isSymlinkOrOtherNonRegular(p)) unlinkSync(p); // replace, never follow — see the SECURITY note above readLineageToken
  // O_NOFOLLOW makes the refusal atomic at the syscall level rather than
  // trusting the lstat check above to still be true by the time we open —
  // belt-and-suspenders against a symlink planted in the gap between them.
  const fd = openSync(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
  try {
    writeFileSync(fd, JSON.stringify(token));
  } finally {
    closeSync(fd);
  }
}

/**
 * Read-only: THIS branch's already-open segment, or null if none is open yet.
 * NEVER mints — no `.lineage` write, no anchor computation. Safe to call from
 * a read-side check (e.g. a carry-forward's "latest entry" lookup) that must
 * not have the write side effect resolveOpenSegment's minting branch carries.
 */
export function peekOpenSegment(dir = ADLC_DIR, { cwd = process.cwd() } = {}) {
  const branch = currentBranch(cwd);
  const token = readLineageToken(dir);
  if (branch !== null && token && token.branch === branch) {
    const { valid } = discoverSegments(dir);
    if (valid.includes(token.segment) && ulidOf(token.segment) === token.ulid) {
      return { name: token.segment, isNew: false };
    }
  }
  return null;
}

// Read ONLY the first line of a segment (its anchor-carrying entry) — a
// BOUNDED read, not readRawLines (adversarial-review finding, T-MANIFEST-
// FOREST sixth round): the original version read and split the WHOLE
// segment file just to inspect its first line, so recoverOpenSegment's
// per-candidate scan cost grew with the TOTAL size of every discovered
// segment, not just the bytes actually needed — one oversized (but
// grammar-valid) segment could stall or exhaust memory on every recovery
// attempt, including a routine fresh-clone push/doctor/reassign/carry-
// forward run. discoverSegments already rejects symlinks before a name
// ever reaches here, so no O_NOFOLLOW hardening is needed the way
// readBoundedJsonNoFollow's (.lineage/.store.json) needs it.
const MAX_FIRST_LINE_BYTES = 65536; // generous headroom; a real first entry is a few hundred bytes
// Distinguishes "no first entry / malformed" (null — genuinely absent, safe
// to treat as a non-candidate) from "first entry exists but exceeds the
// bounded-read cap" (adversarial-review finding, T-MANIFEST-FOREST seventh
// round): nothing on the write side caps entry size, so a legitimately large
// evidence payload (a big `data` object or `files` map) could exceed 64 KiB
// and previously vanished from recovery exactly like the original
// lost-token bug, just via a different mechanism. recoverOpenSegment (below)
// refuses instead of silently excluding an oversized segment as a candidate.
const OVERSIZED_FIRST_ENTRY = Symbol('oversized-first-entry');
// Returns a parsed first entry, or one of two "cannot determine, refuse"
// sentinels — never `null` (adversarial-review finding, T-MANIFEST-FOREST
// ninth round): a genuinely EMPTY file used to return `null` on the theory
// that empty is always safe, but `firstEntryOf` is only ever called on a
// name `discoverSegments` already confirmed exists as a real, discovered
// segment file — an EXISTING segment being zero bytes is not "nothing to
// see", it's the same anomaly this package's own verifyChain treats as
// invalid ("empty segment file has no first entry to carry the required
// anchor"): every real segment's mint atomically writes its anchor-carrying
// first entry, so zero bytes can only mean a crash between file creation
// and first append, or truncation/tampering. Folded into
// MALFORMED_FIRST_ENTRY rather than given a third sentinel — the caller's
// response (refuse, cannot safely exclude as a non-candidate) is identical
// either way. Unreadable (open failure) and unparseable (JSON.parse
// failure) get the same treatment for the same underlying reason:
// discoverSegments already confirmed this name exists, so any failure past
// that point is unexpected and unsafe to treat as absence.
const MALFORMED_FIRST_ENTRY = Symbol('malformed-first-entry');
function firstEntryOf(dir, segmentName) {
  let fd;
  try {
    fd = openSync(segmentPath(dir, segmentName), fsConstants.O_RDONLY);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  }
  try {
    const buf = Buffer.alloc(MAX_FIRST_LINE_BYTES);
    const bytesRead = readSync(fd, buf, 0, MAX_FIRST_LINE_BYTES, 0);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    const newlineIndex = chunk.indexOf('\n');
    if (newlineIndex === -1 && bytesRead >= MAX_FIRST_LINE_BYTES) return OVERSIZED_FIRST_ENTRY;
    const firstLine = newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex);
    if (firstLine.trim() === '') return MALFORMED_FIRST_ENTRY;
    return JSON.parse(firstLine);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read-only recovery for consumers that need "what evidence exists for MY
 * branch" to survive a fresh clone or a branch switch that overwrote
 * `.lineage` (T-MANIFEST-FOREST lineage-durability finding): `.lineage` is
 * deliberately gitignored (spec §7 point 1), so peekOpenSegment alone returns
 * null in exactly those cases even when a real, COMMITTED segment for this
 * branch exists on disk.
 *
 * IDENTITY (T-MANIFEST-FOREST, fourth round — supersedes the original
 * slug-based version of this function): matches on the EXACT `branch` field
 * every segment's first entry now carries (spec §4.4), never the derived
 * FILENAME slug. `deriveSlug` is lossy by design (lowercases, collapses,
 * truncates at 40 chars) purely so it makes a legible filename component —
 * branch `feat/x` and a literal branch named `feat-x` derive the identical
 * slug, so slug-based matching could recover (or, worse for a signing
 * consumer, launder) an unrelated branch's segment as this branch's own. The
 * `branch` field is the exact Git ref string, part of the entry's own signed
 * content once a key is configured (an anchor-carrying entry is always
 * v2-signed — spec §4.4) — but exact identity is not authenticity: THIS
 * FUNCTION DOES NOT VERIFY ANY SIGNATURE. An unsigned segment can still claim
 * any branch by name; matching its `branch` field only proves the claim, not
 * that anyone with the key made it (adversarial-review finding,
 * T-MANIFEST-FOREST fourth round — `@adlc/tickets`' readOwnChains learned
 * this the hard way when push.mjs published a hand-planted "clear" verdict
 * from an unsigned but exact-branch-matching recovered segment). Every
 * caller MUST independently verify (entrySigValid/verifyEntrySig) whatever
 * specific entries it actually intends to trust or re-sign before doing so
 * — this function only answers "which FILE is mine", never "is its content
 * trustworthy". `@adlc/tickets`' readOwnChains(dir, {allowRecovery, key})
 * does this filtering for its own callers; a caller of THIS function gets no
 * such filtering for free.
 *
 * Segments minted BEFORE this change carry no `branch` field and are simply
 * never matched here — they remain reachable only via a still-valid
 * `.lineage` token (peekOpenSegment). This is a deliberate, honest scope
 * boundary, not an oversight: recovery becomes reliable going forward without
 * a disruptive rewrite of already-committed segments (tracked as a follow-up
 * — T-01KYTQ4BADHSDJNBFNZHB2ZG5V).
 *
 * `resolveOpenSegment` (below) DOES now consult this function
 * (T-MANIFEST-FOREST follow-up, gap 1) — a WRITE that happens before any read
 * on a fresh clone (token absent) continues this function's match instead of
 * always minting a needless fresh segment. The identity this returns is
 * STILL UNVERIFIED (see above): `resolveOpenSegment` deliberately does NOT
 * heal (write) the `.lineage` token from a match here, precisely because the
 * token's own downstream trust value depends on it being written only by a
 * genuine mint — see that function's doc for the full rationale.
 *
 * NEVER mints (like peekOpenSegment) and NEVER guesses among multiple
 * candidates: a writer resolving where to APPEND must stay precise, but a reader
 * recovering "what's already there" must not silently guess either — spec's
 * own multiple-independent-segments-per-branch possibility (§7 point 1: two
 * branches forked from the same rootless state can legitimately mint
 * independent segments without coordinating) means the SAME branch can
 * legitimately own more than one committed segment (e.g. a token was lost
 * mid-stream and a second one was minted) — picking one at random could
 * silently ignore genuine evidence in the other. Throws in that case;
 * callers must fail closed, never report "no evidence" when the truth is
 * "ambiguous".
 *
 * @returns {{ name: string, isNew: false }|null}
 * @throws {Error} when more than one committed segment's first entry declares
 *   this branch and the local token does not disambiguate, or when a
 *   discovered segment's first entry exceeds the bounded-read cap (its
 *   branch cannot be determined, so it cannot be safely excluded either)
 */
export function recoverOpenSegment(dir = ADLC_DIR, { cwd = process.cwd() } = {}) {
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked) return peeked;
  const branch = currentBranch(cwd);
  if (branch === null) return null; // detached HEAD: no branch identity to recover by
  const discovered = discoverSegments(dir);
  // adversarial-review finding, T-MANIFEST-FOREST ninth round: this used to
  // scan ONLY `.valid`, silently ignoring `.invalid` — a real segment
  // renamed to a bad-grammar name, replaced with a symlink, or otherwise
  // turned into a non-conforming filesystem object became indistinguishable
  // from "never existed", exactly the class of silent exclusion already
  // closed for oversized/malformed first entries below, just one layer up.
  // The forest's own write-time precondition already refuses on ANY invalid
  // object anywhere; recovery must match that fail-closed contract rather
  // than quietly proceed as if nothing is wrong.
  if (discovered.invalid.length > 0) {
    throw new Error(
      `manifest.d/ contains ${discovered.invalid.length} non-conforming filesystem object(s) `
      + `(${discovered.invalid.map((i) => i.name).sort().join(', ')}) — one could be a disguised or `
      + `tampered segment belonging to this branch, so recovery refuses rather than guess`
    );
  }
  const candidates = [];
  for (const name of discovered.valid) {
    const first = firstEntryOf(dir, name);
    if (first === OVERSIZED_FIRST_ENTRY) {
      throw new Error(
        `segment ${name}'s first entry exceeds the ${MAX_FIRST_LINE_BYTES}-byte bounded-read cap — `
        + `its branch cannot be determined, so it cannot be safely excluded as a candidate either; refusing to guess`
      );
    }
    if (first === MALFORMED_FIRST_ENTRY) {
      throw new Error(
        `segment ${name}'s first entry could not be read or parsed — `
        + `its branch cannot be determined, so it cannot be safely excluded as a candidate either; refusing to guess`
      );
    }
    if (first?.branch === branch) candidates.push(name);
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous: ${candidates.length} committed segments declare branch "${branch}" as their own `
      + `(${candidates.sort().join(', ')}) and no local .lineage token disambiguates them — refusing to guess; `
      + `run \`adlc gate-manifest adopt\` to see the candidates and choose which lineage this checkout continues`
    );
  }
  return { name: candidates[0], isNew: false };
}

/**
 * Refuse to mint a segment whose file .gitignore would ignore (spec §7.1) —
 * evidence recorded into an ignored file exists only in this checkout,
 * never in CI or any other clone, which is silent evidence divergence. The
 * probe child gets a scrubbed environment (no manifest key, no GIT_* repo
 * selectors) and soft-passes outside any git repository; a real
 * check-ignore failure inside a repository throws rather than recording
 * evidence blindly.
 */
function assertSegmentPathCommittable(dir, name) {
  const probeCwd = dirname(dir);
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const run = (args) => {
    try {
      execFileSync('git', args, { cwd: probeCwd, env, stdio: 'ignore' });
      return 0;
    } catch (err) {
      if (err.code === 'ENOENT') return 'no-git';
      return err.status ?? 'error';
    }
  };
  if (run(['rev-parse', '--is-inside-work-tree']) !== 0) return; // no git binary, or not a repository — nothing to commit or ignore
  const rel = relative(probeCwd, segmentPath(dir, name)).split(sep).join('/');
  const status = run(['check-ignore', '-q', '--', rel]);
  if (status === 0) {
    throw new Error(
      `refusing to mint segment ${name}: .gitignore would ignore its file, so evidence recorded there would exist `
      + 'only in this checkout — never in CI or any other clone; fix the ignore rules (gate-manifest enable names '
      + 'the required negation lines) and retry',
    );
  }
  if (status !== 1) {
    throw new Error(`git check-ignore failed while probing segment ${name} — cannot verify the segment is committable, refusing to record evidence blindly`);
  }
}

/**
 * Resolve which segment file the NEXT append should target (spec §7.1).
 *
 * Tries, in order: (a) the local `.lineage` token (fast path, unchanged);
 * (b) WITH A KEY ONLY, `recoverOpenSegment`'s exact-`branch` scan (§4.4a),
 * authenticated before use — a keyed write is never allowed to mint a
 * needless duplicate of a segment that already, verifiably, belongs to this
 * checkout on a fresh clone or after a lost token (T-MANIFEST-FOREST
 * follow-up, gap 1: write-side recovery blindness). Only when NEITHER
 * yields a segment does this mint a fresh one.
 *
 * Recovery is KEY-GATED, mirroring `readOwnChains`' reader contract
 * (adversarial-review finding): a keyless writer that extended a recovered
 * segment would strand the checkout — the keyless reader refuses recovered
 * content it cannot authenticate, so every subsequent push/read would fail
 * loudly and permanently. A keyless writer therefore mints fresh and writes
 * its own token (whose peeked path the keyless reader does trust), exactly
 * the pre-recovery behavior. A KEYED writer authenticates the candidate
 * (chain intact under the key, at least one entry with a verified
 * signature) and REFUSES — never extends, never mints a duplicate — when
 * the single candidate cannot be authenticated; minting past an
 * unauthenticatable same-branch segment would silently fork the branch's
 * lineage, gap 1's own bug. `recoverOpenSegment` may throw on genuine
 * ambiguity (two candidates, no token to disambiguate); that throw
 * propagates — a writer must refuse, never guess, exactly like a reader.
 *
 * At MINT time the actual segment filename is probed against .gitignore
 * (adversarial-review finding): a branch-derived slug can match an ignore
 * rule that enable's representative probes cannot anticipate (e.g.
 * `release-*.jsonl` on a `release/...` branch), and evidence written into
 * an ignored file is local-only — invisible to CI and every other clone —
 * which is silent evidence divergence. The writer fails closed BEFORE
 * recording anything rather than recording evidence only this checkout
 * will ever see.
 *
 * Deliberately does NOT heal (write) the `.lineage` token from a (b) match
 * (adversarial-review finding): the token's whole trust value downstream —
 * `readOwnChains`'s "peeked" path treats a token match as PROOF this checkout
 * itself minted the segment, and (with no signing key configured, a fully
 * supported configuration) skips all signature verification on that basis
 * alone — depends on the token being written ONLY by a genuine mint, never
 * from `recoverOpenSegment`'s unauthenticated, branch-string-only match
 * (its own doc: "does not verify any signature... only proves the claim, not
 * that anyone with the key made it"). Healing from it would launder an
 * attacker-committed, unsigned, branch-matching segment into the
 * token-trusted fast path the moment any keyless write recovered it. The
 * cost of not healing is purely a repeated (b) scan on the checkout's NEXT
 * write — no correctness or security cost, since recovery is idempotent.
 *
 * @returns {{ name: string, isNew: boolean, anchor?: object|null, branch?: string }}
 *   `isNew: true` means this append is the segment's FIRST entry and must
 *   carry `anchor` and `branch` (both also returned); `isNew: false` means
 *   append as a plain continuation of the named, already-open segment.
 */
export function resolveOpenSegment(dir = ADLC_DIR, { cwd = process.cwd(), key = null } = {}) {
  // The forest's persisted authentication mode is enforced on EVERY write
  // (adversarial-review finding): a keyed forest written keylessly — by a
  // hook, CI job, or worktree missing the key variable — would mint or
  // extend unsigned evidence that keyed clones then refuse forever (a v2
  // signature can never be added retroactively). Markers without the field
  // (pre-policy activations, hand-built fixtures) carry no mode to enforce.
  const markerDoc = readBoundedJsonNoFollow(markerPath(dir));
  if (markerDoc && markerDoc.auth === 'keyed' && key === null) {
    throw new Error(
      'this forest was activated in keyed mode, but no signing key was provided for this write — an unsigned '
      + 'entry here would permanently strand every keyed clone of this branch; configure the manifest key',
    );
  }
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked) return peeked;

  if (key !== null) {
    const recovered = recoverOpenSegment(dir, { cwd });
    if (recovered) {
      // Lenient chain check (an honest unsigned legacy prefix is tolerated;
      // tampered or unsigned-after-signed entries are not) plus the
      // BRANCH-BEARING FIRST ENTRY itself carrying a verified v2 signature
      // (adversarial-review finding): a v1 signature does not cover `branch`
      // or `anchor`, so a valid v1-signed entry with a bolted-on branch
      // claim still verifies — "some entry verifies" authenticates the
      // bytes of SOME entry, never the identity claim recovery selects by.
      // Only v2 signs every field, so only a v2-verified first entry proves
      // the branch binding was made by a key holder. Branch-carrying
      // segments postdate v2 writers, so no legitimate segment is excluded.
      const lines = readRawLines(segmentPath(dir, recovered.name));
      const chain = verifyChain(lines, { key, requireSignatures: false, anchorOnFirst: true });
      let first = null;
      try { first = JSON.parse(lines[0]?.line); } catch { /* refused below */ }
      const firstAuthenticated = Boolean(first) && first.sigVersion === 2 && verifyEntrySig(key, first);
      if (!chain.valid || !firstAuthenticated) {
        throw new Error(
          `segment ${recovered.name} declares this branch but cannot be authenticated with the configured key `
          + '(broken chain, or its branch-bearing first entry lacks a verified v2 signature) — refusing to extend '
          + 'it, and refusing to mint a duplicate past it (that would silently fork this branch\'s lineage)',
        );
      }
      return recovered;
    }
  } else {
    // Keyless writers must not resolve past a committed same-branch segment
    // in EITHER direction (adversarial-review findings, two rounds):
    // extending it strands the checkout (the keyless reader refuses
    // recovered content it cannot authenticate), and minting alongside it
    // shadows the committed evidence behind the fresh token for every later
    // read. Fail closed instead, exactly like the keyless reader does in
    // this same state. Ambiguity counts as existence.
    let candidateExists = false;
    try { candidateExists = recoverOpenSegment(dir, { cwd }) !== null; } catch { candidateExists = true; }
    if (candidateExists) {
      throw new Error(
        'a committed segment already declares this branch, and with no signing key this writer can neither '
        + 'authenticate and extend it nor safely mint alongside it (a fresh token would shadow the committed '
        + 'evidence from every later read) — configure the manifest key, or restore the local .lineage token',
      );
    }
  }

  const branch = currentBranch(cwd);
  // No usable token or recoverable segment: mint a new one, anchored to root's current head line
  // if a root exists, else anchor: null (spec §4.4/§7.1 — never chase the
  // stale token's segment or any other segment as a fallback anchor target).
  const rootLines = readRawLines(ledgerPath('manifest', dir));
  const rootLast = rootLines.at(-1) ?? null;
  let anchor = null;
  if (rootLast !== null) {
    const lastEntry = JSON.parse(rootLast.line);
    anchor = { segment: 'root', seq: lastEntry.seq, lineHash: sha256(rootLast.line) };
  }
  const ulid = generateSegmentUlid();
  const slug = deriveSlug(branch ?? '');
  const name = `${slug}-${ulid}.jsonl`;
  assertSegmentPathCommittable(dir, name);
  if (branch !== null) writeLineageToken(dir, { segment: name, ulid, branch });
  // branch is omitted (not `null`) when detached HEAD minted this segment —
  // recoverOpenSegment's exact-match scan simply never matches an omitted
  // field, the same as any other unset field, so no explicit sentinel is
  // needed the way `anchor: null` needs one (anchor is spec-mandatory on
  // every first entry; branch is not).
  return { name, isNew: true, anchor, ...(branch !== null ? { branch } : {}) };
}
