import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync, readFileSync, utimesSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as hookEngine from '../index.mjs';
import * as cliGemini from '../lib/cli-gemini.mjs';
import { evaluatePreTool, resolveActiveTicketId } from '../lib/pretool.mjs';
import { resolveTranscriptPath } from '../lib/flail-transcript.mjs';
import {
  classifyTool, isReadonlyCommand, isVerificationCommand, isSecretStatePath, isTrustRootOrSecretPath,
} from '../lib/command-verify.mjs';
import {
  createPersistentTracker, verifyPreExistingTestFiles, judgeStaleLock, reclaimJudgedLock, LOCK_TTL_MS,
} from '../lib/session-tracker.mjs';
import { decide, runFromStdin, preInvocation, postToolUse, onStop } from '../lib/gemini-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(HERE, '..', 'lib');

function makeFixtureRepo(t, { tickets, activeId = 'T-1' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-he-gemini-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'adlc-he-home-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  const ticketList = tickets ?? [{
    id: 'T-1',
    title: 'Gemini guard fixture',
    completed: false,
    scope: ['src/**', 'test/in-scope.test.mjs'],
    rails: ['test/frozen.test.mjs'],
  }];
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: ticketList }, null, 2));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const v = 1;\n');
  writeFileSync(join(dir, 'test', 'in-scope.test.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'test', 'out-of-scope.test.mjs'), 'export const b = 1;\n');
  writeFileSync(join(dir, 'test', 'frozen.test.mjs'), 'export const c = 1;\n');
  const env = {
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    ADLC_P4_ENFORCEMENT: '1',
    ADLC_TICKET: activeId,
    AGY_WORKSPACE: dir,
  };
  return { dir, fakeHome, env };
}

test('every .mjs file in packages/hook-engine/lib/ is strictly under 400 lines (and specific budgets)', () => {
  const files = readdirSync(LIB_DIR).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length >= 9);
  for (const f of files) {
    const lines = readFileSync(join(LIB_DIR, f), 'utf8').split('\n').length;
    assert.ok(lines < 400, `${f} has ${lines} lines (must be < 400)`);
    if (f === 'protocol-adapters.mjs') assert.ok(lines < 300, `${f} has ${lines} lines (must be < 300)`);
    if (f === 'command-verify.mjs') assert.ok(lines < 350, `${f} has ${lines} lines (must be < 350)`);
    if (f === 'cli-gemini.mjs') assert.ok(lines < 150, `${f} has ${lines} lines (must be < 150)`);
  }
});

test('index.mjs and cli-gemini.mjs re-export all public Gemini runtime symbols', () => {
  for (const sym of [
    'decide', 'preInvocation', 'postToolUse', 'onStop', 'runFromStdin',
    'printStatus', 'printDoctor', 'checkRail', 'findAdlcRoot', 'anchorPath',
    'extractToolName', 'extractArgs', 'extractFilePaths', 'canonicalizeExisting',
    'resolveTranscriptPath', 'verifyPreExistingTestFiles', 'resolveActiveTicketId',
  ]) {
    assert.equal(typeof hookEngine[sym], 'function', `index.mjs missing ${sym}`);
    assert.equal(typeof cliGemini[sym], 'function', `cli-gemini.mjs missing ${sym}`);
  }
  assert.equal(typeof cliGemini.main, 'function');
});

