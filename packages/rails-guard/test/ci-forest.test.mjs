// ci-forest.test.mjs — the CI gate's forest validation (spec §9.1–9.3,
// T-01KZGTMD9VTTPQ6036SXKPJ8SS, T-MANIFEST-FOREST slice 6).
//
// Before this slice the committed-tree reader validated `.adlc/manifest.jsonl`
// alone: committed segment files under `.adlc/manifest.d/` got none of the
// append-only enforcement the root gets, so a PR could rewrite, truncate,
// reorder or delete committed evidence and CI raised nothing. These tests are
// the contract for closing that.
//
// Every fixture that should DENY is asserted with the specific reason, and the
// headline regressions (a rewritten committed segment, a deleted one) are
// pinned first — they pass silently on main today.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRootTransition,
  baseForestBytes,
  validateReservedFiles,
  validateSegmentAppendOnly,
  validateSegmentedMigrationEvidence,
  validateNewSegments,
  committedEvidenceAtHead,
} from '../lib/ci/manifest.mjs';
import { GateDeny, GateFail } from '../lib/ci/errors.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex');
/** Raw bytes of the last non-empty line (no trailing newline) of a buffer. */
function lastLineOf(buf) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0x0a) end -= 1;
  let start = end;
  while (start > 0 && buf[start - 1] !== 0x0a) start -= 1;
  return buf.subarray(start, end);
}

// ---- fixture builders -------------------------------------------------------

/** Chain entries into raw JSONL text: seq/prev computed over the REAL lines. */
function chainText(entries, { startSeq = 1, prevLine = null } = {}) {
  const lines = [];
  let seq = startSeq;
  let prev = prevLine === null ? null : sha256(prevLine);
  for (const entry of entries) {
    const line = JSON.stringify({ seq, ...entry, prev });
    lines.push(line);
    prev = sha256(line);
    seq += 1;
  }
  return lines.join('\n') + '\n';
}

const evidence = (extra = {}) => ({ gate: 'evidence', ts: '2026-01-01T00:00:00.000Z', files: {}, ...extra });

/** A structurally valid §4.6 seal entry (sig PRESENCE only — CI holds no key). */
const seal = () => ({
  gate: 'cross-model-review',
  ts: '2026-01-02T00:00:00.000Z',
  data: { verdict: 'needs-attention', sealedByCutover: true, provider: 'codex', authorProvider: 'anthropic', revision: 'git-change:x:y' },
  files: {},
  sigVersion: 2,
  sig: 'f'.repeat(64),
});

/** A structurally valid §4.5 cutover entry bound to the given prior bytes. */
const cutover = ({ priorBytes, priorLines, sealedApprovals }) => ({
  gate: 'manifest-cutover',
  ts: '2026-01-02T00:00:01.000Z',
  data: { reason: 'operator-migration', rootLines: priorLines, rootSha256: sha256(priorBytes), sealedApprovals },
  files: {},
  sigVersion: 2,
  sig: 'e'.repeat(64),
});

/** Base root: two ordinary entries. */
const BASE_ROOT = chainText([evidence(), evidence()]);
const BASE_LINES = BASE_ROOT.trim().split('\n');

/** Append a seal+cutover set onto a base, chained over the real raw lines. */
function withSealCutover(baseText, { sealCount = 1, mutate = (e) => e } = {}) {
  const baseLines = baseText.trim() === '' ? [] : baseText.trim().split('\n');
  let text = baseText;
  let prevLine = baseLines.at(-1) ?? null;
  let seq = baseLines.length;
  const seals = [];
  for (let i = 0; i < sealCount; i++) seals.push(seal());
  for (const entry of seals) {
    seq += 1;
    const line = JSON.stringify({ seq, ...mutate(entry), prev: prevLine === null ? null : sha256(prevLine) });
    text += line + '\n';
    prevLine = line;
  }
  const priorBytes = text; // everything before the cutover entry
  seq += 1;
  const cut = mutate(cutover({ priorBytes, priorLines: seq - 1, sealedApprovals: sealCount }));
  const cutLine = JSON.stringify({ seq, ...cut, prev: sha256(prevLine) });
  return { text: text + cutLine + '\n', cutLine };
}

const NO_MIGRATION = { verified: false };

const rootArgs = (baseText, headText, extra = {}) => ({
  basePresent: baseText !== null,
  baseBytes: baseText === null ? null : Buffer.from(baseText),
  headPresent: headText !== null,
  headBytes: headText === null ? null : Buffer.from(headText),
  migration: NO_MIGRATION,
  ...extra,
});

// A valid segment: first entry carries the anchor, chained per §4.3.
function segmentText({ anchor, entries = 1, branch = 'feat-x' } = {}) {
  const first = JSON.stringify({ seq: 1, ...evidence({ anchor, branch }), prev: null });
  const lines = [first];
  for (let i = 2; i <= entries; i++) {
    lines.push(JSON.stringify({ seq: i, ...evidence(), prev: sha256(lines.at(-1)) }));
  }
  return lines.join('\n') + '\n';
}

const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const SEG_A = `feat-a-${ULID_A}.jsonl`;
const SEG_B = `feat-b-${ULID_B}.jsonl`;

const rootAnchor = (rootText) => {
  const lastLine = rootText.trim().split('\n').at(-1);
  const seq = JSON.parse(lastLine).seq;
  return { segment: 'root', seq, lineHash: sha256(lastLine) };
};

const newSegArgs = (over = {}) => ({
  headSegments: new Map(),
  baseSegmentNames: new Set(),
  baseRootPresent: true,
  headRootText: BASE_ROOT,
  ...over,
});

// ════ §9.2 — existing segments are append-only, per file ════════════════════

test('AC1 (headline): a committed segment with a rewritten byte DENIES', () => {
  const base = segmentText({ anchor: rootAnchor(BASE_ROOT) });
  const tampered = base.replace('evidence', 'evidencx');
  assert.throws(
    () => validateSegmentAppendOnly(new Map([[SEG_A, Buffer.from(base)]]), new Map([[SEG_A, Buffer.from(tampered)]])),
    (e) => e instanceof GateDeny && /append-only/.test(e.message) && e.message.includes(SEG_A)
  );
});

test('AC2: a truncated committed segment DENIES', () => {
  const base = segmentText({ anchor: rootAnchor(BASE_ROOT), entries: 3 });
  const truncated = base.trim().split('\n').slice(0, 2).join('\n') + '\n';
  assert.throws(
    () => validateSegmentAppendOnly(new Map([[SEG_A, Buffer.from(base)]]), new Map([[SEG_A, Buffer.from(truncated)]])),
    (e) => e instanceof GateDeny && e.message.includes(SEG_A)
  );
});

test('AC3: a deleted committed segment DENIES', () => {
  const base = segmentText({ anchor: rootAnchor(BASE_ROOT) });
  assert.throws(
    () => validateSegmentAppendOnly(new Map([[SEG_A, Buffer.from(base)]]), new Map()),
    (e) => e instanceof GateDeny && /removed|deleted|absent/.test(e.message) && e.message.includes(SEG_A)
  );
});

test('AC4: a renamed committed segment DENIES (the old name is what §9.2 tracks)', () => {
  const base = segmentText({ anchor: rootAnchor(BASE_ROOT) });
  assert.throws(
    () => validateSegmentAppendOnly(new Map([[SEG_A, Buffer.from(base)]]), new Map([[SEG_B, Buffer.from(base)]])),
    (e) => e instanceof GateDeny && e.message.includes(SEG_A)
  );
});

test('AC5: a pure append to a committed segment passes', () => {
  const base = segmentText({ anchor: rootAnchor(BASE_ROOT), entries: 2 });
  const lastLine = base.trim().split('\n').at(-1);
  const appended = base + JSON.stringify({ seq: 3, ...evidence(), prev: sha256(lastLine) }) + '\n';
  assert.doesNotThrow(() =>
    validateSegmentAppendOnly(new Map([[SEG_A, Buffer.from(base)]]), new Map([[SEG_A, Buffer.from(appended)]]))
  );
});

// ════ §9.3 — new segments ════════════════════════════════════════════════════

test('AC7: a new segment anchored to the root passes', () => {
  const seg = segmentText({ anchor: rootAnchor(BASE_ROOT) });
  assert.doesNotThrow(() => validateNewSegments(newSegArgs({ headSegments: new Map([[SEG_A, Buffer.from(seg)]]) })));
});

test('AC7b: a new segment anchored to ANOTHER segment added in the same PR passes', () => {
  const segA = segmentText({ anchor: rootAnchor(BASE_ROOT) });
  const aFirstLine = segA.trim().split('\n')[0];
  const segB = segmentText({ anchor: { segment: SEG_A, seq: 1, lineHash: sha256(aFirstLine) }, branch: 'feat-b' });
  assert.doesNotThrow(() => validateNewSegments(newSegArgs({
    headSegments: new Map([[SEG_A, Buffer.from(segA)], [SEG_B, Buffer.from(segB)]]),
  })));
});

