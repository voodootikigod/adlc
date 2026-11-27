import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evaluatePreTool,
  readActiveTicketRails,
  harvestTranscriptUsage,
  evaluateStop,
  normalizeHookInput,
} from '../index.mjs';
import { detectTicketStore } from '@adlc/tickets';

function makeTestRepo(t, { withActiveTicket = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-he-scoped-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(dir, '.adlc'), { recursive: true });

  const tickets = [
    {
      id: 'T-ACTIVE',
      title: 'Active Ticket',
      completed: false,
      rails: ['test/active.test.mjs'],
    },
    {
      id: 'T-BACKLOG',
      title: 'Backlog Ticket',
      completed: false,
      rails: ['test/backlog.test.mjs'],
    },
  ];

  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));

  if (withActiveTicket) {
    // In detectTicketStore, json store hashes tickets. We can calculate or retrieve snapshot hash, or pass env: { ADLC_TICKET: 'T-ACTIVE' }
    // Or write current-ticket.json with ticketHash
    const store = detectTicketStore({ root: dir, allowRecovery: true, env: {} });
    const snap = store.load();
    const ticketHash = snap.ticketHashes['T-ACTIVE'];
    writeFileSync(
      join(dir, '.adlc', 'current-ticket.json'),
      JSON.stringify({ id: 'T-ACTIVE', ticketHash }),
    );
  }

  mkdirSync(join(dir, 'test'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'test', 'active.test.mjs'), '// active rail\n');
  writeFileSync(join(dir, 'test', 'backlog.test.mjs'), '// backlog rail\n');
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const a = 1;\n');

  return dir;
}

test('Objective 1: NON_FS_UI_TOOL_NAMES and boundTicket semantics in evaluatePreTool', (t) => {
  const boundRepo = makeTestRepo(t, { withActiveTicket: true });
  const unboundRepo = makeTestRepo(t, { withActiveTicket: false });

  // 1. readActiveTicketRails reports boundTicket: true when current-ticket is resolved (and ok: true on empty root)
  assert.equal(readActiveTicketRails('', { env: {} }).ok, true);
  const boundRails = readActiveTicketRails(boundRepo, { env: {} });
  assert.equal(boundRails.boundTicket, true);
  assert.equal(boundRails.activeTicket.id, 'T-ACTIVE');

  // 2. readActiveTicketRails reports boundTicket: false when no current-ticket pointer exists
  const unboundRails = readActiveTicketRails(unboundRepo, { env: {} });
  assert.equal(unboundRails.boundTicket, false);
  assert.equal(unboundRails.rails.includes('test/backlog.test.mjs'), true);

  // 3. evaluatePreTool allows NON_FS_UI_TOOL_NAMES (e.g. update_steps) ONLY when boundTicket === false
  const allowUI = evaluatePreTool({
    toolName: 'update_steps',
    cwd: unboundRepo,
    env: {},
  });
  assert.equal(allowUI.decision, 'allow');

  const denyUIBound = evaluatePreTool({
    toolName: 'update_steps',
    cwd: boundRepo,
    env: {},
  });
  assert.equal(denyUIBound.decision, 'deny');

  // 4. Defaulting boundTicket = opts.boundTicket ?? true when caller passes explicit rails
  const denyExplicit = evaluatePreTool({
    toolName: 'update_steps',
    rails: ['test/something.mjs'],
  });
  assert.equal(denyExplicit.decision, 'deny');

  const allowExplicitUnbound = evaluatePreTool({
    toolName: 'update_steps',
    rails: ['test/something.mjs'],
    boundTicket: false,
  });
  assert.equal(allowExplicitUnbound.decision, 'allow');

  // 5. Ambient backlog rails STILL deny file mutations & shell mutations even when boundTicket === false!
  const denyBacklogEdit = evaluatePreTool({
    toolName: 'Edit',
    toolInput: { file_path: 'test/backlog.test.mjs' },
    cwd: unboundRepo,
    env: {},
  });
  assert.equal(denyBacklogEdit.decision, 'deny');
  assert.match(denyBacklogEdit.reason, /test\/backlog\.test\.mjs/);

  const denyBacklogBash = evaluatePreTool({
    toolName: 'Bash',
    toolInput: { command: 'echo x > test/backlog.test.mjs' },
    cwd: unboundRepo,
    env: {},
  });
  assert.equal(denyBacklogBash.decision, 'deny');

  // Non-rail edit in unbound repo is allowed
  const allowAppEdit = evaluatePreTool({
    toolName: 'Edit',
    toolInput: { file_path: 'src/app.mjs' },
    cwd: unboundRepo,
    env: {},
  });
  assert.equal(allowAppEdit.decision, 'allow');
});

test('Objective 2: normalizeHookInput extracts transcriptPath', () => {
  const p1 = normalizeHookInput('claude-code', {
    transcript_path: '/tmp/session-1.jsonl',
  });
  assert.equal(p1.transcriptPath, '/tmp/session-1.jsonl');

  const p2 = normalizeHookInput('gemini', {
    transcriptPath: '  /tmp/session-2.json  ',
  });
  assert.equal(p2.transcriptPath, '/tmp/session-2.json');

  const p3 = normalizeHookInput('copilot', {});
  assert.equal(p3.transcriptPath, null);
});

