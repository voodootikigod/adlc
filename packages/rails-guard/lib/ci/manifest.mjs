// The gate's single reader for `.adlc/manifest.jsonl`, and the append-only rule (#140).
//
// Every question the gate asks about the manifest — did this PR create it, is it
// append-only, does it carry valid migration evidence — is answered from this one
// reader. That is the point: the bug in #314 was a second, filesystem-based reader that
// answered "does the manifest exist" differently from CI's clean checkout, and the
// hardening below (rounds 5-7) had to be argued once per reader. There is one now.

import { createHash } from 'node:crypto';
import { deny, fail } from './errors.mjs';
import { parseJson } from './git.mjs';

/**
 * The COMMITTED content of `.adlc/manifest.jsonl` at HEAD.
 *
 * Whether a PR "creates the manifest" is a DIFF question, not a filesystem one. Every
 * developer who has run the toolkit has an untracked, gitignored manifest in their tree;
 * it is in zero commits, so it must not be read, and reading it is why a local verdict
 * used to disagree with CI's clean checkout (#314).
 *
 * @returns {{present: boolean, text: string, bytes?: Buffer}} `present` is whether the
 *   manifest is TRACKED at HEAD; `text` is a utf8 view for the semantic checks (trim,
 *   JSON parse); `bytes` is the raw buffer, present only when the file is, because the
 *   only consumer (the append-only prefix check) tests `present` first.
 */
export function committedManifestAtHead(git) {
  // Pin HEAD to ONE immutable commit sha and resolve every lookup against it (#314
  // round 7). Otherwise the ancestor check and the leaf check each re-resolve the
  // mutable `HEAD`, and a concurrent ref change between them — tree A with a normal
  // `.adlc`, tree B with a symlinked one — would pass the ancestor guard on A while the
  // leaf reads absent on B.
  const rev = git(['rev-parse', 'HEAD'], 'git rev-parse HEAD');
  if (rev.status !== 0) fail('git rev-parse HEAD failed (operational error) — failing closed.');
  const head = rev.stdout.trim();

  // ANCESTOR GUARD (#314 round 6). `git ls-tree <head> -- .adlc/manifest.jsonl` does not
  // descend a symlinked or submodule `.adlc`, so an ancestor symlink (`.adlc` pointing
  // at some `state/` directory holding a forged manifest) would make the leaf lookup
  // report "absent" while any filesystem consumer follows the link and reads the
  // pre-populated evidence. Require `.adlc` itself to be a real tree before trusting the
  // leaf. An absent `.adlc` is fine — the directory simply does not exist yet.
  const adlcDir = git(['ls-tree', head, '--', '.adlc'], 'git ls-tree HEAD .adlc');
  if (adlcDir.status !== 0) fail('git ls-tree failed for the HEAD .adlc directory (operational error) — failing closed.');
  const adlcRow = adlcDir.stdout.trim();
  if (adlcRow && adlcRow.split(/\s+/)[0] !== '040000') {
    deny('.adlc must be a directory, not a symlink or submodule');
  }

  const ls = git(['ls-tree', head, '--', '.adlc/manifest.jsonl'], 'git ls-tree HEAD manifest');
  if (ls.status !== 0) fail('git ls-tree failed for the HEAD manifest (operational error) — failing closed.');
  const row = ls.stdout.trim();
  if (!row) return { present: false, text: '' };

  const [mode, type, hash] = row.split(/\s+/);
  // A manifest committed as a SYMLINK must not smuggle evidence: `git show` returns a
  // symlink's TARGET STRING rather than the target's content, so a whitespace-target
  // symlink would slip past a `.trim()` emptiness check while downstream readers that
  // follow the link consume forged entries.
  if (type !== 'blob' || mode !== '100644') {
    deny('.adlc/manifest.jsonl must be a regular tracked file, not a symlink or submodule');
  }
  // Read by the immutable BLOB HASH from the same ls-tree row, not `git show HEAD:path`:
  // `git show` re-resolves the mutable HEAD and could bind content to a different tree
  // than the mode check just inspected — a TOCTOU (#314 round 5). The hash cannot move,
  // so metadata and content provably describe the same object.
  const blob = git(['cat-file', 'blob', hash], 'git cat-file HEAD manifest blob', { raw: true });
  if (blob.status !== 0) fail('git cat-file failed for the HEAD manifest blob (operational error) — failing closed.');
  return { present: true, text: blob.stdout.toString('utf8'), bytes: blob.stdout };
}

/**
 * The base manifest's raw bytes, for the append-only comparison.
 * Raw because the comparison is byte-for-byte; see `assertAppendOnly`.
 */
