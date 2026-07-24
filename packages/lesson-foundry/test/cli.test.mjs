// CLI integration tests: exit-code contract (0/1/2) and --json stdout purity.
// Spawns the binary as a subprocess to verify the real contract that CI depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { clusterId, findingHash } from '../lib/route.mjs';

const BIN = resolve(new URL('../bin/lesson-foundry.mjs', import.meta.url).pathname);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'lesson-foundry-cli-test-'));
}

function writeLedger(dir, entries) {
  const adlcDir = join(dir, '.adlc');
  mkdirSync(adlcDir, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(adlcDir, 'findings.jsonl'), content, 'utf8');
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status };
}

// ---------------------------------------------------------------------------
// Exit 0: advisory pass (no findings, no --gate)
// ---------------------------------------------------------------------------
test('CLI exit 0: empty ledger with no --gate', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, []);
    const { code } = runCli([], dir);
    assert.strictEqual(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exit 0: clusters present but --gate not supplied', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, [
      { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check in database query' },
      { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check in database query' },
    ]);
    const { code } = runCli([], dir);
    assert.strictEqual(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exit 0: --gate passes when all clusters are banked', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, [
      { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check in database query' },
      { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check in database query' },
    ]);
    // Bank the cluster by emitting its real defense files first (this writes the
    // cluster's specific question into the interrogation template).
    const outDir = join(dir, '.adlc', 'lessons');
    const writeRes = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(writeRes.code, 0, `--write should succeed: ${writeRes.stderr}`);
    const { code } = runCli(['--gate', '--out-dir', outDir], dir);
    assert.strictEqual(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Exit 1: operational error (bad args, unreadable ledger path)
// ---------------------------------------------------------------------------
test('CLI exit 1: --min receives non-numeric argument', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, []);
    const { code } = runCli(['--min', 'abc'], dir);
    assert.strictEqual(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exit 1: --min zero is rejected', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, []);
    const { code } = runCli(['--min', '0'], dir);
    assert.strictEqual(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Exit 2: gate fails (unbanked clusters present with --gate)
// ---------------------------------------------------------------------------
test('CLI exit 2: --gate fails when recurring cluster has no defense file', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, [
      { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check in database query' },
      { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check in database query' },
    ]);
    const { code } = runCli(['--gate'], dir);
    assert.strictEqual(code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exit 2: --gate details reported to stderr (not stdout)', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, [
      { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check in query function' },
      { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check in query function' },
    ]);
    const { code, stderr } = runCli(['--gate'], dir);
    assert.strictEqual(code, 2);
    // Gate failure details go to stderr, not stdout
    assert(stderr.length > 0, 'stderr should contain gate failure message');
    assert(stderr.includes('unbanked') || stderr.includes('lesson'), `stderr should mention unbanked: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --json: stdout must be valid JSON, no contamination
// ---------------------------------------------------------------------------
test('CLI --json: stdout is valid JSON (no extra text)', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, [
      { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check in database query' },
      { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check in database query' },
    ]);
    const { code, stdout } = runCli(['--json'], dir);
    assert.strictEqual(code, 0);
    // stdout must parse cleanly — this is the machine-readable contract
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(stdout); }, `stdout must be valid JSON; got: ${stdout.slice(0, 200)}`);
    assert(typeof parsed === 'object' && parsed !== null);
    assert(Array.isArray(parsed.clusters));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --json: empty ledger produces valid JSON with empty clusters', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, []);
    const { code, stdout } = runCli(['--json'], dir);
    assert.strictEqual(code, 0);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(stdout); }, `stdout must be valid JSON; got: ${stdout.slice(0, 200)}`);
    assert.deepStrictEqual(parsed.clusters, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --json: no "done" message or human text in stdout', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, []);
    const { stdout } = runCli(['--json'], dir);
    // The bug was "lesson-foundry: done." appended after the JSON
    assert(!stdout.includes('lesson-foundry: done.'), 'stdout must not contain pass() message');
    assert(!stdout.includes('Clusters:'), 'stdout must not contain human report header');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --json --gate: exit 2 with valid JSON gate result when unbanked', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, [
      { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check in database query' },
      { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check in database query' },
    ]);
    const { code, stdout } = runCli(['--json', '--gate'], dir);
    assert.strictEqual(code, 2);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(stdout); }, `stdout must be valid JSON even on exit 2; got: ${stdout.slice(0, 200)}`);
    assert(parsed.gate !== null, 'gate field should be present');
    assert.strictEqual(parsed.gate.pass, false);
    assert(Array.isArray(parsed.gate.unbanked));
    assert(parsed.gate.unbanked.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F3 regression: --write must be idempotent for the interrogation template.
// Two identical runs must NOT duplicate the spec-gap question.
// ---------------------------------------------------------------------------
test('CLI --write: repeated runs do not duplicate interrogation questions', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, [
      { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check in database query' },
      { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check in database query' },
    ]);
    const outDir = join(dir, '.adlc', 'lessons');

    const first = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(first.code, 0, `first --write should pass: ${first.stderr}`);
    const second = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(second.code, 0, `second --write should pass: ${second.stderr}`);

    const template = readFileSync(join(outDir, 'interrogation-template.md'), 'utf8');
    const marker = 'cluster: missing-null-check-in-database-query';
    const occurrences = template.split(marker).length - 1;
    assert.strictEqual(occurrences, 1, `question should appear exactly once, found ${occurrences}:\n${template}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --write: a cluster GAINING a finding does not re-append its question (round-13)', () => {
  // The realistic lifecycle for a now-durable, append-only ledger: an already-distilled
  // cluster gains another occurrence. The occurrence count and member list both change, but
  // the cluster-id (founding occurrence) does not. Dedup must key on that stable id, or the
  // changed member suffix makes the prior question unrecognizable and it is duplicated.
  const dir = makeTempDir();
  try {
    const outDir = join(dir, '.adlc', 'lessons');
    writeLedger(dir, [
      { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check in database query' },
      { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check in database query' },
    ]);
    const first = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(first.code, 0, `first --write should pass: ${first.stderr}`);

    // A THIRD occurrence joins the SAME cluster (same desc) — count 2→3, members grow.
    writeLedger(dir, [
      { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check in database query' },
      { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check in database query' },
      { ts: '2025-01-03', tool: 'test', file: 'c.mjs', line: 3, category: 'security', severity: 'high', desc: 'missing null check in database query' },
    ]);
    const second = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(second.code, 0, `second --write should pass: ${second.stderr}`);

    const template = readFileSync(join(outDir, 'interrogation-template.md'), 'utf8');
    const marker = 'cluster: missing-null-check-in-database-query';
    const occurrences = template.split(marker).length - 1;
    assert.strictEqual(occurrences, 1, `a grown cluster must not duplicate its question, found ${occurrences}:\n${template}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --write: an out-of-order merge introducing an OLDER member does not re-append (round-14)', () => {
  // Now that the ledger is tracked in git, a branch merge can introduce an occurrence with
  // an EARLIER timestamp than the current founding member. That changes cluster-id (which is
  // derived from the founding occurrence), so cluster-id dedup would treat the cluster as new
  // and re-append its question. Member-overlap dedup — the same identity banking uses —
  // survives it, because the merge does not remove the members already covered.
  const dir = makeTempDir();
  try {
    const outDir = join(dir, '.adlc', 'lessons');
    const desc = 'unchecked array index in the token parser';
    writeLedger(dir, [
      { ts: '2025-06-02', tool: 'test', file: 'a.mjs', line: 1, category: 'correctness', severity: 'high', desc },
      { ts: '2025-06-03', tool: 'test', file: 'b.mjs', line: 2, category: 'correctness', severity: 'high', desc },
    ]);
    const first = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(first.code, 0, `first --write should pass: ${first.stderr}`);

    // A merge brings in an OLDER occurrence (earliest ts) — the founding member, and thus
    // cluster-id, changes; the member set still overlaps the original two.
    writeLedger(dir, [
      { ts: '2025-06-01', tool: 'test', file: 'z.mjs', line: 9, category: 'correctness', severity: 'high', desc },
      { ts: '2025-06-02', tool: 'test', file: 'a.mjs', line: 1, category: 'correctness', severity: 'high', desc },
      { ts: '2025-06-03', tool: 'test', file: 'b.mjs', line: 2, category: 'correctness', severity: 'high', desc },
    ]);
    const second = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(second.code, 0, `second --write should pass: ${second.stderr}`);

    const template = readFileSync(join(outDir, 'interrogation-template.md'), 'utf8');
    const marker = 'cluster: unchecked-array-index-in-the-token-parser';
    const occurrences = template.split(marker).length - 1;
    assert.strictEqual(occurrences, 1, `an out-of-order merge must not duplicate the question, found ${occurrences}:\n${template}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --write: a FUSED cluster whose uncovered members form a subcluster still gets a question (round-15)', () => {
  // A prior lesson covers only PART of a recurring cluster; the uncovered members form their
  // own recurring subcluster, so the gate deems the cluster UNBANKED (coverage invariant).
  // The write path must still emit the cluster's question even though its members overlap the
  // partially-covering one — the earlier overlap dedup suppressed it, leaving --gate failing
  // forever (adversarial-review round-15).
  const dir = makeTempDir();
  try {
    const outDir = join(dir, '.adlc', 'lessons');
    mkdirSync(outDir, { recursive: true });
    const findings = [
      { ts: '2025-07-01', tool: 'test', file: 'a.mjs', line: 1, category: 'correctness', severity: 'high', desc: 'off-by-one in the ring buffer index' },
      { ts: '2025-07-02', tool: 'test', file: 'b.mjs', line: 2, category: 'correctness', severity: 'high', desc: 'off-by-one in the ring buffer index' },
      { ts: '2025-07-03', tool: 'test', file: 'c.mjs', line: 3, category: 'correctness', severity: 'high', desc: 'off-by-one in the ring buffer index' },
      { ts: '2025-07-04', tool: 'test', file: 'd.mjs', line: 4, category: 'correctness', severity: 'high', desc: 'off-by-one in the ring buffer index' },
    ];
    writeLedger(dir, findings);

    // Pre-seed the template with a lesson covering only TWO of the four members. The other
    // two remain uncovered and (same pattern) recluster — the coverage invariant fires.
    const h = findings.map((f) => findingHash(f).slice(0, 12));
    writeFileSync(
      join(outDir, 'interrogation-template.md'),
      `# Interrogation Template\n\n- [ ] **[correctness]** partially covered *(recurring in 2 findings, cluster: partial, cluster-id: deadbeefdead, cluster-members: ${h[0]} ${h[1]})*\n`,
      'utf8',
    );

    const r = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(r.code, 0, `--write should pass: ${r.stderr}`);

    const template = readFileSync(join(outDir, 'interrogation-template.md'), 'utf8');
    const fullId = clusterId(findings);
    assert.ok(
      template.includes(`cluster-id: ${fullId}`),
      `the unbanked fused cluster's question must be emitted despite overlapping the partial lesson:\n${template}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --json --gate: exit 0 with valid JSON when all banked', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, [
      { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check in database query' },
      { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check in database query' },
    ]);
    const outDir = join(dir, '.adlc', 'lessons');
    // Emit real defenses first so the cluster's question is actually banked.
    const writeRes = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(writeRes.code, 0, `--write should succeed: ${writeRes.stderr}`);
    const { code, stdout } = runCli(['--json', '--gate', '--out-dir', outDir], dir);
    assert.strictEqual(code, 0);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(stdout); });
    assert.strictEqual(parsed.gate.pass, true);
    assert.deepStrictEqual(parsed.gate.unbanked, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
