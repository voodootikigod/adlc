import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@adlc/core';
import { runProsecution } from '../lib/run.mjs';

function makeGitFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-prosecute-mandatory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({
    tickets: [{ id: 'T1', title: 'Test', scope: ['src/**'], rails: [], edges: [] }],
  }));
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, headSha };
}

function makePacket(passes, extra = {}) {
  return {
    target: 'feature branch',
    provenance: {
      reviewer: 'local-reviewer',
      session: 'test-session',
      command: 'test-cmd',
      ...(extra.provenance ?? {}),
    },
    ...(extra.review_packet ? { review_packet: extra.review_packet } : {}),
    no_findings_attestation: {
      reason: 'no findings',
      method: 'manual check',
      evidence: 'test',
    },
    passes,
  };
}

describe('T-P12: prosecute mandatory lenses, symlink rejection, and HEAD binding', () => {
  it('fails closed (exit 2) when 3 dry lenses omit security', (t) => {
    const { dir } = makeGitFixture(t);
    const res = runProsecution(makePacket([
      { lens: 'correctness', findings: [], dry_evidence: 'ok' },
      { lens: 'tests', findings: [], dry_evidence: 'ok' },
      { lens: 'behavior', findings: [], dry_evidence: 'ok' },
    ]), { ticket: 'T1', cwd: dir, dir: '.adlc', revision: 'rev-1' });
    assert.equal(res.status, 'gate-fail');
    assert.equal(res.exitCode, 2);
    assert.match(res.message, /security/);
  });

  it('fails closed (exit 2) when 3 dry lenses omit correctness', (t) => {
    const { dir } = makeGitFixture(t);
    const res = runProsecution(makePacket([
      { lens: 'security', findings: [], dry_evidence: 'ok' },
      { lens: 'tests', findings: [], dry_evidence: 'ok' },
      { lens: 'behavior', findings: [], dry_evidence: 'ok' },
    ]), { ticket: 'T1', cwd: dir, dir: '.adlc', revision: 'rev-1' });
    assert.equal(res.status, 'gate-fail');
    assert.equal(res.exitCode, 2);
    assert.match(res.message, /correctness/);
  });

  it('passes (exit 0) when correctness, security, and a 3rd lens are dry and binds headSha to git rev-parse HEAD', (t) => {
    const { dir, headSha } = makeGitFixture(t);
    const res = runProsecution(makePacket([
      { lens: 'security', findings: [], dry_evidence: 'ok' },
      { lens: 'correctness', findings: [], dry_evidence: 'ok' },
      { lens: 'tests', findings: [], dry_evidence: 'ok' },
    ]), { ticket: 'T1', cwd: dir, dir: '.adlc', revision: 'rev-1' });
    assert.equal(res.status, 'pass');
    assert.equal(res.exitCode, 0);
    assert.equal(res.headSha, headSha);
  });

  it('rejects symlinked provenance.transcript via lstatSync', (t) => {
    const { dir } = makeGitFixture(t);
    const outside = mkdtempSync(join(tmpdir(), 'adlc-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const targetFile = join(outside, 'transcript.txt');
    writeFileSync(targetFile, `ticket: T1\nrevision: rev-1\n${'x'.repeat(80)}\n`);
    mkdirSync(join(dir, '.adlc', 'evidence'), { recursive: true });
    const linkPath = join(dir, '.adlc', 'evidence', 'link.txt');
    symlinkSync(targetFile, linkPath);

    const res = runProsecution(makePacket([
      { lens: 'security', findings: [], dry_evidence: 'ok' },
      { lens: 'correctness', findings: [], dry_evidence: 'ok' },
      { lens: 'tests', findings: [], dry_evidence: 'ok' },
    ], { provenance: { transcript: '.adlc/evidence/link.txt' } }), {
      ticket: 'T1',
      cwd: dir,
      dir: '.adlc',
      revision: 'rev-1',
    });
    assert.equal(res.status, 'op-error');
    assert.equal(res.exitCode, 1);
    assert.ok(res.errors.some((e) => /symlink/i.test(e)), `expected symlink error, got: ${res.errors.join('; ')}`);
  });

  it('rejects symlinked review_packet.prompt via lstatSync', (t) => {
    const { dir } = makeGitFixture(t);
    const outside = mkdtempSync(join(tmpdir(), 'adlc-outside-pkt-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const promptBody = 'prompt content';
    const inputsBody = 'inputs content';
    const outsidePrompt = join(outside, 'prompt.txt');
    writeFileSync(outsidePrompt, promptBody);
    mkdirSync(join(dir, '.adlc', 'evidence'), { recursive: true });
    symlinkSync(outsidePrompt, join(dir, '.adlc', 'evidence', 'prompt.txt'));
    writeFileSync(join(dir, '.adlc', 'evidence', 'inputs.txt'), inputsBody);

    const res = runProsecution(makePacket([
      { lens: 'security', findings: [], dry_evidence: 'ok' },
      { lens: 'correctness', findings: [], dry_evidence: 'ok' },
      { lens: 'tests', findings: [], dry_evidence: 'ok' },
    ], {
      review_packet: {
        prompt: '.adlc/evidence/prompt.txt',
        prompt_hash: sha256(Buffer.from(promptBody)),
        inputs: '.adlc/evidence/inputs.txt',
        inputs_hash: sha256(Buffer.from(inputsBody)),
        clean_worktree: 'rev-1',
      },
    }), { ticket: 'T1', cwd: dir, dir: '.adlc', revision: 'rev-1' });
    assert.equal(res.status, 'op-error');
    assert.equal(res.exitCode, 1);
    assert.ok(res.errors.some((e) => /symlink/i.test(e)), `expected symlink error, got: ${res.errors.join('; ')}`);
  });
});
