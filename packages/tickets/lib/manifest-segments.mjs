// manifest-segments.mjs — segmented gate-manifest support for ticket evidence
// (T-MANIFEST-FOREST, docs/specs/segmented-gate-manifest.md).
//
// DUPLICATED, not imported, from @adlc/gate-manifest/lib/{forest,lineage}.mjs:
// @adlc/core already depends on @adlc/tickets (core/lib/tickets.mjs), and
// @adlc/gate-manifest depends on @adlc/core — so tickets -> gate-manifest
// would be a cycle (tickets -> gate-manifest -> core -> tickets). This
// mirrors the existing precedent in doctor.mjs, which already duplicates
// gate-manifest's sign.mjs byte-for-byte for the identical reason. Keep this
// file's behavior in sync with gate-manifest's forest.mjs/lineage.mjs by
// hand; there is no automated check that they agree.
//
// Scope is deliberately narrower than gate-manifest's own reader: this file
// only needs (a) "is this repo segmented", (b) "which segment does the next
// ticket-evidence append target" (using the SAME .lineage protocol and
// segment-naming grammar as gate-manifest's writer, so both producers share
// one open segment per branch instead of each minting their own), and (c) a
// full-forest entry scan for the idempotency check.
//
// *.lock handling IS content-aware, mirroring gate-manifest's own
// looksLikeGenuineLedgerLock (P5 prosecution finding): forestChainsIntact is
// now a fail-closed precondition before finalizing a ticket transaction (see
// its own doc), so a NAME-only *.lock skip would let a malicious branch
// rename a real segment — one whose chain is broken, or one this checkout's
// own idempotency scan should have seen — to end in `.lock`, silently
// vanishing it from the forest instead of being caught as bad-filename-
// grammar. Content-checking it against withManifestLock's own owner-record
// shape ({version, token, pid, hostname, startedAt} in this file's own
// withManifestLock) closes that exactly the way gate-manifest's history
// already proved necessary for the identical class of object.

import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync, unlinkSync, mkdirSync, constants as fsConstants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { sha256, canonicalJson } from './canonical.mjs';

const SEGMENT_DIRNAME = 'manifest.d';
const SEGMENT_NAME_RE = /^[a-z0-9-]{1,40}-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/;
// Only `.store.json` needs an explicit reserved-name skip: `.lineage` is
// ALSO excluded, but for free, by SEGMENT_NAME_RE alone (it doesn't end in
// exactly `.jsonl`) — listing it here too would be a genuinely unobservable
// (equivalent-mutant-prone) redundancy, not a second real guard.
const RESERVED_NAMES = new Set(['.store.json']);
const MARKER_NAME = '.store.json';
const LINEAGE_NAME = '.lineage';
const MARKER_FORMAT = 'adlc-manifest-segments';
const MARKER_VERSION = 1;
const MAX_LOCAL_JSON_BYTES = 4096; // generous headroom for a marker/token; real ones are under 200 bytes
const MAX_LOCK_OWNER_BYTES = 512; // withManifestLock's owner record is ~120 bytes; generous headroom, not a real limit

// Mirrors @adlc/gate-manifest/lib/forest.mjs's looksLikeGenuineLedgerLock
// exactly (see this file's header). A genuine lock is briefly 0 bytes
// between withManifestLock's openSync('wx') and writeFileSync — size===0 is
// always treated as a genuine transient lock, never a hidden segment (an
// empty file can never hide real segment content).
function looksLikeGenuineLedgerLock(path, size) {
  if (size === 0) return true;
  if (size >= MAX_LOCK_OWNER_BYTES) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8').trim());
  } catch {
    // leave parsed at its null default — falls through to the same shape
    // check below, which already rejects a non-object.
  }
  return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
    && typeof parsed.token === 'string' && typeof parsed.pid === 'number'
    && typeof parsed.hostname === 'string' && typeof parsed.startedAt === 'string';
}

function segmentDirPath(dir) {
  return join(dir, SEGMENT_DIRNAME);
}

export function segmentPath(dir, name) {
  return join(segmentDirPath(dir), name);
}

function markerPath(dir) {
  return join(segmentDirPath(dir), MARKER_NAME);
}

export function lineagePath(dir) {
  return join(segmentDirPath(dir), LINEAGE_NAME);
}

