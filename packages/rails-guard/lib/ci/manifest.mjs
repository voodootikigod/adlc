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
// Hardened forest primitives, reused rather than reimplemented (see the
// forest-validation header below): verifyChain walks one chain's raw lines
// with the anchor-position rules; resolveAnchor and detectAnchorCycle are
// pure over Maps of data. rails-guard already depends on @adlc/gate-manifest.
import { verifyChain } from '@adlc/gate-manifest/lib/verify.mjs';
import { resolveAnchor, detectAnchorCycle } from '@adlc/gate-manifest/lib/forest.mjs';

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

// ════════════════════════════════════════════════════════════════════════════
// Forest validation (spec §9.1–9.3, T-MANIFEST-FOREST slice 6).
//
// Everything below extends this single reader to `.adlc/manifest.d/`. The
// anchor-resolution and cycle-detection logic is imported from
// @adlc/gate-manifest (already a dependency) rather than reimplemented — the
// enable-disclosure work demonstrated exactly how a hand-rolled duplicate of
// a hardened helper reintroduces the vulnerability the original closed.
// SEGMENT_NAME_RE and the reserved-name set are module-local in forest.mjs
// (out of this ticket's scope to export), so they are duplicated here with
// the same rationale enable.mjs recorded for MARKER: both transcribe the
// railed spec (§4.2, §4.7), so drift means one of us diverged from the spec
// and the cross-implementation test will catch it.

/** spec §4.2 — `<slug>-<ulid>.jsonl`, lowercase slug, UPPERCASE Crockford ULID. */
const CI_SEGMENT_NAME_RE = /^[a-z0-9-]{1,40}-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/;
/** spec §4.7 — the marker and the (never-committed, but grammar-exempt) token. */
const CI_RESERVED_NAMES = new Set(['.store.json', '.lineage']);

/**
 * The committed root AND forest at HEAD, from ONE pinned rev.
 *
 * A separate pin per file would be the #314 round-7 TOCTOU spread across
 * files: the root read from tree A and the segments from tree B, with a
 * concurrent ref move between them making the combined snapshot describe a
 * tree that never existed. One `rev-parse`, every lookup against that sha,
 * every blob read by the hash from its own ls-tree row.
 *
 * Mode/type discipline matches the root's exactly, for the same smuggling
 * reasons: `.adlc` and `.adlc/manifest.d` must be real trees; every entry
 * under `manifest.d/` must be a regular 100644 blob — a symlinked segment
 * (or marker) is the same forged-evidence vector as a symlinked manifest.
 * Nested directories are denied outright (§4.2).
 *
 * @returns {{ rev: string,
 *             root: {present: boolean, text: string, bytes?: Buffer},
 *             manifestDPresent: boolean,
 *             segments: Map<string, Buffer> }}  reserved names are mode-checked
 *   but never included in `segments`.
 */
