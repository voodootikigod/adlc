// Concern: #365 Decision 2 / AC15 at the record-cross-model CLI boundary — the same
// untracked-and-NOT-ignored refusal pinned at the lib level (untracked-file-refusal.test.mjs) for
// runProsecution, exercised here as a real subprocess so the CLI wiring itself is covered, not
// just the library function.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

process.env.ADLC_MANIFEST_KEY = 'test-untracked-refusal-cli-signing-key';

function runBin(args, cwd, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-untracked-refusal-cli-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({
    tickets: [{ id: 'T1', title: 'x', scope: ['src/**'], rails: [], edges: [] }],
  }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 0;\n');
  g('add', '-A'); g('commit', '-qm', 'baseline');
  g('checkout', '-q', '-b', 'feat');
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 1;\n');
  g('add', '-A'); g('commit', '-qm', 'the reviewed change');
  return { dir, g };
}

describe('#365 Decision 2 / AC15 CLI — record-cross-model refuses on an untracked, non-ignored file', () => {
  it('exits 1 and names the offending path when auto-resolving the revision (no --revision)', () => {
    const { dir } = repo();
    try {
      writeFileSync(join(dir, 'scratch-not-ignored.txt'), 'stray\n');
      const r = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--base', 'main', '--dir', '.adlc'], dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /refusing to record/);
      assert.match(r.stderr, /scratch-not-ignored\.txt/);
    } finally { cleanup(dir); }
  });

  it('succeeds when the only untracked file is GITIGNORED', () => {
    const { dir, g } = repo();
    try {
      writeFileSync(join(dir, '.gitignore'), '*.log\n');
      g('add', '-A'); g('commit', '-qm', 'add gitignore');
      writeFileSync(join(dir, 'debug.log'), 'noise\n');
      const r = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--base', 'main', '--dir', '.adlc'], dir);
      assert.equal(r.status, 0, `gitignored untracked files must not trigger the refusal: ${r.stderr}`);
    } finally { cleanup(dir); }
  });

  it('an EXPLICIT --revision bypasses the refusal, even with an untracked file present', () => {
    const { dir } = repo();
    try {
      writeFileSync(join(dir, 'scratch-not-ignored.txt'), 'stray\n');
      const r = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', 'pinned-rev', '--dir', '.adlc'], dir);
      assert.equal(r.status, 0, `an explicit --revision must bypass the refusal: ${r.stderr}`);
    } finally { cleanup(dir); }
  });
});
