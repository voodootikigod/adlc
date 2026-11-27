import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  CLAUDE_CLI_MODELS,
  CODEX_CLI_MODELS,
  normalizeCliAnthropicUsage,
  claudeCliSend,
  codexCliSend,
} from '../lib/cli-providers.mjs';

function createMockChild({ stdoutText = '', exitCode = 0, delayMs = 0, emitError = null, timeoutOnStdin = false }) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (sig) => {
    child.killed = true;
    child.killSignal = sig;
    child.emit('close', null, sig);
  };

  let receivedInput = '';
  child.stdin.on('data', (chunk) => {
    receivedInput += chunk.toString('utf8');
  });

  child.stdin.on('finish', () => {
    if (timeoutOnStdin) return;
    setTimeout(() => {
      if (emitError) {
        child.emit('error', emitError);
        return;
      }
      if (stdoutText) {
        child.stdout.write(stdoutText);
      }
      child.stdout.end();
      child.stderr.end();
      child.emit('close', exitCode, null);
    }, delayMs);
  });

  child.getReceivedInput = () => receivedInput;
  return child;
}

test('CLI model constants are frozen with cheap, mid, and frontier mappings', () => {
  assert.ok(Object.isFrozen(CLAUDE_CLI_MODELS));
  assert.equal(CLAUDE_CLI_MODELS.cheap, 'claude-haiku-4-5');
  assert.equal(CLAUDE_CLI_MODELS.mid, 'claude-sonnet-4-6');
  assert.equal(CLAUDE_CLI_MODELS.frontier, 'claude-opus-4-7');

  assert.ok(Object.isFrozen(CODEX_CLI_MODELS));
  assert.equal(CODEX_CLI_MODELS.cheap, 'gpt-5-mini');
  assert.equal(CODEX_CLI_MODELS.mid, 'gpt-5.1');
  assert.equal(CODEX_CLI_MODELS.frontier, 'gpt-5.1');
});

test('normalizeCliAnthropicUsage parses snake_case and camelCase usage blocks', () => {
  assert.equal(normalizeCliAnthropicUsage(null), null);
  assert.equal(normalizeCliAnthropicUsage(undefined), null);
  assert.equal(normalizeCliAnthropicUsage('usage'), null);
  assert.equal(normalizeCliAnthropicUsage([]), null);

  const snakeCase = normalizeCliAnthropicUsage({
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 4,
    cache_creation_input_tokens: 6,
  });
  assert.deepEqual(snakeCase, {
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: 10,
  });

  const camelCase = normalizeCliAnthropicUsage({
    inputTokens: 15,
    outputTokens: 25,
    cachedTokens: 5,
  });
  assert.deepEqual(camelCase, {
    inputTokens: 15,
    outputTokens: 25,
    cachedTokens: 5,
  });

  const emptyObj = normalizeCliAnthropicUsage({});
  assert.deepEqual(emptyObj, {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
  });
});

test('claudeCliSend spawns claude binary with json format and stdin prompt, stripping ADLC manifest/admin env', async () => {
  let capturedBin = null;
  let capturedArgs = null;
  let capturedSpawnOpts = null;
  let mockChild = null;

  const mockSpawn = (bin, args, spawnOpts) => {
    capturedBin = bin;
    capturedArgs = args;
    capturedSpawnOpts = spawnOpts;
    mockChild = createMockChild({
      stdoutText: JSON.stringify({
        result: 'Claude response text',
        usage: { input_tokens: 12, output_tokens: 24 },
      }),
    });
    return mockChild;
  };

  const env = {
    NODE_ENV: 'test',
    HOME: '/mock/home',
    PATH: '/mock/path',
    ADLC_MANIFEST_KEY: 'secret-manifest-key',
    ADLC_ADMIN_TOKEN: 'secret-admin-token',
    __adlcCliSpawn: mockSpawn,
  };

  const response = await claudeCliSend('1', 'claude-sonnet-4-6', 'system prompt', 'user prompt', { env });
  assert.equal(capturedBin, 'claude');
  assert.deepEqual(capturedArgs, ['--print', '--output-format', 'json', '--tools', '', '--model', 'claude-sonnet-4-6']);
  assert.equal(mockChild.getReceivedInput(), 'system prompt\n\n---\n\nuser prompt');
  assert.equal(typeof capturedSpawnOpts.cwd, 'string');
  assert.notEqual(capturedSpawnOpts.cwd, process.cwd());
  assert.equal(capturedSpawnOpts.env.ADLC_MANIFEST_KEY, undefined);
  assert.equal(capturedSpawnOpts.env.ADLC_ADMIN_TOKEN, undefined);
  assert.equal(capturedSpawnOpts.env.HOME, '/mock/home');
  assert.equal(capturedSpawnOpts.env.PATH, '/mock/path');
  assert.equal(response.text, 'Claude response text');
  assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 24, cachedTokens: 0 });
});

