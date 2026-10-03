/**
 * signal-mid-evaluation.test.mjs — a termination signal that arrives while a
 * candidate's hunks are on disk (its repro or rails run is executing) must
 * stop the run promptly, kill the in-flight command's process group, restore
 * the original files, exit 1, and never apply a winner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { runCommand } from '../lib/runner.mjs';

const BIN = resolve(new URL('../bin/consensus-fix.mjs', import.meta.url).pathname);
const ORIGINAL = 'export const val = 1;\n';

function writeMockLlm(dir, targetFile) {
  const preload = join(dir, 'mock-llm.mjs');
  writeFileSync(preload, `
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        changes: [{ file: ${JSON.stringify(targetFile)},
          hunks: [{ startLine: 1, endLine: 1, replacement: 'export const val = 2;' }] }]
      }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  `);
  return preload;
}

/**
 * A shell command that fails on the original source and, once it sees the
 * candidate on disk, writes `ready`, then sleeps and writes `late` — so a
 * surviving grandchild is observable after the bin has exited.
 */
function blockingOnCandidate(targetFile, ready, late) {
  return `if grep -q 'val = 2' '${targetFile}'; then touch '${ready}'; sleep 2; touch '${late}'; exit 0; fi; exit 1`;
}

async function waitFor(path, ms) {
  const start = Date.now();
  while (!existsSync(path) && Date.now() - start < ms) {
    await new Promise((res) => setTimeout(res, 25));
  }
  return existsSync(path);
}

function exitOf(child) {
  return new Promise((res) => child.on('exit', (code, sig) => res({ code, sig, at: Date.now() })));
}

async function runAndSignal({ signal, useRails }) {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-mid-eval-'));
  try {
    const targetFile = join(dir, 'target.mjs');
    const ready = join(dir, 'ready');
    const late = join(dir, 'late');
    writeFileSync(targetFile, ORIGINAL);
    const preload = writeMockLlm(dir, targetFile);
    const blocking = blockingOnCandidate(targetFile, ready, late);
    const testCmd = useRails ? `grep -q 'val = 2' '${targetFile}'` : blocking;
    const args = ['--import', preload, BIN, '--test-cmd', testCmd, '--files', targetFile,
      '--n', '1', '--allow-dirty', '--apply'];
    if (useRails) args.push('--rails', blocking);

    const child = spawn(process.execPath, args, {
      cwd: dir,
      env: { ...process.env, OPENAI_API_KEY: 'mock-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const exited = exitOf(child);

    assert.ok(await waitFor(ready, 8000), 'candidate never reached evaluation');
    assert.equal(readFileSync(targetFile, 'utf8'), 'export const val = 2;\n', 'candidate should be on disk');
    const sentAt = Date.now();
    child.kill(signal);
    const { code, at } = await exited;
    // Past the in-flight command's own 2 s sleep, so a surviving grandchild
    // would have written `late` by now.
    await new Promise((res) => setTimeout(res, 2500));
    return {
      code,
      elapsed: at - sentAt,
      content: readFileSync(targetFile, 'utf8'),
      stdout,
      lateWritten: existsSync(late),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
  test(`${signal} during the repro run of a candidate restores files and applies nothing`, async () => {
    const r = await runAndSignal({ signal, useRails: false });
    assert.equal(r.code, 1, `exit code (stdout: ${r.stdout})`);
    assert.ok(r.elapsed < 1500, `exit took ${r.elapsed} ms after ${signal}`);
    assert.equal(r.content, ORIGINAL);
    assert.doesNotMatch(r.stdout, /Winning fix has been applied/);
    assert.equal(r.lateWritten, false, 'in-flight command outlived the run');
  });
}

test('SIGTERM during the rails run of a candidate restores files and applies nothing', async () => {
  const r = await runAndSignal({ signal: 'SIGTERM', useRails: true });
  assert.equal(r.code, 1, `exit code (stdout: ${r.stdout})`);
  assert.ok(r.elapsed < 1500, `exit took ${r.elapsed} ms`);
  assert.equal(r.content, ORIGINAL);
  assert.doesNotMatch(r.stdout, /Winning fix has been applied/);
  assert.equal(r.lateWritten, false, 'in-flight rails command outlived the run');
});

test('runCommand resolves promptly and kills the whole process group on abort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-abort-'));
  try {
    const late = join(dir, 'late');
    const controller = new AbortController();
    const started = Date.now();
    const pending = runCommand(`(sleep 1; touch '${late}') & sleep 5`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    assert.ok(Date.now() - started < 1500, 'abort did not stop the command');
    assert.equal(result.exitCode, 130);
    await new Promise((res) => setTimeout(res, 1300));
    assert.equal(existsSync(late), false, 'background grandchild survived the abort');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand does not start a command when already aborted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-preabort-'));
  try {
    const marker = join(dir, 'ran');
    const controller = new AbortController();
    controller.abort();
    const result = await runCommand(`touch '${marker}'`, { signal: controller.signal });
    assert.equal(result.exitCode, 130);
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
