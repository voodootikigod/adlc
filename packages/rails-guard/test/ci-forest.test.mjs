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
import {
  assertRootTransition,
  validateSegmentAppendOnly,
  validateNewSegments,
  committedEvidenceAtHead,
} from '../lib/ci/manifest.mjs';
import { GateDeny, GateFail } from '../lib/ci/errors.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

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
  ]);
  const snapshot = committedEvidenceAtHead(git);
  assert.equal(snapshot.segments.size, 0, 'the marker is not a segment');

  const gitSym = stubGit([
    [/^rev-parse HEAD$/, ok(`${REV}\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc$/, ok(`040000 tree ${'b'.repeat(40)}\t.adlc\n`)],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.jsonl$/, ok('')],
    [/^ls-tree [a-f0-9]+ -- \.adlc\/manifest\.d$/, ok(`040000 tree ${'c'.repeat(40)}\t.adlc/manifest.d\n`)],
    [/^ls-tree [a-f0-9]+ \.adlc\/manifest\.d\/$/, ok(`120000 blob ${'d'.repeat(40)}\t.adlc/manifest.d/.store.json\n`)],
  ]);
  assert.throws(() => committedEvidenceAtHead(gitSym), (e) => e instanceof GateDeny, 'a symlinked marker is the same smuggling vector as a symlinked manifest');
});
