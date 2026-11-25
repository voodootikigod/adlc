import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  enclosingAdlcRoot,
  isAncestorDirOfRail,
  railHit,
  isDirectoryDeletionCommand,
  readActiveTicketRails,
  evaluatePreTool,
} from '../lib/pretool.mjs';

function makeAdlcRepo(t, prefix = 'adlc-he-pretool-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(
    join(dir, '.adlc', 'tickets.json'),
    JSON.stringify({
      tickets: [
        {
          id: 'T-1',
          title: 'Active ticket',
          completed: false,
          scope: ['src/**'],
          rails: ['test/auth.test.mjs', 'packages/core/test/**'],
        },
        {
          id: 'T-DONE',
          title: 'Done ticket',
          completed: true,
          scope: ['old/**'],
          rails: ['old/rail.mjs'],
        },
      ],
    }, null, 2),
  );
  mkdirSync(join(dir, 'test'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'test', 'auth.test.mjs'), '// frozen rail\n');
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 1;\n');
  return dir;
}

test('isAncestorDirOfRail detects ancestor directories of literal, nested, and wildcard rails', () => {
  assert.equal(isAncestorDirOfRail('test', 'test/auth.test.mjs'), true);
  assert.equal(isAncestorDirOfRail('test/', 'test/auth.test.mjs'), true);
  assert.equal(isAncestorDirOfRail('packages', 'packages/core/test/**'), true);
  assert.equal(isAncestorDirOfRail('packages/core', 'packages/core/test/**'), true);
  assert.equal(isAncestorDirOfRail('packages/foo', 'packages/*/test/**'), true);
  assert.equal(isAncestorDirOfRail('src', '**/*.test.mjs'), true);
  assert.equal(isAncestorDirOfRail('.', 'test/auth.test.mjs'), true);
  assert.equal(isAncestorDirOfRail('src', 'test/auth.test.mjs'), false);
  assert.equal(isAncestorDirOfRail('../outside', 'test/auth.test.mjs'), false);
  assert.equal(isAncestorDirOfRail('src', ''), false);
});

test('railHit resolves symlinks to frozen rails and enforces ancestor-directory deletion protection', (t) => {
  const repo = makeAdlcRepo(t);
  // Symlink inside src/ pointing to frozen test/auth.test.mjs
  const linkPath = join(repo, 'src', 'sneaky-link.mjs');
  symlinkSync(join(repo, 'test', 'auth.test.mjs'), linkPath);

  const symHit = railHit('src/sneaky-link.mjs', repo, ['test/auth.test.mjs']);
  assert.equal(symHit.hit, true);
  assert.equal(symHit.rail, 'test/auth.test.mjs');
  assert.equal(symHit.resolvedPath, 'test/auth.test.mjs');
  assert.equal(symHit.ancestorDir, false);

  // Ancestor dir without checkAncestorDir is not a direct file hit; with checkAncestorDir it IS a hit.
  assert.equal(railHit('test', repo, ['test/auth.test.mjs'], { checkAncestorDir: false }).hit, false);
  const ancHit = railHit('test', repo, ['test/auth.test.mjs'], { checkAncestorDir: true });
  assert.equal(ancHit.hit, true);
  assert.equal(ancHit.ancestorDir, true);

  // Non-rail file is allowed.
  assert.equal(railHit('src/app.mjs', repo, ['test/auth.test.mjs']).hit, false);

  // Valid in-root filename starting with `..` (e.g. `..secret`) is NOT treated as outside root.
  writeFileSync(join(repo, '..secret'), 'top-secret\n');
  const dotdotHit = railHit('..secret', repo, ['..secret']);
  assert.equal(dotdotHit.hit, true);
  assert.equal(dotdotHit.resolvedPath, '..secret');
});

test('isDirectoryDeletionCommand identifies rm, rmdir, mv, unlink, git rm, git clean, find -delete, and absolute-path/wrapped commands', () => {
  assert.equal(isDirectoryDeletionCommand('rm -rf test'), true);
  assert.equal(isDirectoryDeletionCommand('/bin/rm -rf test'), true);
  assert.equal(isDirectoryDeletionCommand('/usr/bin/mv test test_bak'), true);
  assert.equal(isDirectoryDeletionCommand('command rm -rf test'), true);
  assert.equal(isDirectoryDeletionCommand('/usr/bin/git rm -r test'), true);
  assert.equal(isDirectoryDeletionCommand('rmdir test'), true);
  assert.equal(isDirectoryDeletionCommand('mv test test_bak'), true);
  assert.equal(isDirectoryDeletionCommand('git rm -r test'), true);
  assert.equal(isDirectoryDeletionCommand('find test -delete'), true);
  assert.equal(isDirectoryDeletionCommand('echo hi > src/app.mjs'), false);
});

