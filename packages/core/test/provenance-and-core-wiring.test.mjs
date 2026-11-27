import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  CLAUDE_CLI_MODELS,
  CODEX_CLI_MODELS,
  CLI_PROVIDER_NAMES,
  PROVIDER_NAMES,
  VALID_ATTESTATION_MODES,
  STRUCTURAL_FALLBACK_OPERATORS,
  detectProvider,
  complete,
  fan,
  fanProviders,
  recordPromptOnlyVerdict,
  mutate,
} from '../index.mjs';

function makeSpawnChild(stdoutText, exitCode = 0) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGKILL');
  let received = '';
  child.stdin.on('data', (chunk) => {
    received += chunk.toString('utf8');
  });
  child.stdin.on('finish', () => {
    if (stdoutText) child.stdout.write(stdoutText);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode, null);
  });
  child.received = () => received;
  return child;
}

test('detectProvider resolves claude-cli and codex-cli while keeping PROVIDER_NAMES stable', () => {
  assert.deepEqual(PROVIDER_NAMES, ['anthropic', 'openai', 'gemini', 'agy']);
  assert.deepEqual(CLI_PROVIDER_NAMES, ['agy', 'claude-cli', 'codex-cli']);
  assert.deepEqual(VALID_ATTESTATION_MODES, ['self-context', 'headless-cli', 'api']);

  assert.equal(detectProvider({ ADLC_CLAUDE_CLI: '1' })?.name, 'claude-cli');
  assert.equal(detectProvider({ ADLC_CLAUDE_CLI: '0' }), null);
  assert.equal(detectProvider({ ADLC_CODEX_CLI: '1' })?.name, 'codex-cli');
  assert.equal(detectProvider({ ADLC_PROVIDER: 'claude-cli' })?.name, 'claude-cli');
  assert.equal(detectProvider({}, 'codex-cli')?.name, 'codex-cli');
  assert.equal(CLAUDE_CLI_MODELS.mid, 'claude-sonnet-4-6');
  assert.equal(CODEX_CLI_MODELS.mid, 'gpt-5.1');
});

test('complete, fan, and fanProviders emit onCompleteMeta with attestationMode and executionWitnessed', async (t) => {
  let childRef = null;
  const env = {
    NODE_ENV: 'test',
    ADLC_CLAUDE_CLI: '1',
    ADLC_CODEX_CLI: '1',
    __adlcCliSpawn: (_bin, _args) => {
      childRef = makeSpawnChild('codex plain response');
      return childRef;
    },
  };

  const metas = [];
  const out = await complete(
    {
      tier: 'mid',
      provider: 'codex-cli',
      prompt: 'verify cli meta',
      onCompleteMeta: (m) => metas.push(m),
    },
    env,
  );
  assert.equal(out, 'codex plain response');
  assert.equal(childRef.received(), 'verify cli meta');
  assert.deepEqual(metas, [
    {
      provider: 'codex-cli',
      model: 'gpt-5.1',
      tier: 'mid',
      attestationMode: 'headless-cli',
      executionWitnessed: true,
      usage: null,
    },
  ]);

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{ text: 'api-out' }],
      usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 2 },
    }),
  });

  const fanMetas = [];
  const fanRes = await fan(
    {
      tier: 'cheap',
      provider: 'anthropic',
      prompt: 'fan check',
      onCompleteMeta: (m) => fanMetas.push(m),
    },
    2,
    { ANTHROPIC_API_KEY: 'test-key' },
  );
  assert.equal(fanRes.length, 2);
  assert.equal(fanMetas.length, 2);
  assert.equal(fanMetas[0].attestationMode, 'api');
  assert.equal(fanMetas[0].executionWitnessed, true);
  assert.deepEqual(fanMetas[0].usage, { inputTokens: 11, outputTokens: 4, cachedTokens: 2 });

  const fpMetas = [];
  const fpRes = await fanProviders(
    {
      tier: 'cheap',
      prompt: 'fp check',
      onCompleteMeta: (m) => fpMetas.push(m),
    },
    ['anthropic', 'codex-cli'],
    { ...env, ANTHROPIC_API_KEY: 'test-key' },
  );
  assert.equal(fpRes.length, 2);
  assert.ok(fpRes.every((r) => r.ok));
  assert.deepEqual(fpMetas.map((m) => m.attestationMode).sort(), ['api', 'headless-cli']);
});

test('recordPromptOnlyVerdict unconditionally enforces self-context non-witnessed provenance', () => {
  let recorded = null;
  recordPromptOnlyVerdict({
    gate: 'premortem',
    ticket: 'T-1',
    verdict: 'approve',
    extra: {
      promptOnly: false,
      executionWitnessed: true,
      attestationMode: 'api',
      usageStatus: 'reported',
      specPath: 'specs/demo.md',
    },
    dir: '.adlc',
    recordFn: (payload) => {
      recorded = payload;
      return payload;
    },
  });

  assert.ok(recorded);
  const parsed = JSON.parse(recorded.rawData);
  assert.equal(parsed.promptOnly, true);
  assert.equal(parsed.executionWitnessed, false);
  assert.equal(parsed.attestationMode, 'self-context');
  assert.equal(parsed.usageStatus, 'unreported');
  assert.equal(parsed.specPath, 'specs/demo.md');
  assert.equal(parsed.verdict, 'approve');
});

test('mutate.generateMutants supports opt-in includeStructural without altering default behavior', () => {
  // Use a call-site option bag with identifier values so no primary or value-substitute operator fires
  const pureBag = 'invokeClient(endpoint, { mode: currentMode, target: destPath });\n';
  assert.equal(mutate.generateMutants(pureBag).length, 0);
  const withStructural = mutate.generateMutants(pureBag, { includeStructural: true });
  assert.equal(withStructural.length, 1);
  assert.equal(withStructural[0].operator, STRUCTURAL_FALLBACK_OPERATORS[0].name);
  assert.equal(withStructural[0].mutated, 'invokeClient(endpoint, { mode: currentMode });');

  const sixtyLines = Array.from({ length: 60 }, (_, i) => `const b${i} = true;`).join('\n');
  assert.equal(mutate.generateMutants(sixtyLines).length, 50);
});
