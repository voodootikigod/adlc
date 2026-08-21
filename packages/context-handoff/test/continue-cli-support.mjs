// Shared fixtures for the `handoff continue` contract tests. Same shape as the
// cli-test/ harnesses: drive the real bin as a subprocess, never a stand-in.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'handoff.mjs');
export const TEST_KEY = 'c'.repeat(64);
export const KEYED = { ADLC_MANIFEST_KEY: TEST_KEY };

export function run(args, { cwd, env = {}, expectOk = true } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, ...env },
      stderr: 'pipe',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const result = {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
    if (expectOk) {
      assert.fail(`handoff ${args.join(' ')} failed (${result.code}): ${result.stderr || result.stdout}`);
    }
    return result;
  }
}

export function withTempRepo(fn) {
  // realpathSync so `dir` is canonical — the form the subprocess's own
  // process.cwd() reports. On macOS tmpdir() is /var, a symlink to /private/var,
  // so a raw mkdtemp path never equals the paths the CLI prints back.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-continue-')));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Arm an open, ticket-bound deny for `session` the way an adapter would. */
export function seedBoundDeny(cwd, session = 'denier-1', ticket = 'T155') {
  return run(['write', '--session', session, '--ticket', ticket, '--write', '--json'], {
    cwd,
    env: KEYED,
  });
}

/** Arm an open deny with a null ticket_id (the pre-bind state). */
export function seedUnboundDeny(cwd, session = 'denier-unbound') {
  return run(['write', '--session', session, '--write', '--json'], { cwd, env: KEYED });
}

export function transcript(cwd, name = 'transcript.jsonl', requestId = 'req_1') {
  const path = join(cwd, name);
  writeFileSync(
    path,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'start' } }),
      JSON.stringify({
        type: 'assistant',
        requestId,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I rewrote the gate and left the tests failing.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'node --test' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        requestId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Next: fix the rollback path.' }] },
      }),
      '{ half-written line',
    ].join('\n'),
    'utf8',
  );
  return path;
}

export const denyPathFor = (cwd, session) =>
  join(cwd, '.adlc', 'handoffs', 'denies', `${session}.json`);
export const finalPathFor = (cwd, session) =>
  join(cwd, '.adlc', 'handoffs', 'finals', `${session}.json`);
export const contentPathFor = (cwd, session) =>
  join(cwd, '.adlc', 'handoffs', 'content', `${session}.md`);
export const resumeAuthPathFor = (cwd, session) =>
  join(cwd, '.adlc', 'handoffs', `${session}.resume-auth.json`);

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Every resume-auth cache in the tree — used to prove WHO was authorized. */
export function resumeAuthFiles(cwd) {
  try {
    return readdirSync(join(cwd, '.adlc', 'handoffs'))
      .filter((name) => name.endsWith('.resume-auth.json'))
      .sort();
  } catch {
    return [];
  }
}

export function manifestEntries(cwd, gate) {
  const raw = readFileSync(join(cwd, '.adlc', 'manifest.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .filter((e) => (gate ? e.gate === gate : true));
}

/** Break the ledger so the next evidence append throws. */
export function poisonManifest(cwd) {
  const path = join(cwd, '.adlc', 'manifest.jsonl');
  writeFileSync(path, `${readFileSync(path, 'utf8')}{not-json\n`, 'utf8');
}
