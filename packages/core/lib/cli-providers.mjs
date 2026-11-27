// Headless subscription CLI providers for Anthropic (claude-cli) and OpenAI (codex-cli).
// Enables zero-API-key execution via local subscription shims.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const CLAUDE_CLI_MODELS = Object.freeze({
  cheap: 'claude-haiku-4-5',
  mid: 'claude-sonnet-4-6',
  frontier: 'claude-opus-4-7',
});

export const CODEX_CLI_MODELS = Object.freeze({
  cheap: 'gpt-5-mini',
  mid: 'gpt-5.1',
  frontier: 'gpt-5.1',
});

export function normalizeCliAnthropicUsage(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  return {
    inputTokens: Number(u.input_tokens ?? u.inputTokens ?? 0),
    outputTokens: Number(u.output_tokens ?? u.outputTokens ?? 0),
    cachedTokens: Number((u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cachedTokens ?? 0)),
  };
}

export function sanitizeProviderEnv(envSource = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(envSource ?? {})) {
    if (k === 'ADLC_MANIFEST_KEY' || k === 'ADLC_MANIFEST_PRIVATE_KEY' || k.startsWith('ADLC_ADMIN_')) continue;
    env[k] = v;
  }
  if (!env.HOME && process.env.HOME) env.HOME = process.env.HOME;
  if (!env.PATH && process.env.PATH) env.PATH = process.env.PATH;
  return env;
}

function runCliCommand(bin, args, input, opts = {}) {
  const envSource = opts.env ?? process.env;
  const isTest = envSource.NODE_ENV === 'test' || process.env.NODE_ENV === 'test';
  const spawnFn = isTest && typeof envSource.__adlcCliSpawn === 'function'
    ? envSource.__adlcCliSpawn
    : spawn;

  const env = sanitizeProviderEnv(envSource);

  const timeoutMs = Number.isFinite(opts?.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 120_000;
  const isolatedCwd = mkdtempSync(join(tmpdir(), 'adlc-cli-cwd-'));
  const cleanupCwd = () => {
    try {
      rmSync(isolatedCwd, { recursive: true, force: true });
    } catch {}
  };

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(bin, args, {
        shell: false,
        cwd: isolatedCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      cleanupCwd();
      return reject(err);
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      cleanupCwd();
      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    child.stdout.on('data', (d) => {
      stdout += outDecoder.write(d);
    });
    child.stderr.on('data', (d) => {
      stderr += errDecoder.write(d);
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupCwd();
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupCwd();
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      if (code !== 0) {
        return reject(new Error(`Process exited with code ${code ?? signal}: ${stderr || stdout}`));
      }
      resolve(stdout);
    });
  });
}

export async function claudeCliSend(apiKey, model, system, prompt, opts = {}) {
  const bin = apiKey === '1' || apiKey === 'true' ? 'claude' : apiKey;
  const args = ['--print', '--output-format', 'json', '--tools', '', '--model', model];
  const input = system ? `${system}\n\n---\n\n${prompt}` : prompt;
  const stdout = await runCliCommand(bin, args, input, opts);
  try {
    const data = JSON.parse(stdout);
    if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.result === 'string') {
      return {
        text: data.result,
        usage: normalizeCliAnthropicUsage(data.usage),
      };
    }
  } catch {}
  return { text: stdout, usage: null };
}

export async function codexCliSend(apiKey, model, system, prompt, opts = {}) {
  const bin = apiKey === '1' || apiKey === 'true' ? 'codex' : apiKey;
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', model, '-'];
  const input = system ? `${system}\n\n---\n\n${prompt}` : prompt;
  const stdout = await runCliCommand(bin, args, input, opts);
  return { text: stdout, usage: null };
}