export function committedEvidenceAtHead(git) {
  const revResult = git(['rev-parse', 'HEAD'], 'git rev-parse HEAD');
  if (revResult.status !== 0) fail('git rev-parse HEAD failed (operational error) — failing closed.');
  const rev = revResult.stdout.toString().trim();

  const adlcDir = git(['ls-tree', rev, '--', '.adlc'], 'git ls-tree .adlc');
  if (adlcDir.status !== 0) fail('git ls-tree failed for the HEAD .adlc directory (operational error) — failing closed.');
  const adlcRow = adlcDir.stdout.toString().trim();
  if (adlcRow && adlcRow.split(/\s+/)[0] !== '040000') {
    deny('.adlc must be a directory, not a symlink or submodule');
  }

  const readBlob = (hash, label) => {
    const blob = git(['cat-file', 'blob', hash], label, { raw: true });
    if (blob.status !== 0) fail(`git cat-file failed for ${label} (operational error) — failing closed.`);
    return Buffer.from(blob.stdout);
  };

  // Root — same rules committedManifestAtHead applies, against THIS pin.
  const rootRow = git(['ls-tree', rev, '--', '.adlc/manifest.jsonl'], 'git ls-tree manifest');
  if (rootRow.status !== 0) fail('git ls-tree failed for the HEAD manifest (operational error) — failing closed.');
  let root = { present: false, text: '' };
  const rootLine = rootRow.stdout.toString().trim();
  if (rootLine) {
    const [mode, type, hash] = rootLine.split(/\s+/);
    if (type !== 'blob' || mode !== '100644') {
      deny('.adlc/manifest.jsonl must be a regular tracked file, not a symlink or submodule');
    }
    const bytes = readBlob(hash, 'HEAD manifest blob');
    root = { present: true, text: bytes.toString('utf8'), bytes };
  }

  // Forest
  const dirRow = git(['ls-tree', rev, '--', '.adlc/manifest.d'], 'git ls-tree manifest.d');
  if (dirRow.status !== 0) fail('git ls-tree failed for the HEAD manifest.d (operational error) — failing closed.');
  const dirLine = dirRow.stdout.toString().trim();
  if (!dirLine) return { rev, root, manifestDPresent: false, segments: new Map(), marker: null };
  if (dirLine.split(/\s+/)[0] !== '040000') {
    deny('.adlc/manifest.d must be a directory, not a symlink or submodule');
  }

  const listing = git(['ls-tree', rev, '.adlc/manifest.d/'], 'git ls-tree manifest.d contents');
  if (listing.status !== 0) fail('git ls-tree failed for the HEAD manifest.d contents (operational error) — failing closed.');
  const segments = new Map();
  let marker = null;
  for (const row of listing.stdout.toString().split('\n')) {
    if (!row.trim()) continue;
    const tab = row.indexOf('\t');
    const [mode, type, hash] = row.slice(0, tab).split(/\s+/);
    const name = row.slice(tab + 1).replace(/^\.adlc\/manifest\.d\//, '');
    if (type === 'tree') deny(`.adlc/manifest.d must not contain nested directories (${name})`);
    if (type !== 'blob' || mode !== '100644') {
      deny(`.adlc/manifest.d/${name} must be a regular tracked file, not a symlink or submodule`);
    }
    if (name === '.lineage') {
      // §4.8: the lineage token is checkout-local and NEVER committed. A
      // committed token makes every clone treat its segment as self-minted,
      // poisoning the peeked keyless fast path's trust assumption — the
      // reader merely skips it, but the GATE must refuse to let it land.
      deny('.adlc/manifest.d/.lineage is checkout-local and must never be committed');
    }
    if (name === '.store.json') {
      marker = readBlob(hash, 'HEAD activation marker');
      continue; // mode-checked above; the marker is not a segment
    }
    segments.set(name, readBlob(hash, `HEAD segment blob ${name}`));
  }
  return { rev, root, manifestDPresent: true, segments, marker };
}

/**
 * The committed forest at the trusted base. Base is the merged main this PR
 * targets — its shape was validated when its own PRs merged, so this collects
 * names and bytes without re-litigating modes (mirroring baseManifestBytes).
 *
 * @returns {Map<string, Buffer>}
 */
export function baseForestBytes(git, trustedBase) {
  const dirRow = git(['ls-tree', trustedBase, '--', '.adlc/manifest.d'], 'git ls-tree base manifest.d');
  if (dirRow.status !== 0) fail('git ls-tree failed for the base manifest.d (operational error) — failing closed.');
  if (!dirRow.stdout.toString().trim()) return { segments: new Map(), marker: null };
  const listing = git(['ls-tree', trustedBase, '.adlc/manifest.d/'], 'git ls-tree base manifest.d contents');
  if (listing.status !== 0) fail('git ls-tree failed for the base manifest.d contents (operational error) — failing closed.');
  const segments = new Map();
  let marker = null;
  for (const row of listing.stdout.toString().split('\n')) {
    if (!row.trim()) continue;
    const tab = row.indexOf('\t');
    const [, type, hash] = row.slice(0, tab).split(/\s+/);
    const name = row.slice(tab + 1).replace(/^\.adlc\/manifest\.d\//, '');
    if (type !== 'blob') continue;
    if (CI_RESERVED_NAMES.has(name)) {
      if (name === '.store.json') {
        const blob = git(['cat-file', 'blob', hash], 'base activation marker', { raw: true });
        if (blob.status !== 0) fail('git cat-file failed for the base activation marker (operational error) — failing closed.');
        marker = Buffer.from(blob.stdout);
      }
      continue;
    }
    const blob = git(['cat-file', 'blob', hash], `base segment blob ${name}`, { raw: true });
    if (blob.status !== 0) fail(`git cat-file failed for base segment ${name} (operational error) — failing closed.`);
    segments.set(name, Buffer.from(blob.stdout));
  }
  return { segments, marker };
}

/**
 * §9.2 — every segment committed at base must survive to HEAD with its base
 * bytes as a byte prefix. Byte-level for the same non-injective-utf8 reason
 * as assertAppendOnly; per-file because each segment is its own chain.
 */
export function validateSegmentAppendOnly(baseSegments, headSegments, { forestAuth = null } = {}) {
  for (const [name, baseBytes] of baseSegments) {
    const headBytes = headSegments.get(name);
    if (headBytes === undefined) {
      deny(`.adlc/manifest.d/${name} exists at base but is absent at HEAD — committed segments cannot be removed or renamed in a PR`);
    }
    if (headBytes.length < baseBytes.length || !headBytes.subarray(0, baseBytes.length).equals(baseBytes)) {
      deny(`.adlc/manifest.d/${name} must be append-only in PRs`);
    }
    if (headBytes.length === baseBytes.length) continue; // untouched: validated when it landed
    // §9.2's letter is byte-prefix only, but a corrupt continuation landing
    // at merge makes every keyed reader fail the whole forest closed — the
    // early catch is the gate's job. Full-chain keyless verify plus §4.3
    // contiguity, only for segments this PR actually extended.
    const text = headBytes.toString('utf8');
    const chain = verifyChain(numberedLines(text), { key: null, requireSignatures: false, anchorOnFirst: true });
    if (!chain.valid) {
      deny(`.adlc/manifest.d/${name} appended entries do not chain-verify: ${chain.message}`);
    }
    let expectedSeq = 1;
    for (const raw of manifestRawLines(text)) {
      const entry = tryParse(raw);
      if (entry === null) continue;
      if (entry.seq !== expectedSeq) {
        deny(`.adlc/manifest.d/${name} seq must be contiguous from 1 (spec §4.3): expected ${expectedSeq}, found ${entry.seq}`);
      }
      expectedSeq += 1;
    }
    if (forestAuth === 'keyed') {
      const baseLineCount = manifestRawLines(baseBytes.toString('utf8')).length;
      assertEntriesCarrySigs(manifestRawLines(text).slice(baseLineCount), `.adlc/manifest.d/${name} continuation`);
    }
  }
}

/** Raw bytes of the last non-empty line of a buffer, no trailing newline. */
function rawLastLine(buf) {
  // Mirrors manifestRawLines' blank-line filter at the byte level: the
  // writer chains prev over the last NON-BLANK raw line, so a trailing
  // whitespace-only line must be skipped here too or a valid chain fails.
  const isBlank = (bytes) => bytes.every((b) => b === 0x20 || b === 0x09 || b === 0x0d);
  let end = buf.length;
  while (end > 0) {
    while (end > 0 && buf[end - 1] === 0x0a) end -= 1;
    let start = end;
    while (start > 0 && buf[start - 1] !== 0x0a) start -= 1;
    const line = buf.subarray(start, end);
    if (line.length > 0 && !isBlank(line)) return line;
    end = start;
  }
  return buf.subarray(0, 0);
}

/** Presence-only signature discipline for a keyed forest. The gate holds no
 *  key, so this is the same posture the seal/cutover entries get: a keyed
 *  forest's writer always signs, so an unsigned entry is either a refused
 *  keyless write or a forgery — catching it before merge beats every clone
 *  failing the forest closed after. Keyless and pre-policy forests have no
 *  mode to enforce. */
function assertEntriesCarrySigs(rawLines, label, { firstMustBeV2 = false } = {}) {
  // Matched to the real writer, not an idealized one: the segment writer
  // forces v2 on the MINT (a v1-signed first entry could never be
  // recovery-authenticated — v1 does not sign branch/anchor) and follows
  // the configured version afterwards, which is v1 in repos that have not
  // adopted v2. So: first entry v2 when required, every entry sig-presence.
  let first = true;
  for (const raw of rawLines) {
    const entry = tryParse(raw);
    if (entry === null) continue;
    if (typeof entry.sig !== 'string' || entry.sig === '') {
      deny(`${label} carries an unsigned entry — this forest declares auth "keyed", and an unsigned entry strands every keyed reader`);
    }
    if (first && firstMustBeV2 && entry.sigVersion !== 2) {
      deny(`${label} first entry must carry sigVersion 2 — the keyed writer always mints v2, and a v1 first entry can never be recovery-authenticated (v1 does not sign branch/anchor)`);
    }
    first = false;
  }
}

/** Raw non-blank lines with 1-based numbers, in verifyChain's input shape. */
function numberedLines(text) {
  const out = [];
  String(text).split('\n').forEach((line, i) => {
    if (line.trim()) out.push({ line, lineNo: i + 1 });
  });
  return out;
}

/** Lenient parse for DETECTION only. The pre-forest gate never parsed the
 *  root — it byte-compared — so lines that are not JSON entries must keep
 *  their old meaning (opaque appended bytes, allowed), not become a new
 *  failure mode (AC19: a segment-free repo gets byte-identical verdicts).
 *  Only once a cutover/seal entry IS detected does strict parsing apply. */
function tryParse(line) {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  } catch {
    return null;
  }
}

const isCutoverEntry = (entry) => entry?.gate === 'manifest-cutover';
const isSealEntry = (entry) => entry?.gate === 'cross-model-review' && entry?.data?.sealedByCutover === true;

/** §9.1 structural presence rule: rails-guard holds no key, so it checks that
 *  the fields EXIST — spoofing is contained (not prevented) because the
 *  absent-or-invalid signature makes every keyed reader fail the forest
 *  closed, denying the spoofer rather than widening trust. */
function assertSealCutoverSignatureShape(entry, label) {
  if (entry.sigVersion !== 2) deny(`${label} must carry sigVersion 2`);
  if (typeof entry.sig !== 'string' || entry.sig === '') deny(`${label} must carry a sig field`);
}

/**
 * §9.1 seal+cutover set: zero or more §4.6 seal entries followed by EXACTLY
 * one terminal §4.5 cutover entry, chain-verified over the actual raw lines
 * exactly as migration evidence is, with the cutover's own bindings checked:
 * `rootSha256` must hash every byte before the cutover line, `rootLines`
 * must count every entry before it, and `sealedApprovals` must equal the
 * seal entries appended. All of that is computable from public bytes — a
 * keyless author can fake it wholesale, which is §9.1's stated containment
 * tradeoff, not a gap in this check.
 */
export function validateSealCutoverAppend(baseText, headText, headBytes = Buffer.from(headText, 'utf8'), baseBytes = Buffer.from(baseText, 'utf8')) {
  const baseRaw = manifestRawLines(baseText);
  const headRaw = manifestRawLines(headText);
  const appendedRaw = headRaw.slice(baseRaw.length);
  const appended = appendedRaw.map((line, i) => parseJson(line, `appended root entry ${i + 1}`));

  const cutoverIndex = appended.findIndex(isCutoverEntry);
  if (cutoverIndex !== appended.length - 1) {
    deny('a root append containing a manifest-cutover entry must end with it — the cutover entry is terminal');
  }
  const cut = appended.at(-1);
  const seals = appended.slice(0, -1);
  for (const [i, entry] of appended.entries()) {
    // Root entries never carry anchors (§4.4) — the reader rejects the whole
    // root on one, so a seal smuggling an anchor field would brick every
    // clone while passing the shape checks below.
    if (Object.hasOwn(entry, 'anchor')) {
      deny(`root append entry ${i + 1} carries an anchor field — root entries never do, and every reader would reject the root`);
    }
  }
  for (const [i, entry] of seals.entries()) {
    if (!isSealEntry(entry)) {
      deny(`root append entry ${i + 1} precedes a cutover entry but is not a §4.6 seal (cross-model-review with data.sealedByCutover) — only a valid seal+cutover set may accompany a cutover`);
    }
    if (entry.data?.verdict !== 'needs-attention') deny(`seal entry ${i + 1} must carry data.verdict "needs-attention"`);
    assertSealCutoverSignatureShape(entry, `seal entry ${i + 1}`);
  }
  assertSealCutoverSignatureShape(cut, 'the cutover entry');
  if (typeof cut.data?.reason !== 'string' || cut.data.reason.length < 8) {
    deny('the cutover entry must carry an operator reason of at least 8 characters');
  }

  // Chain over the ACTUAL raw lines — as BYTES for the base tail, whose
  // legacy region may not decode losslessly; appended lines are strict JSON
  // and decode round-trip clean, so their utf8 re-encoding is byte-exact.
  const baseTailEntry = baseRaw.length ? tryParse(baseRaw.at(-1)) : null;
  const baseTailBytes = baseBytes === null ? Buffer.alloc(0) : rawLastLine(baseBytes);
  let previousLineBytes = baseTailBytes.length > 0 ? baseTailBytes : null;
  let previousSeq = Number.isInteger(baseTailEntry?.seq) ? baseTailEntry.seq : baseRaw.length;
  for (const [i, entry] of appended.entries()) {
    const expectedPrev = previousLineBytes ? createHash('sha256').update(previousLineBytes).digest('hex') : null;
    if (entry.prev !== expectedPrev) deny('the seal+cutover append does not extend the manifest hash chain');
    if (entry.seq !== previousSeq + 1) deny('the seal+cutover append sequence does not extend the manifest');
    previousLineBytes = Buffer.from(appendedRaw[i], 'utf8');
    previousSeq = entry.seq;
  }

  // Cutover bindings: everything before the cutover LINE, as RAW bytes.
  // Hashing the decoded text would re-encode U+FFFD for any invalid utf8 in
  // the legacy region and diverge from the ceremony's hash-of-raw-bytes —
  // denying valid cutovers and laundering byte-level differences alike. The
  // cutover line itself is strict-parsed JSON, so its bytes decode
  // losslessly and locate exactly in the raw buffer.
  const cutLineBytes = Buffer.from(appendedRaw.at(-1), 'utf8');
  const cutStart = headBytes.lastIndexOf(cutLineBytes);
  if (cutStart < 0) fail('cutover line could not be located in the raw head bytes (operational error) — failing closed.');
  const priorBytes = headBytes.subarray(0, cutStart);
  if (cut.data.rootSha256 !== createHash('sha256').update(priorBytes).digest('hex')) {
    deny('the cutover entry rootSha256 does not hash the prior root bytes');
  }
  if (cut.data.rootLines !== headRaw.length - 1) {
    deny('the cutover entry rootLines does not count the prior root entries');
  }
  if (cut.data.sealedApprovals !== seals.length) {
    deny('the cutover entry sealedApprovals does not match the seal entries appended');
  }

  // §4.6: for EVERY standing approve in the root, one seal. A cutover that
  // freezes the root while leaving approves standing grandfathers pre-forest
  // trust across the cutover — the reset §4.6 exists to force. Standing is
  // computed per §3 over the base text: (provider, revision) tuples whose
  // last cross-model verdict is approve.
  const standing = standingApproveTuples(baseText);
  const sealed = new Set(seals.map((entry) => approveTupleKey(entry.data, entry.ticket)));
  for (const tuple of standing) {
    if (!sealed.has(tuple)) {
      const [provider, revision, ticket] = tuple.split('\u0000');
      deny(`the cutover leaves a standing approve unsealed (provider ${provider}, revision ${revision}${ticket ? `, ticket ${ticket}` : ''}) — §4.6 requires one seal per standing approve`);
    }
  }
}

/**
 * §9.1 — the root's transition rules, dispatching on the base's last entry.
 *
 * Base root cutover → HEAD root byte-identical: that is the freeze.
 * Base root not cutover → byte-prefix (today's rule); ordinary evidence
 * appends stay legal (§11: a single-file repo keeps exact current behavior
 * indefinitely — §9.1's "only permitted appends" is read against that
 * guarantee, which the maintainer should adjudicate if the tension is real);
 * but the moment the appended region contains a cutover or seal entry, the
 * WHOLE region must be a valid seal+cutover set. Migration evidence keeps
 * its existing, separately-validated path.
 */
export function assertRootTransition({ basePresent, baseBytes, headPresent, headBytes, migration, baseMarkerPresent = false }) {
  if (!basePresent) return; // creation rules live in verifyManifest's un-seeded branch, unchanged
  if (!headPresent) deny('.adlc/manifest.jsonl exists at base but is absent at HEAD');

  const baseText = baseBytes.toString('utf8');
  const baseRaw = manifestRawLines(baseText);
  const baseTail = baseRaw.length ? tryParse(baseRaw.at(-1)) : null;

  // The cutover tail is not the only freeze signal: a base carrying the
  // activation marker is segmented even when its root is EMPTY (greenfield
  // enable), and a root append there is §11's stale-writer shape — deny at
  // merge with nothing grandfathered.
  if (baseMarkerPresent || (baseTail && isCutoverEntry(baseTail))) {
    if (headBytes.length !== baseBytes.length || !headBytes.equals(baseBytes)) {
      deny('.adlc/manifest.jsonl is frozen once the repository is segmented (cutover tail or activation marker at base) and must be byte-identical in PRs');
    }
    return;
  }

  assertAppendOnly(headBytes, baseBytes);
  const headText = headBytes.toString('utf8');
  const appended = manifestRawLines(headText).slice(baseRaw.length).map(tryParse);
  if (appended.some((entry) => isCutoverEntry(entry) || isSealEntry(entry))) {
    validateSealCutoverAppend(baseText, headText, headBytes, baseBytes);
  }
  if (migration?.verified) {
    validateMigrationEvidence(baseText, headText, migration.storeHash, migration.archiveHash);
  }
}

/** Map seq -> raw line for one chain's text; unparseable lines are skipped
 *  (they can never satisfy an anchor lookup, which indexes by seq). */
function seqIndex(text) {
  const bySeq = new Map();
  for (const line of manifestRawLines(text)) {
    try {
      const entry = JSON.parse(line);
      if (Number.isInteger(entry?.seq)) bySeq.set(entry.seq, line);
    } catch { /* not indexable */ }
  }
  return bySeq;
}

/** First entry's anchor of a segment's text, or undefined when unreadable. */
function firstAnchorOf(text) {
  const first = manifestRawLines(text)[0];
  if (first === undefined) return undefined;
  try {
    const entry = JSON.parse(first);
    return Object.hasOwn(entry, 'anchor') ? entry.anchor : undefined;
  } catch {
    return undefined;
  }
}

/**
 * §9.3 — every segment present at HEAD but not at base must: match the §4.2
 * filename grammar (with case-collision safety across the whole head set),
 * parse and chain-verify internally over raw lines, and carry an anchor that
 * resolves — matching lineHash, cycle-checked — within the HEAD forest.
 *
 * Resolving at HEAD rather than base is deliberate: a PR may legitimately
 * mint a second segment anchored to one it added itself; history pinning
 * comes from §9.1/§9.2's committed-byte append-only, not from anchor targets.
 * `anchor: null` is permitted whenever the BASE tree has no root — regardless
 * of how many other segments base already has (§7.1's two-branch fork:
 * whichever merges second must not be denied because the first is now base).
 *
 * Chain verification runs keyless (rails-guard holds no key): structure and
 * anchor-position rules, signature checks left to keyed readers — §9.1's
 * containment note, applied to segments.
 */
export function validateNewSegments({ headSegments, baseSegmentNames, baseRootPresent, headRootText, forestAuth = null }) {
  // Case-collision guard spans the ENTIRE head set (base names included):
  // grammar forbids uppercase slugs, so a collision implies a grammar break
  // somewhere, but the check must not depend on that coupling surviving.
  const seenLower = new Map();
  for (const name of [...baseSegmentNames, ...headSegments.keys()]) {
    const lower = name.toLowerCase();
    if (seenLower.has(lower) && seenLower.get(lower) !== name) {
      deny(`.adlc/manifest.d/${name} case-collides with ${seenLower.get(lower)} (case-insensitive filesystem safety)`);
    }
    seenLower.set(lower, name);
  }

  const newNames = [...headSegments.keys()].filter((name) => !baseSegmentNames.has(name)).sort();

  // Anchor resolution context: the WHOLE head forest, root included.
  const chainsBySeq = new Map();
  if (headRootText !== null && headRootText !== undefined) chainsBySeq.set('root', seqIndex(headRootText));
  for (const [name, bytes] of headSegments) chainsBySeq.set(name, seqIndex(bytes.toString('utf8')));

  const anchorBySegment = new Map();
  for (const [name, bytes] of headSegments) {
    const anchor = firstAnchorOf(bytes.toString('utf8'));
    if (anchor !== undefined) anchorBySegment.set(name, anchor);
  }

  // Cycle detection FIRST: a byte-consistent cycle cannot exist (each
  // lineHash would have to hash a line that contains the hash of itself), so
  // any cycle necessarily carries at least one lying lineHash — and denying
  // it as a lineHash mismatch would bury the structural finding. Checking
  // the graph before the hashes names the real problem and guarantees the
  // walk terminates before any per-anchor work.
  const cycle = detectAnchorCycle(anchorBySegment);
  if (!cycle.ok) {
    deny(`.adlc/manifest.d anchor cycle detected at ${cycle.segment} — the forest must be a forest`);
  }

  // Reader coherence across the WHOLE head forest, not just new segments:
  // the production verifier resolves every segment's anchor with
  // rootExists = root.count > 0 at read time, so a root gaining its first
  // entries beside ANY null-anchored segment (legitimately minted pre-root)
  // makes every clone's verify fail forever. Reject the composition here —
  // each piece alone is legal, and only the merge assembles the brick.
  const headRootHasEntries = headRootText !== null && headRootText !== undefined
    && manifestRawLines(headRootText).length > 0;
  if (headRootHasEntries && !baseRootPresent) {
    for (const [name, anchor] of anchorBySegment) {
      if (anchor === null) {
        deny(`.adlc/manifest.d/${name} carries anchor: null while this PR gives the root its first entries — the merged forest would fail verification for every reader`);
      }
    }
  }

  // Whole-forest anchor re-resolution, not just new segments: append-only
  // admits changes that alter an existing segment's terminal RAW LINE (a
  // base file lacking its trailing newline gains a CRLF-prefixed append),
  // silently breaking every child anchor at read time. The reader resolves
  // every anchor on every read; the gate must resolve exactly what the
  // reader will. Null anchors are excluded here — their legality is the
  // base-state §9.3 rule (new segments) and the root-first-entries
  // composition check above (existing ones).
  for (const [name, anchor] of anchorBySegment) {
    if (anchor === null || anchor === undefined) continue;
    const resolution = resolveAnchor(anchor, chainsBySeq, true);
    if (!resolution.ok) {
      deny(`.adlc/manifest.d/${name} anchor rejected: ${resolution.reason}`);
    }
  }

  for (const name of newNames) {
    if (!CI_SEGMENT_NAME_RE.test(name)) {
      deny(`.adlc/manifest.d/${name} violates the segment filename grammar (spec §4.2)`);
    }
    const text = headSegments.get(name).toString('utf8');
    const chain = verifyChain(numberedLines(text), { key: null, requireSignatures: false, anchorOnFirst: true });
    if (!chain.valid) {
      deny(`.adlc/manifest.d/${name} does not chain-verify: ${chain.message}`);
    }
    // §4.3: seq starts at 1 and increases strictly BY 1. The shared
    // verifyChain enforces monotonicity, not contiguity (a 1,5 gap passes
    // it); tightening that helper is outside this ticket's scope, so the
    // gate holds new segments to the spec here. (The shared looseness is a
    // gate-manifest follow-up, recorded in the PR.)
    let expectedSeq = 1;
    for (const raw of manifestRawLines(text)) {
      const entry = tryParse(raw);
      if (entry === null) continue; // verifyChain already accepted the chain; unparseable lines cannot occur past it
      if (entry.seq !== expectedSeq) {
        deny(`.adlc/manifest.d/${name} seq must be contiguous from 1 (spec §4.3): expected ${expectedSeq}, found ${entry.seq}`);
      }
      expectedSeq += 1;
    }
    // Non-null anchors were re-resolved forest-wide above; what remains per
    // NEW segment is §9.3's null rule, judged against the BASE tree.
    if (chain.firstAnchor === null && baseRootPresent) {
      deny(`.adlc/manifest.d/${name} anchor rejected: anchor: null is not permitted once a root exists`);
    }
    if (forestAuth === 'keyed') {
      assertEntriesCarrySigs(manifestRawLines(text), `.adlc/manifest.d/${name}`, { firstMustBeV2: true });
    }
  }
}

/**
 * The activation marker is a trust file, not inert metadata: `auth: "keyed"`
 * is what makes every resolver refuse keyless writes, so a PR flipping it to
 * "keyless" silently downgrades authentication for every reader. Once the
 * marker exists at base it is frozen byte-identical; a NEW marker (the
 * enable/migration PR) must carry exactly the §4.7 shape.
 */
export function validateReservedFiles({ baseMarker, headMarker, baseRootHasEntries = false, headRootCutover = false, headRootGainedEntries = false, newlyCutover = false }) {
  // The ceremony writes the marker and the cutover entry together (§8 step
  // 6); a cutover arriving WITHOUT the marker is a state no producer
  // creates, and it lands the repo in the degraded marker-lost shape on day
  // one. Only the TRANSITION is gated — an already-cutover base with a
  // long-lost marker must not brick every later PR retroactively.
  if (newlyCutover && (headMarker === null || headMarker === undefined)) {
    deny('a cutover entry cannot land without the .adlc/manifest.d/.store.json activation marker — the ceremony writes both together');
  }
  if (baseMarker !== null && baseMarker !== undefined) {
    if (headMarker === null || headMarker === undefined) {
      deny('.adlc/manifest.d/.store.json exists at base and cannot be removed in a PR');
    }
    if (!headMarker.equals(baseMarker)) {
      deny('.adlc/manifest.d/.store.json is a trust file and must be byte-identical to base in PRs');
    }
    return;
  }
  if (headMarker === null || headMarker === undefined) return;

  // A NEW marker flips isSegmentedRepo for every clone the moment it merges.
  // It has exactly two legitimate arrivals: greenfield enable (the base root
  // has no evidence to freeze) and the migration ceremony (the same PR ends
  // the root in a cutover entry). A marker landing on a LIVE root without a
  // cutover manufactures the half-migrated state enable itself refuses —
  // writers route to segments while the root never froze.
  if (baseRootHasEntries && !headRootCutover) {
    deny('.adlc/manifest.d/.store.json cannot be introduced while the root manifest holds evidence and no cutover entry — forest activation on a live root is the migration ceremony, not a marker add');
  }
  if (headRootGainedEntries && !headRootCutover) {
    deny('.adlc/manifest.d/.store.json marker cannot be introduced in the same PR that appends root evidence — activation and evidence do not mix outside the cutover ceremony');
  }
  let parsed;
  try {
    parsed = JSON.parse(headMarker.toString('utf8'));
  } catch {
    deny('.adlc/manifest.d/.store.json must be valid JSON');
  }
  if (parsed?.format !== 'adlc-manifest-segments' || parsed?.version !== 1) {
    deny('.adlc/manifest.d/.store.json must carry format "adlc-manifest-segments" version 1 (spec §4.7)');
  }
  // Markers WITHOUT the field exist (§4.7 pre-policy activations) — but a
  // marker being ADDED now is post-policy by definition, and both producers
  // (enable, the ceremony) always write the mode. Absent auth on a new
  // marker is a hand-rolled activation dodging the authentication decision.
  if (parsed.auth !== 'keyed' && parsed.auth !== 'keyless') {
    deny('.adlc/manifest.d/.store.json auth must be "keyed" or "keyless" on a newly introduced marker (spec §4.7)');
  }
  // The ceremony cannot run keyless and always writes auth "keyed" — a
  // keyless marker arriving WITH the cutover is producer-impossible, and CI
  // would enforce keyed for this forest while the marker tells writers the
  // opposite: a standing contradiction planted in one merge.
  if (newlyCutover && parsed.auth === 'keyless') {
    deny('.adlc/manifest.d/.store.json cannot declare auth "keyless" alongside a cutover — the migration ceremony is always keyed');
  }
}

/**
 * §3 standing approves of a root text: cross-model-review approve entries
 * whose (provider, revision) tuple has no later needs-attention entry.
 * Lenient parse — unparseable lines cannot carry approvals.
 */
// Transcribed from packages/prosecute/lib/cross-model.mjs's module-local
// normalizeProvider (not exported; a package dependency for three lines is
// worse than the transcription pattern this file already documents). §6:
// "providers normalized on both sides as today" — defeats accidental
// variants, not determined forgers, same as the reader.
const normalizeProvider = (value) =>
  typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, '').toLowerCase() : '';

