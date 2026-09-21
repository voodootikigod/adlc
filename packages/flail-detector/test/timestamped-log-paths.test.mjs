// test/timestamped-log-paths.test.mjs — tests for path extraction from timestamped and indented log lines (#623).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractPath,
  detectScopeViolations,
  detectEditChurn,
} from '../lib/signals.mjs';

const CLI = new URL('../bin/flail-detector.mjs', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// extractPath — timestamp and indentation support
// ---------------------------------------------------------------------------

test('extractPath: extracts paths with timestamp prefixes', () => {
  assert.equal(extractPath('12:03:01 Writing /etc/passwd'), '/etc/passwd');
  assert.equal(extractPath('[2026-09-21T19:00:00Z] Editing lib/signals.mjs'), 'lib/signals.mjs');
  assert.equal(extractPath('2026-09-21 12:00:00 Created test/foo.test.js'), 'test/foo.test.js');
  assert.equal(extractPath('2026-09-21T12:00:00.000Z writing out.txt'), 'out.txt');
  assert.equal(extractPath('[INFO] 10:15:30 editing config.json'), 'config.json');
  assert.equal(extractPath('2026-09-21T19:03:06-04:00 Created file.txt'), 'file.txt');
});

test('extractPath: extracts paths with indentation', () => {
  assert.equal(extractPath('  Writing src/foo.js'), 'src/foo.js');
  assert.equal(extractPath('\tEditing src/bar.js'), 'src/bar.js');
  assert.equal(extractPath('    Created src/baz.js'), 'src/baz.js');
  assert.equal(extractPath('  \t  writing src/qux.js'), 'src/qux.js');
  assert.equal(extractPath('   editing src/qux.js'), 'src/qux.js');
  assert.equal(extractPath('   created src/qux.js'), 'src/qux.js');
});

test('extractPath: preserves line-leading path extraction', () => {
  assert.equal(extractPath('Writing src/direct.js'), 'src/direct.js');
  assert.equal(extractPath('Editing src/direct.js'), 'src/direct.js');
  assert.equal(extractPath('Created src/direct.js'), 'src/direct.js');
  assert.equal(extractPath('writing src/direct.js'), 'src/direct.js');
  assert.equal(extractPath('editing src/direct.js'), 'src/direct.js');
  assert.equal(extractPath('created src/direct.js'), 'src/direct.js');
});

test('extractPath: does not match verbs embedded inside other words', () => {
  assert.equal(extractPath('Rewriting src/foo.js'), null);
  assert.equal(extractPath('Uncreated src/foo.js'), null);
  assert.equal(extractPath('CreditEditing src/foo.js'), null);
  assert.equal(extractPath('Subediting src/foo.js'), null);
});

test('extractPath: returns null when line does not contain a path or matching verb', () => {
  assert.equal(extractPath('Writing'), null);
  assert.equal(extractPath('Editing   '), null);
  assert.equal(extractPath('Just some random log line'), null);
});

// ---------------------------------------------------------------------------
// detectScopeViolations — timestamped and indented logs
// ---------------------------------------------------------------------------

test('detectScopeViolations: flags out-of-scope paths on timestamped or indented lines', () => {
  const lines = [
    '12:03:01 Writing /etc/passwd',
    '  Editing /etc/shadow',
    '[2026-09-21] Created /var/log/secret.log',
  ];
  const violations = detectScopeViolations(lines, ['src/**', 'test/**']);
  assert.equal(violations.length, 3);
  assert.equal(violations[0].path, '/etc/passwd');
  assert.equal(violations[1].path, '/etc/shadow');
  assert.equal(violations[2].path, '/var/log/secret.log');
});

test('detectScopeViolations: in-scope paths with timestamp or indentation do not trigger', () => {
  const lines = [
    '12:03:01 Writing src/index.js',
    '  Editing test/foo.test.js',
    '[2026-09-21] Created src/utils.mjs',
  ];
  const violations = detectScopeViolations(lines, ['src/**', 'test/**']);
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// detectEditChurn — timestamped and indented logs
// ---------------------------------------------------------------------------

test('detectEditChurn: tracks churn across timestamped and indented lines', () => {
  const lines = [
    '12:00:01 Writing src/index.js',
    '  Editing src/index.js',
    '[2026-09-21 12:00:05] Created src/index.js',
    '12:00:06 Writing src/other.js',
    '  Editing src/other.js',
  ];
  const churn = detectEditChurn(lines);
  assert.equal(churn.length, 1);
  assert.equal(churn[0].path, 'src/index.js');
  assert.equal(churn[0].count, 3);
});

// ---------------------------------------------------------------------------
// CLI integration: timestamped log lines trigger scope-violation and edit-churn
// ---------------------------------------------------------------------------

test('CLI: timestamped plain-text log triggers scope-violation and edit-churn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flail-detector-ts-test-'));
  try {
    const logPath = join(dir, 'session.log');
    writeFileSync(
      logPath,
      [
        '12:03:01 Writing /etc/passwd',
        '12:03:02 Editing /etc/passwd',
        '12:03:03 Created /etc/passwd',
      ].join('\n'),
      'utf8',
    );
    const r = spawnSync(process.execPath, [CLI, logPath, '--scope', 'src/**', '--json'], {
      encoding: 'utf8',
      cwd: dir,
    });
    assert.equal(r.status, 2, `expected exit code 2 (FLAIL), got ${r.status}; stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.verdict, 'flail');
    const signals = out.signals.map((s) => s.type);
    assert.ok(signals.includes('scope-violation'), 'should trigger scope-violation');
    assert.ok(signals.includes('edit-churn'), 'should trigger edit-churn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
