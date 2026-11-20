import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEDGER,
  scanFindingsLedger,
  guardFindingsLedgerAppendOnly,
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

test('guardFindingsLedgerAppendOnly and scanFindingsLedger return 2 when .adlc/findings.jsonl is a symlink and 1 when it is a directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lf-staged-symlink-'));
  const prev = process.cwd();
  try {
    const adlc = join(dir, '.adlc');
    mkdirSync(adlc, { recursive: true });
    const target = join(dir, 'outside.jsonl');
    writeFileSync(
      target,
      `${JSON.stringify({ tool: 'prosecutor', file: 'a.mjs', desc: 'clean finding' })}\n`,
      'utf8',
    );
    const ledgerPath = join(dir, LEDGER);
    symlinkSync(target, ledgerPath);

    process.chdir(dir);

    const scanSymlink = captureConsole(() => scanFindingsLedger());
    assert.strictEqual(scanSymlink.code, 2);
    assert.match(scanSymlink.stderr, /symbolic link|symlink/i);

    const baseRun = (...args) => {
      if (args[0] === 'merge-base') return 'abc123\n';
      if (args[0] === 'ls-tree') return '';
      if (args[0] === 'ls-files') return '';
      throw new Error(`unexpected ${args.join(' ')}`);
    };

    const guardSymlink = captureConsole(() =>
      guardFindingsLedgerAppendOnly('main', { run: baseRun }),
    );
    assert.strictEqual(guardSymlink.code, 2);
    assert.match(guardSymlink.stderr, /symbolic link|symlink/i);

    rmSync(ledgerPath, { force: true });
    mkdirSync(ledgerPath, { recursive: true });

    const scanDir = captureConsole(() => scanFindingsLedger());
    assert.strictEqual(scanDir.code, 1);
    assert.match(scanDir.stderr, /cannot read/);

    const guardDir = captureConsole(() =>
      guardFindingsLedgerAppendOnly('main', { run: baseRun }),
    );
    assert.strictEqual(guardDir.code, 1);
    assert.match(guardDir.stderr, /cannot read/);

    const lstatErr = captureConsole(() =>
      scanFindingsLedger('x', { exists: () => true, lstat: () => { throw new Error('boom'); } }),
    );
    assert.strictEqual(lstatErr.code, 1);
    assert.match(lstatErr.stderr, /cannot read/);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guardFindingsLedgerAppendOnly returns 2 on trailing-newline or byte-prefix alteration', () => {
  const baseText = '{"desc":"one"}\n{"desc":"two"}\n';
  const makeRun = () => (...args) => {
    if (args[0] === 'merge-base') return 'abc123\n';
    if (args[0] === 'ls-tree') return `100644 blob 1\t${LEDGER}\n`;
    if (args[0] === 'show') return baseText;
    if (args[0] === 'ls-files') return `100644 deadbeef 0\t${LEDGER}\n`;
    throw new Error(`unexpected ${args.join(' ')}`);
  };

  // Stripped trailing newline on working tree despite identical nonEmptyLines
  const strippedNewline = captureConsole(() =>
    guardFindingsLedgerAppendOnly('main', {
      run: makeRun(),
      exists: () => true,
      lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }),
      read: () => Buffer.from('{"desc":"one"}\n{"desc":"two"}', 'utf8'),
    }),
  );
  assert.strictEqual(strippedNewline.code, 2);
  assert.match(strippedNewline.stderr, /not append-only/);

  // Inserted leading blank line altering byte prefix despite identical nonEmptyLines
  const leadingNewline = captureConsole(() =>
    guardFindingsLedgerAppendOnly('main', {
      run: makeRun(),
      exists: () => true,
      lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }),
      read: () => Buffer.from('\n{"desc":"one"}\n{"desc":"two"}\n', 'utf8'),
    }),
  );
  assert.strictEqual(leadingNewline.code, 2);
  assert.match(leadingNewline.stderr, /not append-only/);
});