test('claudeCliSend resolves custom binary and handles prompt without system prompt', async () => {
  let capturedBin = null;
  let capturedArgs = null;
  let mockChild = null;

  const mockSpawn = (bin, args) => {
    capturedBin = bin;
    capturedArgs = args;
    mockChild = createMockChild({
      stdoutText: 'Plain text without json result',
    });
    return mockChild;
  };

  const env = {
    NODE_ENV: 'test',
    __adlcCliSpawn: mockSpawn,
  };

  const response = await claudeCliSend('/usr/local/bin/custom-claude', 'claude-haiku-4-5', null, 'bare prompt', { env });
  assert.equal(capturedBin, '/usr/local/bin/custom-claude');
  assert.deepEqual(capturedArgs, ['--print', '--output-format', 'json', '--tools', '', '--model', 'claude-haiku-4-5']);
  assert.equal(mockChild.getReceivedInput(), 'bare prompt');
  assert.equal(response.text, 'Plain text without json result');
  assert.equal(response.usage, null);
});

test('codexCliSend spawns codex exec with skip-git-repo-check, read-only sandbox, isolated cwd, and stdin prompt', async () => {
  let capturedBin = null;
  let capturedArgs = null;
  let capturedSpawnOpts = null;
  let mockChild = null;

  const mockSpawn = (bin, args, spawnOpts) => {
    capturedBin = bin;
    capturedArgs = args;
    capturedSpawnOpts = spawnOpts;
    mockChild = createMockChild({
      stdoutText: 'Codex completion output',
    });
    return mockChild;
  };

  const env = {
    NODE_ENV: 'test',
    __adlcCliSpawn: mockSpawn,
  };

  const response = await codexCliSend('true', 'gpt-5.1', 'sys instructions', 'user question', { env });
  assert.equal(capturedBin, 'codex');
  assert.deepEqual(capturedArgs, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-5.1', '-']);
  assert.notEqual(capturedSpawnOpts.cwd, process.cwd());
  assert.equal(mockChild.getReceivedInput(), 'sys instructions\n\n---\n\nuser question');
  assert.equal(response.text, 'Codex completion output');
  assert.equal(response.usage, null);
});

test('claudeCliSend enforces timeout and rejects on failure', async () => {
  let mockChild = null;
  const mockSpawn = () => {
    mockChild = createMockChild({ timeoutOnStdin: true });
    return mockChild;
  };

  const env = {
    NODE_ENV: 'test',
    __adlcCliSpawn: mockSpawn,
  };

  await assert.rejects(
    claudeCliSend('1', 'claude-sonnet-4-6', null, 'hang test', { env, timeoutMs: 30 }),
    /Process timed out after 30ms/,
  );
  assert.equal(mockChild.killed, true);
  assert.equal(mockChild.killSignal, 'SIGKILL');
});

test('claudeCliSend rejects on non-zero process exit code', async () => {
  const mockSpawn = () => {
    return createMockChild({ exitCode: 1, stdoutText: 'fatal error occurred' });
  };

  const env = {
    NODE_ENV: 'test',
    __adlcCliSpawn: mockSpawn,
  };

  await assert.rejects(
    claudeCliSend('1', 'claude-sonnet-4-6', null, 'fail test', { env }),
    /Process exited with code 1/,
  );
});