test('AC8: an anchor that resolves nowhere in the HEAD forest DENIES', () => {
  const seg = segmentText({ anchor: { segment: 'root', seq: 99, lineHash: 'a'.repeat(64) } });
  assert.throws(
    () => validateNewSegments(newSegArgs({ headSegments: new Map([[SEG_A, Buffer.from(seg)]]) })),
    (e) => e instanceof GateDeny && /dangling|no entry|no such/.test(e.message)
  );
});

test('AC9: an anchor whose lineHash mismatches DENIES', () => {
  const target = rootAnchor(BASE_ROOT);
  const seg = segmentText({ anchor: { ...target, lineHash: 'b'.repeat(64) } });
  assert.throws(
    () => validateNewSegments(newSegArgs({ headSegments: new Map([[SEG_A, Buffer.from(seg)]]) })),
    (e) => e instanceof GateDeny && /lineHash/.test(e.message)
  );
});

test('AC10: an anchor cycle among new segments DENIES, and terminates', () => {
  // Two segments anchored to each other. lineHashes are self-consistent lies:
  // each names the other's first line, so only cycle detection catches it.
  const segALines = segmentText({ anchor: { segment: SEG_B, seq: 1, lineHash: 'c'.repeat(64) } });
  const segBLines = segmentText({ anchor: { segment: SEG_A, seq: 1, lineHash: sha256(segALines.trim().split('\n')[0]) }, branch: 'feat-b' });
  assert.throws(
    () => validateNewSegments(newSegArgs({
      headSegments: new Map([[SEG_A, Buffer.from(segALines)], [SEG_B, Buffer.from(segBLines)]]),
    })),
    (e) => e instanceof GateDeny && /cycle/.test(e.message)
  );
});

test('AC11: a new segment that does not chain-verify internally DENIES', () => {
  const good = segmentText({ anchor: rootAnchor(BASE_ROOT), entries: 2 });
  const lines = good.trim().split('\n');
  const broken = lines[0] + '\n' + lines[1].replace(/"prev":"[0-9a-f]+"/, `"prev":"${'d'.repeat(64)}"`) + '\n';
  assert.throws(
    () => validateNewSegments(newSegArgs({ headSegments: new Map([[SEG_A, Buffer.from(broken)]]) })),
    (e) => e instanceof GateDeny && /chain/.test(e.message)
  );
});

test('AC11b: an EMPTY new segment file DENIES — no first entry to carry the anchor', () => {
  assert.throws(
    () => validateNewSegments(newSegArgs({ headSegments: new Map([[SEG_A, Buffer.from('')]]) })),
    (e) => e instanceof GateDeny
  );
});

test('AC12: a filename violating the §4.2 grammar DENIES', () => {
  const seg = segmentText({ anchor: rootAnchor(BASE_ROOT) });
  const badNames = [
    `Feat-A-${ULID_A}.jsonl`,            // uppercase slug
    `feat-a-${ULID_A.toLowerCase()}.jsonl`, // lowercase ulid — rejected, NOT folded
    `feat-a-${ULID_A}.json`,             // wrong extension
    `feat-a-SHORT.jsonl`,                // ulid too short
    `-${'x'.repeat(41)}-${ULID_A}.jsonl`, // slug too long
  ];
  for (const name of badNames) {
    assert.throws(
      () => validateNewSegments(newSegArgs({ headSegments: new Map([[name, Buffer.from(seg)]]) })),
      (e) => e instanceof GateDeny && /grammar|filename/.test(e.message),
      `expected grammar denial for ${name}`
    );
  }
});

test('AC12b: two new segments whose names differ only by case DENY', () => {
  // Case-colliding pair; each individually grammar-valid is impossible for the
  // slug (lowercase only), so collide on the ULID region via the marker check:
  // grammar requires uppercase ULID, so a case collision must come from slugs —
  // which grammar forbids. The collision check must still exist for defense in
  // depth against grammar drift: feed two names that only differ by case and
  // expect a denial from EITHER the grammar or the collision rule.
  const seg = segmentText({ anchor: rootAnchor(BASE_ROOT) });
  assert.throws(
    () => validateNewSegments(newSegArgs({
      headSegments: new Map([
        [`feat-a-${ULID_A}.jsonl`, Buffer.from(seg)],
        [`FEAT-A-${ULID_A}.jsonl`, Buffer.from(seg)],
      ]),
    })),
    (e) => e instanceof GateDeny
  );
});

test('AC13: anchor:null is permitted when the base tree has no root — including when base already has other segments', () => {
  const nullSeg = segmentText({ anchor: null });
  // sub-case 1: totally rootless, no segments anywhere
  assert.doesNotThrow(() => validateNewSegments(newSegArgs({
    headSegments: new Map([[SEG_A, Buffer.from(nullSeg)]]),
    baseRootPresent: false,
    headRootText: null,
  })));
  // sub-case 2 (the §7.1 two-branch case a narrower reading gets wrong):
  // base already contains ANOTHER segment; the second branch's null-anchored
  // segment must not be denied merely because the first merged before it.
  const existing = segmentText({ anchor: null, branch: 'feat-b' });
  assert.doesNotThrow(() => validateNewSegments(newSegArgs({
    headSegments: new Map([[SEG_B, Buffer.from(existing)], [SEG_A, Buffer.from(nullSeg)]]),
    baseSegmentNames: new Set([SEG_B]),
    baseRootPresent: false,
    headRootText: null,
  })));
});

test('AC14: anchor:null DENIES when the base tree HAS a root', () => {
  const nullSeg = segmentText({ anchor: null });
  assert.throws(
    () => validateNewSegments(newSegArgs({ headSegments: new Map([[SEG_A, Buffer.from(nullSeg)]]) })),
    (e) => e instanceof GateDeny && /anchor: null|null is not permitted/.test(e.message)
  );
});

// ════ §9.1 — root transition rules ═══════════════════════════════════════════

test('AC15: once base root is cutover, HEAD root must be byte-identical — one appended byte DENIES', () => {
  const { text: cutoverRoot } = withSealCutover(BASE_ROOT);
  assert.throws(
    () => assertRootTransition(rootArgs(cutoverRoot, cutoverRoot + '\n')),
    (e) => e instanceof GateDeny && /byte-identical|frozen/.test(e.message)
  );
  assert.doesNotThrow(() => assertRootTransition(rootArgs(cutoverRoot, cutoverRoot)));
});

test('AC15b: a REWRITE of a cutover root also DENIES (identical length, different bytes)', () => {
  const { text: cutoverRoot } = withSealCutover(BASE_ROOT);
  const twiddled = cutoverRoot.replace('operator-migration', 'operator-migratioX');
  assert.throws(
    () => assertRootTransition(rootArgs(cutoverRoot, twiddled)),
    (e) => e instanceof GateDeny
  );
});

test('AC16: a valid seal+cutover append to a non-cutover root passes', () => {
  const { text } = withSealCutover(BASE_ROOT, { sealCount: 2 });
  assert.doesNotThrow(() => assertRootTransition(rootArgs(BASE_ROOT, text)));
});

test('AC16b: ordinary evidence appends remain legal on a non-cutover root (§11: single-file behavior unchanged)', () => {
  const last = BASE_LINES.at(-1);
  const head = BASE_ROOT + JSON.stringify({ seq: 3, ...evidence(), prev: sha256(last) }) + '\n';
  assert.doesNotThrow(() => assertRootTransition(rootArgs(BASE_ROOT, head)));
});

test('AC17: an appended region CONTAINING a cutover entry that is not a valid seal+cutover set DENIES', () => {
  // ordinary evidence AFTER the cutover entry — cutover must be terminal
  const { text } = withSealCutover(BASE_ROOT);
  const lastLine = text.trim().split('\n').at(-1);
  const trailing = text + JSON.stringify({ seq: 99, ...evidence(), prev: sha256(lastLine) }) + '\n';
  assert.throws(
    () => assertRootTransition(rootArgs(BASE_ROOT, trailing)),
    (e) => e instanceof GateDeny
  );
});

test('AC18: seal or cutover entries missing sig or sigVersion 2 DENY', () => {
  const noSig = withSealCutover(BASE_ROOT, { mutate: (e) => { const { sig, ...rest } = e; return rest; } });
  assert.throws(() => assertRootTransition(rootArgs(BASE_ROOT, noSig.text)), (e) => e instanceof GateDeny && /sig/.test(e.message));
  const v1 = withSealCutover(BASE_ROOT, { mutate: (e) => ({ ...e, sigVersion: 1 }) });
  assert.throws(() => assertRootTransition(rootArgs(BASE_ROOT, v1.text)), (e) => e instanceof GateDeny && /sigVersion/.test(e.message));
});