const approveTupleKey = (data, ticket) =>
  [normalizeProvider(data?.provider), data?.revision, ticket ?? ''].join('\u0000');

function standingApproveTuples(text) {
  // Keyed exactly as the reader matches (§6): (provider, revision), plus
  // ticket when present — authorProvider is NOT part of the match key, and
  // ticket must be, or a ticketless seal would "cover" a ticketed approve
  // the per-ticket gate still honors. Revocation is TERMINAL and
  // position-independent ("no needs-attention anywhere in the forest"): an
  // approve recorded after a revocation is still revoked, so last-verdict
  // accounting would over-count standing approves and reject valid cutovers.
  const approved = new Set();
  const revoked = new Set();
  for (const line of manifestRawLines(text)) {
    const entry = tryParse(line);
    // gate ?? type: prosecute's own evidence writer historically used
    // `type`, and the reader honors either — an approve in the legacy shape
    // escaping this census would survive cutover unsealed.
    if (entry === null || (entry.gate ?? entry.type) !== 'cross-model-review') continue;
    const { provider, revision, verdict } = entry.data ?? {};
    if (typeof provider !== 'string' || typeof revision !== 'string') continue;
    // entry.ticket, TOP-LEVEL only: the reader's per-ticket matching never
    // consults data.ticket, so honoring a data-shaped ticket here would let
    // a malformed seal "cover" an approve the reader keeps honoring.
    const key = approveTupleKey(entry.data, entry.ticket);
    if (verdict === 'approve') approved.add(key);
    else if (verdict === 'needs-attention') revoked.add(key);
  }
  return new Set([...approved].filter((key) => !revoked.has(key)));
}

