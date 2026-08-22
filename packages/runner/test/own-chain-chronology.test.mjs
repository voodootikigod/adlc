// Concern: the P5/P6 gate consumers must not read forest ARRAY POSITION as
// chronology (T-01M01HTKD290FQQB4NDCV60Q24).
//
// `latestP5Entry` takes `.at(-1)`, `p5CompletionIntegrityErrors` slices around
// `entries.indexOf(entry)`, and `openP5FindingErrors` asks whether a kill falls
// between a finding and a completion — all three are chronology claims made
// from position in the array `readManifestForest` returns. That array is sorted
// by anchor topology for DISPLAY, which its own header says is deliberately not
// causal across independent segments: whether a foreign branch's segment lands
// before or after ours is decided by a ULID, not by when anything happened.
//
// With one segment the consumers are right by accident. Every test here builds
// a SECOND segment belonging to another branch, which is what the frozen root
// made ordinary — and each of them fails against a whole-forest read.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPhase } from '../lib/assertions.mjs';
import { recordAcceptancePacket } from '../lib/acceptance.mjs';
import { sha256 } from '@adlc/core';
import { ticketHash as domainTicketHash } from '@adlc/tickets';

const OUR_BRANCH = 'feat/own-chain-runner-fixture';
const OTHER_BRANCH = 'feat/somebody-elses-work';
const ULID_FIRST = '0'.repeat(26);
const ULID_LAST = 'Z'.repeat(26);
const OURS = `ours-${ULID_FIRST}.jsonl`;
const THEIRS_LATER = `theirs-${ULID_LAST}.jsonl`;
const REVISION = 'fixture-revision';
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'adlc.mjs');

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-runner-own-chain-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', OUR_BRANCH);
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  const dir = join(root, '.adlc');
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}
const clean = (root) => rmSync(root, { recursive: true, force: true });

function ticketDefinition(ticket = 'T1') {
  return { id: ticket, title: `${ticket} fixture`, scope: ['src/**'], rails: ['test/**'], edges: [] };
}

function writeTicketDefinition(dir, ticket = 'T1') {
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [ticketDefinition(ticket)] }));
}

/**
 * The full set of entries one complete, valid P5 prosecution writes. Returned
 * rather than written so a test can direct the SAME evidence at root or at a
 * segment — which chain it lands in is the whole subject here.
 */
function p5Entries(dir, { ticket = 'T1', revision = REVISION, dryLenses = ['security', 'correctness', 'tests'] } = {}) {
  const transcriptPath = join(dir, `${ticket}-p5-review.txt`);
  writeFileSync(transcriptPath, [
    `ticket: ${ticket}`,
    `reviewed revision: ${revision}`,
    'review transcript fixture with enough detail to be accepted as evidence',
    'review transcript fixture with enough detail to be accepted as evidence',
  ].join('\n'));
  const promptPath = join(dir, `${ticket}-p5-prompt.txt`);
  const inputsPath = join(dir, `${ticket}-p5-inputs.txt`);
  writeFileSync(promptPath, `review prompt for ${ticket} at ${revision}\n`);
  writeFileSync(inputsPath, `reviewed inputs for ${ticket} at ${revision}\n`);

  const entries = [];
  dryLenses.forEach((lens, index) => {
    const pass = index + 1;
    entries.push({ type: 'p5-dry-pass', ticket, revision, pass, lens, consecutiveDry: pass });
    entries.push({ type: 'p5-pass-completed', ticket, revision, pass, lens, dry: true, verified: 0, killed: 0, needsHuman: 0, consecutiveDry: pass });
  });
  entries.push({
    type: 'p5-complete',
    ticket,
    revision,
    pass: dryLenses.length,
    consecutiveDry: dryLenses.length,
    provenance: { reviewer: 'fixture-reviewer', command: 'fixture review command', transcript: transcriptPath },
    transcript: { path: transcriptPath, hash: sha256(readFileSync(transcriptPath)) },
    reviewPacket: {
      prompt: { path: promptPath, hash: sha256(readFileSync(promptPath)) },
      inputs: { path: inputsPath, hash: sha256(readFileSync(inputsPath)) },
      cleanWorktree: revision,
    },
    dryLenses,
    ticketHash: domainTicketHash(ticketDefinition(ticket)),
  });
  return entries;
}

