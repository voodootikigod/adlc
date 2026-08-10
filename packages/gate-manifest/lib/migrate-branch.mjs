// migrate-branch.mjs — in-flight branch salvage after cutover
// (T-01KZHAG1NSKDQTRB1JHZ4EJY2M).
//
// When main cuts over while a branch still holds root-tail evidence, the
// rebase's only correct resolution is taking main's frozen root — discarding
// the branch's entries and, with them, the prior approve that
// `prosecute --carry-forward` needs to find. This tool re-chains the
// branch's signature-verified entries into a fresh segment so the evidence
// survives with honest provenance.
//
// Deliberately thin: every write goes through appendManifestEntry — the
// PRODUCTION writer performs the mint (anchor to the root head line, branch
// identity, gitignore probe, lineage token), the chaining, and the v2
// signing. The salvage adds only: source extraction, signature verification
// of what is being salvaged, and the disclosure record.

import { lstatSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ADLC_DIR, ledgerPath } from '@adlc/core';
import { validateKeyParam } from '@adlc/tickets/lib/key-contract.mjs';
import { isSegmentedRepo } from './lineage.mjs';
import { segmentDirPath, discoverSegments, readRawLines } from './forest.mjs';
import { verifyEntrySig } from './sign.mjs';
import { appendManifestEntry } from './record.mjs';

const sha256 = (input) => createHash('sha256').update(input).digest('hex');

const RESERVED = new Set(['seq', 'prev', 'sig', 'sigVersion', 'segment', 'anchor', 'branch']);

/** The complete field set a V1 signature covers (sign.mjs canonicalEntryBytes'
 *  v1 branch): anything else on a v1-signed entry is UNAUTHENTICATED, and
 *  replaying it through the v2-signing writer would launder it into evidence
 *  that verifies as if it had always been signed. */
const V1_COVERED = new Set(['seq', 'gate', 'ts', 'ticket', 'data', 'files', 'prev', 'sig']);

/** Stable stringify for content comparison: key-order independent. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Order-insensitive identity of an entry's replayable content. Exported for
 *  the property test: two entries with the same fields in different key
 *  orders MUST compare equal, or resume/race comparisons would break the
 *  moment a legacy source stores keys in a nonstandard order. */
export const contentKey = (entry) => stable(contentOf(entry));

