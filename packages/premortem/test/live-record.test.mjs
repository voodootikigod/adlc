import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@adlc/core';
import { appendManifestEntry } from '@adlc/gate-manifest';
import { verifyEntrySig } from '@adlc/gate-manifest/lib/sign.mjs';
import { assertPhase } from '../../runner/lib/assertions.mjs';
import { run } from '../lib/run.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'premortem.mjs');

const SAMPLE_SPEC = `# Spec: Resilient Queue

## Acceptance Criteria
- Queue drains cleanly, verified by \`node --test test/queue.test.mjs\`
`;

const SAMPLE_CAUSES_JSON = JSON.stringify({
  causes: [
    {
      cause: 'Consumer crashes mid-batch without acking offset',
      earliest_signal: 'Growing lag metric',
      prevention: 'Idempotent replay test',
      interrogation_question: 'Is message processing idempotent on redelivery?',
    },
  ],
});

function makeTempDir(t, prefix = 'premortem-live-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeCliChild(stdoutText) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGKILL');
  child.stdin.on('data', () => {});
  child.stdin.on('finish', () => {
    child.stdout.write(stdoutText);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
  });
  return child;
}

test('live run() with --ticket records witnessed headless-cli provenance and omits usage when unreported', async (t) => {
  const root = makeTempDir(t);
  const adlcDir = join(root, 'custom-adlc');
  const specPath = join(root, 'spec.md');
  writeFileSync(specPath, SAMPLE_SPEC, 'utf8');

  await run({
    specPath,
    tier: 'mid',
    provider: 'codex-cli',
    ticket: 'T-LIVE-1',
    dir: adlcDir,
    json: true,
    key: null,
    env: {
      NODE_ENV: 'test',
      ADLC_CODEX_CLI: '1',
      __adlcCliSpawn: () => makeCliChild(SAMPLE_CAUSES_JSON),
    },
  });

  const manifestPath = join(adlcDir, 'manifest.jsonl');
  const entries = readFileSync(manifestPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.gate, 'premortem');
  assert.equal(entry.ticket, 'T-LIVE-1');
  assert.equal(entry.files[specPath], sha256(readFileSync(specPath)));
  assert.equal(entry.data.specPath, specPath);
  assert.equal(entry.data.provider, 'codex-cli');
  assert.equal(entry.data.model, 'gpt-5.1');
  assert.equal(entry.data.tier, 'mid');
  assert.equal(entry.data.attestationMode, 'headless-cli');
  assert.equal(entry.data.executionWitnessed, true);
  assert.equal(entry.data.usageStatus, 'unreported');
  assert.equal('usage' in entry.data, false);
});

test('live run() with API provider records usage, signs with key, and skips recording when ticket is omitted', async (t) => {
  const root = makeTempDir(t);
  const adlcDir = join(root, '.adlc');
  const specPath = join(root, 'spec.md');
  writeFileSync(specPath, SAMPLE_SPEC, 'utf8');

  const origFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = origFetch;
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      content: [{ text: SAMPLE_CAUSES_JSON }],
      usage: { input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 5 },
    }),
  });

  await run({
    specPath,
    tier: 'cheap',
    provider: 'anthropic',
    dir: adlcDir,
    json: true,
    key: null,
    env: { ANTHROPIC_API_KEY: 'stub-api-token' },
  });
  assert.equal(existsSync(join(adlcDir, 'manifest.jsonl')), false);

  const signingKey = 'local-hmac-test';
  await run({
    specPath,
    tier: 'cheap',
    provider: 'anthropic',
    ticket: 'T-LIVE-2',
    dir: adlcDir,
    json: true,
    key: signingKey,
    env: { ANTHROPIC_API_KEY: 'stub-api-token' },
  });

  const entry = JSON.parse(readFileSync(join(adlcDir, 'manifest.jsonl'), 'utf8').trim());
  assert.equal(entry.data.attestationMode, 'api');
  assert.equal(entry.data.executionWitnessed, true);
  assert.equal(entry.data.usageStatus, 'reported');
  assert.deepEqual(entry.data.usage, { inputTokens: 40, outputTokens: 20, cachedTokens: 5 });
  assert.equal(verifyEntrySig(signingKey, entry), true);
});

test('CLI round-trip: live premortem --ticket --dir satisfies runner --track substantial p1 gate', (t) => {
  const root = makeTempDir(t);
  const adlcDir = join(root, '.adlc');
  mkdirSync(adlcDir, { recursive: true });
  const specPath = join(root, 'spec.md');
  writeFileSync(specPath, SAMPLE_SPEC, 'utf8');
  const specHash = sha256(readFileSync(specPath));

  const fakeClaude = join(root, 'fake-claude.mjs');
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => {\n  process.stdout.write(${JSON.stringify(JSON.stringify({ result: SAMPLE_CAUSES_JSON, usage: { input_tokens: 10, output_tokens: 15 } }))});\n});\n`,
    'utf8',
  );
  chmodSync(fakeClaude, 0o755);

  appendManifestEntry(
    { gate: 'spec-lint', ticket: 'T1', files: { [specPath]: specHash }, data: { verified: true } },
    adlcDir,
    { key: null },
  );

  const cliRes = spawnSync(
    process.execPath,
    [CLI, specPath, '--ticket', 'T1', '--dir', adlcDir, '--tier', 'cheap', '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ADLC_PROVIDER: 'claude-cli', ADLC_CLAUDE_CLI: fakeClaude, ADLC_MANIFEST_KEY: '' },
    },
  );
  assert.equal(cliRes.status, 0, cliRes.stderr);

  appendManifestEntry(
    {
      gate: 'spec-approval',
      ticket: 'T1',
      files: { [specPath]: specHash },
      data: {
        verdict: 'approved',
        approver: 'human@adlc.local',
        spec_hash: specHash,
        rounds: 1,
        questions: 2,
        sources: ['premortem'],
        unresolved: 0,
      },
    },
    adlcDir,
    { key: null },
  );

  const check = assertPhase('p1', { dir: adlcDir, ticket: 'T1', cwd: root, track: 'substantial' });
  assert.equal(check.ok, true, JSON.stringify(check));
});
