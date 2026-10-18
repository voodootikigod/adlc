import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEDGER,
  scanFindingsLedger,
  scan,
  baseLedger,
  headLedgerText,
  appendOnlyViolations,
  guardFindingsLedgerAppendOnly,
  guard,
} from '../lib/ledger-guard.mjs';

function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const code = fn();
    return { code, stdout: logs.join('\n'), stderr: errors.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lf-ledger-guard-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('exports LEDGER constant and scan/guard aliases', () => {
  assert.strictEqual(LEDGER, '.adlc/findings.jsonl');
  assert.strictEqual(scan, scanFindingsLedger);
  assert.strictEqual(guard, guardFindingsLedgerAppendOnly);
});

// ---- scanFindingsLedger -------------------------------------------------------------------

test('scanFindingsLedger: absent ledger logs message and returns 0', () => {
  const r = captureConsole(() => scanFindingsLedger('/nonexistent/path/findings.jsonl'));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /scan-findings-ledger: no ledger at \/nonexistent\/path\/findings\.jsonl — nothing to scan\./);
  assert.strictEqual(r.stderr, '');
});

test('scanFindingsLedger: unreadable ledger (directory path) logs error and returns 1', () => {
  withTempDir((dir) => {
    const r = captureConsole(() => scanFindingsLedger(dir));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, new RegExp(`scan-findings-ledger: cannot read ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
  });
});

test('scanFindingsLedger: clean ledger with blank/whitespace lines counts non-empty lines and returns 0', () => {
  withTempDir((dir) => {
    const p = join(dir, 'findings.jsonl');
    const lines = [
      '',
      JSON.stringify({ tool: 'prosecutor', file: 'a.mjs', desc: 'first curated finding description' }),
      '   ',
      JSON.stringify({ tool: 'prosecutor', file: 'b.mjs', desc: 'second curated finding description' }),
      '',
    ];
    writeFileSync(p, lines.join('\n'), 'utf8');
    const r = captureConsole(() => scanFindingsLedger(p));
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /scan-findings-ledger: 2 ledger line\(s\) clean\./);
    assert.strictEqual(r.stderr, '');
  });
});

test('scanFindingsLedger: default ledger parameter scans .adlc/findings.jsonl in cwd', () => {
  withTempDir((dir) => {
    const prev = process.cwd();
    try {
      process.chdir(dir);
      const absent = captureConsole(() => scanFindingsLedger());
      assert.strictEqual(absent.code, 0);
      assert.match(absent.stdout, /scan-findings-ledger: no ledger at \.adlc\/findings\.jsonl — nothing to scan\./);

      mkdirSync(join(dir, '.adlc'), { recursive: true });
      writeFileSync(
        join(dir, '.adlc', 'findings.jsonl'),
        `${JSON.stringify({ tool: 'prosecutor', file: 'x.mjs', desc: 'valid finding' })}\n`,
        'utf8',
      );
      const present = captureConsole(() => scanFindingsLedger());
      assert.strictEqual(present.code, 0);
      assert.match(present.stdout, /scan-findings-ledger: 1 ledger line\(s\) clean\./);
    } finally {
      process.chdir(prev);
    }
  });
});

test('scanFindingsLedger: malformed JSON line without secret reports exactly 1 violation and continues', () => {
  withTempDir((dir) => {
    const p = join(dir, 'findings.jsonl');
    writeFileSync(
      p,
      [
        JSON.stringify({ tool: 'prosecutor', file: 'a.mjs', desc: 'valid line one' }),
        'this is not valid json at all',
        JSON.stringify({ tool: 'prosecutor', file: 'b.mjs', desc: 'valid line three' }),
      ].join('\n') + '\n',
      'utf8',
    );
    const r = captureConsole(() => scanFindingsLedger(p));
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /scan-findings-ledger: 1 line\(s\) in .* are not publishable:/);
    assert.match(r.stderr, / {2}line 2: malformed JSONL record — a committed ledger must be valid JSON \(readEntries silently skips this, starving lesson-foundry\)/);
    assert.match(r.stderr, /This file is committed to git\. Describe the failure class instead of quoting the value \(ADR 0014\)\./);
  });
});

test('scanFindingsLedger: malformed JSON line containing a secret reports both corruption and the secret', () => {
  withTempDir((dir) => {
    const p = join(dir, 'findings.jsonl');
    writeFileSync(p, 'corrupt json with AKIA1234567890ABCDEF inside\n', 'utf8');
    const r = captureConsole(() => scanFindingsLedger(p));
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /scan-findings-ledger: 2 line\(s\) in .* are not publishable:/);
    assert.match(r.stderr, /line 1: malformed JSONL record/);
    assert.match(r.stderr, /line 1: .*AWS access key id/);
  });
});

test('scanFindingsLedger: valid JSON line containing a secret or invalid schema fails with exit 2', () => {
  withTempDir((dir) => {
    const p = join(dir, 'findings.jsonl');
    writeFileSync(
      p,
      [
        JSON.stringify({ tool: 'prosecutor', file: 'a.mjs', desc: 'clean finding' }),
        JSON.stringify({
          tool: 'prosecutor',
          file: 'b.mjs',
          desc: 'leaked github_pat_11ABCDEFG0aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb token',
        }),
        JSON.stringify({ tool: 'prosecutor', file: 'c.mjs', desc: '' }),
      ].join('\n') + '\n',
      'utf8',
    );
    const r = captureConsole(() => scanFindingsLedger(p));
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /scan-findings-ledger: 2 line\(s\) in .* are not publishable:/);
    assert.match(r.stderr, /line 2: .*GitHub fine-grained token/);
    assert.match(r.stderr, /line 3: .*non-empty string `desc`/);
  });
});

// ---- baseLedger ---------------------------------------------------------------------------

test('baseLedger: uses merge-base trimmed SHA when available and reads blob via show', () => {
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    if (args[0] === 'merge-base') return '  abc123def  \n';
    if (args[0] === 'ls-tree') return `100644 blob 999\t${LEDGER}\n`;
    if (args[0] === 'show') return '{"desc":"from base"}\n';
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const res = baseLedger('origin/main', run);
  assert.deepEqual(res, { resolved: true, text: '{"desc":"from base"}\n' });
  assert.deepEqual(calls, [
    ['merge-base', 'origin/main', 'HEAD'],
    ['ls-tree', 'abc123def', '--', LEDGER],
    ['show', `abc123def:${LEDGER}`],
  ]);
});

test('baseLedger: falls back to rev-parse when merge-base throws or returns whitespace', () => {
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    if (args[0] === 'merge-base') return '   \n';
    if (args[0] === 'rev-parse') return '  deadbeef  \n';
    if (args[0] === 'ls-tree') return '   \n';
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const res = baseLedger('v1.0', run);
  assert.deepEqual(res, { resolved: true, text: '' });
  assert.deepEqual(calls, [
    ['merge-base', 'v1.0', 'HEAD'],
    ['rev-parse', '--verify', 'v1.0^{commit}'],
    ['ls-tree', 'deadbeef', '--', LEDGER],
  ]);
});

test('baseLedger: fails closed when merge-base and rev-parse both fail', () => {
  const run = (...args) => {
    throw new Error(`git ${args[0]} failed`);
  };
  assert.deepEqual(baseLedger('bad-ref', run), { resolved: false });
});

test('baseLedger: fails closed when ls-tree or show throws', () => {
  const lsTreeFail = (...args) => {
    if (args[0] === 'merge-base') return 'abc';
    throw new Error('ls-tree error');
  };
  assert.deepEqual(baseLedger('main', lsTreeFail), { resolved: false });

  const showFail = (...args) => {
    if (args[0] === 'merge-base') return 'abc';
    if (args[0] === 'ls-tree') return `100644 blob 123\t${LEDGER}\n`;
    throw new Error('show error');
  };
  assert.deepEqual(baseLedger('main', showFail), { resolved: false });
});

// ---- headLedgerText -----------------------------------------------------------------------

test('headLedgerText: returns empty string when ledger does not exist and reads utf8 when it does', () => {
  let readCalled = false;
  assert.strictEqual(
    headLedgerText(
      () => { readCalled = true; return 'x'; },
      (p) => { assert.strictEqual(p, LEDGER); return false; },
    ),
    '',
  );
  assert.strictEqual(readCalled, false);

  assert.strictEqual(
    headLedgerText(
      (p, enc) => {
        assert.strictEqual(p, LEDGER);
        assert.strictEqual(enc, 'utf8');
        return '{"desc":"head"}\n';
      },
      (p) => { assert.strictEqual(p, LEDGER); return true; },
    ),
    '{"desc":"head"}\n',
  );
});

// ---- appendOnlyViolations -----------------------------------------------------------------

test('appendOnlyViolations: clean cases (unchanged, appended, empty base, blank lines)', () => {
  assert.deepEqual(appendOnlyViolations('', ''), []);
  assert.deepEqual(appendOnlyViolations('', '{"a":1}\n'), []);
  assert.deepEqual(appendOnlyViolations('{"a":1}\n{"b":2}\n', '{"a":1}\n{"b":2}\n'), []);
  assert.deepEqual(appendOnlyViolations('{"a":1}\n', '\n{"a":1}\n\n{"b":2}\n  \n'), []);
});

test('appendOnlyViolations: detects first rewritten line and stops after first divergence', () => {
  const v = appendOnlyViolations(
    '{"a":1}\n{"b":2}\n{"c":3}\n',
    '{"a":1}\n{"b":99}\n{"c":88}\n',
  );
  assert.deepEqual(v, [
    'finding on line 2 was rewritten relative to the base — existing findings are immutable (append-only)',
  ]);
});

test('appendOnlyViolations: detects truncation and combined rewrite + truncation', () => {
  const trunc = appendOnlyViolations('{"a":1}\n{"b":2}\n{"c":3}\n', '{"a":1}\n');
  assert.deepEqual(trunc, [
    'the base ledger had 3 finding(s); head has only 1 — 2 removed (deletion or truncation)',
  ]);

  const both = appendOnlyViolations('{"a":1}\n{"b":2}\n', '{"a":99}\n');
  assert.strictEqual(both.length, 2);
  assert.match(both[0], /finding on line 1 was rewritten/);
  assert.match(both[1], /the base ledger had 2 finding\(s\); head has only 1 — 1 removed/);
});

// ---- guardFindingsLedgerAppendOnly --------------------------------------------------------

test('guardFindingsLedgerAppendOnly: returns 1 when base ref does not resolve', () => {
  const r = captureConsole(() =>
    guardFindingsLedgerAppendOnly('missing-ref', {
      run: () => { throw new Error('unknown revision'); },
    }),
  );
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /guard-findings-ledger-append-only: base ref 'missing-ref' does not resolve to a commit/);
});

test('guardFindingsLedgerAppendOnly: returns 2 and prints violations when not append-only', () => {
  const r = captureConsole(() =>
    guardFindingsLedgerAppendOnly('main', {
      run: (...args) => {
        if (args[0] === 'merge-base') return 'abc';
        if (args[0] === 'ls-tree') return `100644 blob 1\t${LEDGER}\n`;
        if (args[0] === 'show') return '{"desc":"one"}\n{"desc":"two"}\n';
        throw new Error('unexpected');
      },
      exists: () => true,
      read: () => '{"desc":"one"}\n',
    }),
  );
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /guard-findings-ledger-append-only: \.adlc\/findings\.jsonl is not append-only vs main:/);
  assert.match(r.stderr, /  - the base ledger had 2 finding\(s\); head has only 1 — 1 removed/);
  assert.match(r.stderr, /The findings ledger is durable P5->P7 memory \(ADR 0014\)/);
});

test('guardFindingsLedgerAppendOnly: returns 0 and logs confirmation when append-only (including default git/fs)', () => {
  withTempDir((dir) => {
    const git = (...args) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    git('init', '-b', 'main');
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, LEDGER), '{"desc":"first"}\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(dir, LEDGER), '{"desc":"first"}\n{"desc":"second"}\n', 'utf8');

    const prev = process.cwd();
    try {
      process.chdir(dir);
      const r = captureConsole(() => guardFindingsLedgerAppendOnly('main'));
      assert.strictEqual(r.code, 0);
      assert.match(r.stdout, /guard-findings-ledger-append-only: \.adlc\/findings\.jsonl is append-only vs main\./);
      assert.strictEqual(r.stderr, '');
    } finally {
      process.chdir(prev);
    }
  });
});