export function baseManifestBytes(git, trustedBase) {
  const shown = git(['show', `${trustedBase}:.adlc/manifest.jsonl`], 'git show base manifest', { raw: true });
  if (shown.status !== 0) fail('git show failed for an existing base manifest (operational error) — failing closed.');
  return shown.stdout;
}

/**
 * The HEAD manifest must begin with the base manifest, BYTE for byte (#314 round 7).
 *
 * Not a decoded-string prefix check: utf8 decoding is non-injective — distinct invalid
 * byte sequences all decode to U+FFFD — so a comparison on decoded text could miss a
 * raw-byte rewrite of the region the base already occupies.
 */
export function assertAppendOnly(headBytes, baseBytes) {
  if (headBytes.length < baseBytes.length || !headBytes.subarray(0, baseBytes.length).equals(baseBytes)) {
    deny('.adlc/manifest.jsonl must be append-only in PRs');
  }
}

/** The non-blank RAW lines of a manifest, in order. */
export function manifestRawLines(text) {
  return String(text).split('\n').filter((line) => line.trim());
}

/** Split manifest text into parsed entries, naming the source on a parse failure. */
export function manifestLines(text, label) {
  return manifestRawLines(text).map((line, index) => parseJson(line, `${label} line ${index + 1}`));
}

/**
 * Validate the evidence a legacy-to-directory ticket-store migration must append.
 *
 * The migration is the one ceremony allowed to restructure the ticket store in a PR, so
 * its evidence is checked hard: exactly the expected entry shapes, bound to the migrated
 * store and archive hashes AND to one transaction id, extending the manifest's hash
 * chain and sequence without a gap.
 */
export function validateMigrationEvidence(baseText, headText, expectedStoreHash, expectedArchiveHash) {
  const baseRawLines = manifestRawLines(baseText);
  const headRawLines = manifestRawLines(headText);
  const baseEntries = manifestLines(baseText, 'base manifest');
  const headEntries = manifestLines(headText, 'HEAD manifest');
  const appended = headEntries.slice(baseEntries.length);
  const appendedRawLines = headRawLines.slice(baseRawLines.length);
  if (![1, 2].includes(appended.length)) deny('migration must append apply evidence and at most one recovery-complete entry');

  const entry = appended[0];
  if (entry?.gate !== 'ticket-migrate' || entry?.data?.operation !== 'migrate' || entry?.data?.action !== 'apply') {
    deny('migration evidence must be a ticket-migrate/apply entry');
  }
  if (entry.data.bindingScope !== 'store'
    || entry.data.storeHash !== expectedStoreHash
    || entry.data.archiveHash !== expectedArchiveHash
    || typeof entry.data.transactionId !== 'string') {
    deny('migration evidence is not bound to the migrated active/archive hashes and transaction');
  }

  if (appended.length === 2) {
    const recovery = appended[1];
    if (recovery?.gate !== 'ticket-migrate' || recovery?.data?.operation !== 'migrate' || recovery?.data?.action !== 'recover-complete') {
      deny('second migration evidence entry must be ticket-migrate/recover-complete');
    }
    if (recovery.data.transactionId !== entry.data.transactionId
      || recovery.data.bindingScope !== 'store'
      || recovery.data.storeHash !== expectedStoreHash
      || recovery.data.archiveHash !== expectedArchiveHash) {
      deny('migration recovery evidence is not bound to the apply transaction and migrated hashes');
    }
  }

  // Chain over the ACTUAL RAW LINES. `prev` is defined as sha256 of the previous raw line
  // (@adlc/gate-manifest record.mjs / verify.mjs), so re-serializing a parsed entry with
  // JSON.stringify only coincides with the truth when the writer's exact byte form is
  // reproduced. It is not: leading whitespace, key order, or spacing all diverge, and the
  // SECOND appended entry was validated against that re-serialization rather than the line
  // actually in the file — accepting a manifest whose real chain is broken (cross-model
  // review, #363 round 4; the same bug is on main, faithfully ported here).
  let previousLine = baseRawLines.at(-1) ?? null;
  let previousSeq = baseEntries.length ? baseEntries.at(-1).seq : 0;
  appended.forEach((appendedEntry, index) => {
    const expectedPrev = previousLine ? createHash('sha256').update(previousLine).digest('hex') : null;
    if (appendedEntry.prev !== expectedPrev) deny('migration evidence does not extend the manifest hash chain');
    if (appendedEntry.seq !== previousSeq + 1) deny('migration evidence sequence does not extend the manifest');
    previousLine = appendedRawLines[index];
    previousSeq = appendedEntry.seq;
  });
}
