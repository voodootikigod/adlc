import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import {
  canonicalizeExisting,
  decide,
  discoverRootFromTranscriptRecords,
  findAdlcRoot,
  anchorPath,
  resolveWorkspaceRoot,
  extractCwdFromArgs,
  isUnauthorizedWorkspaceEscape,
  isReadonlyCommand,
  isVerificationCommand,
  onStop,
  postToolUse,
  runFromStdin,
} from '../hooks/adlc-rails-guard.mjs';
import { resolveTranscriptPath } from '../flail-inline.mjs';
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

test('resolveWorkspaceRoot, discoverRootFromTranscriptRecords, and lifecycle hooks handle nested worktree tool Cwd/dir_path', (t) => {
  const primary = repoWithAdlc(t);
  writeFileSync(
    join(primary, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T-WT', title: 'WT', rails: ['src/frozen.js'] }] })
  );
  writeFileSync(join(primary, 'src', 'frozen.js'), 'export const f = 1;\n');
  mkdirSync(join(primary, 'test'), { recursive: true });
  writeFileSync(join(primary, 'test', 'ok.test.mjs'), 'import { test } from "node:test"; test("ok", () => {});\n');
  git(primary, 'init', '-b', 'main');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-m', 'init');

  const lane = join(primary, '.worktrees', 'lane-wt');
  git(primary, 'worktree', 'add', '-b', 'lane-wt', lane);
  writeFileSync(join(lane, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-WT' }));

  // Tool-level Cwd / dir_path upgrades outer workspacePaths[0] to nested worktree
  assert.equal(
    realpathSync(
      resolveWorkspaceRoot(
        {
          workspacePaths: [primary],
          toolCall: { name: 'run_shell_command', args: { command: 'npm test', dir_path: '.worktrees/lane-wt' } },
        },
        {}
      )
    ),
    realpathSync(lane)
  );
  assert.equal(
    realpathSync(
      resolveWorkspaceRoot(
        {
          toolCall: { name: 'run_shell_command', args: { command: 'npm test', working_directory: lane } },
        },
        {}
      )
    ),
    realpathSync(lane)
  );

  // Transcript discovery supports dir_path, working_directory, and relative worktree paths with anchorBase
  assert.equal(
    realpathSync(
      discoverRootFromTranscriptRecords(
        [{ toolCalls: [{ name: 'run_shell_command', args: { command: 'npm test', dir_path: lane } }] }],
        {}
      )
    ),
    realpathSync(lane)
  );
  assert.equal(
    realpathSync(
      discoverRootFromTranscriptRecords(
        [{ toolCalls: [{ name: 'run_shell_command', args: { command: 'npm test', working_directory: '.worktrees/lane-wt' } }] }],
        {},
        { anchorBase: primary }
      )
    ),
    realpathSync(lane)
  );

  // Transcript discovery does NOT let a later unrelated checkout hijack the established root
  const unrelatedRepo = repoWithAdlc(t);
  git(unrelatedRepo, 'init', '-b', 'main');
  assert.equal(
    realpathSync(
      discoverRootFromTranscriptRecords(
        [
          { toolCalls: [{ name: 'write_to_file', args: { TargetFile: join(lane, 'src', 'impl.js') } }] },
          { toolCalls: [{ name: 'read_file', args: { Path: join(unrelatedRepo, 'src', 'other.js') } }] },
        ],
        {}
      )
    ),
    realpathSync(lane)
  );

  // Structured edit with escaping Cwd or relative ../ TargetFile is DENIED under enforcement
  const outsideTmp = tmp(t, 'gemini-escape-cwd-');
  const escapeCwdVerdict = decide(
    {
      workspacePaths: [primary],
      toolCall: { name: 'write_to_file', args: { TargetFile: 'escape.mjs', Cwd: outsideTmp, CodeContent: 'x' } },
    },
    { env: { ADLC_P4_ENFORCEMENT: '1' } }
  );
  assert.equal(escapeCwdVerdict.allow_tool, false);

  const escapeRelVerdict = decide(
    {
      workspacePaths: [primary],
      toolCall: { name: 'write_to_file', args: { TargetFile: '../../../escape.mjs', Cwd: lane, CodeContent: 'x' } },
    },
    { env: { ADLC_P4_ENFORCEMENT: '1' } }
  );
  assert.equal(escapeRelVerdict.allow_tool, false);

  // Full PreToolUse -> PostToolUse -> Stop lifecycle with real brain transcript path, outer workspacePaths[0],
  // initial outer read_file, structured edit using { TargetFile: 'src/impl.js', Cwd: lane }, and nested test run
  const home = tmp(t, 'gemini-wt-home-');
  const conversationId = '11111111-1111-4111-8111-111111111111';
  const appDataDir = join(home, '.gemini', 'antigravity-cli');
  const transcriptDir = join(appDataDir, 'brain', conversationId, '.system_generated', 'logs');
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, 'transcript.jsonl');
  const env = {
    ADLC_P4_ENFORCEMENT: '1',
    HOME: home,
    ANTIGRAVITY_APP_DATA_DIR: appDataDir,
    ANTIGRAVITY_CONVERSATION_ID: conversationId,
  };

  const initialRead = { name: 'read_file', args: { Path: join(primary, 'src', 'frozen.js') } };
  writeFileSync(transcriptPath, `${JSON.stringify({ status: 'DONE', toolCalls: [initialRead] })}\n`);
  assert.equal(realpathSync(resolveTranscriptPath({ conversationId, env })), realpathSync(transcriptPath));

  runFromStdin(JSON.stringify({ workspacePaths: [primary], conversationId, transcriptPath, toolCall: initialRead }), env);
  postToolUse({ workspacePaths: [primary], conversationId, transcriptPath, exitCode: 0 }, { env });

  const editCall = {
    workspacePaths: [primary],
    conversationId,
    transcriptPath,
    toolCall: { name: 'write_to_file', args: { TargetFile: 'src/impl.js', Cwd: lane, CodeContent: 'export const x = 2;\n' } },
  };
  const preEdit = runFromStdin(JSON.stringify(editCall), env);
  assert.equal(preEdit.allow_tool, true, preEdit.deny_reason);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ status: 'DONE', toolCalls: [initialRead] })}\n` +
      `${JSON.stringify({ status: 'DONE', toolCalls: [editCall.toolCall] })}\n`
  );
  postToolUse({ workspacePaths: [primary], conversationId, transcriptPath, exitCode: 0 }, { env });

  // Prove onStop is genuinely exercising transcript verification on `lane`: BEFORE running tests, onStop MUST reject!
  const prematureStop = onStop({ workspacePaths: [primary], conversationId, transcriptPath }, { env });
  assert.equal(prematureStop.decision, 'continue');
  assert.match(prematureStop.reason ?? '', /unverified file edits/);

  const testCall = {
    workspacePaths: [primary],
    conversationId,
    transcriptPath,
    toolCall: { name: 'run_shell_command', args: { command: 'npm test', dir_path: '.worktrees/lane-wt' } },
  };
  const preTest = runFromStdin(JSON.stringify(testCall), env);
  assert.equal(preTest.allow_tool, true, preTest.deny_reason);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ status: 'DONE', toolCalls: [initialRead] })}\n` +
      `${JSON.stringify({ status: 'DONE', toolCalls: [editCall.toolCall] })}\n` +
      `${JSON.stringify({ status: 'DONE', exitCode: 0, content: 'pass 1', toolCalls: [testCall.toolCall] })}\n`
  );
  postToolUse({ workspacePaths: [primary], conversationId, transcriptPath, exitCode: 0 }, { env });

  const stopRes = onStop({ workspacePaths: [primary], conversationId, transcriptPath }, { env });
  assert.equal(stopRes.decision, 'stop', stopRes.reason);

  // Also prove record-derived checkout wins when headless transcript file resides inside a different ADLC repo
  const foreignTranscript = join(unrelatedRepo, 'foreign-transcript.jsonl');
  const foreignConvId = '22222222-2222-4222-8222-222222222222';
  const foreignEnv = {
    ADLC_P4_ENFORCEMENT: '1',
    HOME: home,
    ANTIGRAVITY_APP_DATA_DIR: unrelatedRepo,
    ANTIGRAVITY_CONVERSATION_ID: foreignConvId,
  };
  writeFileSync(foreignTranscript, '');
  const foreignEdit = { name: 'write_to_file', args: { TargetFile: join(lane, 'src', 'impl2.js'), CodeContent: 'export const y = 3;\n' } };
  runFromStdin(JSON.stringify({ conversationId: foreignConvId, transcriptPath: foreignTranscript, toolCall: foreignEdit }), foreignEnv);
  writeFileSync(foreignTranscript, `${JSON.stringify({ status: 'DONE', toolCalls: [foreignEdit] })}\n`);
  postToolUse({ conversationId: foreignConvId, transcriptPath: foreignTranscript, exitCode: 0 }, { env: foreignEnv });
  const foreignStop = onStop({ conversationId: foreignConvId, transcriptPath: foreignTranscript }, { env: foreignEnv });
  assert.equal(foreignStop.decision, 'continue');
  assert.match(foreignStop.reason ?? '', /unverified file edits/);
});
