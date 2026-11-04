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
import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { recordOverride } from '../lib/override.mjs';

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

test('--ticket <id> works as an alias for positional <ticket-id> (#894)', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const byFlag = run(['--ticket', 'T1', '--depth', '1', '--json'], { cwd: dir });
    const byPos = run(['T1', '--depth', '1', '--json'], { cwd: dir });
    assert.equal(byFlag.code, 0, byFlag.stderr);
    assert.deepEqual(JSON.parse(byFlag.stdout), JSON.parse(byPos.stdout));
  });
});

test('passing both positional <ticket-id> and matching --ticket <id> succeeds (#894)', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const r = run(['T1', '--ticket', 'T1', '--depth', '1', '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).ticket, 'T1');
  });
});

test('passing conflicting positional <ticket-id> and --ticket <id> exits 1 naming the conflict (#894)', () => {
  withTicketRepo([{ id: 'T1', title: 'x' }, { id: 'T2', title: 'y' }], (dir) => {
    const r = run(['T1', '--ticket', 'T2', '--json'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /conflicting ticket ids: positional "T1" vs --ticket "T2"/);
  });
});

test('--help documents --ticket <id> (#894)', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--ticket <id>\s+Ticket to gate \(alias for positional <ticket-id>\)/);
});

test('ADLC_BUILD_GATE_BYPASS=1 without ADLC_MANIFEST_KEY is refused when ledger has signed entries (#589)', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const adlcDir = join(dir, '.' + 'adlc');
    record({ gate: 'coldstart', ticket: 'T1', rawData: '{}', dir: adlcDir, key: 'secret-test-key' });
    const manifestFile = join(adlcDir, 'manifest' + '.jsonl');
    const beforeLines = readFileSync(manifestFile, 'utf8').trim().split('\n');
    assert.equal(beforeLines.length, 1);

    const r = run(['T1', '--depth', '999', '--json'], {
      cwd: dir,
      env: { ADLC_BUILD_GATE_BYPASS: '1', ADLC_MANIFEST_KEY: '' },
    });
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'deny');
    assert.equal(out.overridden, false);
    assert.match(out.reason, /refused|could not be recorded/i);

    const afterLines = readFileSync(manifestFile, 'utf8').trim().split('\n');
    assert.equal(afterLines.length, 1, 'must not append an unsigned entry to a signed ledger');
  });
});

test('ADLC_BUILD_GATE_BYPASS=1 with ADLC_MANIFEST_KEY succeeds on a signed ledger (#589)', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const adlcDir = join(dir, '.' + 'adlc');
    record({ gate: 'coldstart', ticket: 'T1', rawData: '{}', dir: adlcDir, key: 'secret-test-key' });

    const r = run(['T1', '--depth', '999', '--json'], {
      cwd: dir,
      env: { ADLC_BUILD_GATE_BYPASS: '1', ADLC_MANIFEST_KEY: 'secret-test-key' },
    });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'allow');
    assert.equal(out.overridden, true);

    const manifestFile = join(adlcDir, 'manifest' + '.jsonl');
    const lines = readFileSync(manifestFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const last = JSON.parse(lines[1]);
    assert.equal(last.gate, 'build-gate-bypass');
    assert.equal(typeof last.sig, 'string');
    assert.ok(last.sig.length > 0);
  });
});

test('recordOverride unit: refuses missing/empty/non-string key on signed ledger, allows unsigned ledger (#589)', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const adlcDir = join(dir, '.' + 'adlc');
    // Unsigned ledger -> keyless override allowed
    assert.equal(recordOverride({ ticketId: 'T1', signals: ['s1'], depth: 50, sessionBytes: 100, reason: 'r', dir: adlcDir, key: null }), true);
    // Add a signed entry
    record({ gate: 'coldstart', ticket: 'T1', rawData: '{}', dir: adlcDir, key: 'secret-test-key' });
    // Signed ledger -> null, undefined, empty string, non-string keys all refused
    assert.equal(recordOverride({ ticketId: 'T1', signals: ['s1'], depth: 50, sessionBytes: 100, reason: 'r', dir: adlcDir, key: null }), false);
    assert.equal(recordOverride({ ticketId: 'T1', signals: ['s1'], depth: 50, sessionBytes: 100, reason: 'r', dir: adlcDir, key: undefined }), false);
    assert.equal(recordOverride({ ticketId: 'T1', signals: ['s1'], depth: 50, sessionBytes: 100, reason: 'r', dir: adlcDir, key: '' }), false);
    assert.equal(recordOverride({ ticketId: 'T1', signals: ['s1'], depth: 50, sessionBytes: 100, reason: 'r', dir: adlcDir, key: 123 }), false);
    // Signed ledger + valid non-empty key -> allowed
    assert.equal(recordOverride({ ticketId: 'T1', signals: ['s1'], depth: 50, sessionBytes: 100, reason: 'r', dir: adlcDir, key: 'secret-test-key' }), true);
    // Unwritable dir -> returns false
    assert.equal(recordOverride({ ticketId: 'T1', signals: ['s1'], depth: 50, sessionBytes: 100, reason: 'r', dir: '/dev/null/impossible', key: 'secret-test-key' }), false);
  });
});

test('README documents signed-ledger requirement for ADLC_BUILD_GATE_BYPASS (#589)', () => {
  const readme = readFileSync(README, 'utf8');
  assert.match(readme, /ADLC_MANIFEST_KEY/);
  assert.match(readme, /signed entries/i);
});

test('--transcript bounds scan to MAX_ACTIVE_CONTEXT_BYTES tail window while preserving full sessionBytes (#590)', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const tp = join(dir, 'huge-transcript.jsonl');
    const earlyCall = JSON.stringify({ type: 'tool_use', name: 'Read' }) + '\n';
    const paddingLine = 'x'.repeat(1023) + '\n';
    const padCount = 8192 + 10; // > 8 MiB
    const tailCall = JSON.stringify({ type: 'tool_use', name: 'Edit' }) + '\n';
    const content = earlyCall.repeat(50) + paddingLine.repeat(padCount) + tailCall.repeat(3);
    writeFileSync(tp, content);
    const totalSize = Buffer.byteLength(content, 'utf8');
    assert.ok(totalSize > 8 * 1024 * 1024, 'fixture exceeds MAX_ACTIVE_CONTEXT_BYTES');

    // Raise --bytes-threshold so only depth decides: if the whole file were scanned,
    // depth would be 53 (>= 40 -> deny); with the 8 MiB tail window, the 50 early
    // calls are outside the window and depth is 3 (< 40 -> allow), while sessionBytes
    // still reports the full file size.
    const r = run(['T1', '--transcript', tp, '--bytes-threshold', String(totalSize + 1024), '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'allow');
    assert.equal(out.depth, 3);
    assert.equal(out.sessionBytes, totalSize);
    assert.equal(out.signalSource, 'transcript');

    // Without raising --bytes-threshold, full sessionBytes (> 8 MiB) still triggers deny.
    const deny = run(['T1', '--transcript', tp, '--json'], { cwd: dir });
    assert.equal(deny.code, 2);
    const denyOut = JSON.parse(deny.stdout);
    assert.equal(denyOut.sessionBytes, totalSize);
    assert.equal(denyOut.depth, 3);
  });
});