test('guardFindingsLedgerAppendOnly returns 2 when staged index truncates findings.jsonl even if working tree appears intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lf-staged-trunc-'));
  const prev = process.cwd();
  try {
    const git = (...args) =>
      execFileSync(
        'git',
        ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
        {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    git('init', '-b', 'main');
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const fullLedger = '{"desc":"first"}\n{"desc":"second"}\n';
    writeFileSync(join(dir, LEDGER), fullLedger, 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    // Stage a truncated version in the index, then restore the full ledger in the working tree
    writeFileSync(join(dir, LEDGER), '{"desc":"first"}\n', 'utf8');
    git('add', LEDGER);
    writeFileSync(join(dir, LEDGER), fullLedger, 'utf8');

    process.chdir(dir);
    const res = captureConsole(() => guardFindingsLedgerAppendOnly('main'));
    assert.strictEqual(res.code, 2);
    assert.match(res.stderr, /staged index/);

    // Staged deletion (git rm --cached) while working-tree copy remains intact is rejected too
    git('rm', '-f', '-q', '--cached', LEDGER);
    writeFileSync(join(dir, LEDGER), fullLedger, 'utf8');
    const deletedIndex = captureConsole(() => guardFindingsLedgerAppendOnly('main'));
    assert.strictEqual(deletedIndex.code, 2);
    assert.match(deletedIndex.stderr, /staged index deleted/);

    // Staged symlink entry (120000) in index while working-tree copy is regular file is rejected too
    const stagedLink = captureConsole(() =>
      guardFindingsLedgerAppendOnly('main', {
        run: (...args) => {
          if (args[0] === 'merge-base') return 'abc123\n';
          if (args[0] === 'ls-tree') return `100644 blob 1\t${LEDGER}\n`;
          if (args[0] === 'show' && args[1] === `abc123:${LEDGER}`) return fullLedger;
          if (args[0] === 'ls-files') return `120000 deadbeef 0\t${LEDGER}\n`;
          throw new Error(`unexpected ${args.join(' ')}`);
        },
        exists: () => true,
        lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }),
        read: () => Buffer.from(fullLedger, 'utf8'),
      }),
    );
    assert.strictEqual(stagedLink.code, 2);
    assert.match(stagedLink.stderr, /replaces .* with a symbolic link/);

    // Equal-length staged rewrite (same byte length, altered prefix) is rejected too
    const sameLenRewrite = captureConsole(() =>
      guardFindingsLedgerAppendOnly('main', {
        run: (...args) => {
          if (args[0] === 'merge-base') return 'abc123\n';
          if (args[0] === 'ls-tree') return `100644 blob 1\t${LEDGER}\n`;
          if (args[0] === 'show' && args[1] === `abc123:${LEDGER}`) return fullLedger;
          if (args[0] === 'ls-files') return `100644 deadbeef 0\t${LEDGER}\n`;
          if (args[0] === 'show' && args[1] === `:0:${LEDGER}`) return '{"desc":"OTHER"}\n{"desc":"second"}\n';
          throw new Error(`unexpected ${args.join(' ')}`);
        },
        exists: () => true,
        lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }),
        read: () => Buffer.from(fullLedger, 'utf8'),
      }),
    );
    assert.strictEqual(sameLenRewrite.code, 2);

    // Custom git runner that does not support ls-files still passes when working tree is append-only
    const noLsFilesOk = captureConsole(() =>
      guardFindingsLedgerAppendOnly('main', {
        run: (...args) => {
          if (args[0] === 'merge-base') return 'abc123\n';
          if (args[0] === 'ls-tree') return `100644 blob 1\t${LEDGER}\n`;
          if (args[0] === 'show' && args[1] === `abc123:${LEDGER}`) return fullLedger;
          throw new Error(`unsupported ${args[0]}`);
        },
        exists: () => true,
        lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }),
        read: () => Buffer.from(fullLedger, 'utf8'),
      }),
    );
    assert.strictEqual(noLsFilesOk.code, 0);

    // Also verify operational error (exit 1) when reading staged blob throws
    const showErr = captureConsole(() =>
      guardFindingsLedgerAppendOnly('main', {
        run: (...args) => {
          if (args[0] === 'merge-base') return 'abc123\n';
          if (args[0] === 'ls-tree') return `100644 blob 1\t${LEDGER}\n`;
          if (args[0] === 'show' && args[1] === `abc123:${LEDGER}`) return fullLedger;
          if (args[0] === 'ls-files') return `100644 deadbeef 0\t${LEDGER}\n`;
          if (args[0] === 'show' && args[1] === `:0:${LEDGER}`) throw new Error('corrupt index blob');
          throw new Error(`unexpected ${args.join(' ')}`);
        },
        exists: () => true,
        lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }),
        read: () => Buffer.from(fullLedger, 'utf8'),
      }),
    );
    assert.strictEqual(showErr.code, 1);
    assert.match(showErr.stderr, /cannot read staged/);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});
