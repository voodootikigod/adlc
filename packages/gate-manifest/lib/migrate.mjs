// migrate.mjs — the history-preserving cutover ceremony (spec §8,
// T-01KZM33B2CNGYQH00XFAYWZXYC, T-MANIFEST-FOREST slice 5).
//
// A repository with a LIVE root has no greenfield path into forest mode:
// `enable` refuses it by design and names this ceremony. The ceremony freezes
// the root WITHOUT rewriting a byte of it — every append extends the existing
// chain — after sealing every standing approve so no pre-forest trust is
// grandfathered across the cutover (§4.6's deliberate reset).
//
// The seal census here deliberately duplicates the semantics of TWO other
// implementations it can import neither of (dependency cycles): prosecute's
// reader (the truth being modeled) and rails-guard's CI census (the gate that
// judges the migration PR). The migrate test suite holds this implementation
// to parity by validating the ceremony's output with rails-guard's own
// validators — a census divergence fails there, not on migration day.

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ADLC_DIR, ledgerPath, withLedgerLock } from '@adlc/core';
import { validateKeyParam } from '@adlc/tickets/lib/key-contract.mjs';
import { isSegmentedRepo, markerPath } from './lineage.mjs';
import { segmentDirPath } from './forest.mjs';
import { verify, verifyChain } from './verify.mjs';
import { signEntry } from './sign.mjs';
import { gitignoreContractViolation } from './enable.mjs';

const sha256 = (input) => createHash('sha256').update(input).digest('hex');

/** Reader-faithful provider normalization (NFKC, whitespace stripped,
 *  lowercased) — transcribed from prosecute's module-local normalizeProvider,
 *  which cannot be imported without a dependency cycle. Same rationale and
 *  same limits: defeats accidental variants, not determined forgers. */
const normalizeProvider = (value) =>
  typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, '').toLowerCase() : '';

const tupleKey = (data, ticket) =>
  [normalizeProvider(data?.provider), data?.revision, ticket ?? ''].join('\u0000');

function rawLines(text) {
  const out = [];
  String(text).split('\n').forEach((line, i) => {
    if (line.trim()) out.push({ line, lineNo: i + 1 });
  });
  return out;
}

const parse = (line) => {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  } catch {
    return null;
  }
};

/**
 * §3 standing approves with READER semantics: keyed (provider, revision
 * [, ticket]) — ticket TOP-LEVEL only; `gate ?? type` legacy-shape tolerance;
 * revocation TERMINAL and position-independent. Returns the seal payloads —
 * each carries the VERBATIM fields of the last approve for its tuple (§4.6:
 * "the same provider, authorProvider, revision (and ticket when present)"),
 * not the normalized forms, which exist only for matching.
 */
export function standingApproves(text) {
  const approves = new Map(); // key -> last approve entry's verbatim fields
  const revoked = new Set();
  for (const { line } of rawLines(text)) {
    const entry = parse(line);
    if (entry === null || (entry.gate ?? entry.type) !== 'cross-model-review') continue;
    const { provider, revision, verdict } = entry.data ?? {};
    if (typeof provider !== 'string' || typeof revision !== 'string') continue;
    const key = tupleKey(entry.data, entry.ticket);
    if (verdict === 'approve') {
      approves.set(key, {
        provider: entry.data.provider,
        authorProvider: entry.data.authorProvider,
        revision: entry.data.revision,
        ticket: entry.ticket ?? null,
      });
    } else if (verdict === 'needs-attention') {
      revoked.add(key);
    }
  }
  return [...approves.entries()].filter(([key]) => !revoked.has(key)).map(([, fields]) => fields);
}

/** Entries with no signature at all, with their 1-based line numbers.
 *  Present-but-invalid signatures are verify()'s job, not this scan's. */
function unsignedEntries(text) {
  const out = [];
  for (const { line, lineNo } of rawLines(text)) {
    const entry = parse(line);
    if (entry === null) continue;
    if (entry.sig === undefined || entry.sig === null) out.push({ lineNo, seq: entry.seq ?? null });
  }
  return out;
}