test('Objective 3: harvestTranscriptUsage extracts usage from Claude, Codex, Gemini, OpenAI and deduplicates message.id', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-harvest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Claude / Codex style JSONL with streaming snapshot updates on message id
  const claudeLines = [
    JSON.stringify({
      id: 'msg_001',
      provider: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
    }),
    // Streaming update for same message id -> should overwrite
    JSON.stringify({
      id: 'msg_001',
      provider: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    }),
    // Second message
    JSON.stringify({
      id: 'msg_002',
      provider: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 0 },
    }),
  ].join('\n');

  const claudeFile = join(dir, 'claude.jsonl');
  writeFileSync(claudeFile, claudeLines);

  const claudeResult = harvestTranscriptUsage(claudeFile);
  assert.ok(claudeResult);
  assert.equal(claudeResult.calls, 2);
  assert.equal(claudeResult.provider, 'claude');
  // Message 1: 100 in, 50 out, 60 cached
  // Message 2: 200 in, 80 out, 0 cached
  assert.equal(claudeResult.usage.inputTokens, 300);
  assert.equal(claudeResult.usage.outputTokens, 130);
  assert.equal(claudeResult.usage.cachedTokens, 60);

  // Gemini transcript
  const geminiLines = [
    JSON.stringify({
      response: {
        model: 'gemini-2.5-pro',
        usage: { promptTokenCount: 500, candidatesTokenCount: 150, thoughtsTokenCount: 50, cachedContentTokenCount: 200 },
      },
    }),
  ].join('\n');
  const geminiFile = join(dir, 'gemini.jsonl');
  writeFileSync(geminiFile, geminiLines);

  const geminiResult = harvestTranscriptUsage(geminiFile);
  assert.ok(geminiResult);
  assert.equal(geminiResult.calls, 1);
  assert.equal(geminiResult.provider, 'gemini');
  assert.equal(geminiResult.usage.inputTokens, 500);
  assert.equal(geminiResult.usage.outputTokens, 200); // 150 + 50
  assert.equal(geminiResult.usage.cachedTokens, 200);

  // OpenAI / Codex transcript
  const openaiLines = [
    JSON.stringify({
      message: {
        id: 'cmpl_01',
        model: 'gpt-4o',
        usage: { prompt_tokens: 120, completion_tokens: 45, cached_input_tokens: 30 },
      },
    }),
  ].join('\n');
  const openaiFile = join(dir, 'openai.jsonl');
  writeFileSync(openaiFile, openaiLines);

  const openaiResult = harvestTranscriptUsage(openaiFile);
  assert.ok(openaiResult);
  assert.equal(openaiResult.calls, 1);
  assert.equal(openaiResult.usage.inputTokens, 120);
  assert.equal(openaiResult.usage.outputTokens, 45);
  assert.equal(openaiResult.usage.cachedTokens, 30);

  // Symlink rejection via O_NOFOLLOW
  const linkFile = join(dir, 'symlink.jsonl');
  symlinkSync(claudeFile, linkFile);
  assert.equal(harvestTranscriptUsage(linkFile), null);

  // Missing, null, whitespace, or empty file
  assert.equal(harvestTranscriptUsage(null), null);
  assert.equal(harvestTranscriptUsage('   '), null);
  assert.equal(harvestTranscriptUsage(join(dir, 'missing.jsonl')), null);
  const emptyFile = join(dir, 'empty.jsonl');
  writeFileSync(emptyFile, '');
  assert.equal(harvestTranscriptUsage(emptyFile), null);
});

test('Objective 3: evaluateStop with transcriptPath and recordSessionUsage idempotent persistence', (t) => {
  const repo = makeTestRepo(t, { withActiveTicket: true });

  const transcriptContent = JSON.stringify({
    id: 'turn_1',
    provider: 'claude',
    model: 'claude-3-7-sonnet',
    usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 50 },
  });
  const transcriptPath = join(repo, 'session-transcript.jsonl');
  writeFileSync(transcriptPath, transcriptContent);

  // Default recordSessionUsage (false) harvests usage in memory without writing manifest
  const resNoRecord = evaluateStop({
    cwd: repo,
    env: {},
    transcriptPath,
  });
  assert.equal(resNoRecord.decision, 'allow');
  assert.equal(resNoRecord.harvestedUsage.calls, 1);
  assert.equal(existsSync(join(repo, '.adlc', 'manifest.jsonl')), false);

  // First stop with recordSessionUsage = true
  const res1 = evaluateStop({
    cwd: repo,
    env: {},
    transcriptPath,
    recordSessionUsage: true,
    sessionId: 'test-session-123',
    phaseGate: 'p4',
  });

  assert.equal(res1.decision, 'allow');
  assert.ok(res1.harvestedUsage);
  assert.equal(res1.harvestedUsage.calls, 1);
  assert.equal(res1.harvestedUsage.usage.inputTokens, 500);

  // Second stop call with same transcript: should be idempotent and not append duplicate
  const res2 = evaluateStop({
    cwd: repo,
    env: {},
    transcriptPath,
    recordSessionUsage: true,
    sessionId: 'test-session-123',
    phaseGate: 'p4',
  });
  assert.equal(res2.decision, 'allow');

  // Verify manifest contents in repo/.adlc
  const manifestPath = join(repo, '.adlc', 'manifest.jsonl');
  const manifestContent = readFileSync(manifestPath, 'utf8');
  const lines = manifestContent.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);

  const entry = JSON.parse(lines[0]);
  assert.equal(entry.gate, 'p4');
  assert.equal(entry.ticket, 'T-ACTIVE');
  assert.equal(entry.data.sessionId, 'test-session-123');
  assert.equal(entry.data.transcriptSha256, res1.harvestedUsage.transcriptSha256);
  assert.equal(entry.data.usageStatus, 'reported');
  assert.deepEqual(entry.data.usage, res1.harvestedUsage.usage);
});