function finding({ id = 'F1', claim = 'verified claim', evidence = 'verified finding evidence' } = {}) {
  return { id, file: 'src/auth.mjs', line_start: 1, line_end: 1, category: 'correctness', claim, evidence };
}

function writeRoot(dir, entries) {
  writeFileSync(join(dir, 'manifest.jsonl'), entries.map((e, i) => JSON.stringify({ seq: i + 1, ...e })).join('\n') + '\n');
}

// Hand-built, like gate-manifest's own segment fixtures: assertPhase's read is
// LENIENT, so a fixture needs only a grammar-valid name and a first entry
// carrying `anchor` and `branch`. Signatures are verify()'s business, not this
// reader's.
function writeSegment(dir, name, { branch, anchorSeq, entries }) {
  mkdirSync(join(dir, 'manifest.d'), { recursive: true });
  writeFileSync(join(dir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
  const lines = entries.map((e, i) => JSON.stringify(
    i === 0
      ? { seq: 1, anchor: { segment: 'root', seq: anchorSeq, lineHash: 'a'.repeat(64) }, branch, ...e }
      : { seq: i + 1, ...e }
  ));
  writeFileSync(join(dir, 'manifest.d', name), lines.join('\n') + '\n');
}

describe('assertPhase p5: a foreign segment cannot be this ticket\'s latest evidence', () => {
  it('asserts against OUR p5-complete, not a defective one sorted last by a foreign segment', () => {
    const { root, dir } = repo();
    try {
      writeTicketDefinition(dir);
      const ours = p5Entries(dir);
      writeRoot(dir, ours);
      // Same ticket, same revision, and structurally hollow — no provenance, no
      // transcript, no reviewPacket. Nothing about it is later than ours; it
      // merely sorts last, and `.at(-1)` reads that as "most recent".
      writeSegment(dir, THEIRS_LATER, {
        branch: OTHER_BRANCH,
        anchorSeq: ours.length,
        entries: [{ type: 'p5-complete', ticket: 'T1', revision: REVISION, consecutiveDry: 3, dryLenses: ['security', 'correctness', 'tests'] }],
      });

      const result = assertPhase('p5', { dir, ticket: 'T1', revision: REVISION, cwd: root });
      assert.deepEqual(result.errors ?? [], []);
      assert.equal(result.ok, true);
    } finally { clean(root); }
  });

  it('does not treat a foreign segment\'s unresolved finding as this chain\'s open finding', () => {
    const { root, dir } = repo();
    try {
      writeTicketDefinition(dir);
      const ours = p5Entries(dir);
      writeRoot(dir, ours);
      // A verified finding that sorts AFTER the completion it is compared
      // against: openP5FindingErrors slices `(index + 1, completionIndex)`,
      // which is empty when index already exceeds it, so a whole-forest read
      // reports it unresolved no matter what happened to it on its own branch.
      writeSegment(dir, THEIRS_LATER, {
        branch: OTHER_BRANCH,
        anchorSeq: ours.length,
        entries: [{ type: 'p5-finding-verified', ticket: 'T1', revision: REVISION, pass: 1, lens: 'security', finding: finding() }],
      });

      const result = assertPhase('p5', { dir, ticket: 'T1', revision: REVISION, cwd: root });
      assert.deepEqual(result.errors ?? [], []);
      assert.equal(result.ok, true);
    } finally { clean(root); }
  });

  it('still reports OUR chain\'s own unresolved finding — scoping narrows the read, it does not soften the check', () => {
    const { root, dir } = repo();
    try {
      writeTicketDefinition(dir);
      const ours = p5Entries(dir);
      const withFinding = [
        { type: 'p5-finding-verified', ticket: 'T1', revision: REVISION, pass: 1, lens: 'security', finding: finding() },
        ...ours,
      ];
      writeRoot(dir, withFinding);

      const result = assertPhase('p5', { dir, ticket: 'T1', revision: REVISION, cwd: root });
      assert.equal(result.ok, false);
      assert.equal(result.errors.some((e) => /unresolved p5-finding-verified F1/.test(e)), true);
    } finally { clean(root); }
  });

  it('reads evidence recorded in OUR OWN segment, not only root', () => {
    const { root, dir } = repo();
    try {
      writeTicketDefinition(dir);
      writeRoot(dir, [{ gate: 'ticket-create', ticket: 'T1' }]);
      writeSegment(dir, OURS, { branch: OUR_BRANCH, anchorSeq: 1, entries: p5Entries(dir) });

      const result = assertPhase('p5', { dir, ticket: 'T1', revision: REVISION, cwd: root });
      assert.deepEqual(result.errors ?? [], []);
      assert.equal(result.ok, true);
    } finally { clean(root); }
  });

  it('refuses when two committed segments both claim our branch, rather than reading past them', () => {
    const { root, dir } = repo();
    try {
      writeTicketDefinition(dir);
      writeRoot(dir, p5Entries(dir));
      writeSegment(dir, OURS, { branch: OUR_BRANCH, anchorSeq: 7, entries: [{ gate: 'noop' }] });
      writeSegment(dir, `ours-${ULID_LAST}.jsonl`, { branch: OUR_BRANCH, anchorSeq: 7, entries: [{ gate: 'noop' }] });

      const result = assertPhase('p5', { dir, ticket: 'T1', revision: REVISION, cwd: root });
      assert.equal(result.ok, false);
      assert.equal(result.skipped.some((s) => /cannot establish this checkout's own causal chain/.test(s.error)), true);
    } finally { clean(root); }
  });
});

describe('recordAcceptancePacket: binds our P5 revision, not a foreign segment\'s', () => {
  it('rejects P6 when only a foreign segment carries a p5-complete for the ticket', () => {
    const { root, dir } = repo();
    try {
      writeTicketDefinition(dir);
      writeRoot(dir, [{ gate: 'ticket-create', ticket: 'T1' }]);
      writeSegment(dir, THEIRS_LATER, {
        branch: OTHER_BRANCH,
        anchorSeq: 1,
        entries: p5Entries(dir),
      });
      const packet = join(dir, 'acceptance.md');
      writeFileSync(packet, '# acceptance fixture\n');

      const result = recordAcceptancePacket({ key: null, dir, ticket: 'T1', packet, cwd: root });
      assert.equal(result.ok, false);
      assert.equal(result.errors.some((e) => /P5 evidence is missing: no p5-complete for ticket T1/.test(e)), true);
      // And nothing was appended on the way to refusing.
      assert.equal(existsSync(join(dir, 'manifest.d', OURS)), false);
    } finally { clean(root); }
  });
});

// A CI checkout of a PR SHA is detached, which is where these gates actually
// run. recoverOpenSegment answers that case with `null` — the same value it
// uses for the benign "this branch has no segment yet" — so a reader that only
// catches would silently validate root-only evidence and ignore every segment
// (adversarial-review, distinct provider).
describe('a detached checkout refuses rather than validating root-only evidence', () => {
  function detach(root) {
    execFileSync('git', ['checkout', '-q', '--detach', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  }

  it('assertPhase p5 fails closed when HEAD is detached and committed segments exist', () => {
    const { root, dir } = repo();
    try {
      writeTicketDefinition(dir);
      const ours = p5Entries(dir);
      writeRoot(dir, ours);
      writeSegment(dir, THEIRS_LATER, { branch: OTHER_BRANCH, anchorSeq: ours.length, entries: [{ gate: 'noop' }] });
      detach(root);

      const result = assertPhase('p5', { dir, ticket: 'T1', revision: REVISION, cwd: root });
      assert.equal(result.ok, false);
      assert.equal(result.skipped.some((s) => /detached HEAD has no branch identity/.test(s.error)), true);
      // Distinctly, not only inside `skipped`: a caller reading that channel
      // alone cannot tell an identity refusal from an unparseable line, and
      // bin/adlc.mjs proved it by rendering the refusal as one.
      assert.match(result.identityError, /detached HEAD has no branch identity/);
    } finally { clean(root); }
  });

  // Driven through the REAL CLI, because the defect was in the rendering, not
  // the gate: `skipped` carried the refusal, bin/adlc.mjs counted that channel
  // as "malformed manifest lines: 1", and the operator of a detached CI
  // checkout was told the ledger was corrupt while the actionable sentence sat
  // unread in skipped[0].error.
  it('the CLI prints WHY it refused and does not call the refusal a malformed manifest line', () => {
    const { root, dir } = repo();
    try {
      writeTicketDefinition(dir);
      const ours = p5Entries(dir);
      writeRoot(dir, ours);
      writeSegment(dir, THEIRS_LATER, { branch: OTHER_BRANCH, anchorSeq: ours.length, entries: [{ gate: 'noop' }] });
      detach(root);

      const r = spawnSync(
        process.execPath,
        [BIN, 'run', 'p5', '--dir', dir, '--ticket', 'T1', '--revision', REVISION],
        { cwd: root, encoding: 'utf8' }
      );
      // Diagnostics only: the gate still fails closed on the identity refusal.
      assert.equal(r.status, 2, `expected exit 2 (gate fails closed), got ${r.status}\n${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /detached HEAD has no branch identity/);
      assert.doesNotMatch(r.stderr, /malformed manifest lines/);
    } finally { clean(root); }
  });

  // The refusal is appended to `skipped` AND returned as `identityError` (see
  // own-chain.mjs's contract), so a renderer that prints both channels says the
  // same sentence twice.
  it('says the refusal once, not once per channel', () => {
    const { root, dir } = repo();
    try {
      writeTicketDefinition(dir);
      const ours = p5Entries(dir);
      writeRoot(dir, ours);
      writeSegment(dir, THEIRS_LATER, { branch: OTHER_BRANCH, anchorSeq: ours.length, entries: [{ gate: 'noop' }] });
      detach(root);

      const r = spawnSync(
        process.execPath,
        [BIN, 'run', 'p5', '--dir', dir, '--ticket', 'T1', '--revision', REVISION],
        { cwd: root, encoding: 'utf8' }
      );
      const said = r.stderr.split('\n').filter((line) => line.includes('detached HEAD has no branch identity'));
      assert.equal(said.length, 1, `refusal printed ${said.length} times:\n${r.stderr}`);
    } finally { clean(root); }
  });

  it('recordAcceptancePacket says WHY it refused, not "P5 evidence is missing"', () => {
    const { root, dir } = repo();
    try {
      writeTicketDefinition(dir);
      writeRoot(dir, p5Entries(dir));
      writeSegment(dir, THEIRS_LATER, { branch: OTHER_BRANCH, anchorSeq: 7, entries: [{ gate: 'noop' }] });
      detach(root);
      const packet = join(dir, 'acceptance.md');
      writeFileSync(packet, '# acceptance fixture\n');

      const result = recordAcceptancePacket({ key: null, dir, ticket: 'T1', packet, cwd: root });
      assert.equal(result.ok, false);
      assert.equal(result.errors.some((e) => /cannot establish this checkout's own causal chain/.test(e)), true);
    } finally { clean(root); }
  });
});