/** Whether a root text's last parseable line is the cutover entry — the
 *  lenient-detection twin of assertRootTransition's dispatch, exported so the
 *  caller can hand validateReservedFiles its context without re-parsing. */
export function rootTextEndsInCutover(text) {
  const lines = manifestRawLines(text ?? '');
  if (lines.length === 0) return false;
  return isCutoverEntry(tryParse(lines.at(-1)));
}

/**
 * The ticket-store migration's manifest evidence, located in SEGMENTS: once
 * a repo is segmented, appendManifestEntry routes evidence there and the
 * frozen root cannot carry it — validating only the root would let a
 * "migration" PR restructure the store with no bound evidence at all
 * (fail-open), while demanding root evidence would make the supported
 * migration impossible (fail-closed against legitimate work). Exactly one
 * segment must carry the ticket-migrate set in its appended region, and
 * that region is held to the same binding/chain rules the root path uses.
 */
export function validateSegmentedMigrationEvidence({ baseSegments, headSegments, storeHash, archiveHash }) {
  const carriers = [];
  for (const [name, headBytes] of headSegments) {
    const baseBytes = baseSegments.get(name);
    const baseText = baseBytes === undefined ? '' : baseBytes.toString('utf8');
    const headText = headBytes.toString('utf8');
    const appended = manifestRawLines(headText).slice(manifestRawLines(baseText).length);
    if (appended.some((line) => tryParse(line)?.gate === 'ticket-migrate')) {
      carriers.push({ name, baseText, headText });
    }
  }
  if (carriers.length === 0) {
    deny('ticket-store migration evidence was not found in any segment — a segmented repo records it there, and a migration without bound evidence cannot merge');
  }
  if (carriers.length > 1) {
    deny(`ticket-store migration evidence must live in exactly one segment, found it in: ${carriers.map((c) => c.name).join(', ')}`);
  }
  // The ceremony carries no payload: beyond the one evidence carrier, no
  // segment may be added or changed in a migration diff — the same rule the
  // path allowlist enforces for everything else.
  for (const [name, headBytes] of headSegments) {
    if (name === carriers[0].name) continue;
    const baseBytes = baseSegments.get(name);
    if (baseBytes === undefined || !headBytes.equals(baseBytes)) {
      deny(`migration diffs must not touch segments beyond the evidence carrier — ${name} is an unrelated payload`);
    }
  }
  validateMigrationEvidence(carriers[0].baseText, carriers[0].headText, storeHash, archiveHash);
}