test('AC18b: the cutover binding is checked — wrong rootSha256, rootLines, or sealedApprovals DENIES', () => {
  const badSha = withSealCutover(BASE_ROOT, {
    mutate: (e) => e.gate === 'manifest-cutover' ? { ...e, data: { ...e.data, rootSha256: 'a'.repeat(64) } } : e,
  });
  assert.throws(() => assertRootTransition(rootArgs(BASE_ROOT, badSha.text)), (e) => e instanceof GateDeny && /rootSha256/.test(e.message));
  const badCount = withSealCutover(BASE_ROOT, {
    sealCount: 2,
    mutate: (e) => e.gate === 'manifest-cutover' ? { ...e, data: { ...e.data, sealedApprovals: 7 } } : e,
  });
  assert.throws(() => assertRootTransition(rootArgs(BASE_ROOT, badCount.text)), (e) => e instanceof GateDeny && /sealedApprovals/.test(e.message));
});

test('AC18c: a seal+cutover append that does not extend the raw-line hash chain DENIES', () => {
  const { text } = withSealCutover(BASE_ROOT);
  const lines = text.trim().split('\n');
  // corrupt the first appended entry's prev: it no longer hashes the raw base
  // tail line. (An earlier version of this fixture re-serialized the base line
  // and hashed that — a no-op here, because these fixture lines ARE their own
  // JSON.stringify serialization. The mutation must actually change the hash.)
  const forged = [...BASE_LINES,
    lines[BASE_LINES.length].replace(/"prev":"[0-9a-f]+"/, `"prev":"${'9'.repeat(64)}"`),
    ...lines.slice(BASE_LINES.length + 1)].join('\n') + '\n';
  assert.throws(() => assertRootTransition(rootArgs(BASE_ROOT, forged)), (e) => e instanceof GateDeny);
});

// ════ pinned single-rev collector — mode/type guards and fail-closed ═════════

function stubGit(responses) {
  const calls = [];
  const git = (args, label) => {
    calls.push(args.join(' '));
    for (const [pattern, response] of responses) {
      if (pattern.test(args.join(' '))) return typeof response === 'function' ? response(args) : response;
    }
    throw new Error(`stubGit: unexpected invocation ${args.join(' ')} (${label})`);
  };
  git.calls = calls;
  return git;
}

const ok = (stdout) => ({ status: 0, stdout });
const okRaw = (buf) => ({ status: 0, stdout: buf });
const REV = 'a'.repeat(40);

test('AC6: a segment committed as a symlink or submodule DENIES', () => {
  for (const [mode, type, label] of [['120000', 'blob', 'symlink'], ['160000', 'commit', 'submodule']]) {
    const git = stubGit([
      [/^rev-parse HEAD$/, ok(`${REV}\n`)],
      [/^ls-tree [a-f0-9]+ -- \.adlc$/, ok(`040000 tree ${'b'.repeat(40)}\t.adlc\n`)],
      [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.jsonl$/, ok('')],
      [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.d$/, ok(`040000 tree ${'c'.repeat(40)}\t.adlc/manifest.d\n`)],
      [/^ls-tree [a-f0-9]+ \.adlc\/manifest\.d\/$/, ok(`${mode} ${type} ${'d'.repeat(40)}\t.adlc/manifest.d/${SEG_A}\n`)],
    ]);
    assert.throws(
      () => committedEvidenceAtHead(git),
      (e) => e instanceof GateDeny && /regular tracked file|symlink|submodule/.test(e.message),
      `expected denial for a ${label} segment`
    );
  }
});

test('a manifest.d that is itself a symlink or submodule DENIES', () => {
  const git = stubGit([
    [/^rev-parse HEAD$/, ok(`${REV}\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc$/, ok(`040000 tree ${'b'.repeat(40)}\t.adlc\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.jsonl$/, ok('')],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.d$/, ok(`120000 blob ${'c'.repeat(40)}\t.adlc/manifest.d\n`)],
  ]);
  assert.throws(() => committedEvidenceAtHead(git), (e) => e instanceof GateDeny && /directory/.test(e.message));
});

test('a NESTED directory under manifest.d DENIES', () => {
  const git = stubGit([
    [/^rev-parse HEAD$/, ok(`${REV}\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc$/, ok(`040000 tree ${'b'.repeat(40)}\t.adlc\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.jsonl$/, ok('')],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.d$/, ok(`040000 tree ${'c'.repeat(40)}\t.adlc/manifest.d\n`)],
    [/^ls-tree [a-f0-9]+ \.adlc\/manifest\.d\/$/, ok(`040000 tree ${'d'.repeat(40)}\t.adlc/manifest.d/nested\n`)],
  ]);
  assert.throws(() => committedEvidenceAtHead(git), (e) => e instanceof GateDeny && /nested/.test(e.message));
});

test('AC20: an operational git failure during forest enumeration FAILS closed (exit 1), never skips', () => {
  const git = stubGit([
    [/^rev-parse HEAD$/, ok(`${REV}\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc$/, ok(`040000 tree ${'b'.repeat(40)}\t.adlc\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.jsonl$/, ok('')],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.d$/, { status: 128, stdout: '' }],
  ]);
  assert.throws(() => committedEvidenceAtHead(git), (e) => e instanceof GateFail);
});

test('the root and the forest are read from ONE pinned rev — rev-parse HEAD runs exactly once', () => {
  const segBytes = Buffer.from(segmentText({ anchor: rootAnchor(BASE_ROOT) }));
  const git = stubGit([
    [/^rev-parse HEAD$/, ok(`${REV}\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc$/, ok(`040000 tree ${'b'.repeat(40)}\t.adlc\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.jsonl$/, ok(`100644 blob ${'e'.repeat(40)}\t.adlc/manifest.jsonl\n`)],
    [/^cat-file blob e+$/, okRaw(Buffer.from(BASE_ROOT))],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.d$/, ok(`040000 tree ${'c'.repeat(40)}\t.adlc/manifest.d\n`)],
    [/^ls-tree [a-f0-9]+ \.adlc\/manifest\.d\/$/, ok(`100644 blob ${'d'.repeat(40)}\t.adlc/manifest.d/${SEG_A}\n`)],
    [/^cat-file blob d+$/, okRaw(segBytes)],
  ]);
  const snapshot = committedEvidenceAtHead(git);
  assert.equal(git.calls.filter((c) => c === 'rev-parse HEAD').length, 1, 'two pins would be a TOCTOU across root and forest');
  assert.equal(snapshot.root.present, true);
  assert.equal(snapshot.segments.size, 1);
  assert.ok(snapshot.segments.get(SEG_A).equals(segBytes));
});

test('reserved names (.store.json, .lineage) are not treated as segments, but must still be regular blobs', () => {
  const git = stubGit([
    [/^rev-parse HEAD$/, ok(`${REV}\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc$/, ok(`040000 tree ${'b'.repeat(40)}\t.adlc\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.jsonl$/, ok('')],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.d$/, ok(`040000 tree ${'c'.repeat(40)}\t.adlc/manifest.d\n`)],
    [/^ls-tree [a-f0-9]+ \.adlc\/manifest\.d\/$/, ok(`100644 blob ${'d'.repeat(40)}\t.adlc/manifest.d/.store.json\n`)],
    [/^cat-file blob d+$/, okRaw(Buffer.from(JSON.stringify({ format: 'adlc-manifest-segments', version: 1 })))],
  ]);
  const snapshot = committedEvidenceAtHead(git);
  assert.equal(snapshot.segments.size, 0, 'the marker is not a segment');
  assert.ok(snapshot.marker !== null, 'but its bytes are captured for the trust-file check');

  const gitSym = stubGit([
    [/^rev-parse HEAD$/, ok(`${REV}\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc$/, ok(`040000 tree ${'b'.repeat(40)}\t.adlc\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.jsonl$/, ok('')],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.d$/, ok(`040000 tree ${'c'.repeat(40)}\t.adlc/manifest.d\n`)],
    [/^ls-tree [a-f0-9]+ \.adlc\/manifest\.d\/$/, ok(`120000 blob ${'d'.repeat(40)}\t.adlc/manifest.d/.store.json\n`)],
  ]);
  assert.throws(() => committedEvidenceAtHead(gitSym), (e) => e instanceof GateDeny, 'a symlinked marker is the same smuggling vector as a symlinked manifest');
});

// ---- kill-coverage for the seal+cutover field checks -----------------------
// Each of these is a line a mutant could flip silently without a test that
// reaches it: the binding fields individually, the seal verdict, the
// operator reason floor, and the seal-without-cutover shape.

test('AC18d: a wrong rootLines count DENIES', () => {
  const bad = withSealCutover(BASE_ROOT, {
    mutate: (e) => e.gate === 'manifest-cutover' ? { ...e, data: { ...e.data, rootLines: 99 } } : e,
  });
  assert.throws(() => assertRootTransition(rootArgs(BASE_ROOT, bad.text)), (e) => e instanceof GateDeny && /rootLines/.test(e.message));
});

test('AC18e: a cutover reason shorter than 8 characters DENIES', () => {
  const bad = withSealCutover(BASE_ROOT, {
    mutate: (e) => e.gate === 'manifest-cutover' ? { ...e, data: { ...e.data, reason: 'short' } } : e,
  });
  assert.throws(() => assertRootTransition(rootArgs(BASE_ROOT, bad.text)), (e) => e instanceof GateDeny && /reason/.test(e.message));
});

