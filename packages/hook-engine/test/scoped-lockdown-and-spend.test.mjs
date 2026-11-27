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
import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { verify } from '@adlc/gate-manifest/lib/verify.mjs';

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

test('Objective 3: evaluateStop skips keyless append on signed/keyed manifests and survives record errors', (t) => {
  const signedRepo = makeTestRepo(t, { withActiveTicket: true });
  const adlcDir = join(signedRepo, '.adlc');
  const signingKey = 'local-hmac-test';
  record({
    gate: 'p4',
    ticket: 'T-ACTIVE',
    dir: adlcDir,
    key: signingKey,
    rawData: JSON.stringify({ note: 'signed-baseline' }),
  });

  const transcriptPath = join(signedRepo, 'session.jsonl');
  writeFileSync(
    transcriptPath,
    JSON.stringify({ id: 'm1', provider: 'claude', model: 'claude-sonnet-4-6', usage: { input_tokens: 50, output_tokens: 10 } }),
  );

  // Without key on an already-signed manifest: must NOT append unsigned entry and must block when requireEvidence=true
  const blockedKeyless = evaluateStop({
    cwd: signedRepo,
    key: null,
    transcriptPath,
    recordSessionUsage: true,
    requireEvidence: true,
    requiredGate: 'p4',
  });
  assert.equal(blockedKeyless.decision, 'block');
  assert.equal(readFileSync(join(adlcDir, 'manifest.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(verify(adlcDir, { requireSignatures: true, key: signingKey }).valid, true);

  // Keyed forest marker (.adlc/manifest.d/.store.json) also skips keyless append
  const keyedForestRepo = makeTestRepo(t, { withActiveTicket: true });
  mkdirSync(join(keyedForestRepo, '.adlc', 'manifest.d'), { recursive: true });
  writeFileSync(
    join(keyedForestRepo, '.adlc', 'manifest.d', '.store.json'),
    JSON.stringify({ version: 1, auth: 'keyed' }),
  );
  const kfTranscript = join(keyedForestRepo, 'session.jsonl');
  writeFileSync(
    kfTranscript,
    JSON.stringify({ id: 'm2', provider: 'claude', model: 'claude-sonnet-4-6', usage: { input_tokens: 20, output_tokens: 5 } }),
  );
  const kfStop = evaluateStop({
    cwd: keyedForestRepo,
    key: null,
    transcriptPath: kfTranscript,
    recordSessionUsage: true,
  });
  assert.equal(kfStop.decision, 'allow');
  assert.equal(existsSync(join(keyedForestRepo, '.adlc', 'manifest.jsonl')), false);

  // Detached HEAD with committed segment where record() would throw: evaluateStop catches and still blocks
  const detachedRepo = makeTestRepo(t, { withActiveTicket: true });
  writeFileSync(join(detachedRepo, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
  mkdirSync(join(detachedRepo, '.adlc', 'manifest.d'), { recursive: true });
  writeFileSync(
    join(detachedRepo, '.adlc', 'manifest.d', '01J00000000000000000000000.jsonl'),
    JSON.stringify({ seq: 1, ts: '2026-01-01T00:00:00Z', gate: 'p4', prev: null, hash: 'abc', branch: 'feat/x', anchor: null }) + '\n',
  );
  const detTranscript = join(detachedRepo, 'session.jsonl');
  writeFileSync(
    detTranscript,
    JSON.stringify({ id: 'm3', provider: 'claude', model: 'claude-sonnet-4-6', usage: { input_tokens: 30, output_tokens: 5 } }),
  );
  const detStop = evaluateStop({
    cwd: detachedRepo,
    key: signingKey,
    transcriptPath: detTranscript,
    recordSessionUsage: true,
    requireEvidence: true,
    requiredGate: 'p5',
  });
  assert.equal(detStop.decision, 'block');

  // Session telemetry entries must NEVER self-satisfy hasManifestEvidence on blocked or subsequent Stop checks
  const selfForgeRepo = makeTestRepo(t, { withActiveTicket: true });
  const sfTranscript = join(selfForgeRepo, 'session.jsonl');
  writeFileSync(
    sfTranscript,
    JSON.stringify({ id: 'm4', provider: 'claude', model: 'claude-sonnet-4-6', usage: { input_tokens: 40, output_tokens: 10 } }),
  );
  // Blocked stop does not append usage entry at all
  const block1 = evaluateStop({
    cwd: selfForgeRepo,
    key: signingKey,
    transcriptPath: sfTranscript,
    recordSessionUsage: true,
    requireEvidence: true,
    requiredGate: 'p4',
    phaseGate: 'p4',
  });
  assert.equal(block1.decision, 'block');
  assert.equal(existsSync(join(selfForgeRepo, '.adlc', 'manifest.jsonl')), false);

  // Even if an advisory stop records signed p4 session telemetry, a subsequent requireEvidence=true Stop still blocks
  const advisory = evaluateStop({
    cwd: selfForgeRepo,
    key: signingKey,
    transcriptPath: sfTranscript,
    recordSessionUsage: true,
    requireEvidence: false,
    phaseGate: 'p4',
  });
  assert.equal(advisory.decision, 'allow');
  assert.equal(existsSync(join(selfForgeRepo, '.adlc', 'manifest.jsonl')), true);

  const block2 = evaluateStop({
    cwd: selfForgeRepo,
    key: signingKey,
    transcriptPath: sfTranscript,
    recordSessionUsage: true,
    requireEvidence: true,
    requiredGate: 'p4',
    phaseGate: 'p4',
  });
  assert.equal(block2.decision, 'block');
  assert.equal(block2.hasEvidence, false);

  // Hermetic env option isolates evaluateStop from ambient process.env.ADLC_TICKET and ADLC_MANIFEST_KEY
  process.env.ADLC_TICKET = 'T-DOES-NOT-EXIST';
  process.env.ADLC_MANIFEST_KEY = 'ambient-outer-hmac';
  t.after(() => {
    delete process.env.ADLC_TICKET;
    delete process.env.ADLC_MANIFEST_KEY;
  });
  const hermeticRepo = makeTestRepo(t, { withActiveTicket: true });
  const hermTranscript = join(hermeticRepo, 'session.jsonl');
  writeFileSync(
    hermTranscript,
    JSON.stringify({ id: 'm5', provider: 'claude', model: 'claude-sonnet-4-6', usage: { input_tokens: 15, output_tokens: 5 } }),
  );
  const hermStop = evaluateStop({
    cwd: hermeticRepo,
    env: {},
    transcriptPath: hermTranscript,
    recordSessionUsage: true,
  });
  assert.equal(hermStop.decision, 'allow');
  const hermEntry = JSON.parse(readFileSync(join(hermeticRepo, '.adlc', 'manifest.jsonl'), 'utf8').trim());
  assert.equal(hermEntry.sig, undefined);
});
