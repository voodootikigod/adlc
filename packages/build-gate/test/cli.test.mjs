// test/cli.test.mjs — end-to-end exercise of the build-gate CLI: exit codes,
// --json output, and the audited-override recording path via the real
// manifest ledger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PKG_ROOT, 'bin', 'build-gate.mjs');
const README = join(PKG_ROOT, 'README.md');
const SITE_PAGE = join(PKG_ROOT, '..', '..', 'apps', 'docs', 'content', 'docs', 'toolkit', 'build-gate.mdx');

function run(args, { cwd, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function withTicketRepo(tickets, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-build-gate-cli-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('--help exits 0 and prints usage', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /build-gate/);
});

test('missing ticket id → operational error, exit 1', () => {
  withTicketRepo([{ id: 'T1', title: 'x' }], (dir) => {
    const r = run([], { cwd: dir });
    assert.equal(r.code, 1);
  });
});

test('unknown ticket id → operational error, exit 1', () => {
  withTicketRepo([{ id: 'T1', title: 'x' }], (dir) => {
    const r = run(['T404'], { cwd: dir });
    assert.equal(r.code, 1);
  });
});

test('normal-risk ticket, deep session → allow, exit 0', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'feature' }], (dir) => {
    const r = run(['T1', '--depth', '999', '--json'], { cwd: dir });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'allow');
    assert.equal(out.riskTier, 'normal');
  });
});

// ---- fail closed on a malformed (non-array) scope/rails field, instead of
// crashing with an uncaught TypeError (issue #48 review round 3 finding) ----

test('non-array scope field → strict store validation fails closed as an operational error', () => {
  withTicketRepo([{ id: 'T1', title: 'x', scope: 42 }], (dir) => {
    const r = run(['T1', '--depth', '999', '--json'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /scope must be an array of strings/);
  });
});

test('non-array rails field → strict store validation fails closed as an operational error', () => {
  withTicketRepo([{ id: 'T1', title: 'x', rails: { foo: 'bar' } }], (dir) => {
    const r = run(['T1', '--depth', '999', '--json'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /rails must be an array of strings/);
  });
});

test('high-risk ticket (contract), shallow session → allow, exit 0', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const r = run(['T1', '--depth', '1', '--json'], { cwd: dir });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'allow');
    assert.equal(out.riskTier, 'high');
  });
});

test('high-risk ticket (contract), deep session, no bypass → DENY, exit 2', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const r = run(['T1', '--depth', '999', '--json'], { cwd: dir });
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'deny');
  });
});

test('--depth past --depth-threshold triggers deny; below a raised threshold allows', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const deny = run(['T1', '--depth', '50', '--json'], { cwd: dir });
    assert.equal(deny.code, 2);
    const allow = run(['T1', '--depth', '50', '--depth-threshold', '100', '--json'], { cwd: dir });
    assert.equal(allow.code, 0);
  });
});

test('--session-bytes past --bytes-threshold triggers deny', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const r = run(['T1', '--session-bytes', '500000', '--bytes-threshold', '100', '--json'], { cwd: dir });
    assert.equal(r.code, 2);
  });
});

test('the --bytes-threshold DEFAULT (no flag passed) is the recalibrated 8 MiB, matching every host hook (Round-5)', () => {
  // Before this fix, the CLI's own default silently stayed at the old,
  // uncalibrated 256 KiB (packages/build-gate/lib/depth-signal.mjs's own
  // DEFAULT_BYTES_THRESHOLD, frozen by ticket T156) even after every host
  // hook's own copy was recalibrated — so a caller running this CLI
  // directly (rather than through a host hook) still denied the exact
  // routine session the hooks now correctly allow.
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    // A routine fresh-session-sized transcript: well over the OLD 256 KiB
    // threshold, comfortably under the new 8 MiB one.
    const routine = run(['T1', '--session-bytes', String(400 * 1024), '--json'], { cwd: dir });
    assert.equal(routine.code, 0, routine.stdout || routine.stderr);
    const genuinelyOversized = run(['T1', '--session-bytes', String(9 * 1024 * 1024), '--json'], { cwd: dir });
    assert.equal(genuinelyOversized.code, 2);
  });
});

test('--help documents the recalibrated 8 MiB default, not the frozen library default', () => {
  const r = run(['--help']);
  assert.match(r.stdout, /--bytes-threshold <n>\s+default 8388608/);
});

