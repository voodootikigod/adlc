import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import {
  canonicalizeExisting,
  findAdlcRoot,
  anchorPath,
  resolveWorkspaceRoot,
  extractCwdFromArgs,
  isUnauthorizedWorkspaceEscape,
  isReadonlyCommand,
  isVerificationCommand,
} from '../hooks/adlc-rails-guard.mjs';
import { loadTickets } from '../core-inline.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function repoWithAdlc(t) {
  const root = tmp(t, 'gemini-root-');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), '{"tickets":[]}');
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

test('findAdlcRoot walks up to the .adlc/ ancestor', (t) => {
  const root = repoWithAdlc(t);
  assert.equal(findAdlcRoot(join(root, 'src', 'a.js')), root);
});
test('findAdlcRoot returns null when no .adlc up-tree', (t) => {
  const root = tmp(t, 'gemini-root-');
  assert.equal(findAdlcRoot(join(root, 'a.js')), null);
});
test('anchorPath keeps an absolute path as-is', () => {
  const r = anchorPath('/abs/a.js', {});
  assert.deepEqual(r, { abs: '/abs/a.js', anchored: true });
});
test('anchorPath anchors a relative path via workspacePaths[0]', () => {
  const r = anchorPath('src/a.js', { workspacePaths: ['/ws'] });
  assert.deepEqual(r, { abs: join('/ws', 'src/a.js'), anchored: true });
});
test('anchorPath cannot anchor a relative path with empty workspacePaths', () => {
  const r = anchorPath('src/a.js', { workspacePaths: [] });
  assert.equal(r.anchored, false);
});

test('findAdlcRoot and resolveWorkspaceRoot prefer nested git worktrees and ignore stale PWD/INIT_CWD', (t) => {
  const primary = repoWithAdlc(t);
  git(primary, 'init', '-b', 'main');
  writeFileSync(join(primary, 'README.md'), '# primary\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init');

  const lane = join(primary, '.worktrees', 'lane-1');
  git(primary, 'worktree', 'add', '-b', 'lane-1', lane);
  mkdirSync(join(lane, 'src'), { recursive: true });

  assert.equal(realpathSync(findAdlcRoot(join(lane, 'src', 'file.js'))), realpathSync(lane));
  assert.equal(
    realpathSync(
      resolveWorkspaceRoot(
        { workspacePaths: [primary], cwd: join(lane, 'src') },
        { INIT_CWD: primary, PWD: primary }
      )
    ),
    realpathSync(lane)
  );
  assert.equal(
    realpathSync(resolveWorkspaceRoot({}, { AGY_WORKSPACE: lane, INIT_CWD: primary, PWD: primary })),
    realpathSync(lane)
  );
});

test('extractCwdFromArgs and isVerificationCommand support Gemini CLI dir_path and headless single-root Cwd omission', (t) => {
  const root = repoWithAdlc(t);
  assert.equal(extractCwdFromArgs({ dir_path: root }), root);
  assert.equal(extractCwdFromArgs({ working_directory: root }), root);
  assert.equal(isVerificationCommand('npm test', { root, toolArgs: {}, allowImplicitCwd: true }), true);
  assert.equal(isVerificationCommand('npm test', { root, toolArgs: {}, allowImplicitCwd: false }), false);
  assert.equal(isVerificationCommand('npm test', { root, toolArgs: { Cwd: join(root, 'src') }, allowImplicitCwd: true }), false);
  assert.equal(isVerificationCommand('npm test', { root, toolArgs: { dir_path: root }, allowImplicitCwd: false }), true);
});

test('isUnauthorizedWorkspaceEscape allows in-repo /home paths and /dev/null while blocking escapes', () => {
  const linuxRoot = '/home/dev/projects/adlc';
  assert.equal(
    isUnauthorizedWorkspaceEscape(`node ${linuxRoot}/packages/cli/bin/adlc.mjs status 2>/dev/null`, { root: linuxRoot }),
    false
  );
  assert.equal(
    isUnauthorizedWorkspaceEscape('git diff HEAD~1', { root: linuxRoot }),
    false
  );
  assert.equal(
    isUnauthorizedWorkspaceEscape('cat /home/dev/.ssh/id_rsa', { root: linuxRoot }),
    true
  );
  assert.equal(
    isUnauthorizedWorkspaceEscape('cat /etc/passwd', { root: linuxRoot }),
    true
  );
  assert.equal(
    isUnauthorizedWorkspaceEscape('cat ../outside.txt', { root: linuxRoot }),
    true
  );
  assert.equal(
    isUnauthorizedWorkspaceEscape('cat ~/secret.txt', { root: linuxRoot }),
    true
  );
});

test('isReadonlyCommand allows grep and rg within workspace root and loadTickets resolves store root', (t) => {
  const root = repoWithAdlc(t);
  writeFileSync(join(root, 'src', 'a.js'), 'const x = 1;\n');
  assert.equal(isReadonlyCommand('grep -n const src/a.js', { root }), true);
  assert.equal(isReadonlyCommand('rg const src/a.js', { root }), true);
  assert.equal(isReadonlyCommand('grep const ../escape.js', { root }), false);

  const loaded = loadTickets(join(root, '.adlc', 'tickets.json'));
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.tickets, []);

  // Backslash-separated conventional path, sharded path, custom path, and invalid non-string/blank paths
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T-1', title: 'One' }] }));
  const backslashLoaded = loadTickets(`${root}\\.adlc\\tickets.json`);
  assert.deepEqual(backslashLoaded.errors, []);
  assert.equal(backslashLoaded.tickets.length, 1);

  const customPath = join(root, 'src', 'custom-store.json');
  writeFileSync(customPath, JSON.stringify({ tickets: [{ id: 'T-CUSTOM', title: 'Custom' }] }));
  const customLoaded = loadTickets(customPath);
  assert.deepEqual(customLoaded.errors, []);
  assert.equal(customLoaded.tickets[0]?.id, 'T-CUSTOM');

  assert.equal(loadTickets(null).errors.length, 1);
  assert.equal(loadTickets('   ').errors.length, 1);
  assert.equal(canonicalizeExisting(null), null);
  assert.equal(canonicalizeExisting(''), '');
  assert.equal(canonicalizeExisting(root), realpathSync(root));
});