test('AC18f: a seal entry whose verdict is not needs-attention DENIES', () => {
  const bad = withSealCutover(BASE_ROOT, {
    mutate: (e) => e.gate === 'cross-model-review' ? { ...e, data: { ...e.data, verdict: 'approve' } } : e,
  });
  assert.throws(() => assertRootTransition(rootArgs(BASE_ROOT, bad.text)), (e) => e instanceof GateDeny && /needs-attention/.test(e.message));
});

test('AC18g: seal entries with NO terminal cutover DENY — a seal marks a cutover that must exist', () => {
  const lastLine = BASE_LINES.at(-1);
  const sealOnly = BASE_ROOT + JSON.stringify({ seq: 3, ...seal(), prev: sha256(lastLine) }) + '\n';
  assert.throws(() => assertRootTransition(rootArgs(BASE_ROOT, sealOnly)), (e) => e instanceof GateDeny);
});

test('baseForestBytes: reserved names and non-blob rows are excluded; blobs are read by hash', () => {
  const segBytes = Buffer.from(segmentText({ anchor: rootAnchor(BASE_ROOT) }));
  const BASE_REV = 'f'.repeat(40);
  const git = stubGit([
    [/^ls-tree f+ -- \.adlc\/manifest\.d$/, ok(`040000 tree ${'c'.repeat(40)}\t.adlc/manifest.d\n`)],
    [/^cat-file blob a+$/, okRaw(Buffer.from(JSON.stringify({ format: 'adlc-manifest-segments', version: 1 })))],
    [/^ls-tree f+ \.adlc\/manifest\.d\/$/, ok([
      `100644 blob ${'a'.repeat(40)}\t.adlc/manifest.d/.store.json`,
      `040000 tree ${'b'.repeat(40)}\t.adlc/manifest.d/nested`,
      `100644 blob ${'d'.repeat(40)}\t.adlc/manifest.d/${SEG_A}`,
    ].join('\n') + '\n')],
    [/^cat-file blob d+$/, okRaw(segBytes)],
  ]);
  const base = baseForestBytes(git, BASE_REV);
  assert.equal(base.segments.size, 1, 'only the real segment');
  assert.ok(base.segments.get(SEG_A).equals(segBytes));
  assert.ok(base.marker !== null, 'the base marker is captured for the trust-file check');
});

test('baseForestBytes: a git failure FAILS closed', () => {
  const git = stubGit([
    [/^ls-tree f+ -- \.adlc\/manifest\.d$/, { status: 128, stdout: '' }],
  ]);
  assert.throws(() => baseForestBytes(git, 'f'.repeat(40)), (e) => e instanceof GateFail);
});

test('AC19 pin: NON-JSON appended root bytes keep their pre-forest meaning — opaque appends are allowed', () => {
  // The pre-forest gate byte-compared and never parsed; a >1 MiB opaque
  // manifest with arbitrary appended bytes passed. Detection must therefore
  // parse leniently — strict parsing applies only once a cutover/seal entry
  // is actually detected. Caught by the rails-guard-ci entrypoint suite when
  // an early version parsed every appended line fail-closed.
  const opaqueBase = 'x'.repeat(2048) + '\n';
  const opaqueHead = opaqueBase + 'appended-not-json\n';
  assert.doesNotThrow(() => assertRootTransition(rootArgs(opaqueBase, opaqueHead)));
});

// ---- bootstrap, reserved-file, and seal-coverage invariants ----------------

test('a cutover whose seals do not cover the base root standing approves DENIES', () => {
  // §4.6: for EVERY standing approve, one seal. A cutover freezing the root
  // while leaving approves standing grandfathers pre-forest trust across the
  // cutover — the exact reset §4.6 exists to force.
  const approve = {
    gate: 'cross-model-review',
    ts: '2026-01-01T01:00:00.000Z',
    data: { verdict: 'approve', provider: 'codex', authorProvider: 'anthropic', revision: 'git-change:x:y' },
    files: {},
  };
  const baseWithApprove = chainText([evidence(), approve]);
  const zeroSeals = withSealCutover(baseWithApprove, { sealCount: 0 });
  assert.throws(
    () => assertRootTransition(rootArgs(baseWithApprove, zeroSeals.text)),
    (e) => e instanceof GateDeny && /standing approve/.test(e.message)
  );
});

test('a cutover over a base whose approve was ALREADY revoked needs no seal for it', () => {
  const tuple = { provider: 'codex', authorProvider: 'anthropic', revision: 'git-change:x:y' };
  const approve = { gate: 'cross-model-review', ts: '2026-01-01T01:00:00.000Z', data: { verdict: 'approve', ...tuple }, files: {} };
  const revoke = { gate: 'cross-model-review', ts: '2026-01-01T02:00:00.000Z', data: { verdict: 'needs-attention', ...tuple }, files: {} };
  const base = chainText([evidence(), approve, revoke]);
  const zeroSeals = withSealCutover(base, { sealCount: 0 });
  assert.doesNotThrow(() => assertRootTransition(rootArgs(base, zeroSeals.text)));
});

test('a cutover whose seal covers the standing approve tuple passes', () => {
  const tuple = { provider: 'codex', authorProvider: 'anthropic', revision: 'git-change:x:y' };
  const approve = { gate: 'cross-model-review', ts: '2026-01-01T01:00:00.000Z', data: { verdict: 'approve', ...tuple }, files: {} };
  const base = chainText([evidence(), approve]);
  // the default seal() fixture carries the same (provider, revision) tuple
  const sealed = withSealCutover(base, { sealCount: 1 });
  assert.doesNotThrow(() => assertRootTransition(rootArgs(base, sealed.text)));
});

test('a committed .lineage DENIES — the token is checkout-local by contract, never committed', () => {
  const git = stubGit([
    [/^rev-parse HEAD$/, ok(`${REV}\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc$/, ok(`040000 tree ${'b'.repeat(40)}\t.adlc\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.jsonl$/, ok('')],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.d$/, ok(`040000 tree ${'c'.repeat(40)}\t.adlc/manifest.d\n`)],
    [/^ls-tree [a-f0-9]+ \.adlc\/manifest\.d\/$/, ok(`100644 blob ${'d'.repeat(40)}\t.adlc/manifest.d/.lineage\n`)],
  ]);
  assert.throws(
    () => committedEvidenceAtHead(git),
    (e) => e instanceof GateDeny && /\.lineage/.test(e.message)
  );
});

test('a marker mutation DENIES — flipping auth keyed→keyless would silently downgrade every reader', () => {
  const baseMarker = Buffer.from(JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyed' }));
  const headMarker = Buffer.from(JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyless' }));
  assert.throws(
    () => validateReservedFiles({ baseMarker, headMarker }),
    (e) => e instanceof GateDeny && /\.store\.json/.test(e.message)
  );
  // byte-identical marker passes; a NEW marker (absent at base) with a valid shape passes
  assert.doesNotThrow(() => validateReservedFiles({ baseMarker, headMarker: baseMarker }));
  assert.doesNotThrow(() => validateReservedFiles({ baseMarker: null, headMarker: baseMarker }));
});

test('a NEW marker with an unrecognized shape DENIES', () => {
  for (const bad of ['not json', JSON.stringify({ format: 'other', version: 1 }), JSON.stringify({ format: 'adlc-manifest-segments', version: 99 }), JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'maybe' })]) {
    assert.throws(
      () => validateReservedFiles({ baseMarker: null, headMarker: Buffer.from(bad) }),
      (e) => e instanceof GateDeny,
      `expected denial for marker ${bad.slice(0, 30)}`
    );
  }
});

test('baseForestBytes: a base with NO manifest.d returns the same shape as one with — the early return must not change the contract', () => {
  // Caught live: the no-manifest.d early return kept returning a bare Map
  // after the main path moved to {segments, marker}, so EVERY pre-forest
  // fixture crashed the gate with "baseSegments is not iterable". The
  // pre-forest base is the overwhelmingly common case; it gets its own test.
  const git = stubGit([
    [/^ls-tree f+ -- \.adlc\/manifest\.d$/, ok('')],
  ]);
  const base = baseForestBytes(git, 'f'.repeat(40));
  assert.equal(base.segments.size, 0);
  assert.equal(base.marker, null);
});

// ---- marker activation, seal tuples, and seq contiguity --------------------