/**
 * Pull the Default cell out of a `| flag | default | description |` row in a
 * markdown flag table. Scans the whole document instead of anchoring on a
 * heading, because the package README and the docs-site page keep the same
 * table under different headings. Asserting a single match is what makes a
 * row rename or a duplicated table a failure rather than a silent skip.
 */
function flagDefaultCell(markdown, flag) {
  const rows = markdown
    .split('\n')
    .map((line) => line.split('|').map((cell) => cell.trim().replace(/`/g, '')))
    .filter((cells) => cells.length >= 4 && cells[1].startsWith(flag));
  assert.equal(rows.length, 1, `expected exactly one \`${flag}\` flag-table row, found ${rows.length}`);
  return rows[0][2];
}

test('the documented --bytes-threshold default is the number the binary actually prints', () => {
  // The README is what npmjs.com renders for an installing operator, and it
  // carried the frozen library default (262144) long after the CLI's own flag
  // default was recalibrated to 8 MiB — documenting a gate 32x more sensitive
  // than the shipped one, in the silent-green direction. Both sides are read
  // at runtime and compared, rather than the README being pinned to a literal
  // here, so drift fails whichever side moves.
  const help = run(['--help']);
  assert.equal(help.code, 0);
  const printed = help.stdout.match(/--bytes-threshold <n>\s+default (\d+)/);
  assert.ok(printed, '--help must print a numeric --bytes-threshold default');
  const shipped = printed[1];

  // The default cell must LEAD with the number; trailing prose ("8388608
  // (8 MiB)") is free to be reworded without failing this test.
  const readmeCell = flagDefaultCell(readFileSync(README, 'utf8'), '--bytes-threshold');
  assert.equal(
    readmeCell.match(/\d+/)?.[0],
    shipped,
    `README --bytes-threshold row says "${readmeCell}"; --help says ${shipped}`,
  );

  // Without the note, the next reader "corrects" the README back to the
  // library export's 256 KiB. Pinned on the two code identifiers, which
  // survive rewording.
  const readme = readFileSync(README, 'utf8');
  assert.match(readme, /DEFAULT_BYTES_THRESHOLD/);
  assert.match(readme, /HARD_BYTES/);

  // The docs site renders a hand-authored copy of the same table (it is not
  // generated from this README), so it drifts independently. Absent from a
  // published tarball, present in a source checkout.
  if (existsSync(SITE_PAGE)) {
    const siteCell = flagDefaultCell(readFileSync(SITE_PAGE, 'utf8'), '--bytes-threshold');
    assert.equal(
      siteCell.match(/\d+/)?.[0],
      shipped,
      `docs-site --bytes-threshold row says "${siteCell}"; --help says ${shipped}`,
    );
  }
});

test('no --depth/--session-bytes supplied at all → defaults to not-degraded (allow)', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const r = run(['T1', '--json'], { cwd: dir });
    assert.equal(r.code, 0);
  });
});

test('--transcript derives depth from tool_use occurrences in the file', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const transcript = join(dir, 'session.jsonl');
    const line = JSON.stringify({ type: 'tool_use' });
    writeFileSync(transcript, Array.from({ length: 100 }, () => line).join('\n'));
    const r = run(['T1', '--transcript', transcript, '--json'], { cwd: dir });
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.depth, 100);
  });
});

test('ADLC_BUILD_GATE_BYPASS=1 with a writable .adlc → allow + audited manifest entry', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const r = run(['T1', '--depth', '999', '--json'], { cwd: dir, env: { ADLC_BUILD_GATE_BYPASS: '1' } });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.overridden, true);
    const manifestPath = join(dir, '.adlc', 'manifest.jsonl');
    assert.ok(existsSync(manifestPath));
    const entry = JSON.parse(readFileSync(manifestPath, 'utf8').trim().split('\n').pop());
    assert.equal(entry.gate, 'build-gate-bypass');
    assert.equal(entry.ticket, 'T1');
    // Chain-linkage fields required by gate-manifest's verify() (issue #48 review finding).
    assert.equal(entry.seq, 1);
    assert.equal(entry.prev, null);
  });
});

test('bad --depth-threshold value → operational error, exit 1', () => {
  withTicketRepo([{ id: 'T1', title: 'x' }], (dir) => {
    const r = run(['T1', '--depth-threshold', 'nope'], { cwd: dir });
    assert.equal(r.code, 1);
  });
});