test('enclosingAdlcRoot and readActiveTicketRails load active ticket rails from store', (t) => {
  const repo = makeAdlcRepo(t);
  const gitOnly = mkdtempSync(join(tmpdir(), 'adlc-he-gitonly-'));
  t.after(() => rmSync(gitOnly, { recursive: true, force: true }));
  mkdirSync(join(gitOnly, '.git'), { recursive: true });
  writeFileSync(join(gitOnly, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const root = enclosingAdlcRoot(join(repo, 'src'));
  assert.ok(root);
  const { activeTicket, rails } = readActiveTicketRails(root);
  assert.equal(activeTicket.id, 'T-1');
  assert.deepEqual(rails.sort(), ['packages/core/test/**', 'test/auth.test.mjs']);
  // requireStore defaults to true: a plain git repo with no .adlc store returns null.
  assert.equal(enclosingAdlcRoot(gitOnly), null);
});

test('evaluatePreTool enforces rails across file tools, patch tools, shell commands, and conflicting workdirs', (t) => {
  const repo = makeAdlcRepo(t);
  try {
    // Conflicting working directory arguments fail closed.
    const conflict = evaluatePreTool({
      toolName: 'Bash',
      toolInput: { command: 'git status', cwd: 'src', workdir: 'test' },
      cwd: repo,
    });
    assert.equal(conflict.decision, 'deny');
    assert.match(conflict.reason, /conflicting working directory/);

    // Direct Edit on frozen rail denied; Edit on non-rail allowed.
    assert.equal(
      evaluatePreTool({ toolName: 'Edit', toolInput: { file_path: 'test/auth.test.mjs' }, cwd: repo }).decision,
      'deny',
    );
    assert.equal(
      evaluatePreTool({ toolName: 'Edit', toolInput: { file_path: 'src/app.mjs' }, cwd: repo }).decision,
      'allow',
    );

    // delete_file on ancestor directory of frozen rail denied.
    const delDir = evaluatePreTool({
      toolName: 'delete_file',
      toolInput: { path: 'test' },
      cwd: repo,
    });
    assert.equal(delDir.decision, 'deny');
    assert.match(delDir.reason, /ancestor directory/);

    // Shell read-only allowed; write-option smuggle denied.
    assert.equal(
      evaluatePreTool({ toolName: 'Bash', toolInput: { command: 'git status' }, cwd: repo }).decision,
      'allow',
    );
    assert.equal(
      evaluatePreTool({ toolName: 'Bash', toolInput: { command: 'git diff --output=test/auth.test.mjs' }, cwd: repo }).decision,
      'deny',
    );

    // Shell rm -rf (bare and absolute path) on ancestor directory of frozen rail denied.
    const rmAnc = evaluatePreTool({
      toolName: 'Bash',
      toolInput: { command: 'rm -rf test' },
      cwd: repo,
    });
    assert.equal(rmAnc.decision, 'deny');
    assert.match(rmAnc.reason, /ancestor directory/);

    const absRmAnc = evaluatePreTool({
      toolName: 'Bash',
      toolInput: { command: '/bin/rm -rf test' },
      cwd: repo,
    });
    assert.equal(absRmAnc.decision, 'deny');
    assert.match(absRmAnc.reason, /ancestor directory/);

    assert.equal(
      evaluatePreTool({ toolName: 'Bash', toolInput: { command: 'echo ok > src/app.mjs' }, cwd: repo }).decision,
      'allow',
    );

    // Shell opaque / expansion denied.
    assert.equal(
      evaluatePreTool({ toolName: 'Bash', toolInput: { command: 'rm -rf $TARGET' }, cwd: repo }).decision,
      'deny',
    );

    // apply_patch targeting frozen rail denied; non-rail allowed.
    assert.equal(
      evaluatePreTool({
        toolName: 'apply_patch',
        toolInput: { patch: '*** Update File: test/auth.test.mjs\n@@\n' },
        cwd: repo,
      }).decision,
      'deny',
    );
    assert.equal(
      evaluatePreTool({
        toolName: 'apply_patch',
        toolInput: { patch: '*** Update File: src/app.mjs\n@@\n' },
        cwd: repo,
      }).decision,
      'allow',
    );

    // Unknown/novel structured mutators and pathless Edit fail closed; Read is allowed.
    assert.equal(
      evaluatePreTool({ toolName: 'modify_file', toolInput: { file_path: 'test/auth.test.mjs' }, cwd: repo }).decision,
      'deny',
    );
    assert.equal(
      evaluatePreTool({ toolName: 'Edit', toolInput: {}, cwd: repo }).decision,
      'deny',
    );
    assert.equal(
      evaluatePreTool({ toolName: 'custom_unknown_tool', toolInput: { x: 1 }, cwd: repo }).decision,
      'deny',
    );
    assert.equal(
      evaluatePreTool({ toolName: 'Read', toolInput: { file_path: 'test/auth.test.mjs' }, cwd: repo }).decision,
      'allow',
    );

    // Invalid active-ticket pointer fails closed on mutating calls.
    writeFileSync(join(repo, '.adlc', 'current-ticket.json'), '{not-json');
    const badPtr = evaluatePreTool({ toolName: 'Edit', toolInput: { file_path: 'src/app.mjs' }, cwd: repo });
    assert.equal(badPtr.decision, 'deny');
    assert.match(badPtr.reason, /trust-state error/);

    // Stale ticketHash or unknown ticket in pointer fails closed.
    writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-1', ticketHash: '0'.repeat(64) }));
    const stalePtr = evaluatePreTool({ toolName: 'Edit', toolInput: { file_path: 'src/app.mjs' }, cwd: repo });
    assert.equal(stalePtr.decision, 'deny');
    assert.match(stalePtr.reason, /trust-state error/);

    // Conflicting ADLC_TICKET env fails closed.
    rmSync(join(repo, '.adlc', 'current-ticket.json'), { force: true });
    const missingEnv = evaluatePreTool({
      toolName: 'Edit',
      toolInput: { file_path: 'src/app.mjs' },
      cwd: repo,
      env: { ...process.env, ADLC_TICKET: 'T-UNKNOWN' },
    });
    assert.equal(missingEnv.decision, 'deny');
    assert.match(missingEnv.reason, /trust-state error/);

    // Corrupt ticket store fails closed on mutating calls.
    writeFileSync(join(repo, '.adlc', 'tickets.json'), '{corrupt');
    const badStore = evaluatePreTool({ toolName: 'Edit', toolInput: { file_path: 'src/app.mjs' }, cwd: repo });
    assert.equal(badStore.decision, 'deny');
    assert.match(badStore.reason, /trust-state error/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