test('a NEW marker on a LIVE (non-cutover) root DENIES — forest activation cannot bypass the cutover', () => {
  // A marker landed by PR flips isSegmentedRepo for every clone: writers
  // route to segments while the root never froze — the half-migrated state
  // enable itself refuses, delivered via merge instead.
  const marker = Buffer.from(JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyed' }));
  assert.throws(
    () => validateReservedFiles({ baseMarker: null, headMarker: marker, baseRootHasEntries: true, headRootCutover: false }),
    (e) => e instanceof GateDeny && /cutover/.test(e.message)
  );
  // legitimate arrival 1: greenfield enable (base root absent/empty)
  assert.doesNotThrow(() => validateReservedFiles({ baseMarker: null, headMarker: marker, baseRootHasEntries: false, headRootCutover: false }));
  // legitimate arrival 2: the migration ceremony (same PR cuts the root over)
  assert.doesNotThrow(() => validateReservedFiles({ baseMarker: null, headMarker: marker, baseRootHasEntries: true, headRootCutover: true }));
});

test('a NEW marker without an auth mode DENIES — new markers are post-policy by definition', () => {
  const marker = Buffer.from(JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
  assert.throws(
    () => validateReservedFiles({ baseMarker: null, headMarker: marker, baseRootHasEntries: false, headRootCutover: false }),
    (e) => e instanceof GateDeny && /auth/.test(e.message)
  );
});

test('seal coverage is per FULL tuple — a ticket-scoped approve needs its own seal', () => {
  // §4.6 seals carry provider, authorProvider, revision AND ticket when
  // present. Matching on (provider, revision) alone lets a ticketless seal
  // "cover" a ticketed approve while the reader's per-tuple revocation
  // leaves that approval alive across the cutover.
  // ticket is TOP-LEVEL on real entries — the recorder writes it there and
  // the reader matches it there; an earlier version of this fixture put it
  // in data and proved nothing about the real shape.
  const base = chainText([
    evidence(),
    { gate: 'cross-model-review', ticket: 'T-AAA', ts: '2026-01-01T01:00:00.000Z', files: {}, data: { verdict: 'approve', provider: 'codex', authorProvider: 'anthropic', revision: 'git-change:x:y' } },
    { gate: 'cross-model-review', ticket: 'T-BBB', ts: '2026-01-01T01:01:00.000Z', files: {}, data: { verdict: 'approve', provider: 'codex', authorProvider: 'anthropic', revision: 'git-change:x:y' } },
  ]);
  // one seal, carrying only T-AAA's tuple
  const sealed = withSealCutover(base, {
    sealCount: 1,
    mutate: (e) => e.gate === 'cross-model-review' ? { ...e, ticket: 'T-AAA' } : e,
  });
  assert.throws(
    () => assertRootTransition(rootArgs(base, sealed.text)),
    (e) => e instanceof GateDeny && /standing approve/.test(e.message) && /T-BBB/.test(e.message)
  );
});

test('a new segment with NONCONTIGUOUS seq DENIES — §4.3 requires +1 steps from 1', () => {
  // The shared verifyChain checks monotonicity, not contiguity (a gap like
  // 1,5 passes it) — tightening it is out of this ticket's scope, so the CI
  // gate enforces contiguity for NEW segments itself.
  const first = JSON.stringify({ seq: 1, ...evidence({ anchor: rootAnchor(BASE_ROOT), branch: 'feat-x' }), prev: null });
  const gapped = first + '\n' + JSON.stringify({ seq: 5, ...evidence(), prev: sha256(first) }) + '\n';
  assert.throws(
    () => validateNewSegments(newSegArgs({ headSegments: new Map([[SEG_A, Buffer.from(gapped)]]) })),
    (e) => e instanceof GateDeny && /contiguous|strictly by 1|seq/.test(e.message)
  );
});

test('a new segment whose FIRST seq is not 1 DENIES', () => {
  const first = JSON.stringify({ seq: 3, ...evidence({ anchor: rootAnchor(BASE_ROOT), branch: 'feat-x' }), prev: null });
  assert.throws(
    () => validateNewSegments(newSegArgs({ headSegments: new Map([[SEG_A, Buffer.from(first + '\n')]]) })),
    (e) => e instanceof GateDeny && /seq/.test(e.message)
  );
});

// ---- freeze signals and revocation semantics -------------------------------

test('a base with the marker FREEZES the root even without a cutover tail — empty-root forests included', () => {
  // Greenfield enable leaves the root absent or empty and writes the marker.
  // A later PR hand-appending root evidence is the stale-writer shape §11
  // says merge must deny — the cutover tail is not the only freeze signal.
  const head = BASE_ROOT + JSON.stringify({ seq: 3, ...evidence(), prev: sha256(BASE_LINES.at(-1)) }) + '\n';
  assert.throws(
    () => assertRootTransition(rootArgs(BASE_ROOT, head, { baseMarkerPresent: true })),
    (e) => e instanceof GateDeny && /frozen|byte-identical/.test(e.message)
  );
  assert.doesNotThrow(() => assertRootTransition(rootArgs(BASE_ROOT, BASE_ROOT, { baseMarkerPresent: true })));
  // an EMPTY frozen root must stay empty
  assert.throws(
    () => assertRootTransition(rootArgs('', 'seeded\n', { baseMarkerPresent: true })),
    (e) => e instanceof GateDeny
  );
});

test('an approve ANYWHERE-revoked is not standing — revocation is terminal, not last-wins (§6)', () => {
  // approve AFTER needs-attention: the reader still treats the tuple as
  // revoked ("no needs-attention anywhere"), so the ceremony seals nothing
  // — last-verdict accounting would demand a seal and reject a valid cutover.
  const tuple = { provider: 'codex', authorProvider: 'anthropic', revision: 'git-change:x:y' };
  const revoke = { gate: 'cross-model-review', ts: '2026-01-01T01:00:00.000Z', files: {}, data: { verdict: 'needs-attention', ...tuple } };
  const approve = { gate: 'cross-model-review', ts: '2026-01-01T02:00:00.000Z', files: {}, data: { verdict: 'approve', ...tuple } };
  const base = chainText([evidence(), revoke, approve]);
  const zeroSeals = withSealCutover(base, { sealCount: 0 });
  assert.doesNotThrow(() => assertRootTransition(rootArgs(base, zeroSeals.text)));
});

test('seal matching is keyed as the reader matches — authorProvider is not part of the key (§6)', () => {
  // The approve carries authorProvider anthropic; the seal names a different
  // one. §6 matches (provider, revision[, ticket]) — the seal still covers.
  const approve = { gate: 'cross-model-review', ts: '2026-01-01T01:00:00.000Z', files: {}, data: { verdict: 'approve', provider: 'codex', authorProvider: 'anthropic', revision: 'git-change:x:y' } };
  const base = chainText([evidence(), approve]);
  const sealed = withSealCutover(base, {
    sealCount: 1,
    mutate: (e) => e.gate === 'cross-model-review' ? { ...e, data: { ...e.data, authorProvider: 'someone-else' } } : e,
  });
  assert.doesNotThrow(() => assertRootTransition(rootArgs(base, sealed.text)));
});

// ---- continuations, empty roots, and provider normalization ----------------

test('an append to an EXISTING segment must chain-verify — a corrupt continuation DENIES', () => {
  // §9.2's letter is byte-prefix only, but a corrupt tail landing at merge
  // means every keyed reader thereafter fails the whole forest closed — the
  // gate exists to catch that before it lands. Only CHANGED segments are
  // re-verified; untouched base segments were validated when they landed.
  const base = segmentText({ anchor: rootAnchor(BASE_ROOT), entries: 2 });
  const corrupt = base + JSON.stringify({ seq: 3, ...evidence(), prev: 'not-the-tail-hash' }) + '\n';
  assert.throws(
    () => validateSegmentAppendOnly(new Map([[SEG_A, Buffer.from(base)]]), new Map([[SEG_A, Buffer.from(corrupt)]])),
    (e) => e instanceof GateDeny && /chain/.test(e.message) && e.message.includes(SEG_A)
  );
  // a gapped seq in the continuation also denies
  const lastLine = base.trim().split('\n').at(-1);
  const gapped = base + JSON.stringify({ seq: 9, ...evidence(), prev: sha256(lastLine) }) + '\n';
  assert.throws(
    () => validateSegmentAppendOnly(new Map([[SEG_A, Buffer.from(base)]]), new Map([[SEG_A, Buffer.from(gapped)]])),
    (e) => e instanceof GateDeny && e.message.includes(SEG_A)
  );
  // and the honest continuation still passes (pinned above as AC5, re-pinned
  // here against the chain re-verify specifically)
  const appended = base + JSON.stringify({ seq: 3, ...evidence(), prev: sha256(lastLine) }) + '\n';
  assert.doesNotThrow(() =>
    validateSegmentAppendOnly(new Map([[SEG_A, Buffer.from(base)]]), new Map([[SEG_A, Buffer.from(appended)]]))
  );
});

test('an EMPTY tracked base root permits anchor:null — bootstrap creates the root empty by design', () => {
  // "create it empty during bootstrap" is the sanctioned shape, and the
  // writer mints anchor:null when there is no head LINE to anchor to. File
  // existence is the wrong predicate; entry presence is the right one.
  const nullSeg = segmentText({ anchor: null });
  assert.doesNotThrow(() => validateNewSegments(newSegArgs({
    headSegments: new Map([[SEG_A, Buffer.from(nullSeg)]]),
    baseRootPresent: false, // what rail-freeze must pass for an EMPTY tracked root
    headRootText: '',
  })));
});

test('cutover seal matching normalizes providers as the reader does', () => {
  // §6: "providers normalized on both sides as today" — NFKC, whitespace
  // stripped, lowercased. An approve by "Codex" sealed by "codex" matches;
  // treating them as distinct tuples would demand a phantom second seal.
  const approve = { gate: 'cross-model-review', ts: '2026-01-01T01:00:00.000Z', files: {}, data: { verdict: 'approve', provider: 'Codex ', authorProvider: 'anthropic', revision: 'git-change:x:y' } };
  const base = chainText([evidence(), approve]);
  const sealed = withSealCutover(base, { sealCount: 1 }); // seal() uses lowercase 'codex'
  assert.doesNotThrow(() => assertRootTransition(rootArgs(base, sealed.text)));
});

// ---- keyed-forest signature presence, activation seeding, raw-byte bindings --

test('a KEYED forest requires sig presence on new-segment entries — keyless containment is for keyless forests', () => {
  // The gate holds no key, so this is presence-only, exactly the posture the
  // seal/cutover entries already get: a keyed forest's writer always signs,
  // so an unsigned entry is either a refused keyless write or a forgery, and
  // catching it before merge beats every clone failing closed after.
  const unsigned = segmentText({ anchor: rootAnchor(BASE_ROOT) });
  assert.throws(
    () => validateNewSegments(newSegArgs({
      headSegments: new Map([[SEG_A, Buffer.from(unsigned)]]),
      forestAuth: 'keyed',
    })),
    (e) => e instanceof GateDeny && /sig/.test(e.message)
  );
  // keyless forest: unsigned entries are the declared mode
  assert.doesNotThrow(() => validateNewSegments(newSegArgs({
    headSegments: new Map([[SEG_A, Buffer.from(unsigned)]]),
    forestAuth: 'keyless',
  })));
  // no marker / pre-policy: no mode to enforce
  assert.doesNotThrow(() => validateNewSegments(newSegArgs({
    headSegments: new Map([[SEG_A, Buffer.from(unsigned)]]),
  })));
});

test('a KEYED forest requires sig presence on segment CONTINUATIONS too', () => {
  const signedEntry = (extra = {}) => ({ ...evidence(extra), sigVersion: 2, sig: 'a'.repeat(64) });
  const first = JSON.stringify({ seq: 1, ...signedEntry({ anchor: rootAnchor(BASE_ROOT), branch: 'feat-x' }), prev: null });
  const base = first + '\n';
  const unsignedAppend = base + JSON.stringify({ seq: 2, ...evidence(), prev: sha256(first) }) + '\n';
  assert.throws(
    () => validateSegmentAppendOnly(new Map([[SEG_A, Buffer.from(base)]]), new Map([[SEG_A, Buffer.from(unsignedAppend)]]), { forestAuth: 'keyed' }),
    (e) => e instanceof GateDeny && /sig/.test(e.message)
  );
  const signedAppend = base + JSON.stringify({ seq: 2, ...signedEntry(), prev: sha256(first) }) + '\n';
  assert.doesNotThrow(
    () => validateSegmentAppendOnly(new Map([[SEG_A, Buffer.from(base)]]), new Map([[SEG_A, Buffer.from(signedAppend)]]), { forestAuth: 'keyed' })
  );
});

test('a PR cannot seed the root WHILE introducing the marker — activation and evidence do not mix', () => {
  // Base: empty tracked root, no marker (the bootstrap shape). A PR adding
  // the marker AND root entries manufactures a segmented repo with a live
  // non-cutover root — the half-state enable refuses, assembled at merge.
  const marker = Buffer.from(JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyed' }));
  assert.throws(
    () => validateReservedFiles({
      baseMarker: null, headMarker: marker,
      baseRootHasEntries: false, headRootCutover: false,
      headRootGainedEntries: true,
    }),
    (e) => e instanceof GateDeny && /marker/.test(e.message)
  );
  // marker alone (root untouched) stays legal
  assert.doesNotThrow(() => validateReservedFiles({
    baseMarker: null, headMarker: marker,
    baseRootHasEntries: false, headRootCutover: false,
    headRootGainedEntries: false,
  }));
});

test('the cutover rootSha256 binding hashes RAW bytes — invalid utf8 in the legacy region must not launder', () => {
  // Base carries a byte sequence that is not valid utf8 (0xFF). Hashing the
  // DECODED text re-encodes U+FFFD and diverges from the ceremony's
  // hash-of-raw-bytes — a valid cutover would be denied (and a laundered
  // collision accepted). The binding must be computed over the buffer.
  const opaque = Buffer.concat([Buffer.from('{"seq":1,"gate":"evidence","prev":null,"blob":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  const baseBytes = opaque; // one opaque line; lenient detection sees no cutover
  const sealLine = (() => {
    const e = { seq: 2, ...seal(), prev: sha256Buf(baseBytes.subarray(0, baseBytes.length - 1)) };
    return e;
  })();
  // build head = base + cutover (0 seals), binding computed over RAW bytes
  const cutEntry = {
    seq: 2,
    gate: 'manifest-cutover',
    ts: '2026-01-02T00:00:01.000Z',
    data: { reason: 'operator-migration', rootLines: 1, rootSha256: sha256Buf(baseBytes), sealedApprovals: 0 },
    files: {}, sigVersion: 2, sig: 'e'.repeat(64),
    prev: sha256Buf(lastLineOf(baseBytes)),
  };
  void sealLine;
  const headBytes = Buffer.concat([baseBytes, Buffer.from(JSON.stringify(cutEntry) + '\n')]);
  assert.doesNotThrow(() => assertRootTransition({
    basePresent: true, baseBytes, headPresent: true, headBytes, migration: NO_MIGRATION,
  }));
});

// ---- ticket shape fidelity and cutover-only auth inference -----------------

test('a seal carrying ticket only in DATA does not cover a top-level-ticketed approve', () => {
  // The reader matches entry.ticket (top-level) exclusively — a data-shaped
  // ticket on a seal never revokes the per-ticket gate, so treating it as
  // coverage leaves the approval alive across the cutover.
  const approve = { gate: 'cross-model-review', ticket: 'T-AAA', ts: '2026-01-01T01:00:00.000Z', files: {}, data: { verdict: 'approve', provider: 'codex', authorProvider: 'anthropic', revision: 'git-change:x:y' } };
  const base = chainText([evidence(), approve]);
  const sealed = withSealCutover(base, {
    sealCount: 1,
    mutate: (e) => e.gate === 'cross-model-review' ? { ...e, data: { ...e.data, ticket: 'T-AAA' } } : e, // data-shaped: wrong
  });
  assert.throws(
    () => assertRootTransition(rootArgs(base, sealed.text)),
    (e) => e instanceof GateDeny && /T-AAA/.test(e.message)
  );
  // top-level ticket on the seal: covers
  const sealedRight = withSealCutover(base, {
    sealCount: 1,
    mutate: (e) => e.gate === 'cross-model-review' ? { ...e, ticket: 'T-AAA' } : e,
  });
  assert.doesNotThrow(() => assertRootTransition(rootArgs(base, sealedRight.text)));
});

test('a cutover-only forest (marker lost) still enforces keyed signature presence', () => {
  // §8 refuses to run the ceremony without a key, so a cutover-tailed root
  // implies a keyed forest even when the marker is gone — losing the marker
  // must not silently drop the discipline.
  const cutRoot = withSealCutover(BASE_ROOT).text;
  const unsigned = segmentText({ anchor: rootAnchor(cutRoot) });
  assert.throws(
    () => validateNewSegments(newSegArgs({
      headSegments: new Map([[SEG_A, Buffer.from(unsigned)]]),
      headRootText: cutRoot,
      forestAuth: 'keyed', // what rail-freeze must infer from the cutover tail
    })),
    (e) => e instanceof GateDeny && /sig/.test(e.message)
  );
});

test('keyed discipline matches the real writer: v1 continuations pass, v1 FIRST entries of new segments deny', () => {
  // The segment writer forces v2 on the mint (resolved.isNew ? 2 : version)
  // and follows the configured version after — this repo records v1 today.
  // Requiring v2 everywhere rejects the public recorder's real output;
  // requiring nothing on the first entry breaks §4.4a recovery (v1 does not
  // sign branch/anchor). First entry v2, everything else sig-presence.
  const v2 = (extra = {}) => ({ ...evidence(extra), sigVersion: 2, sig: 'a'.repeat(64) });
  const v1 = (extra = {}) => ({ ...evidence(extra), sig: 'b'.repeat(64) }); // v1: sig, no sigVersion

  // v2 first + v1 second: the writer's real shape → passes
  const first = JSON.stringify({ seq: 1, ...v2({ anchor: rootAnchor(BASE_ROOT), branch: 'feat-x' }), prev: null });
  const mixed = first + '\n' + JSON.stringify({ seq: 2, ...v1(), prev: sha256(first) }) + '\n';
  assert.doesNotThrow(() => validateNewSegments(newSegArgs({
    headSegments: new Map([[SEG_A, Buffer.from(mixed)]]), forestAuth: 'keyed',
  })));

  // v1 FIRST entry: the writer never produces this; recovery could never
  // authenticate it → deny
  const v1First = JSON.stringify({ seq: 1, ...v1({ anchor: rootAnchor(BASE_ROOT), branch: 'feat-x' }), prev: null }) + '\n';
  assert.throws(
    () => validateNewSegments(newSegArgs({ headSegments: new Map([[SEG_A, Buffer.from(v1First)]]), forestAuth: 'keyed' })),
    (e) => e instanceof GateDeny && /sigVersion 2|v2/.test(e.message)
  );

  // v1 continuation of an existing segment → passes keyed
  const base = first + '\n';
  const v1Append = base + JSON.stringify({ seq: 2, ...v1(), prev: sha256(first) }) + '\n';
  assert.doesNotThrow(
    () => validateSegmentAppendOnly(new Map([[SEG_A, Buffer.from(base)]]), new Map([[SEG_A, Buffer.from(v1Append)]]), { forestAuth: 'keyed' })
  );
});

// ---- auth precedence, legacy shapes, whitespace tolerance ------------------

test('a legacy type-shaped approve is counted in the seal census — the reader honors it, so the census must', () => {
  // prosecute's own evidence writer historically used `type` instead of
  // `gate`; the reader accepts either (entry.gate ?? entry.type). An approve
  // in that shape escaping the census would survive cutover unsealed.
  const legacyApprove = { type: 'cross-model-review', ts: '2026-01-01T01:00:00.000Z', files: {}, data: { verdict: 'approve', provider: 'codex', authorProvider: 'anthropic', revision: 'git-change:x:y' } };
  const base = chainText([evidence(), legacyApprove]);
  const zeroSeals = withSealCutover(base, { sealCount: 0 });
  assert.throws(
    () => assertRootTransition(rootArgs(base, zeroSeals.text)),
    (e) => e instanceof GateDeny && /standing approve/.test(e.message)
  );
});

test('a whitespace-only trailing line in the legacy region does not break the cutover chain', () => {
  // manifestRawLines filters blank lines, and the writer chains prev over
  // the last NON-BLANK raw line — the byte-level tail helper must skip
  // whitespace-only lines the same way or a valid cutover fails.
  const baseWithBlank = BASE_ROOT + '   \n';
  // Built ON the blank-tailed base: the ceremony's rootSha256 hashes ALL
  // prior bytes (blank line included) while its prev chains over the last
  // NON-blank line — the two must not be conflated.
  const { text } = withSealCutover(baseWithBlank);
  assert.doesNotThrow(() => assertRootTransition(rootArgs(baseWithBlank, text)));
});

test('an explicit keyless marker does not downgrade a cutover forest — cutover implies keyed, and the pair is inconsistent', () => {
  // The ceremony cannot run keyless and always writes auth "keyed"; a
  // keyless marker beside a cutover-tailed root is a state no producer
  // creates. The stronger signal wins for enforcement.
  const cutRoot = withSealCutover(BASE_ROOT).text;
  const unsigned = segmentText({ anchor: rootAnchor(cutRoot) });
  // rail-freeze must pass forestAuth 'keyed' here regardless of the marker;
  // pinned at the validator level: keyed discipline applies.
  assert.throws(
    () => validateNewSegments(newSegArgs({
      headSegments: new Map([[SEG_A, Buffer.from(unsigned)]]),
      headRootText: cutRoot,
      forestAuth: 'keyed',
    })),
    (e) => e instanceof GateDeny && /sig/.test(e.message)
  );
});

// ---- forest-wide reader coherence and segmented migrations -----------------

test('creating a root with entries while ANY null-anchored segment exists DENIES — the merged forest would fail every reader', () => {
  // The production verifier resolves every segment anchor with
  // rootExists = root.count > 0 at READ time. Land a root with entries next
  // to a null-anchored segment (minted legitimately pre-root) and every
  // clone's verify returns invalid forever. The gate must reject the
  // composition, not each piece.
  const nullSeg = segmentText({ anchor: null });
  assert.throws(
    () => validateNewSegments(newSegArgs({
      headSegments: new Map([[SEG_A, Buffer.from(nullSeg)]]),
      baseSegmentNames: new Set([SEG_A]), // existing, not new — §9.3 alone never looks at it
      baseRootPresent: false,
      headRootText: BASE_ROOT, // root with entries arriving in this PR
    })),
    (e) => e instanceof GateDeny && /null/.test(e.message)
  );
  // an EMPTY root arriving is fine — readers resolve rootExists=false
  assert.doesNotThrow(() => validateNewSegments(newSegArgs({
    headSegments: new Map([[SEG_A, Buffer.from(nullSeg)]]),
    baseSegmentNames: new Set([SEG_A]),
    baseRootPresent: false,
    headRootText: '',
  })));
});

test('a segmented repo validates ticket-migration evidence in its SEGMENTS — the frozen root cannot carry it', () => {
  // appendManifestEntry routes to segments once the repo is segmented, so
  // the supported ticket-store migration's evidence lands in a segment; the
  // root is frozen and must stay byte-identical. Skipping validation there
  // would let a 'migration' PR restructure the store with no bound evidence.
  const mkEntry = (over) => JSON.stringify(over);
  const apply = { seq: 1, gate: 'ticket-migrate', anchor: null, branch: 'feat-x', ts: '2026-01-01T00:00:00.000Z', files: {}, data: { operation: 'migrate', action: 'apply', bindingScope: 'store', storeHash: 'SH', archiveHash: 'AH', transactionId: 'tx1' }, prev: null };
  const applyLine = mkEntry(apply);
  const migSeg = applyLine + '\n';

  // evidence present in exactly one segment: passes
  assert.doesNotThrow(() => validateSegmentedMigrationEvidence({
    baseSegments: new Map(),
    headSegments: new Map([[SEG_A, Buffer.from(migSeg)]]),
    storeHash: 'SH', archiveHash: 'AH',
  }));
  // absent everywhere: denies (fail-closed, not fail-open)
  assert.throws(
    () => validateSegmentedMigrationEvidence({
      baseSegments: new Map(),
      headSegments: new Map([[SEG_A, Buffer.from(segmentText({ anchor: null }))]]),
      storeHash: 'SH', archiveHash: 'AH',
    }),
    (e) => e instanceof GateDeny && /migration/.test(e.message)
  );
  // wrong binding: denies via the existing evidence validator
  assert.throws(
    () => validateSegmentedMigrationEvidence({
      baseSegments: new Map(),
      headSegments: new Map([[SEG_A, Buffer.from(migSeg)]]),
      storeHash: 'DIFFERENT', archiveHash: 'AH',
    }),
    (e) => e instanceof GateDeny
  );
  // split across two segments: denies (one ceremony, one chain)
  const applyB = mkEntry({ ...apply, branch: 'feat-b' });
  assert.throws(
    () => validateSegmentedMigrationEvidence({
      baseSegments: new Map(),
      headSegments: new Map([[SEG_A, Buffer.from(migSeg)], [SEG_B, Buffer.from(applyB + '\n')]]),
      storeHash: 'SH', archiveHash: 'AH',
    }),
    (e) => e instanceof GateDeny && /exactly one/.test(e.message)
  );
});

// ---- round-10: allowlist reach and whole-forest anchor re-resolution -------

test('an append that ALTERS an existing segment terminal raw line breaks child anchors — and DENIES', () => {
  // Byte-prefix append-only holds while the terminal RAW LINE changes: a
  // parent whose last line lacks a trailing newline gains "\r\n..." — the
  // old last line now ends in \r, its hash changes, and every child anchor
  // pointing at it fails at read time. Neither segment is new, so per-name
  // §9.3 never looks; the whole head forest must re-resolve, as the reader
  // will.
  const parentFirst = JSON.stringify({ seq: 1, ...evidence({ anchor: rootAnchor(BASE_ROOT), branch: 'feat-a' }), prev: null });
  const parentNoLf = parentFirst; // no trailing newline
  const child = segmentText({ anchor: { segment: SEG_A, seq: 1, lineHash: sha256(parentFirst) }, branch: 'feat-b' });
  // head: parent gains a CRLF-prefixed append; child untouched
  const crlfAppend = parentNoLf + '\r\n' + JSON.stringify({ seq: 2, ...evidence(), prev: sha256(parentFirst + '\r') }) + '\n';
  assert.throws(
    () => validateNewSegments(newSegArgs({
      headSegments: new Map([[SEG_A, Buffer.from(crlfAppend)], [SEG_B, Buffer.from(child)]]),
      baseSegmentNames: new Set([SEG_A, SEG_B]),
    })),
    (e) => e instanceof GateDeny && /lineHash/.test(e.message)
  );
  // untouched healthy forest still passes whole-forest re-resolution
  const parent = parentFirst + '\n';
  assert.doesNotThrow(() => validateNewSegments(newSegArgs({
    headSegments: new Map([[SEG_A, Buffer.from(parent)], [SEG_B, Buffer.from(child)]]),
    baseSegmentNames: new Set([SEG_A, SEG_B]),
  })));
});

// ---- round-11: root anchors, migration payload bounds, marker-less cutovers --

test('a seal or cutover entry carrying an anchor field DENIES — root entries never carry anchors', () => {
  // The reader rejects any root entry with an anchor (§4.4); a seal entry
  // smuggling one would brick every reader while passing shape checks.
  const withAnchor = withSealCutover(BASE_ROOT, {
    mutate: (e) => e.gate === 'cross-model-review' ? { ...e, anchor: null } : e,
  });
  assert.throws(
    () => assertRootTransition(rootArgs(BASE_ROOT, withAnchor.text)),
    (e) => e instanceof GateDeny && /anchor/.test(e.message)
  );
});

test('a migration diff touching segments beyond the evidence carrier DENIES — the ceremony carries no payload', () => {
  const mkEntry = (over) => JSON.stringify(over);
  const apply = { seq: 1, gate: 'ticket-migrate', anchor: null, branch: 'feat-x', ts: '2026-01-01T00:00:00.000Z', files: {}, data: { operation: 'migrate', action: 'apply', bindingScope: 'store', storeHash: 'SH', archiveHash: 'AH', transactionId: 'tx1' }, prev: null };
  const migSeg = mkEntry(apply) + '\n';
  const unrelated = segmentText({ anchor: null, branch: 'feat-b' });
  assert.throws(
    () => validateSegmentedMigrationEvidence({
      baseSegments: new Map(),
      headSegments: new Map([[SEG_A, Buffer.from(migSeg)], [SEG_B, Buffer.from(unrelated)]]),
      storeHash: 'SH', archiveHash: 'AH',
    }),
    (e) => e instanceof GateDeny && /payload|beyond|unrelated/.test(e.message)
  );
});

test('a NEW cutover landing without the activation marker DENIES — the ceremony always writes both', () => {
  const marker = Buffer.from(JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyed' }));
  // ceremony shape: cutover + marker together → fine
  assert.doesNotThrow(() => validateReservedFiles({
    baseMarker: null, headMarker: marker,
    baseRootHasEntries: true, headRootCutover: true, newlyCutover: true,
  }));
  // cutover without any marker → the state no producer creates
  assert.throws(
    () => validateReservedFiles({
      baseMarker: null, headMarker: null,
      baseRootHasEntries: true, headRootCutover: true, newlyCutover: true,
    }),
    (e) => e instanceof GateDeny && /marker/.test(e.message)
  );
  // an ALREADY-cutover base whose marker was lost long ago: PRs must not be
  // bricked retroactively — only the transition is gated
  assert.doesNotThrow(() => validateReservedFiles({
    baseMarker: null, headMarker: null,
    baseRootHasEntries: true, headRootCutover: true, newlyCutover: false,
  }));
});

// ---- round-12: migration root-seeding, keyless-cutover markers -------------

test('a keyless marker arriving WITH a cutover DENIES — the ceremony always writes keyed', () => {
  const keyless = Buffer.from(JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyless' }));
  assert.throws(
    () => validateReservedFiles({
      baseMarker: null, headMarker: keyless,
      baseRootHasEntries: true, headRootCutover: true, newlyCutover: true,
    }),
    (e) => e instanceof GateDeny && /keyless|keyed/.test(e.message)
  );
});

// ---- mutation kill coverage: wiring reachable only through verifyManifest --

import { migrationDiffAllowsPath, verifyManifest, runRailFreezeGate } from '../lib/ci/rail-freeze.mjs';

test('the migration allowlist reaches manifest.d/ and each legacy path', () => {
  for (const path of ['.adlc/manifest.d/x.jsonl', '.adlc/tickets/t1.json', '.adlc/ticket-archive/a.json', '.adlc/tickets.json', '.adlc/manifest.jsonl', '.gitignore']) {
    assert.ok(migrationDiffAllowsPath(path), `${path} must be migration-allowed`);
  }
  assert.ok(!migrationDiffAllowsPath('src/anything.mjs'), 'unrelated paths stay payload');
});

test('a grammar-valid slug may contain every digit', () => {
  const seg = segmentText({ anchor: rootAnchor(BASE_ROOT) });
  assert.doesNotThrow(() => validateNewSegments(newSegArgs({
    headSegments: new Map([[`feat-2345678-9-${ULID_A}.jsonl`, Buffer.from(seg)]]),
  })));
});

test('baseForestBytes never reads .lineage as a segment — no blob fetch, no entry', () => {
  // The stub throws on any un-stubbed invocation, so a mutant that stops
  // reserving .lineage would die trying to cat-file it.
  const git = stubGit([
    [/^ls-tree f+ -- \.adlc\/manifest\.d$/, ok(`040000 tree ${'c'.repeat(40)}\t.adlc/manifest.d\n`)],
    [/^ls-tree f+ \.adlc\/manifest\.d\/$/, ok(`100644 blob ${'e'.repeat(40)}\t.adlc/manifest.d/.lineage\n`)],
  ]);
  const base = baseForestBytes(git, 'f'.repeat(40));
  assert.equal(base.segments.size, 0);
});

function bootstrapGit({ rootText = '', segRows = '', markerJson = null } = {}) {
  const rows = [];
  if (rootText !== null) rows.push(`100644 blob ${'e'.repeat(40)}\t.adlc/manifest.jsonl`);
  const responses = [
    [/^rev-parse HEAD$/, ok(`${REV}\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc$/, ok(`040000 tree ${'b'.repeat(40)}\t.adlc\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.jsonl$/, ok(rootText === null ? '' : rows[0] + '\n')],
    [/^cat-file blob e+$/, okRaw(Buffer.from(rootText ?? ''))],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.d$/, ok(segRows || markerJson ? `040000 tree ${'c'.repeat(40)}\t.adlc/manifest.d\n` : '')],
    [/^ls-tree [a-f0-9]+ \.adlc\/manifest\.d\/$/, ok(segRows + (markerJson ? `100644 blob ${'a'.repeat(40)}\t.adlc/manifest.d/.store.json\n` : ''))],
    [/^cat-file blob a+$/, okRaw(Buffer.from(markerJson ?? ''))],
    [/^cat-file blob d+$/, okRaw(Buffer.from(segmentText({ anchor: null })))],
  ];
  return stubGit(responses);
}

test('verifyManifest: a NEW marker on a LIVE base root denies through the real wiring', () => {
  // Kills the base-read ternary mutants: with baseRootBytes nulled, the
  // marker-on-live-root deny cannot fire and this composition passes.
  const git = bootstrapGit({ rootText: BASE_ROOT, markerJson: JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyed' }) });
  const baseGit = (args, label) => {
    const joined = args.join(' ');
    // base root EXISTS (live, with entries); base forest is empty
    if (/^ls-tree --name-only f+ -- \.adlc\/manifest\.jsonl$/.test(joined)) return ok('.adlc/manifest.jsonl\n');
    if (/^ls-tree f+ -- \.adlc\/manifest\.jsonl$/.test(joined)) return ok(`100644 blob ${'9'.repeat(40)}\t.adlc/manifest.jsonl\n`);
    if (/^ls-tree f+ -- \.adlc\/manifest\.d$/.test(joined)) return ok('');
    if (args[0] === 'show') return okRaw(Buffer.from(BASE_ROOT));
    return git(args, label);
  };
  assert.throws(
    () => verifyManifest({ git: baseGit, trustedBase: 'f'.repeat(40), base: 'main', migration: { verified: false } }),
    // The SPECIFIC live-root refusal — a looser match let a different deny
    // (gained-entries) satisfy this test while the base read was nulled out.
    (e) => e instanceof GateDeny && /holds evidence and no cutover/.test(e.message)
  );
});

test('the REAL bootstrap gate fails a PR seeding segment evidence (no base ticket store)', () => {
  // Drives runRailFreezeGate end to end on a throwaway repo: base has no
  // ticket store and no config, HEAD commits a populated segment. The
  // snapshot-only version of this test never executed the bootstrap branch
  // and its comparison mutants survived.
  const root = mkdtempSync(join(tmpdir(), 'forest-bootstrap-'));
  try {
    const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t.co'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'README.md'), 'x\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    g('checkout', '-qb', 'feat');
    mkdirSync(join(root, '.adlc', 'manifest.d'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'manifest.d', SEG_A), segmentText({ anchor: null }));
    g('add', '-A'); g('commit', '-qm', 'seed a segment');
    assert.throws(
      () => runRailFreezeGate({ cwd: root, base: 'main', env: {}, stdio: 'pipe' }),
      (e) => e instanceof GateFail && /segment evidence/.test(e.message),
      'seeding segment evidence in a bootstrap PR must FAIL closed'
    );
    // and the clean bootstrap (no segments) passes — pinning the comparison
    g('checkout', '-q', 'main');
    g('checkout', '-qb', 'feat2');
    writeFileSync(join(root, 'src.mjs'), 'y\n');
    g('add', '-A'); g('commit', '-qm', 'ordinary change');
    const clean = runRailFreezeGate({ cwd: root, base: 'main', env: {}, stdio: 'pipe' });
    assert.equal(clean.status, 0, 'an ordinary bootstrap PR still passes');
    void clean;
  } finally { rmSync(root, { recursive: true, force: true }); }
});