/** Real segment filenames only — structural files and anything not matching the grammar excluded. */
// Mirrors @adlc/gate-manifest/lib/forest.mjs's discoverSegments SHAPE
// ({valid, invalid}), not just its valid-name list (adversarial-review
// finding, P5 prosecution): a non-conforming filesystem object under
// manifest.d/ (a symlink, a nested directory, a non-regular file, a bad-
// grammar name) must be reported as INVALID, not silently skipped — spec
// §5 item 1 requires the whole forest to fail closed on it, and this
// package's own callers (forestChainsIntact) claim exactly that behavior
// ("mirrors gate-manifest's own segment-writer.mjs precondition"). Silently
// skipping let a directory shadow where a real segment (e.g. one holding a
// needs-attention revocation) should be, while forestChainsIntact still
// reported the forest valid. Case-collision detection and *.lock content-
// awareness are still deliberately out of scope — see this file's header.
function discoverSegments(dir) {
  const segDir = segmentDirPath(dir);
  let dirStat;
  try {
    dirStat = lstatSync(segDir); // lstatSync, never existsSync — never follow a symlinked manifest.d/
  } catch {
    return { valid: [], invalid: [] };
  }
  if (dirStat.isSymbolicLink()) return { valid: [], invalid: [{ name: '.', reason: 'manifest.d/ is a symlink' }] };
  if (!dirStat.isDirectory()) return { valid: [], invalid: [{ name: '.', reason: 'manifest.d/ is not a directory' }] };
  let names;
  try {
    names = readdirSync(segDir).sort();
  } catch (err) {
    return { valid: [], invalid: [{ name: '.', reason: `cannot read manifest.d/: ${err.message}` }] };
  }
  const valid = [];
  const invalid = [];
  for (const name of names) {
    if (RESERVED_NAMES.has(name)) continue;
    let st;
    try {
      st = lstatSync(join(segDir, name));
    } catch (err) {
      invalid.push({ name, reason: `cannot stat: ${err.message}` });
      continue;
    }
    if (st.isSymbolicLink()) { invalid.push({ name, reason: 'symlink' }); continue; }
    if (st.isDirectory()) { invalid.push({ name, reason: 'nested directory' }); continue; }
    if (!st.isFile()) { invalid.push({ name, reason: 'not a regular file' }); continue; }
    if (name === LINEAGE_NAME) continue; // never a segment by grammar alone — expected, legitimate
    if (name.endsWith('.lock')) {
      if (looksLikeGenuineLedgerLock(join(segDir, name), st.size)) continue; // a transient advisory lock, not a segment
      invalid.push({ name, reason: 'lock-suffixed object is not a genuine advisory lock' });
      continue;
    }
    if (!SEGMENT_NAME_RE.test(name)) {
      invalid.push({ name, reason: 'bad filename grammar' });
      continue;
    }
    valid.push(name);
  }
  return { valid, invalid };
}

function readRawLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function parseLines(lines) {
  return lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// Manifest HMAC verification, mirroring @adlc/gate-manifest's sign.mjs
// byte-for-byte. It cannot be imported: the package graph is tickets ← core
// ← gate-manifest, so tickets (the base layer) would create a cycle. The v1
// form is a fixed key order; v2 signs canonical JSON of every field but
// `sig` (this package's canonicalJson is byte-identical to core's, verified
// by test). Keep in lockstep with sign.mjs. Shared by doctor.mjs and the
// signature-aware chain check below — the one place both need it.
//
// No ambient env read lives here (manifest-key-hermeticity, T2/#410): every
// caller in this package now receives its signing key as an explicit
// parameter, resolved once by the entry point (a bin) — see key-contract.mjs.

export function canonicalEntryBytes(entry) {
  if (entry.sigVersion === 2) {
    const { sig: _sig, ...signed } = entry;
    return canonicalJson(signed);
  }
  const canonical = { seq: entry.seq, gate: entry.gate, ts: entry.ts };
  if (entry.ticket !== undefined) canonical.ticket = entry.ticket;
  if (entry.data !== undefined) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return JSON.stringify(canonical);
}

export function entrySigValid(key, entry) {
  if (typeof entry.sig !== 'string' || entry.sig.length === 0) return false;
  const expected = createHmac('sha256', key).update(canonicalEntryBytes(entry)).digest('hex');
  const a = Buffer.from(entry.sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Chain integrity: each entry's `prev` must equal sha256(previous raw line)
// and `seq` must increase by 1 from 1. Mirrors the chain half of
// @adlc/gate-manifest/lib/verify.mjs's verifyChain — no anchor/cycle
// resolution (out of scope here, see manifest-segments.mjs's header).
//
// SIGNATURE (adversarial-review finding): when `key` is provided, also
// enforce verifyChain's "requireSignatures:false" signed-continuity rule —
// once this ONE chain has a validly-signed entry, every LATER entry in it
// must also carry a valid signature (a present-but-invalid signature always
// fails, everywhere). Evaluated PER CHAIN, matching gate-manifest's own
// per-chain `seenSignedEntry` semantics. Without this, an attacker could
// append a correctly hash-chained but UNSIGNED forged entry (matching a real
// transactionId/action) and the idempotency scan in evidence.mjs would trust
// it as genuine, even with a signing key configured. `key === null` keeps
// the original chain-only check (no key means nothing can be verified;
// matches segment-writer.mjs's own precondition).
function chainIsIntact(lines, key = null) {
  let prevLine = null;
  let prevSeq = 0;
  let seenSignedEntry = false;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { return false; }
    const expectedPrev = prevLine === null ? null : sha256(prevLine);
    if (entry?.prev !== expectedPrev || entry?.seq !== prevSeq + 1) return false;
    if (key !== null) {
      const hasSig = typeof entry?.sig === 'string' && entry.sig.length > 0;
      if (hasSig) {
        if (!entrySigValid(key, entry)) return false;
        seenSignedEntry = true;
      } else if (seenSignedEntry) {
        return false; // missing sig after this chain's signed era began
      }
    }
    prevLine = line;
    prevSeq = entry.seq;
  }
  return true;
}

// chainIsIntact deliberately tolerates a chain with an unsigned PREFIX (a
// legacy chain that predates signing, or a repo that never adopted it — see
// chainIsIntact's own callers): its rule is "once signed, stays signed
// forward", which says nothing about entries BEFORE the first signature.
// That tolerance is structurally correct (an honest chain really can adopt
// signing partway through) but was wrong to also treat as a TRUST decision
// (adversarial-review finding, T-MANIFEST-FOREST eighth round): a
// commit-capable attacker without the key can plant an unsigned forged entry
// FIRST, then have it laundered into trust by ANY later, unrelated, genuinely
// signed append sharing the same chain — signing entry N proves only entry
// N's own provenance, not that anyone reviewed an earlier unsigned entry's
// content. Filtering to entries with a genuinely valid signature (rather than
// merely checking "does at least one exist") closes this without
// reintroducing the round 4/5 per-entry-filter bug: this filter only ever
// runs AFTER chainIsIntact has already refused the whole read on any entry
// with an INVALID signature, so every entry reaching this filter either has
// a valid signature or was never signed at all — dropping the never-signed
// ones cannot make a tampered entry silently disappear the way the round 4/5
// bug did. Mirrors reassign.mjs's planManifestMigration, which already
// applies this exact per-entry filter for the identical reason.
//
// No try/catch around JSON.parse here (mutation-gate: a mutant swallowing a
// parse failure as "signed" survived, because there is no reachable input
// that could ever trigger one): every caller runs chainIsIntact(lines, key)
// first and only reaches this filter when it returned true, and
// chainIsIntact's own loop already JSON.parses every one of these SAME
// `lines` and returns false on the first failure — so by the time this
// filter runs, all of `lines` is guaranteed parseable. A defensive catch
// here would be untestable dead code, not a real safety net.
function signedEntriesOnly(lines, key) {
  return lines.filter((line) => entrySigValid(key, JSON.parse(line)));
}

/**
 * True iff root's chain AND every discovered segment's chain are each
 * internally intact (adversarial-review finding: a corrupted OTHER segment
 * must block a ticket evidence append the same way gate-manifest's own
 * segment-writer.mjs refuses to append onto a forest it hasn't confirmed is
 * valid — a ticket transaction must not finalize, and delete its recovery
 * journal, against evidence that lands in an already-broken forest).
 * `key`, when provided, also enforces per-chain signature validity — see
 * chainIsIntact's doc.
 */
export function forestChainsIntact(dir, { key = null } = {}) {
  if (!chainIsIntact(readRawLines(join(dir, 'manifest.jsonl')), key)) return false;
  const { valid, invalid } = discoverSegments(dir);
  if (invalid.length > 0) return false; // a non-conforming object anywhere invalidates the whole forest
  return valid.every((name) => chainIsIntact(readRawLines(segmentPath(dir, name)), key));
}

/**
 * Every entry from root plus every segment, in file-discovery order (not the
 * anchor-depth ordering gate-manifest's own reader uses for display — order
 * does not matter for "does an entry with this transactionId exist
 * anywhere", the only thing this is used for).
 */
export function readForestEntries(dir) {
  const root = parseLines(readRawLines(join(dir, 'manifest.jsonl')));
  const segments = discoverSegments(dir).valid.flatMap((name) => parseLines(readRawLines(segmentPath(dir, name))));
  return [...root, ...segments];
}

/**
 * Root's chain, followed by THIS branch's own open segment's chain (if one is
 * already open) — never any OTHER lineage's segment. Returned as SEPARATE
 * chains (not flattened) because `seq` is only meaningful WITHIN a chain:
 * each chain restarts at 1, so a caller cannot compare `seq` across the
 * returned arrays to find "the latest entry" — it must treat a LATER chain
 * (by return-array position) as strictly newer than an EARLIER one
 * regardless of the seq values inside it, and only compare `seq` for two
 * entries already known to be from the SAME chain (adversarial-review
 * finding: a stale root entry with a high seq must never outrank a
 * causally-later segment entry with a low one). Matches the existing
 * root+own-segment scoping used by storeHashBindingCheck and
 * carryForwardCrossModelReview — no total order exists across UNRELATED
 * segments, so this deliberately never reads them.
 *
 * `allowRecovery` (T-MANIFEST-FOREST lineage-durability finding, default
 * false — opt IN, not opt out): when true, falls back to recoverOpenSegment's
 * exact `branch`-field scan when peekOpenSegment's token doesn't resolve a
 * segment, so a fresh clone or a branch switch that overwrote `.lineage` does
 * not silently look like "this branch has no segment" when a real, committed
 * one exists on disk. Throws if the recovery scan finds more than one
 * candidate — a READ must fail closed rather than guess; callers should let
 * that propagate as a real failure, never swallow it into "no evidence".
 *
 * `key` gates recovery's TRUST, not just its identity match (adversarial-
 * review finding, T-MANIFEST-FOREST fourth round, round 2): matching on the
 * exact `branch` field only proves a segment CLAIMS to belong to this branch
 * — that claim is only as trustworthy as its signature. Some consumers of
 * this function (reassignment, carry-forward) already independently verify
 * the SPECIFIC entries they mint a fresh signature from before trusting them
 * — but push.mjs does not (it renders a display status straight from what
 * this returns), so an unsigned, exact-branch-claiming forged segment could
 * publish a fabricated P5 pass.
 *
 * The recovered segment's WHOLE chain is verified with `chainIsIntact`
 * (round 2 of the SAME finding, not a per-entry filter): an earlier version
 * of this fix dropped individually-invalid entries from the returned array
 * rather than refusing the read. A tampered LATER entry (a real, once-signed
 * "blocked"/revocation verdict edited by someone without the key, which
 * invalidates its own signature) would simply vanish under a per-entry
 * filter, leaving an EARLIER, still-validly-signed "clear" verdict as the
 * apparent latest — resurrecting a stale pass past its own revocation.
 * `chainIsIntact` enforces "once this chain has a signed entry, every LATER
 * entry must also carry a valid signature" and throws the whole read out on
 * any violation, the same whole-chain precondition reassignment
 * (forestChainsIntact) and carry-forward (manifestChainTrustworthy) already
 * require before trusting anything they read.
 *
 * When `key` is null, nothing can be verified, so recovery is disabled
 * entirely and this degrades to the strict, token-only default — the same
 * "cannot verify, cannot trust" boundary `doctor.mjs`'s
 * `authenticated: key !== null` already expresses elsewhere. Every
 * production consumer now opts in (closes the ticket's original AC1/AC2,
 * superseding the third round's "nobody opts in" conclusion). The THIRD
 * round correctly found that the OLD recoverOpenSegment matched on the
 * derived filename slug — a LOSSY, CALLER-CONTROLLED identity (`deriveSlug`
 * lowercases, collapses, and truncates, and nothing stops a branch from
 * deriving the same slug as an unrelated committed segment's) — which made
 * recovery unsafe for every consumer, informational or signing. Matching on
 * the exact `branch` field instead (spec §4.4) closes the CROSS-BRANCH
 * collision risk; whole-chain verification here closes the remaining
 * FORGERY/TAMPERING risk.
 *
 * REFUSE, NEVER SILENTLY LOOK LIKE "NO EVIDENCE" (T-MANIFEST-FOREST, seventh
 * round): two more situations used to fall through to `return [root]` as if
 * genuinely nothing existed, when the truth was "cannot determine" — the
 * exact same class of bug ambiguous recovery already refuses rather than
 * guesses at. (1) `key === null` (a fully supported, common configuration —
 * e.g. ordinary local dev without `ADLC_MANIFEST_KEY`) used to disable
 * recovery outright; now it still checks whether a candidate segment
 * EXISTS (never trusting its content) and refuses if one does, since a
 * mutating consumer (reassignment) proceeding as if there's nothing to
 * migrate can permanently strand real evidence under an abandoned ticket
 * ID. (2) Detached HEAD (a common CI checkout shape) used to return `null`
 * from recoverOpenSegment and get silently treated the same as "no
 * segment"; now, if ANY committed segment exists anywhere in the repo, this
 * refuses rather than assume none of them are ours.
 */
export function readOwnChains(dir, { cwd = dirname(dir), allowRecovery = false, key = null } = {}) {
  const rootRaw = readRawLines(join(dir, 'manifest.jsonl'));
  // Root and a token-matched (peeked) segment are not identity-ambiguous the
  // way a RECOVERED segment is — root is canonically root, and the local
  // `.lineage` token is proof this checkout itself minted the peeked
  // segment, not a self-reported claim from untrusted content. Both still
  // get chainIsIntact's tamper/continuity check when a key is available
  // (round 6 — push.mjs previously trusted root and a token-matched segment
  // with NO verification at all, even with a real key passed in, so an
  // attacker with commit-but-not-key access could append an unsigned forged
  // entry there and have it published).
  //
  // AND (round 7 + round 8): once verified intact, only entries with a
  // genuinely valid signature are handed back — never merely "at least one
  // exists" (round 7's original check, closed further in round 8: see
  // signedEntriesOnly's own doc for why an unsigned PREFIX can otherwise be
  // laundered into trust by an unrelated later signature). Unlike the
  // recovered path's identical requirement below, this is NOT about identity
  // (root/peeked aren't self-claimed) — it is about not letting "this repo
  // happens to have never signed anything yet" (or "not yet, for THIS
  // entry") become "so nothing here needs signing, ever, even once a key
  // exists."
  let rootLines = rootRaw;
  if (key !== null) {
    if (!chainIsIntact(rootRaw, key)) {
      throw new Error('root manifest failed chain or signature verification — refusing to trust it');
    }
    rootLines = signedEntriesOnly(rootRaw, key);
    // Empty is not "unsigned" — a rootless segmented repo genuinely has
    // nothing in root, which is not a forgery risk (nothing to distrust);
    // only a NON-EMPTY chain with zero validly-signed entries is the concern.
    if (rootRaw.length > 0 && rootLines.length === 0) {
      throw new Error('root manifest has no signed entries — cannot authenticate it with the available key, refusing to trust it');
    }
  }
  const root = parseLines(rootLines);
  if (!isSegmentedRepo(dir)) return [root];
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked) {
    const peekedRaw = readRawLines(segmentPath(dir, peeked.name));
    // Structural, not a trust decision (adversarial-review finding,
    // T-MANIFEST-FOREST ninth round) — checked regardless of `key`: a
    // segment this checkout's OWN token resolves to being zero bytes is not
    // "nothing here" the way an empty ROOT legitimately can be. Every real
    // segment's mint atomically writes its anchor-carrying first entry
    // (gate-manifest's verifyChain: an empty segment "has no first entry to
    // carry the required anchor"), so zero bytes here can only mean a crash
    // between file creation and first append, or truncation/tampering.
    if (peekedRaw.length === 0) {
      throw new Error(`segment ${peeked.name} is empty — a real segment always has a first entry, refusing to trust it`);
    }
    let peekedLines = peekedRaw;
    if (key !== null) {
      if (!chainIsIntact(peekedRaw, key)) {
        throw new Error(`segment ${peeked.name} failed chain or signature verification — refusing to trust it`);
      }
      peekedLines = signedEntriesOnly(peekedRaw, key);
      // peekedRaw is never empty here — the unconditional check above already
      // refused an empty segment before this point is reached.
      if (peekedLines.length === 0) {
        throw new Error(`segment ${peeked.name} has no signed entries — cannot authenticate it with the available key, refusing to trust it`);
      }
    }
    return [root, parseLines(peekedLines)];
  }
  if (!allowRecovery) return [root];

  // Beyond this point the token is missing and we are attempting recovery.
  // Two more ways this used to silently look like "no evidence" instead of
  // "cannot determine" (adversarial-review finding, T-MANIFEST-FOREST
  // seventh round) — both get the SAME treatment as an ambiguous recovery
  // match: refuse outright, since a mutating consumer (reassignment) that
  // proceeds as if there's nothing to migrate can permanently strand real
  // evidence under an abandoned ticket ID, and push can wrongly remove a
  // real status label.
  const branch = currentBranch(cwd);
  if (branch === null) {
    // Detached HEAD — a common CI checkout shape (e.g. a PR SHA checked out
    // directly) — has no branch identity to check candidates against AT
    // ALL. If ANY committed segment exists anywhere in this repo, we cannot
    // rule out that one belongs to us; only a genuinely segment-free forest
    // is safe to treat as "nothing to miss".
    if (discoverSegments(dir).valid.length > 0) {
      throw new Error(
        'cannot identify this checkout\'s own segment: detached HEAD has no branch identity to recover by, '
        + 'and committed segments exist — refusing to treat them as absent'
      );
    }
    return [root];
  }
  if (key === null) {
    // A known branch, but nothing can be signature-verified. Check
    // EXISTENCE only via recoverOpenSegment — never trust its content for
    // this purpose, only whether a plausible candidate exists at all — the
    // same "existence check, not a trust decision" pattern used by
    // reassign.mjs before this logic moved into the shared primitive.
    let candidateExists;
    try { candidateExists = recoverOpenSegment(dir, { cwd }) !== null; }
    catch { candidateExists = true; } // ambiguous match — still a candidate, still refuse
    if (candidateExists) {
      throw new Error(
        'a candidate segment for this branch exists but cannot be verified without a signing key — '
        + 'refusing to treat it as absent'
      );
    }
    return [root];
  }

  const recovered = recoverOpenSegment(dir, { cwd });
  if (!recovered) return [root];
  // WHOLE-CHAIN verification, not a per-entry filter (adversarial-review
  // finding, T-MANIFEST-FOREST fourth round, round 2): filtering out entries
  // that individually fail entrySigValid used to silently DROP them from the
  // returned chain rather than refusing the read. A tampered LATER entry
  // (e.g. a real, signed "blocked"/revocation verdict edited by someone
  // without the key, invalidating its own signature) would vanish, leaving
  // an EARLIER, still-validly-signed "clear" verdict as if it were the
  // latest — resurrecting a stale pass past its own revocation. chainIsIntact
  // enforces "once this chain has a signed entry, every LATER entry must also
  // carry a valid signature" (see its own doc) — the SAME whole-chain
  // precondition reassignment (forestChainsIntact) and carry-forward
  // (manifestChainTrustworthy) already require before trusting anything they
  // read; push.mjs was the one consumer with no such precondition of its own,
  // which is why this belongs in the shared primitive, not each caller.
  //
  // chainIsIntact alone is NOT sufficient here, though (round 5 of the same
  // finding): it deliberately tolerates a chain with an unsigned PREFIX —
  // that legacy-unsigned-prefix tolerance is correct for
  // forestChainsIntact's write-time precondition on a segment THIS checkout
  // already owns via a valid token, but a RECOVERED segment is untrusted
  // input claiming an identity this checkout never verified. An attacker
  // without the key can trivially hand-write an entirely unsigned segment
  // that is perfectly hash-chain-consistent and passes chainIsIntact — so
  // recovery filters to entries with a genuinely valid signature (round 8:
  // not merely "at least one exists" — see signedEntriesOnly's own doc for
  // why a lone later signature must not launder an earlier unsigned forged
  // entry into trust).
  const rawLines = readRawLines(segmentPath(dir, recovered.name));
  if (!chainIsIntact(rawLines, key)) {
    throw new Error(`recovered segment ${recovered.name} failed chain or signature verification — refusing to trust it`);
  }
  const signedRecovered = signedEntriesOnly(rawLines, key);
  if (signedRecovered.length === 0) {
    throw new Error(`recovered segment ${recovered.name} failed chain or signature verification — refusing to trust it`);
  }
  return [root, parseLines(signedRecovered)];
}

// SECURITY: `.store.json` is repository-TRACKED, so a malicious branch can
// commit it as a symlink to an unbounded source (e.g. a character device) —
// isSegmentedRepo runs on every ticket evidence append. O_NOFOLLOW (never
// follows a symlink) plus a hard byte cap (real markers/tokens are under 200
// bytes) closes both the symlink-follow and unbounded-read paths. Mirrors
// gate-manifest/lib/lineage.mjs's readBoundedJsonNoFollow exactly.
function readBoundedJsonNoFollow(path) {
  // lstatSync FIRST, not just O_NOFOLLOW on the open (cross-platform finding,
  // mirrors @adlc/gate-manifest/lib/lineage.mjs's identical fix): O_NOFOLLOW's
  // enforcement is not portable — Windows CI showed a symlinked marker was
  // silently followed, since O_NOFOLLOW is not reliably honored there (Windows
  // symlinks are reparse points, handled differently than POSIX symlinks by
  // Node's fs layer). lstatSync + isFile() is a portable, OS-independent
  // check; O_NOFOLLOW stays for its atomicity where it IS honored.
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null; // a symlink, directory, or other non-regular object — never followed
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_LOCAL_JSON_BYTES);
    const bytesRead = readSync(fd, buf, 0, MAX_LOCAL_JSON_BYTES, 0);
    if (bytesRead >= MAX_LOCAL_JSON_BYTES) return null;
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
  const raw = readRawLines(join(dir, 'manifest.jsonl'));
  if (raw.length === 0) return false;
  try {
    const last = JSON.parse(raw.at(-1));
    return Boolean(last) && typeof last === 'object' && last.gate === 'manifest-cutover';
  } catch {
    return false;
  }
}