/**
 * Decide what `migrate` would do, writing nothing. Refusal order follows
 * spec §8: key, chain validity, unsigned entries, already-segmented — with
 * the two pure input checks (reason, gitignore contract) folded in where
 * they cost nothing.
 *
 * @returns {{ decision: 'refuse-keyless'|'refuse-reason'|'refuse-symlink'|'refuse-invalid'|'refuse-unsigned'|'refuse-already-segmented'|'refuse-ignored'|'plan',
 *             reason?: string, seals?: object[], unsignedEntries?: object[],
 *             cutover?: {reason: string, sealedApprovals: number, rootLines: number},
 *             backupPath?: string, markerPath?: string, followUps?: string[] }}
 */
export function planMigrate(dir = ADLC_DIR, { key = null, reason = '', attestUnsigned = false } = {}) {
  // Step 1 — the ceremony signs seals and the cutover and must verify every
  // existing signature: there is deliberately no keyless form of it.
  if (key === null || key === undefined || key === '') {
    return { decision: 'refuse-keyless', reason: 'the migration ceremony requires ADLC_MANIFEST_KEY — it signs seal and cutover entries and verifies existing signatures; no keyless form exists' };
  }
  const signingKey = validateKeyParam(key);

  if (typeof reason !== 'string' || reason.length < 8) {
    return { decision: 'refuse-reason', reason: 'the cutover entry requires an operator reason of at least 8 characters (spec §4.5)' };
  }

  // No-follow discipline before ANY read: a repository-controlled symlink at
  // the root (or at manifest.d) would redirect the ceremony's reads and
  // writes outside the workspace — the same smuggling vector every other
  // trust-surface reader in this suite lstat-guards against.
  const lstatIsSymlink = (path) => {
    try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
  };
  for (const path of [dir, ledgerPath('manifest', dir), segmentDirPath(dir)]) {
    if (lstatIsSymlink(path)) {
      return { decision: 'refuse-symlink', reason: `${path} is a symlink — the ceremony refuses to read or write through repository-controlled links` };
    }
  }

  // Step 4 checked EARLY as well as in spec position: everything below reads
  // the root, and a segmented repo's root is frozen — §4.7's FULL test
  // (marker OR cutover tail), so a lost marker cannot cause a re-run that
  // appends duplicate seal and cutover entries to the frozen root.
  if (isSegmentedRepo(dir)) {
    return { decision: 'refuse-already-segmented', reason: 'this repository is already segmented (activation marker or cutover-tailed root) — re-running the ceremony would append duplicate seals and a duplicate cutover to the frozen root' };
  }

  // Step 2 — full §5 verification via the existing verifier, chain-and-tamper
  // first (requireSignatures: false still rejects every PRESENT-but-invalid
  // signature; only genuinely unsigned entries pass through to step 3, which
  // owns that decision explicitly).
  const chain = verify(dir, { key: signingKey, requireSignatures: false });
  if (!chain.valid) {
    return { decision: 'refuse-invalid', reason: `the manifest does not verify (${chain.message}) — run repair-chain first; the ceremony refuses to freeze an invalid history` };
  }

  const rootPath = ledgerPath('manifest', dir);
  const bytes = existsSync(rootPath) ? readFileSync(rootPath) : Buffer.alloc(0);
  const text = bytes.toString('utf8');

  // Step 3 — unsigned entries are an explicit operator decision, with the
  // same disclosure repair-chain gives: count and original line numbers, in
  // the plan and in the recorded evidence.
  const unsigned = unsignedEntries(text);
  if (unsigned.length > 0 && !attestUnsigned) {
    return { decision: 'refuse-unsigned', reason: `${unsigned.length} unsigned entr${unsigned.length === 1 ? 'y' : 'ies'} (lines ${unsigned.map((u) => u.lineNo).join(', ')}) — re-run with --attest-unsigned to seal them under the ceremony key deliberately, with the count disclosed in the cutover record` };
  }

  // The marker this ceremony writes must be COMMITTABLE, or every other
  // clone silently stays in single-file mode — the same two-sided contract
  // enable enforces, reused rather than re-derived.
  const ignored = gitignoreContractViolation(dir);
  if (ignored !== null) {
    return { decision: 'refuse-ignored', reason: ignored };
  }

  // Step 5 — the census, and the plan.
  const seals = standingApproves(text);
  const lines = rawLines(text);
  return {
    decision: 'plan',
    seals,
    unsignedEntries: unsigned,
    cutover: {
      reason,
      sealedApprovals: seals.length,
      // rootLines/rootSha256 bind to the state IMMEDIATELY BEFORE the cutover
      // entry — i.e. after the seals land — so the plan reports the line
      // count the cutover will carry, and the hash is computed at write time
      // over the actual bytes.
      rootLines: lines.length + seals.length,
    },
    backupPath: `${rootPath}.pre-cutover-${sha256(bytes).slice(0, 16)}.bak`,
    markerPath: markerPath(dir),
    followUps: [
      'commit the migrated files in a DEDICATED pull request containing only this ceremony output',
      'pin the minimum toolkit version in CI workflows so a pre-forest toolkit cannot silently write the frozen root',
      'in-flight PRs must rebase and re-record revision-bound attestations; use `gate-manifest migrate-branch` to salvage a branch’s root-tail evidence',
    ],
  };
}

