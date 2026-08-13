// Concern: bin/adlc-prosecute.mjs record-cross-model unknown-ticket refusal
// (#485 / T-01KZW6ENFHCJJX873C5J35835Q), end-to-end at the process boundary.
//
// The defect this pins: record-cross-model accepted any string as --ticket, so a
// typo'd id wrote a signed, PERMANENT attestation (the manifest is append-only)
// that satisfied the gate for no ticket — the forest-cutover seal census carries
// the incident pair, one dropped character apart. The record path must resolve
// --ticket against the canonical ticket store and refuse (exit 2, near-miss ids
// listed) before anything is appended, on BOTH write paths. Store-external ids
// are recorded deliberately via --allow-unknown-ticket; a repo with NO store
// records freely; a store that exists but cannot be resolved is an operational
// error (exit 1), never treated as absent.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ticketFilename } from '@adlc/tickets';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

// The real ids from the recorded incident (issue #485): the typo drops one character.
const REAL_ID = 'T-01KZGT27XAN6C767VRP1T32Z60';
const TYPO_ID = 'T-01KZGT27XA6C767VRP1T32Z60';

process.env.ADLC_MANIFEST_KEY = 'test-unknown-ticket-signing-key';

function runBin(args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// A scratch git repo; `tickets` seeds a legacy canonical store at .adlc/tickets.json,
// null seeds NO store at all.
function repoWithStore(tickets) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-unknown-ticket-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  if (tickets !== null) {
    writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({
      tickets: tickets.map((id) => ({ id, title: `Fixture ${id}`, scope: [], rails: [], edges: [] })),
    }));
  }
  return dir;
}