test('resolveActiveTicketId satisfies CONFLICT_ADAPTERS contract and pretool handles PascalCase & file:// URIs', (t) => {
  const { dir } = makeFixtureRepo(t);
  // Absent pointer + no env => inert
  assert.deepEqual(resolveActiveTicketId(dir, {}), { id: null, conflict: false, code: null, message: null, ticketHash: null });
  // Env-only resolves
  assert.equal(resolveActiveTicketId(dir, { ADLC_TICKET: 'T-1' }).id, 'T-1');
  // Unrecognized pointer key fails closed
  writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ tickett: 'T-1' }));
  const bad = resolveActiveTicketId(dir, {});
  assert.equal(bad.conflict, true);
  assert.equal(bad.id, null);
  assert.equal(bad.code, 'INVALID_CURRENT_TICKET');
  assert.ok(bad.message.length > 0);
  // Conflict between env and pointer fails closed
  writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-2' }));
  const conf = resolveActiveTicketId(dir, { ADLC_TICKET: 'T-1' });
  assert.equal(conf.conflict, true);
  assert.equal(conf.code, 'ACTIVE_TICKET_CONFLICT');
  rmSync(join(dir, '.adlc', 'current-ticket.json'), { force: true });

  // PascalCase TargetFile & file:// URI hit frozen rail
  const pascalHit = evaluatePreTool({
    toolName: 'write_to_file',
    toolInput: { TargetFile: 'test/frozen.test.mjs' },
    cwd: dir,
    rails: ['test/frozen.test.mjs'],
  });
  assert.equal(pascalHit.decision, 'deny');

  const uriHit = evaluatePreTool({
    toolName: 'write_to_file',
    toolInput: { TargetFile: pathToFileURL(join(dir, 'test', 'frozen.test.mjs')).href },
    cwd: dir,
    rails: ['test/frozen.test.mjs'],
  });
  assert.equal(uriHit.decision, 'deny');
});

test('resolveTranscriptPath supports antigravity-cli and flat/nested jetski paths while rejecting symlinks & traversal', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'adlc-he-tr-'));
  const outside = mkdtempSync(join(tmpdir(), 'adlc-he-out-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const env = { HOME: home, USERPROFILE: home };

  // Flat ~/.gemini/jetski/brain/<cid>/.system_generated/logs/transcript.jsonl
  const flatDir = join(home, '.gemini', 'jetski', 'brain', 'cid-flat', '.system_generated', 'logs');
  mkdirSync(flatDir, { recursive: true });
  const flatFile = join(flatDir, 'transcript.jsonl');
  writeFileSync(flatFile, '{"type":"USER_INPUT"}\n');
  assert.equal(resolveTranscriptPath({ conversationId: 'cid-flat', env }), flatFile);

  // Nested ~/.gemini/jetski/brain/v1/sub/<cid>/.system_generated/logs/transcript.jsonl
  const nestedDir = join(home, '.gemini', 'jetski', 'brain', 'v1', 'sub', 'cid-nested', '.system_generated', 'logs');
  mkdirSync(nestedDir, { recursive: true });
  const nestedFile = join(nestedDir, 'transcript.jsonl');
  writeFileSync(nestedFile, '{"type":"USER_INPUT"}\n');
  assert.equal(resolveTranscriptPath({ conversationId: 'cid-nested', env }), nestedFile);

  // Symlink transcript rejected
  const outsideFile = join(outside, 'transcript.jsonl');
  writeFileSync(outsideFile, '{"type":"USER_INPUT"}\n');
  const symDir = join(home, '.gemini', 'jetski', 'brain', 'cid-sym', '.system_generated', 'logs');
  mkdirSync(symDir, { recursive: true });
  const symFile = join(symDir, 'transcript.jsonl');
  symlinkSync(outsideFile, symFile);
  assert.equal(resolveTranscriptPath({ conversationId: 'cid-sym', env }), null);
  assert.equal(resolveTranscriptPath({ payload: { transcriptPath: symFile }, env }), null);

  // Outside-root direct path and .. traversal rejected
  assert.equal(resolveTranscriptPath({ payload: { transcriptPath: outsideFile }, env }), null);
  assert.equal(resolveTranscriptPath({ payload: { transcriptPath: join(flatDir, '..', '..', '..', 'outside', 'transcript.jsonl') }, env }), null);
  assert.equal(resolveTranscriptPath({ conversationId: '../escape', env }), null);
});