/** An entry reduced to its replayable content fields. */
function contentOf(entry) {
  const out = {};
  for (const [field, value] of Object.entries(entry)) {
    if (!RESERVED.has(field)) out[field] = value;
  }
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

function gitShow(cwd, ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { cwd, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** The branch's committed segments, by the §4.4a branch field on first entries. */
function branchOwnsSegment(dir, branch) {
  const { valid } = discoverSegments(dir);
  for (const name of valid) {
    const first = readRawLines(`${segmentDirPath(dir)}/${name}`)[0];
    if (first === undefined) continue;
    const entry = parse(first.line);
    if (entry?.branch === branch) return name;
  }
  return null;
}

/**
 * Decide what the salvage would do, writing nothing.
 *
 * @returns {{ decision: 'refuse-keyless'|'refuse-symlink'|'refuse-not-segmented'|'refuse-source'|'refuse-unresolved'|'refuse-nothing'|'refuse-broken-chain'|'refuse-tampered'|'refuse-unsigned'|'refuse-existing-segment'|'refuse-branch'|'plan',
 *             reason?: string, entries?: object[], unsignedEntries?: object[],
 *             branch?: string, sourceRef?: string, sourceSha?: string }}
 */
export function planMigrateBranch(dir = ADLC_DIR, {
  key = null,
  sourceRef = 'ORIG_HEAD',
  sourcePath = '.adlc/manifest.jsonl',
  cwd = null,
  attestUnsigned = false,
} = {}) {
  if (key === null || key === undefined || key === '') {
    return { decision: 'refuse-keyless', reason: 'salvage requires ADLC_MANIFEST_KEY — it exists to preserve AUTHENTICATED evidence, and re-chained entries must be re-signed' };
  }
  const signingKey = validateKeyParam(key);
  const repoCwd = cwd ?? process.cwd();

  const lstatIsSymlink = (path) => {
    try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
  };
  for (const path of [dir, ledgerPath('manifest', dir), segmentDirPath(dir)]) {
    if (lstatIsSymlink(path)) {
      return { decision: 'refuse-symlink', reason: `${path} is a symlink — salvage refuses to read or write through repository-controlled links` };
    }
  }

  // Salvage is a POST-cutover tool: the working repo must already be
  // segmented (the rebase brought over the marker/cutover), or there is no
  // frozen root to have discarded evidence for.
  if (!isSegmentedRepo(dir)) {
    return { decision: 'refuse-not-segmented', reason: 'this repository is not segmented — salvage applies after rebasing onto a cut-over main; nothing here has discarded root-tail evidence' };
  }

  const branch = currentBranch(repoCwd);
  if (branch === null) {
    return { decision: 'refuse-branch', reason: 'no current git branch (detached HEAD?) — the salvaged segment carries the branch identity, which must exist' };
  }

  // A ref beginning with '-' would be parsed by git as a FLAG, not a ref —
  // execFileSync avoids the shell but not git's own option parsing.
  if (typeof sourceRef !== 'string' || sourceRef === '' || sourceRef.startsWith('-')) {
    return { decision: 'refuse-source', reason: `invalid source ref ${JSON.stringify(sourceRef)} — refs must not begin with '-'` };
  }
  if (typeof sourcePath !== 'string' || sourcePath === '' || sourcePath.startsWith('-')) {
    return { decision: 'refuse-source', reason: `invalid source path ${JSON.stringify(sourcePath)} — paths must not begin with '-'` };
  }
  const sourceBytes = gitShow(repoCwd, sourceRef, sourcePath);
  if (sourceBytes === null) {
    return { decision: 'refuse-source', reason: `cannot read ${sourcePath} at ${sourceRef} — pass --from <ref> naming the pre-rebase state (ORIG_HEAD is the default and survives one rebase; the reflog holds older states)` };
  }
  let sourceSha;
  try {
    sourceSha = execFileSync('git', ['rev-parse', sourceRef], { cwd: repoCwd, encoding: 'utf8' }).trim();
  } catch {
    return { decision: 'refuse-source', reason: `cannot resolve ${sourceRef} to a commit` };
  }

  const workingBytes = readFileSync(ledgerPath('manifest', dir));
  const workingLines = workingBytes.toString('utf8').split('\n').filter((l) => l.trim());
  const sourceLines = sourceBytes.toString('utf8').split('\n').filter((l) => l.trim());

  // The working root must be RESOLVED — main's frozen side, not the branch's
  // pre-rebase root. The reliable signal: the source must diverge from the
  // working root by having entries the working root lacks, while the working
  // root is the one whose tail the ceremony sealed (segmented, checked
  // above). A working root equal to the source means the conflict was
  // resolved the wrong way (or not at all).
  // Identity FIRST: a working root equal to the pre-rebase source is the
  // unresolved state itself (the conflict was taken on the branch's side, or
  // never resolved) — checking the empty-suffix condition before this would
  // misreport it as nothing-to-salvage.
  if (workingBytes.equals(sourceBytes)) {
    return { decision: 'refuse-unresolved', reason: 'the working root still matches the pre-rebase source — resolve the conflict by taking main\'s side of .adlc/manifest.jsonl wholesale, then re-run the salvage' };
  }
  let common = 0;
  while (common < workingLines.length && common < sourceLines.length && workingLines[common] === sourceLines[common]) common += 1;
  const suffix = sourceLines.slice(common);
  const workingDiverges = workingLines.slice(common);
  if (workingDiverges.length === 0) {
    return { decision: 'refuse-unresolved', reason: 'the working root is a prefix of the pre-rebase source — the branch tail was never replaced by main\'s side; take main\'s .adlc/manifest.jsonl wholesale, then re-run the salvage' };
  }
  if (suffix.length === 0) {
    return { decision: 'refuse-nothing', reason: 'the source holds no entries beyond the shared prefix — nothing to salvage' };
  }

  // The suffix must chain from the shared prefix: prev of each entry hashes
  // the previous raw line (the writer's decoded-line rule). A break means
  // the source is corrupt — surfaced, never silently truncated.
  let prevLine = common > 0 ? sourceLines[common - 1] : null;
  const entries = [];
  for (const line of suffix) {
    const entry = parse(line);
    if (entry === null) {
      return { decision: 'refuse-broken-chain', reason: 'a source entry beyond the shared prefix is not a JSON object — the source is corrupt' };
    }
    const expectedPrev = prevLine === null ? null : sha256(prevLine);
    if (entry.prev !== expectedPrev) {
      return { decision: 'refuse-broken-chain', reason: `source entry seq ${entry.seq ?? '?'} does not chain from the shared prefix — the source is corrupt; salvage refuses to guess at its true content` };
    }
    entries.push({ entry, line });
    prevLine = line;
  }

  // Authenticate what is being salvaged. TAMPERED (present-but-invalid sig)
  // always refuses — --attest-unsigned admits only genuinely UNSIGNED
  // entries, with disclosure, mirroring repair-chain's posture.
  const unsigned = [];
  for (const [index, { entry }] of entries.entries()) {
    const hasSig = entry.sig !== undefined && entry.sig !== null;
    if (!hasSig) {
      unsigned.push({ index, seq: entry.seq ?? null });
      continue;
    }
    if (!verifyEntrySig(signingKey, entry)) {
      return { decision: 'refuse-tampered', reason: `source entry seq ${entry.seq ?? '?'} carries a signature that does not verify under the key — tampered evidence is never salvaged` };
    }
    if (entry.sigVersion !== 2) {
      // v1 signs a FIXED subset; any other field on the entry was never
      // authenticated, and replaying it would launder it into v2-signed
      // evidence that verifies as if it had always been covered.
      const uncovered = Object.keys(entry).filter((field) => !V1_COVERED.has(field));
      if (uncovered.length > 0) {
        return { decision: 'refuse-uncovered', reason: `source entry seq ${entry.seq ?? '?'} is v1-signed but carries field(s) its signature never covered: ${uncovered.join(', ')} — salvaging them would launder unauthenticated data into v2-signed evidence` };
      }
    }
  }
  if (unsigned.length > 0 && !attestUnsigned) {
    return { decision: 'refuse-unsigned', reason: `${unsigned.length} source entr${unsigned.length === 1 ? 'y is' : 'ies are'} unsigned — re-run with --attest-unsigned to salvage them under the ceremony key deliberately, with the count disclosed in the salvage record` };
  }

  // Once-only, with crash RESUMABILITY: a branch segment whose entries are
  // exactly a content-prefix of this salvage (and no salvage record yet) is
  // an interrupted run — resume by appending the remainder. Any other
  // existing segment means post-rebase evidence already landed; interleaving
  // older salvaged entries after it would scramble the record, so refuse.
  const planned = entries.map(({ entry, line }) => ({ entry, lineHash: sha256(line), content: contentOf(entry) }));
  const owned = branchOwnsSegment(dir, branch);
  let alreadyAppended = 0;
  if (owned !== null) {
    const segEntries = readRawLines(`${segmentDirPath(dir)}/${owned}`)
      .map(({ line }) => parse(line))
      .filter((e) => e !== null);
    const record = segEntries.find((e) => e.gate === 'manifest-salvage');
    if (record !== undefined) {
      const recordedHashes = JSON.stringify(record.data?.salvagedLineHashes ?? []);
      const plannedHashes = JSON.stringify(planned.map((e) => e.lineHash));
      if (recordedHashes === plannedHashes) {
        return { decision: 'refuse-existing-segment', reason: `branch ${branch} already owns segment ${owned} carrying the completed record of THIS salvage — nothing left to do` };
      }
      return { decision: 'refuse-existing-segment', reason: `branch ${branch} owns segment ${owned} whose salvage record does not match this source — a different or corrupted salvage landed there; inspect the segment and its manifest-salvage entry before anything else` };
    }
    const isPrefix = segEntries.length <= planned.length
      && segEntries.every((e, i) => stable(contentOf(e)) === stable(planned[i].content));
    if (!isPrefix) {
      return { decision: 'refuse-existing-segment', reason: `branch ${branch} already owns segment ${owned} with entries unrelated to this salvage — salvage runs once, immediately after the rebase, before any new writes` };
    }
    alreadyAppended = segEntries.length;
  }

  return {
    decision: 'plan',
    entries: planned.slice(alreadyAppended).map(({ entry, lineHash }) => ({ entry, lineHash })),
    allEntries: planned.map(({ entry, lineHash }) => ({ entry, lineHash })),
    alreadyAppended,
    unsignedEntries: unsigned,
    branch,
    sourceRef,
    sourceSha,
  };
}

/**
 * Execute the plan. Every append goes through appendManifestEntry with the
 * repo already segmented, so the FIRST append performs the production mint
 * (anchor to the root head line, branch field, gitignore probe on the minted
 * filename, lineage token) and the rest extend the same segment. Content
 * fields are preserved verbatim; chain fields (seq/prev/sig) are the
 * writer's to recompute — that re-signing is exactly what the terminal
 * salvage record disclosed below makes honest.
 */
export function migrateBranch(dir = ADLC_DIR, { key = null, sourceRef = 'ORIG_HEAD', sourcePath = '.adlc/manifest.jsonl', cwd = null, attestUnsigned = false, write = false } = {}) {
  const plan = planMigrateBranch(dir, { key, sourceRef, sourcePath, cwd, attestUnsigned });
  if (plan.decision !== 'plan' || !write) return { ...plan, written: false };
  const signingKey = validateKeyParam(key);
  const repoCwd = cwd ?? process.cwd();

  for (const { entry } of plan.entries) {
    const payload = {};
    for (const [field, value] of Object.entries(entry)) {
      if (!RESERVED.has(field)) payload[field] = value;
    }
    appendManifestEntry(payload, dir, { signatureVersion: 2, cwd: repoCwd, key: signingKey });
  }

  // Verify BEFORE the salvage record lands: if a concurrent writer's mint
  // absorbed these appends, failing here leaves NO completed-salvage record
  // on disk — the segment is inspectable and, once resolved, retryable. The
  // old ordering stamped the record first and then threw, leaving a state
  // whose record blocked every retry forever.
  {
    const segName = branchOwnsSegment(dir, plan.branch);
    const soFar = readRawLines(`${segmentDirPath(dir)}/${segName}`)
      .map(({ line }) => parse(line))
      .filter((e) => e !== null);
    const expected = plan.allEntries.map((e) => stable(contentOf(e.entry)));
    const actual = soFar.map((e) => stable(contentOf(e)));
    if (actual.length !== expected.length || !expected.every((c, i) => c === actual[i])) {
      throw new Error(`segment ${segName} does not match the salvage plan — a concurrent writer raced this salvage; no salvage record was written, nothing was deleted; inspect the segment, then re-run (the salvage resumes past a clean prefix)`);
    }
  }

  appendManifestEntry({
    gate: 'manifest-salvage',
    data: {
      sourceRef: plan.sourceRef,
      sourceSha: plan.sourceSha,
      // The FULL salvage, not this run's remainder: a resumed run must
      // disclose everything the segment carries from the source, or the
      // record understates what was re-signed.
      salvagedEntries: plan.allEntries.length,
      salvagedLineHashes: plan.allEntries.map((e) => e.lineHash),
      ...(plan.unsignedEntries.length > 0
        ? { attestedUnsignedEntries: plan.unsignedEntries.length }
        : {}),
    },
    files: {},
  }, dir, { signatureVersion: 2, cwd: repoCwd, key: signingKey });

  // Post-write verification: the segment's content sequence must be exactly
  // the planned salvage followed by the salvage record. A concurrent writer
  // minting this branch's segment between plan and write would have made the
  // first append EXTEND a foreign segment — detected here, loudly, because
  // the resulting sequence does not match the salvage plan.
  const segment = branchOwnsSegment(dir, plan.branch);
  const written = readRawLines(`${segmentDirPath(dir)}/${segment}`)
    .map(({ line }) => parse(line))
    .filter((e) => e !== null);
  const expected = plan.allEntries.map((e) => stable(contentOf(e.entry)));
  const actualContent = written.slice(0, -1).map((e) => stable(contentOf(e)));
  const last = written.at(-1);
  if (actualContent.length !== expected.length
    || !expected.every((c, i) => c === actualContent[i])
    || last?.gate !== 'manifest-salvage') {
    throw new Error(`segment ${segment} does not match the salvage plan — a concurrent writer raced this salvage; inspect the segment before retrying, nothing has been deleted`);
  }
  return { ...plan, segment, decision: 'applied', written: true };
}