function manifestLines(dir) {
  const path = join(dir, '.adlc', 'manifest.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

// Fresh-record invocation with an explicit revision (skips revision resolution and
// the untracked-tree refusal, so the case under test is purely the ticket check).
const record = (ticket, ...extra) => [
  'record-cross-model', '--ticket', ticket, '--provider', 'openai',
  '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', '.adlc', ...extra,
];

describe('record-cross-model unknown-ticket refusal (#485)', () => {
  it('AC1: an unknown id refuses with exit 2 and writes nothing', () => {
    const dir = repoWithStore(['T1']);
    const r = runBin(record('T-DOES-NOT-EXIST'), dir);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(manifestLines(dir).length, 0, 'the manifest must gain no entry');
    assert.match(r.stderr, /T-DOES-NOT-EXIST/);
    assert.match(r.stderr, /does not exist in the canonical ticket store/);
    assert.match(r.stderr, /--allow-unknown-ticket/);
  });

  it('AC2: the incident typo surfaces the real id as a near-miss', () => {
    const dir = repoWithStore(['T1', REAL_ID]);
    const r = runBin(record(TYPO_ID), dir);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Near-miss store id\(s\):/);
    assert.ok(r.stderr.includes(REAL_ID), `the real id must be suggested: ${r.stderr}`);
    assert.equal(manifestLines(dir).length, 0);
  });

  it('a far-off id gets no near-miss section (the suggestion is a match, not a constant)', () => {
    const dir = repoWithStore(['T1', REAL_ID]);
    const r = runBin(record('COMPLETELY-UNRELATED-ID-99'), dir);
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stderr, /Near-miss/);
  });

  it('suggestions include distance-2 ids, exclude distance-3, and cap at five', () => {
    // T-AAAA00 .. T-AAAA09: all distance ≤ 2 from T-AAAAXX except none — build
    // deliberately: 7 ids at distance 2, 1 id at distance 3.
    const twoOff = Array.from({ length: 7 }, (_, i) => `T-AAAA${i}Z`); // vs T-AAAAXX: 2 substitutions
    const threeOff = 'T-AABBBZ'; // 3 substitutions away
    const dir = repoWithStore([...twoOff, threeOff]);
    const r = runBin(record('T-AAAAXX'), dir);
    assert.equal(r.status, 2);
    const suggested = twoOff.filter((id) => r.stderr.includes(id));
    assert.equal(suggested.length, 5, `exactly five suggestions, got ${suggested.length}: ${r.stderr}`);
    assert.ok(!r.stderr.includes(threeOff), 'distance-3 ids are not suggestions');
  });

  it('AC3: --allow-unknown-ticket records a store-external id deliberately', () => {
    const dir = repoWithStore(['T1']);
    const r = runBin(record('359', '--allow-unknown-ticket'), dir);
    assert.equal(r.status, 0, r.stderr);
    const lines = manifestLines(dir);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).ticket, '359');
  });

  it('AC4: a known id records exactly as before, no flag needed', () => {
    const dir = repoWithStore(['T1']);
    const r = runBin(record('T1'), dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(manifestLines(dir).length, 1);
    assert.match(r.stdout, /recorded cross-model approve for T1/);
  });

  it('outside any git repository with no store, records freely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-no-git-'));
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const r = runBin(record('ANY-ID'), dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no canonical ticket store/);
    assert.equal(manifestLines(dir).length, 1);
  });

  it('a store in a NON-git directory still validates ids (not-a-repo is not store absence)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-no-git-store-'));
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({
      tickets: [{ id: 'T1', title: 'Fixture T1', scope: [], rails: [], edges: [] }],
    }));
    const denied = runBin(record('T-DOES-NOT-EXIST'), dir);
    assert.equal(denied.status, 2, denied.stderr);
    assert.equal(manifestLines(dir).length, 0);
    const allowed = runBin(record('T1'), dir);
    assert.equal(allowed.status, 0, allowed.stderr);
  });

  it('a partially materialised SHARDED store still validates ids tracked at HEAD', () => {
    // Directory backend: the marker and one shard are materialised, the shard
    // for the id being recorded is skip-worktree'd away. The worktree store is
    // "present" with a partial id set — the HEAD union must still accept the
    // tracked id, while a genuinely unknown id still refuses.
    const dir = repoWithStore(null);
    const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const ticketsDir = join(dir, '.adlc', 'tickets');
    mkdirSync(ticketsDir, { recursive: true });
    writeFileSync(join(ticketsDir, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    writeFileSync(join(ticketsDir, ticketFilename('T1')), JSON.stringify({ id: 'T1', title: 'Fixture T1', scope: [], rails: [], edges: [] }));
    writeFileSync(join(ticketsDir, ticketFilename('T2')), JSON.stringify({ id: 'T2', title: 'Fixture T2', scope: [], rails: [], edges: [] }));
    g('add', '-A');
    g('commit', '-qm', 'sharded store');
    const t2Shard = join('.adlc', 'tickets', ticketFilename('T2'));
    g('update-index', '--skip-worktree', t2Shard);
    rmSync(join(dir, t2Shard));

    const allowed = runBin(record('T2'), dir);
    assert.equal(allowed.status, 0, `HEAD-tracked shard id must be accepted: ${allowed.stderr}`);

    const denied = runBin(record('T-DOES-NOT-EXIST'), dir);
    assert.equal(denied.status, 2, denied.stderr);
  });

  it('an UNCOMMITTED shard archive makes the id unknown — HEAD must not resurrect it', () => {
    // No skip-worktree bit anywhere: the worktree store loaded successfully and
    // is authoritative. T2's shard was deliberately removed (an archive/prune
    // in progress); recording against T2 must refuse even though HEAD still
    // tracks the shard.
    const dir = repoWithStore(null);
    const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const ticketsDir = join(dir, '.adlc', 'tickets');
    mkdirSync(ticketsDir, { recursive: true });
    writeFileSync(join(ticketsDir, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    writeFileSync(join(ticketsDir, ticketFilename('T1')), JSON.stringify({ id: 'T1', title: 'Fixture T1', scope: [], rails: [], edges: [] }));
    writeFileSync(join(ticketsDir, ticketFilename('T2')), JSON.stringify({ id: 'T2', title: 'Fixture T2', scope: [], rails: [], edges: [] }));
    g('add', '-A');
    g('commit', '-qm', 'sharded store');
    rmSync(join(ticketsDir, ticketFilename('T2'))); // plain uncommitted removal

    const denied = runBin(record('T2'), dir);
    assert.equal(denied.status, 2, `an archived-but-uncommitted id must be unknown: ${denied.stdout}`);
    assert.equal(manifestLines(dir).length, 0);

    const allowed = runBin(record('T1'), dir);
    assert.equal(allowed.status, 0, allowed.stderr);
  });

  it('a plain uncommitted deletion of the WHOLE store still validates against HEAD (garbage refused)', () => {
    const dir = repoWithStore(['T1']);
    const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    g('add', '-A');
    g('commit', '-qm', 'store');
    rmSync(join(dir, '.adlc', 'tickets.json'));

    const denied = runBin(record('T-DOES-NOT-EXIST'), dir);
    assert.equal(denied.status, 2, denied.stderr);
    const allowed = runBin(record('T1'), dir);
    assert.equal(allowed.status, 0, allowed.stderr);
  });

  it('a 128-status git failure that is NOT "not a repository" also fails closed', () => {
    // A malformed .git/config makes every git command exit 128 with a "bad
    // config" message. That establishes nothing about store absence — only the
    // specific not-a-repository verdict may proceed to cwd-based detection.
    const dir = repoWithStore(['T1']);
    appendFileSync(join(dir, '.git', 'config'), '\n[core\n');
    const r = runBin(record('T-DOES-NOT-EXIST'), dir);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /git discovery failed/);
    assert.equal(manifestLines(dir).length, 0);
  });

  it('an operational git failure fails closed, never as "no store"', () => {
    // git unresolvable on PATH: repoRoot() throws ENOENT, which proves nothing
    // about store absence. The refusal must be exit 1 with nothing written —
    // treating it as absent would recreate the permanent-typo write.
    const dir = repoWithStore(['T1']);
    const nodeDir = mkdtempSync(join(tmpdir(), 'adlc-nogit-path-'));
    const r = runBin(record('T-DOES-NOT-EXIST'), dir, { PATH: nodeDir });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /git discovery failed/);
    assert.equal(manifestLines(dir).length, 0);
  });

  it('a repo with commits but no tracked store anywhere is genuinely absent — records freely', () => {
    // Exercises the HEAD-tree STORE_NOT_FOUND branch (the fixtures above either
    // have a worktree store or no commits at all): worktree absent AND HEAD
    // tracks no store → absent, note, record proceeds. An inverted or flipped
    // branch either refuses (exit 2) or op-errors (exit 1) here.
    const dir = repoWithStore(null);
    const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    writeFileSync(join(dir, 'README.md'), 'fixture\n');
    g('add', 'README.md');
    g('commit', '-qm', 'no store here');
    const r = runBin(record('ANY-ID'), dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no canonical ticket store/);
    assert.equal(manifestLines(dir).length, 1);
  });

  it('AC5: a repo with no ticket store records freely, with a note on stderr', () => {
    const dir = repoWithStore(null);
    const r = runBin(record('ANY-ID-AT-ALL'), dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no canonical ticket store/);
    assert.equal(manifestLines(dir).length, 1);
  });

  it('the absent-store note never corrupts --json stdout (exactly one JSON document)', () => {
    const dir = repoWithStore(null);
    const r = runBin(record('ANY-ID-AT-ALL', '--json'), dir);
    assert.equal(r.status, 0, r.stderr);
    // JSON.parse over the WHOLE stream: a prose note on stdout would throw here.
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ticket, 'ANY-ID-AT-ALL');
    assert.match(r.stderr, /no canonical ticket store/);
  });

  it('a tracked store hidden by skip-worktree still validates ids (worktree absence is not store absence)', () => {
    const dir = repoWithStore(['T1']);
    const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    g('add', '-A');
    g('commit', '-qm', 'store');
    g('update-index', '--skip-worktree', '.adlc/tickets.json');
    rmSync(join(dir, '.adlc', 'tickets.json'));

    const denied = runBin(record('T-DOES-NOT-EXIST'), dir);
    assert.equal(denied.status, 2, `HEAD's tracked store must still gate: ${denied.stderr}`);
    assert.match(denied.stderr, /does not exist in the canonical ticket store/);

    const allowed = runBin(record('T1'), dir);
    assert.equal(allowed.status, 0, allowed.stderr);
  });

  it('a PRESENT but EMPTY store makes every id unknown (empty is not absent)', () => {
    const dir = repoWithStore([]);
    const r = runBin(record('T1'), dir);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(manifestLines(dir).length, 0);
  });

  it('AC6: an unresolvable (ambiguous dual) store is an operational error, exit 1', () => {
    const dir = repoWithStore(['T1']);
    // A directory store alongside the legacy file — the ambiguous shape the
    // loader refuses. The refusal must not be misread as "store absent".
    mkdirSync(join(dir, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets', '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    const r = runBin(record('T1'), dir);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /cannot be read to validate --ticket/);
    assert.equal(manifestLines(dir).length, 0);
  });

  it('AC7: the carry-forward path refuses an unknown id before any chain inspection', () => {
    const dir = repoWithStore(['T1']);
    const r = runBin(['record-cross-model', '--ticket', 'T-DOES-NOT-EXIST', '--carry-forward', 'git-change:a:b', '--revision', 'r', '--dir', '.adlc'], dir);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /does not exist in the canonical ticket store/);
    assert.equal(manifestLines(dir).length, 0);
  });

  it('AC7 control: --allow-unknown-ticket reaches carry-forward\'s own refusal, not the store check', () => {
    const dir = repoWithStore(['T1']);
    const r = runBin(['record-cross-model', '--ticket', 'T-DOES-NOT-EXIST', '--carry-forward', 'git-change:a:b', '--revision', 'r', '--dir', '.adlc', '--allow-unknown-ticket'], dir);
    assert.notEqual(r.status, 2, 'the store check must be skipped');
    assert.doesNotMatch(r.stderr, /does not exist in the canonical ticket store/);
  });

  it('validation anchors to the --dir target workspace, not the caller\'s checkout', () => {
    // Controller (cwd) has NO store; worker (--dir target) has [T1]. The id
    // must be judged against the WORKER's store: T1 records into the worker
    // ledger, an unknown id refuses, and a caller-side absent store never
    // makes the check vacuous.
    const worker = repoWithStore(['T1']);
    const controller = mkdtempSync(join(tmpdir(), 'adlc-controller-'));
    const workerDir = join(worker, '.adlc');

    const denied = runBin(['record-cross-model', '--ticket', 'T-DOES-NOT-EXIST', '--provider', 'openai',
      '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', workerDir], controller);
    assert.equal(denied.status, 2, `the worker store must gate: ${denied.stdout}`);
    assert.equal(manifestLines(worker).length, 0);

    const allowed = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai',
      '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', workerDir], controller);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(manifestLines(worker).length, 1);
  });

  it('an id known only to the CALLER\'s store does not pass for a foreign --dir target', () => {
    const worker = repoWithStore(['T1']);
    const controller = repoWithStore(['T-CONTROLLER-ONLY']);
    const r = runBin(['record-cross-model', '--ticket', 'T-CONTROLLER-ONLY', '--provider', 'openai',
      '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', join(worker, '.adlc')], controller);
    assert.equal(r.status, 2, `the target workspace's store is the authority: ${r.stdout}`);
    assert.equal(manifestLines(worker).length, 0);
  });

  it('a symlinked --dir validates against the link TARGET\'s workspace, where the entry lands', () => {
    // controller/ledger-link → worker/.adlc. A controller-only id must not be
    // recordable into the worker's manifest through the link; the worker's own
    // ids must still record.
    const worker = repoWithStore(['T1']);
    const controller = repoWithStore(['T-CONTROLLER-ONLY']);
    const link = join(controller, 'ledger-link');
    symlinkSync(join(worker, '.adlc'), link);

    const argsFor = (ticket) => ['record-cross-model', '--ticket', ticket, '--provider', 'openai',
      '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', link];

    const denied = runBin(argsFor('T-CONTROLLER-ONLY'), controller);
    assert.equal(denied.status, 2, `the link target's store is the authority: ${denied.stdout}`);
    assert.equal(manifestLines(worker).length, 0);

    const allowed = runBin(argsFor('T1'), controller);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(manifestLines(worker).length, 1);
  });

  it('a custom --dir workspace validates against its own tickets.json (the tiering contract)', () => {
    // No canonical .adlc store at all; the workspace is `custom/` with its own
    // tickets.json — the same table loadTicketsForTier unions for tiering.
    const dir = repoWithStore(null);
    rmSync(join(dir, '.adlc'), { recursive: true, force: true });
    mkdirSync(join(dir, 'custom'), { recursive: true });
    writeFileSync(join(dir, 'custom', 'tickets.json'), JSON.stringify({
      tickets: [{ id: 'T1', title: 'Fixture T1', scope: [], rails: [], edges: [] }],
    }));
    const argsFor = (ticket) => ['record-cross-model', '--ticket', ticket, '--provider', 'openai',
      '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', 'custom'];

    const denied = runBin(argsFor('T-DOES-NOT-EXIST'), dir);
    assert.equal(denied.status, 2, `the custom workspace's table must gate: ${denied.stdout}`);

    const allowed = runBin(argsFor('T1'), dir);
    assert.equal(allowed.status, 0, allowed.stderr);
    const lines = readFileSync(join(dir, 'custom', 'manifest.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 1);
  });

  it('one sparse shard must not resurrect a DIFFERENT, ordinarily deleted shard from HEAD', () => {
    // T3's shard is skip-worktree'd (deliberately unmaterialised); T2's shard
    // is plainly deleted (an uncommitted archive). T3 records via the per-shard
    // HEAD overlay; T2 stays unknown — all-of-HEAD union would resurrect it.
    const dir = repoWithStore(null);
    const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const ticketsDir = join(dir, '.adlc', 'tickets');
    mkdirSync(ticketsDir, { recursive: true });
    writeFileSync(join(ticketsDir, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    for (const id of ['T1', 'T2', 'T3']) {
      writeFileSync(join(ticketsDir, ticketFilename(id)), JSON.stringify({ id, title: `Fixture ${id}`, scope: [], rails: [], edges: [] }));
    }
    g('add', '-A');
    g('commit', '-qm', 'sharded store');
    const t3Shard = join('.adlc', 'tickets', ticketFilename('T3'));
    g('update-index', '--skip-worktree', t3Shard);
    rmSync(join(dir, t3Shard));
    rmSync(join(dir, '.adlc', 'tickets', ticketFilename('T2'))); // plain uncommitted removal

    const sparse = runBin(record('T3'), dir);
    assert.equal(sparse.status, 0, `the sparse shard's own id must record: ${sparse.stderr}`);

    const archived = runBin(record('T2'), dir);
    assert.equal(archived.status, 2, `the deleted shard's id must stay unknown: ${archived.stdout}`);
  });

  it('a not-yet-created --dir anchors through its parent (unknown id refused, not op-errored)', () => {
    // realpath of a nonexistent leaf is ENOENT — the parent chain is
    // canonicalized instead, and validation proceeds against the repo store.
    // Treating the ENOENT itself as fatal would op-error (1) before the
    // refusal (2) this case must produce.
    const dir = repoWithStore(['T1']);
    const r = runBin(['record-cross-model', '--ticket', 'T-DOES-NOT-EXIST', '--provider', 'openai',
      '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', 'fresh-ledger'], dir);
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /does not exist in the canonical ticket store/);
  });

  it('a MULTI-LEVEL absent --dir anchors through the nearest existing ancestor', () => {
    // The manifest writers create directories recursively — validation must
    // not fail on `artifacts/<run-id>/.adlc`-style per-run ledgers whose
    // parents do not exist yet.
    const dir = repoWithStore(['T1']);
    const argsFor = (ticket) => ['record-cross-model', '--ticket', ticket, '--provider', 'openai',
      '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', 'deep/nested/ledger'];

    const denied = runBin(argsFor('T-DOES-NOT-EXIST'), dir);
    assert.equal(denied.status, 2, `${denied.stdout}${denied.stderr}`);

    const allowed = runBin(argsFor('T1'), dir);
    assert.equal(allowed.status, 0, `recording into a to-be-created nested ledger must work: ${allowed.stderr}`);
  });

  it('--dir . (ledger at the repo root) validates against THAT repo\'s store', () => {
    // Discovery must not escape to whatever contains the repository: the
    // canonical ledger dir itself is the discovery start.
    const dir = repoWithStore(['T1']);
    const argsFor = (ticket) => ['record-cross-model', '--ticket', ticket, '--provider', 'openai',
      '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', '.'];

    const denied = runBin(argsFor('T-GHOST'), dir);
    assert.equal(denied.status, 2, `the repo's own store must gate --dir .: ${denied.stdout}`);

    const allowed = runBin(argsFor('T1'), dir);
    assert.equal(allowed.status, 0, allowed.stderr);
    const lines = readFileSync(join(dir, 'manifest.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 1);
  });

  it('a malformed record never coerces into a matchable ghost id like "undefined"', () => {
    const dir = repoWithStore(null);
    rmSync(join(dir, '.adlc'), { recursive: true, force: true });
    mkdirSync(join(dir, 'custom'), { recursive: true });
    writeFileSync(join(dir, 'custom', 'tickets.json'), JSON.stringify({
      tickets: [{}, { id: 'T1', title: 'Fixture T1', scope: [], rails: [], edges: [] }],
    }));
    const argsFor = (ticket) => ['record-cross-model', '--ticket', ticket, '--provider', 'openai',
      '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'r', '--dir', 'custom'];

    const ghost = runBin(argsFor('undefined'), dir);
    assert.equal(ghost.status, 2, `String-coerced ids must not match: ${ghost.stdout}`);

    const allowed = runBin(argsFor('T1'), dir);
    assert.equal(allowed.status, 0, allowed.stderr);
  });

  it('an operational HEAD-resolution failure fails closed, never as "unborn repo"', () => {
    // A git shim that passes everything through EXCEPT `rev-parse --verify
    // --quiet HEAD`, which it fails with exit 128 (an operational error, NOT
    // the exit-1 "no such ref" of an unborn repository). With the worktree
    // store deleted, treating that as unborn would accept any id.
    const dir = repoWithStore(['T1']);
    const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    g('add', '-A');
    g('commit', '-qm', 'store');
    rmSync(join(dir, '.adlc', 'tickets.json'));

    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), 'git-shim-'));
    writeFileSync(join(shimDir, 'git'), [
      '#!/bin/sh',
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$3" = "--quiet" ] && [ "$4" = "HEAD" ]; then',
      '  echo "fatal: fixture operational failure" >&2',
      '  exit 128',
      'fi',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });

    const r = runBin(record('T-DOES-NOT-EXIST'), dir, { PATH: `${shimDir}:${process.env.PATH}` });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /could not resolve HEAD/);
    assert.equal(manifestLines(dir).length, 0);
  });

  it('AC8: --help documents --allow-unknown-ticket', () => {
    const dir = repoWithStore(null);
    const r = runBin(['--help'], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--allow-unknown-ticket/);
  });
});