test('command-verify classifies MCP read-only tools, ask_permission, secret paths, and stale locks', (t) => {
  const { dir, fakeHome, env } = makeFixtureRepo(t);
  assert.equal(classifyTool('ask_permission', { message: 'ok?' }), 'readonly');
  assert.equal(classifyTool('call_mcp_tool', { ServerName: 'codegraph', ToolName: 'codegraph_explore', Arguments: { query: 'foo' } }), 'readonly');
  assert.equal(classifyTool('call_mcp_tool', { ServerName: 'custom', ToolName: 'write_record', Arguments: { TargetFile: 'x' } }), 'mutating');
  assert.equal(isReadonlyCommand('git status', { root: dir, env }), true);
  assert.equal(isVerificationCommand('node --test', { root: dir, toolArgs: { Cwd: dir } }), true);
  assert.equal(isSecretStatePath(join(fakeHome, '.config', 'adlc', 'secrets', '.auth-key'), env), true);
  assert.equal(isTrustRootOrSecretPath(join(dir, 'node_modules', '.bin', 'vitest'), env), true);

  // Stale lock judgment and reclamation
  const lockDir = join(dir, '.adlc', 'sessions.lock');
  mkdirSync(lockDir, { recursive: true });
  const oldTime = new Date(Date.now() - LOCK_TTL_MS - 5000);
  utimesSync(lockDir, oldTime, oldTime);
  const judged = judgeStaleLock(lockDir);
  assert.ok(judged);
  assert.equal(reclaimJudgedLock(lockDir, judged), true);
});

test('decide enforces deny > force_ask > ask > pass lattice for rails, .adlc/.booster, interactive vs headless shell', (t) => {
  const { dir, env } = makeFixtureRepo(t);

  // Clean in-scope edit -> pass with allow_tool: true
  const clean = decide({
    toolCall: { name: 'write_to_file', args: { TargetFile: join(dir, 'src', 'app.mjs') } },
    workspacePaths: [dir],
    conversationId: 'conv-1',
  }, { env });
  assert.equal(clean.decision, 'pass');
  assert.equal(clean.allow_tool, true);

  // Frozen rail -> deny
  const railDeny = decide({
    toolCall: { name: 'write_to_file', args: { TargetFile: join(dir, 'test', 'frozen.test.mjs') } },
    workspacePaths: [dir],
    conversationId: 'conv-1',
  }, { env });
  assert.equal(railDeny.decision, 'deny');
  assert.equal(railDeny.allow_tool, false);
  assert.ok(railDeny.deny_reason);

  // Protected .adlc/** and .booster/** -> deny
  const adlcDeny = decide({
    toolCall: { name: 'write_to_file', args: { TargetFile: join(dir, '.adlc', 'tickets.json') } },
    workspacePaths: [dir],
  }, { env });
  assert.equal(adlcDeny.decision, 'deny');

  const boosterDeny = decide({
    toolCall: { name: 'write_to_file', args: { TargetFile: join(dir, '.booster', 'state.json') } },
    workspacePaths: [dir],
  }, { env });
  assert.equal(boosterDeny.decision, 'deny');

  // Interactive ambiguous shell -> force_ask; headless ADLC_HEADLESS=1 -> deny
  const ambigPayload = {
    toolCall: { name: 'run_command', args: { CommandLine: 'node scripts/custom-mutation.mjs', Cwd: dir } },
    workspacePaths: [dir],
    conversationId: 'conv-1',
  };
  const interactive = decide(ambigPayload, { env });
  assert.equal(interactive.decision, 'force_ask');
  assert.equal(interactive.allow_tool, false);

  const headless = decide(ambigPayload, { env: { ...env, ADLC_HEADLESS: '1' } });
  assert.equal(headless.decision, 'deny');
  assert.equal(headless.allow_tool, false);

  // Out-of-workspace mutation: interactive -> force_ask, headless -> deny
  const outPayload = {
    toolCall: { name: 'write_to_file', args: { TargetFile: '/tmp/outside-file.txt' } },
    workspacePaths: [dir],
  };
  assert.equal(decide(outPayload, { env }).decision, 'force_ask');
  assert.equal(decide(outPayload, { env: { ...env, ADLC_HEADLESS: '1' } }).decision, 'deny');
});