/**
 * Execute the plan. Dry-run (write: false) returns it untouched with
 * `written: false`.
 *
 * Ordering and crash-safety (each step leaves a recoverable state):
 *   backup → seals → cutover → marker.
 * A crash after some seals: the seals already REVOKE their tuples (terminal
 * revocation), so a re-run computes them as no-longer-standing and seals only
 * the remainder — no duplicates. A crash after the cutover but before the
 * marker: the root is cutover-tailed, §4.7's second signal keeps the repo
 * segmented, and a re-run refuses at step 4 rather than double-appending.
 *
 * Appends go through appendManifestEntry (v2 forced): each append owns the
 * ledger lock, chains over the ACTUAL raw tail, and signs every field. The
 * cutover's rootSha256 is computed from the file bytes immediately before its
 * own append and then RE-VERIFIED against the final file — a concurrent
 * writer interleaving in that window is surfaced as a loud operational error
 * with the backup path, never a silently mis-bound cutover.
 */
export function migrate(dir = ADLC_DIR, { key = null, reason = '', attestUnsigned = false, write = false } = {}) {
  const plan = planMigrate(dir, { key, reason, attestUnsigned });
  if (plan.decision !== 'plan' || !write) return { ...plan, written: false };
  const signingKey = validateKeyParam(key);
  const rootPath = ledgerPath('manifest', dir);

  // The ENTIRE step-6 unit — backup, seals, cutover, marker — runs under ONE
  // root-ledger lock (spec: "with --write, under the ledger lock"), so no
  // concurrent appendManifestEntry writer can interleave between the census
  // and the cutover binding. appendManifestEntry cannot be called here (it
  // acquires the same non-reentrant lock), so entries are chained and signed
  // exactly as record.mjs chains them: seq +1, prev over the DECODED tail
  // line, v2 signature over every field via signEntry.
  const applied = withLedgerLock(rootPath, () => {
    // Re-check the segmented state UNDER the lock: a concurrent migration
    // that completed between planning and locking would otherwise get
    // duplicate seals and a duplicate cutover appended to its frozen root.
    if (isSegmentedRepo(dir)) {
      throw new Error('another migration completed while this one waited for the lock — the repository is already segmented');
    }
    const originalBytes = readFileSync(rootPath);
    const originalText = originalBytes.toString('utf8');

    // Everything the plan derived is RE-DERIVED inside the lock: a writer
    // may have appended between planning and locking, changing both the
    // census and the backup hash.
    const seals = standingApproves(originalText);
    const unsigned = unsignedEntries(originalText);
    if (unsigned.length > 0 && !attestUnsigned) {
      throw new Error('unsigned entries appeared between planning and locking — re-run');
    }
    // The backup path is PREDICTABLE (sha16 of the visible manifest bytes),
    // so a hostile checkout can pre-plant a symlink exactly there and turn
    // the backup write into an arbitrary-path write. lstat first, and create
    // exclusively ('wx') so nothing pre-existing is ever followed or
    // silently reused except a byte-identical prior backup (crash re-run).
    const backupPath = `${rootPath}.pre-cutover-${sha256(originalBytes).slice(0, 16)}.bak`;
    let backupStat = null;
    try { backupStat = lstatSync(backupPath); } catch { backupStat = null; }
    if (backupStat !== null) {
      if (!backupStat.isFile()) {
        throw new Error(`backup path ${backupPath} exists and is not a regular file — refusing to write through it`);
      }
      if (!readFileSync(backupPath).equals(originalBytes)) {
        throw new Error(`backup path ${backupPath} exists with different content — refusing to overwrite; resolve it before re-running`);
      }
    } else {
      const fd = openSync(backupPath, 'wx');
      try {
        writeSync(fd, originalBytes);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }

    const lines = rawLines(originalText);
    let lastLine = lines.length ? lines.at(-1).line : null;
    let lastSeq = lastLine ? (parse(lastLine)?.seq ?? lines.length) : 0;
    let appendix = '';
    const appendEntry = (payload) => {
      const chained = {
        seq: lastSeq + 1,
        ...payload,
        ts: payload.ts ?? new Date().toISOString(),
        files: payload.files ?? {},
        prev: lastLine === null ? null : sha256(lastLine),
      };
      chained.sigVersion = 2;
      chained.sig = signEntry(signingKey, chained);
      const line = JSON.stringify(chained);
      appendix += line + '\n';
      lastLine = line;
      lastSeq = chained.seq;
    };

    for (const seal of seals) {
      appendEntry({
        gate: 'cross-model-review',
        ...(seal.ticket ? { ticket: seal.ticket } : {}),
        data: {
          verdict: 'needs-attention',
          sealedByCutover: true,
          provider: seal.provider,
          authorProvider: seal.authorProvider,
          revision: seal.revision,
        },
      });
    }

    // §4.5 bindings computed over base (+ newline repair) + seals — exactly
    // the bytes that will precede the cutover line in the file.
    const newlineRepair = originalBytes.length > 0 && originalBytes[originalBytes.length - 1] !== 0x0a ? '\n' : '';
    const preCutoverBytes = Buffer.concat([originalBytes, Buffer.from(newlineRepair + appendix, 'utf8')]);
    appendEntry({
      gate: 'manifest-cutover',
      data: {
        reason,
        rootLines: rawLines(preCutoverBytes.toString('utf8')).length,
        rootSha256: sha256(preCutoverBytes),
        sealedApprovals: seals.length,
        ...(unsigned.length > 0
          ? { attestedUnsignedEntries: unsigned.length, attestedUnsignedLines: unsigned.map((u) => u.lineNo) }
          : {}),
      },
    });

    // APPEND-mode, never a full rewrite: a crash mid-write must leave the
    // original region intact (a whole-root rewrite would truncate history at
    // whatever byte the crash hit). A root whose final line lacks its
    // trailing newline gets one first, or the first seal would concatenate
    // onto the old tail line and corrupt both.
    {
      // Durable, append-mode: the backup was fsynced above, and the appendix
      // must reach disk before the marker publishes — otherwise a power loss
      // could surface a marker (or a later write) with the cutover entries
      // still in the page cache, assembling states no crash-recovery path
      // expects.
      const fd = openSync(rootPath, 'a');
      try {
        writeSync(fd, newlineRepair + appendix);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }

    // Marker (§4.7) inside the SAME lock — the unit is not done until the
    // repo carries both signals. Temp file cleanup on EVERY failure path:
    // a stranded .store.json.tmp-* would trip forest validation later.
    const segDir = segmentDirPath(dir);
    mkdirSync(segDir, { recursive: true });
    // A marker file already present here was NOT recognized by
    // isSegmentedRepo (or the plan would have refused) — an unrecognized or
    // foreign trust marker is a broken state to surface, never something to
    // silently overwrite.
    if (lstatSync(markerPath(dir), { throwIfNoEntry: false }) !== undefined) {
      throw new Error(`${markerPath(dir)} already exists but was not recognized as a valid activation marker — refusing to overwrite a trust file; inspect and remove it deliberately before re-running`);
    }
    const tempPath = join(segDir, `.store.json.tmp-${randomBytes(6).toString('hex')}`);
    try {
      const fd = openSync(tempPath, 'wx');
      try {
        writeSync(fd, JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyed' }));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(tempPath, markerPath(dir));
      // fsync the directories so the rename and the new dirents (backup,
      // manifest.d) are durable, not just file contents. BEST-EFFORT: Windows
      // cannot open directories for fsync (EPERM/EISDIR) — the rename is
      // still atomic there, and reporting failure AFTER committing the
      // cutover would be strictly worse than reduced metadata durability.
      for (const d of [segDir, dir]) {
        try {
          const dirFd = openSync(d, 'r');
          try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
        } catch { /* platform without directory fsync */ }
      }
    } catch (err) {
      rmSync(tempPath, { force: true });
      throw err;
    }
    if (!isSegmentedRepo(dir)) {
      rmSync(markerPath(dir), { force: true });
      throw new Error('the resolver does not recognize the marker that was just written (format/version skew) — rolled back');
    }

    // Verify the ROOT chain here, INSIDE the lock, where nothing else can
    // write: this is authoritative for everything the ceremony changed. The
    // whole-forest verify() below is advisory — the instant the marker
    // published, a concurrent writer may legitimately mint a segment, and a
    // forest-wide failure must never be answered by deleting manifest.d/
    // (that could destroy the concurrent writer's real evidence).
    const finalText = readFileSync(rootPath, 'utf8');
    const finalCheck = verifyChain(
      rawLines(finalText),
      { key: signingKey, requireSignatures: unsigned.length === 0, anchorOnFirst: false }
    );
    if (!finalCheck.valid) {
      throw new Error(`the migrated root does not chain-verify (${finalCheck.message}) — restore ${backupPath} over manifest.jsonl; if .adlc/manifest.d contains ONLY .store.json, delete the directory too, otherwise investigate its segments before touching them`);
    }
    return {
      seals,
      unsignedEntries: unsigned,
      backupPath,
      cutover: {
        reason,
        sealedApprovals: seals.length,
        rootLines: rawLines(preCutoverBytes.toString('utf8')).length,
      },
    };
  }, dir);

  // Post-ceremony verification: the migrated ledger must verify strictly
  // under the key. attest-unsigned runs tolerate exactly the disclosed
  // legacy prefix.
  const post = verify(dir, { key: signingKey, requireSignatures: applied.unsignedEntries.length === 0 });
  if (!post.valid) {
    // Advisory, not destructive: the root was verified authoritatively
    // inside the lock; a forest-level failure here can be a concurrent
    // writer's half-minted segment, whose evidence must not be deleted on
    // this path's say-so.
    throw new Error(`post-ceremony forest verification reported: ${post.message}. The migrated ROOT verified inside the lock; investigate ${segmentDirPath(dir)} before altering anything — a concurrent writer may have minted a segment mid-verification. Backup: ${applied.backupPath}`);
  }

  // Applied metadata comes from INSIDE the lock — the plan's numbers can be
  // stale the moment a writer appended between planning and locking.
  return { ...plan, ...applied, decision: 'applied', written: true };
}