/** Spec §4.7 — mirrors @adlc/gate-manifest/lib/lineage.mjs's isSegmentedRepo exactly. */
export function isSegmentedRepo(dir) {
  return hasActivationMarker(dir) || rootEndsInCutover(dir);
}

// Crockford base32, mirrors @adlc/gate-manifest/lib/lineage.mjs's ULID
// encoder (itself mirroring @adlc/tickets/lib/ids.mjs's ticket-ULID encoder)
// byte-for-byte.
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
// Mirrors @adlc/gate-manifest/lib/lineage.mjs's identical validation: this was
// previously internal-only, so a caller-supplied `now`/`entropy` was always this
// file's own well-formed value; now exported (lineage-durability test fixtures
// need it directly), the same guards apply as the sibling this mirrors.
export function generateSegmentUlid(now = Date.now(), entropy = randomBytes(10)) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new RangeError('ULID timestamp out of range');
  if (!Buffer.isBuffer(entropy) || entropy.length !== 10) throw new TypeError('ULID entropy must be 10 bytes');
  const random = BigInt(`0x${entropy.toString('hex')}`);
  return `${encodeUlidPart(BigInt(now), 10)}${encodeUlidPart(random, 16)}`;
}

// spec §7.1 slug derivation — mirrors gate-manifest/lib/lineage.mjs's deriveSlug exactly.
export function deriveSlug(branchName) {
  const lowered = String(branchName ?? '').toLowerCase();
  const substituted = lowered.replace(/[^a-z0-9-]+/g, '-');
  const collapsed = substituted.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const truncated = collapsed.slice(0, 40).replace(/-+$/g, '');
  return truncated || 'segment';
}