test('onStop allows editing in-scope non-railed pre-existing test files after verification passes, and blocks out-of-scope or railed test edits/deletions', (t) => {
  const { dir, fakeHome, env } = makeFixtureRepo(t);
  const sid = 'stop-scope-test';
  const trDir = join(fakeHome, '.gemini', 'jetski', 'brain', sid, '.system_generated', 'logs');
  mkdirSync(trDir, { recursive: true });
  const trFile = join(trDir, 'transcript.jsonl');

  // Seed transcript with edit + passing verification test
  writeFileSync(trFile, [
    JSON.stringify({ toolCall: { name: 'write_to_file', args: { TargetFile: join(dir, 'test', 'in-scope.test.mjs') } } }),
    JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: dir } }, exitCode: 0, status: 'DONE' }),
  ].join('\n') + '\n');

  // Record initial baseline via preInvocation and execute tool calls via runFromStdin
  const pre = preInvocation({ workspacePaths: [dir], conversationId: sid }, { env });
  assert.equal(pre.injectSteps.length, 1);
  runFromStdin(JSON.stringify({ workspacePaths: [dir], conversationId: sid, toolCall: { name: 'write_to_file', args: { TargetFile: join(dir, 'test', 'in-scope.test.mjs') } } }), env);
  runFromStdin(JSON.stringify({ workspacePaths: [dir], conversationId: sid, toolCall: { name: 'run_command', args: { CommandLine: 'node --test', Cwd: dir } } }), env);

  // 1. Modify in-scope non-railed pre-existing test file -> onStop ALLOWS ('stop')
  writeFileSync(join(dir, 'test', 'in-scope.test.mjs'), 'export const a = 2;\n');
  const stopOk = onStop({ workspacePaths: [dir], conversationId: sid }, { env });
  assert.equal(stopOk.decision, 'stop', `expected stop, got ${JSON.stringify(stopOk)}`);

  // 2. Modify out-of-scope pre-existing test file -> onStop BLOCKS ('continue')
  writeFileSync(join(dir, 'test', 'out-of-scope.test.mjs'), 'export const b = 2;\n');
  const stopOutOfScope = onStop({ workspacePaths: [dir], conversationId: sid }, { env });
  assert.equal(stopOutOfScope.decision, 'continue');
  assert.match(stopOutOfScope.reason, /outside active ticket scope/);
  writeFileSync(join(dir, 'test', 'out-of-scope.test.mjs'), 'export const b = 1;\n');

  // 3. Modify railed pre-existing test file -> onStop BLOCKS ('continue')
  writeFileSync(join(dir, 'test', 'frozen.test.mjs'), 'export const c = 2;\n');
  const stopRail = onStop({ workspacePaths: [dir], conversationId: sid }, { env });
  assert.equal(stopRail.decision, 'continue');
  assert.match(stopRail.reason, /frozen rails/);
  writeFileSync(join(dir, 'test', 'frozen.test.mjs'), 'export const c = 1;\n');

  // 4. Delete pre-existing test file -> onStop BLOCKS ('continue')
  rmSync(join(dir, 'test', 'in-scope.test.mjs'));
  const stopDel = onStop({ workspacePaths: [dir], conversationId: sid }, { env });
  assert.equal(stopDel.decision, 'continue');
  assert.match(stopDel.reason, /deleted or renamed/);

  // Direct verifyPreExistingTestFiles unit assertion (railed even if in scope)
  const tracker = createPersistentTracker(dir, env);
  const directCheck = verifyPreExistingTestFiles(dir, { 'test/frozen.test.mjs': 'oldhash' }, {
    scope: ['test/**'],
    rails: ['test/frozen.test.mjs'],
  });
  assert.equal(directCheck.ok, false);
  assert.match(directCheck.reason, /frozen rails/);
  assert.ok(tracker);
});

test('runFromStdin and postToolUse execute cleanly', (t) => {
  const { dir, env } = makeFixtureRepo(t);
  const res = runFromStdin(JSON.stringify({
    toolCall: { name: 'write_to_file', args: { TargetFile: join(dir, 'src', 'app.mjs') } },
    workspacePaths: [dir],
    conversationId: 'stdin-1',
  }), env);
  assert.equal(res.decision, 'pass');
  assert.equal(res.allow_tool, true);

  const post = postToolUse({ workspacePaths: [dir], conversationId: 'stdin-1', exitCode: 0, output: 'ok' }, { env });
  assert.equal(post.decision, 'pass');
});