export function currentBranch(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === '' || out === 'HEAD' ? null : out; // detached HEAD never matches a cached token
  } catch {
    return null;
  }
}

function readLineageToken(dir) {
  const token = readBoundedJsonNoFollow(lineagePath(dir));
  if (!token || typeof token !== 'object') return null;
  if (typeof token.segment !== 'string' || typeof token.ulid !== 'string' || typeof token.branch !== 'string') return null;
  return token;
}

function isSymlinkOrOtherNonRegular(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return false;
  }
  return !st.isFile();
}

// SECURITY: never write through a symlink planted at .lineage — see
// gate-manifest/lib/lineage.mjs's identical writeLineageToken for the full
// rationale (a written token embeds the branch name, and branch names can
// contain shell metacharacters, making a followed symlink a near-RCE
// primitive).
function writeLineageToken(dir, token) {
  mkdirSync(segmentDirPath(dir), { recursive: true });
  const p = lineagePath(dir);
  if (isSymlinkOrOtherNonRegular(p)) unlinkSync(p);
  const fd = openSync(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
  try {
    writeFileSync(fd, JSON.stringify(token));
  } finally {
    closeSync(fd);
  }
}

// spec §4.2: ULID is the last 26 chars before `.jsonl`.
function ulidOf(segmentName) {
  return segmentName.slice(segmentName.length - '.jsonl'.length - 26, segmentName.length - '.jsonl'.length);
}

/**
 * Read-only lookup of the current lineage's ALREADY-OPEN segment, if one
 * exists — never mints, never writes .lineage. Returns null when there is no
 * usable existing segment (the next real append would have to mint one).
 *
 * Exists for callers that need to know "what will THIS append target"
 * *before* actually appending, without racing the real writer: minting has a
 * side effect (writing a fresh .lineage token) that does not yet correspond
 * to any file on disk, so calling the full resolveOpenSegment twice before a
 * real append happens can make each call mint a DIFFERENT segment (the
 * second call's token check fails because the first mint's file was never
 * created). A caller that only needs "is there already an open one" is safe
 * to call this before the real write; one that needs the eventual path when
 * a fresh mint is possible must re-resolve with resolveOpenSegment AFTER the
 * real write completes, once the file genuinely exists.
 */
export function peekOpenSegment(dir, { cwd = dirname(dir) } = {}) {
  const branch = currentBranch(cwd);
  const token = readLineageToken(dir);
  if (branch !== null && token && token.branch === branch) {
    if (discoverSegments(dir).valid.includes(token.segment) && ulidOf(token.segment) === token.ulid) {
      return { name: token.segment, isNew: false };
    }
  }
  return null;
}

// Read ONLY the first line of a segment (its anchor-carrying entry) — a
// BOUNDED read, not readRawLines (adversarial-review finding, T-MANIFEST-
// FOREST sixth round): the original version read and split the WHOLE
// segment file just to inspect its first line — recoverOpenSegment's
// per-candidate scan cost grew with the TOTAL size of every discovered
// segment, not just the bytes actually needed. discoverSegments already
// rejects symlinks before a name ever reaches here, so no O_NOFOLLOW
// hardening is needed the way readBoundedJsonNoFollow's (.lineage/
// .store.json) needs it. Mirrors @adlc/gate-manifest/lib/lineage.mjs's
// identical helper.
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
// see", it's the same anomaly gate-manifest's own verifyChain treats as
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
 * Read-only recovery for callers that need "what evidence exists for MY
 * branch" to survive a fresh clone or a branch switch that overwrote
 * `.lineage` (T-MANIFEST-FOREST lineage-durability finding): `.lineage` is
 * deliberately gitignored, so peekOpenSegment alone returns null in exactly
 * those cases even when a real, COMMITTED segment for this branch exists on
 * disk.
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
 * v2-signed — spec §4.4), so recovery here is bounded to the SAME trust tier
 * the segment's content already carries: cryptographically exact when
 * signed, best-effort hash-chain-only when not, same as every other read in
 * this codebase (see doctor's `authenticated: key !== null`). A caller that
 * needs the recovered content to feed a FRESH signature (reassignment,
 * carry-forward) already independently verifies the specific entries it
 * reads (entrySigValid/verifyEntrySig) before trusting them — this function
 * only answers "which FILE is mine", not "is its content trustworthy".
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
 * heal (write) the `.lineage` token from a match here — see that function's
 * doc for the full rationale.
 *
 * NEVER mints (like peekOpenSegment) and NEVER guesses among multiple
 * candidates: a writer resolving where to APPEND must stay precise, but a reader
 * recovering "what's already there" must not silently guess either — two
 * branches forked from the same rootless state can legitimately mint
 * independent segments without coordinating (spec §7 point 1), and the SAME
 * branch can equally end up with two (a token lost mid-stream, then a second
 * mint) — picking one at random could silently ignore genuine evidence in the
 * other. Throws in that case; callers must fail closed, never report "no
 * evidence" when the truth is "ambiguous". Mirrors
 * @adlc/gate-manifest/lib/lineage.mjs's identical function.
 *
 * @returns {{ name: string, isNew: false }|null}
 * @throws {Error} when more than one committed segment's first entry declares
 *   this branch and the local token does not disambiguate
 */
export function recoverOpenSegment(dir, { cwd = dirname(dir) } = {}) {
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
  // forestChainsIntact (the write-time precondition) already refuses the
  // whole forest on ANY invalid object anywhere; recovery must match that
  // fail-closed contract rather than quietly proceed as if nothing is wrong.
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

// Mint-time committability probe — duplicated from
// @adlc/gate-manifest/lib/lineage.mjs's identical helper (twin convention;
// this package deliberately has no gate-manifest dependency). Evidence
// recorded into a gitignored file exists only in this checkout, never in CI
// or any other clone — silent divergence, refused before anything is
// written. Scrubbed child env; soft-pass outside git; real probe failures
// throw rather than recording blindly.
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
  if (run(['rev-parse', '--is-inside-work-tree']) !== 0) return; // no git binary, or not a repository
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
 * Resolve which segment the next ticket-evidence append should target,
 * mirroring @adlc/gate-manifest/lib/lineage.mjs's resolveOpenSegment (spec
 * §7.1) so both producers share the SAME open segment for one branch rather
 * than each minting their own. Tries (a) the local token, then — WITH A KEY
 * ONLY — (b) `recoverOpenSegment`'s exact-`branch` scan, authenticated
 * before use, before minting fresh (T-MANIFEST-FOREST follow-up, gap 1) —
 * see the sibling function's doc for the full rationale. Recovery is
 * KEY-GATED, mirroring readOwnChains' reader contract: a keyless writer
 * extending a recovered segment would strand the checkout (the keyless
 * reader refuses recovered content it cannot authenticate), so a keyless
 * writer mints fresh and writes its own token instead. A keyed writer whose
 * single candidate cannot be authenticated REFUSES — never extends, never
 * mints a duplicate. Deliberately never heals (writes) the token from a (b)
 * match. At mint time the actual segment filename is probed against
 * .gitignore and refused if ignored — evidence written into an ignored file
 * is local-only, silent divergence.
 *
 * @returns {{ name: string, isNew: boolean, anchor?: object|null, branch?: string }}
 */
export function resolveOpenSegment(dir, { cwd = dirname(dir), key = null } = {}) {
  // Persisted authentication mode enforced on every write — mirrors
  // gate-manifest's identical resolver: a keyed forest written keylessly
  // would mint or extend unsigned evidence keyed clones then refuse
  // forever. Markers without the field carry no mode to enforce.
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
      // The BRANCH-BEARING FIRST ENTRY itself must carry a verified v2
      // signature (adversarial-review finding): a v1 signature does not
      // cover `branch`/`anchor`, so a bolted-on branch claim atop a valid
      // v1-signed entry still verifies — only v2 signs every field, so only
      // a v2-verified first entry authenticates the identity claim recovery
      // selects by. Mirrors gate-manifest's identical resolver.
      const lines = readRawLines(segmentPath(dir, recovered.name));
      let first = null;
      try { first = JSON.parse(lines[0]); } catch { /* refused below */ }
      const firstAuthenticated = Boolean(first) && first.sigVersion === 2 && entrySigValid(key, first);
      if (!chainIsIntact(lines, key) || !firstAuthenticated) {
        throw new Error(
          `segment ${recovered.name} declares this branch but cannot be authenticated with the configured key `
          + '(broken chain, or its branch-bearing first entry lacks a verified v2 signature) — refusing to extend '
          + 'it, and refusing to mint a duplicate past it (that would silently fork this branch\'s lineage)',
        );
      }
      return recovered;
    }
  } else {
    // Keyless writers fail closed past a committed same-branch segment —
    // extending strands the checkout (the keyless reader refuses recovered
    // content), minting shadows the committed evidence behind the fresh
    // token. Mirrors the keyless reader's refusal in this same state.
    // Ambiguity counts as existence.
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
  const rootLines = readRawLines(join(dir, 'manifest.jsonl'));
  const rootLast = rootLines.at(-1) ?? null;
  let anchor = null;
  if (rootLast !== null) {
    let lastEntry = null;
    try { lastEntry = JSON.parse(rootLast); } catch { /* leave anchor null; caller's own append will surface the malformed root */ }
    if (lastEntry) anchor = { segment: 'root', seq: lastEntry.seq, lineHash: sha256(rootLast) };
  }
  const ulid = generateSegmentUlid();
  const slug = deriveSlug(branch ?? '');
  const name = `${slug}-${ulid}.jsonl`;
  assertSegmentPathCommittable(dir, name);
  if (branch !== null) writeLineageToken(dir, { segment: name, ulid, branch });
  // branch is omitted (not `null`) on a detached-HEAD mint — see
  // gate-manifest/lib/lineage.mjs's identical resolveOpenSegment for why no
  // sentinel is needed the way anchor:null needs one.
  return { name, isNew: true, anchor, ...(branch !== null ? { branch } : {}) };
}
