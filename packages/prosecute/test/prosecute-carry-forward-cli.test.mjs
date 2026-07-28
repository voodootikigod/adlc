// Concern: bin/adlc-prosecute.mjs `record-cross-model --carry-forward` (#365 step 5) — the CLI
// surface for carryForwardCrossModelReview, end-to-end at the process boundary in a real git
// repo. The library-level behavior (depth cap, digest equality, legacy-form refusal, etc.) is
// already pinned in cross-model-carry-forward.test.mjs; this file only proves the CLI plumbing:
// --carry-forward <fromRevision> resolves the CURRENT revision the same way a fresh
// record-cross-model would, calls the carry path instead of the fresh-record path, and never
// accepts --provider/--author-provider/--verdict (the carried entry keeps the original review's
// identity).
//
// New file rather than an addition to prosecute-cross-model-cli.test.mjs: that file is pinned
// unmodified by #365 AC14 (FIX A is the acceptance signal for the basis decision).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

process.env.ADLC_MANIFEST_KEY = 'test-carry-forward-cli-signing-key';

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

function repoAt(commitFile) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-carry-cli-'));
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
  writeFileSync(join(dir, 'src', 'app.mjs'), commitFile);
  g('add', '-A'); g('commit', '-qm', 'baseline');
  return { dir, g };
}

describe('#365 step 5 — record-cross-model --carry-forward CLI surface', () => {
  it('carries a prior approve forward onto a base that moved with an unrelated commit', () => {
    const { dir, g } = repoAt('export const x = 0;\n');
    try {
      g('checkout', '-q', '-b', 'feat');
      writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 1;\n');
      g('add', '-A'); g('commit', '-qm', 'the reviewed change');

      const first = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--base', 'main', '--dir', '.adlc', '--json'], dir);
      assert.equal(first.status, 0);
      const fromRevision = JSON.parse(first.stdout).data.revision;

      // main advances with a commit the reviewed change never touches (the #362/#367 scenario).
      g('checkout', '-q', 'main');
      writeFileSync(join(dir, 'UNRELATED.md'), 'an unrelated docs merge\n');
      g('add', '-A'); g('commit', '-qm', 'unrelated docs');
      g('checkout', '-q', 'feat');
      g('rebase', '-q', 'main');

      const carried = runBin(['record-cross-model', '--ticket', 'T1', '--carry-forward', fromRevision, '--base', 'main', '--dir', '.adlc', '--json'], dir);
      assert.equal(carried.status, 0, `carry-forward must succeed for an unchanged diff: ${carried.stdout}${carried.stderr}`);
      const carriedData = JSON.parse(carried.stdout).data;
      assert.equal(carriedData.verdict, 'approve');
      assert.equal(carriedData.carriedFrom, fromRevision);
      assert.equal(carriedData.carryDepth, 1);
      // The identity is INHERITED from the original review, not re-asserted by the CLI call
      // (which passed neither --provider nor --author-provider).
      assert.equal(carriedData.provider, 'openai');
      assert.equal(carriedData.authorProvider, 'anthropic');
      assert.notEqual(carriedData.revision, fromRevision, 'the carried revision must bind to the NEW base');
    } finally { cleanup(dir); }
  });

  it('refuses (fails closed, exit 1) when the reviewed change itself moved, even under --carry-forward', () => {
    const { dir, g } = repoAt('export const x = 0;\n');
    try {
      g('checkout', '-q', '-b', 'feat');
      writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 1;\n');
      g('add', '-A'); g('commit', '-qm', 'the reviewed change');

      const first = runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--base', 'main', '--dir', '.adlc', '--json'], dir);
      const fromRevision = JSON.parse(first.stdout).data.revision;

      // Base moves AND the reviewed byte itself changes.
      g('checkout', '-q', 'main');
      writeFileSync(join(dir, 'UNRELATED.md'), 'unrelated\n');
      g('add', '-A'); g('commit', '-qm', 'unrelated');
      g('checkout', '-q', 'feat');
      g('rebase', '-q', 'main');
      writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 2;\n');
      g('add', '-A'); g('commit', '-qm', 'altered after the fact');

      const carried = runBin(['record-cross-model', '--ticket', 'T1', '--carry-forward', fromRevision, '--base', 'main', '--dir', '.adlc'], dir);
      assert.equal(carried.status, 1, 'a moved diff must never be carried forward, even via the CLI');
    } finally { cleanup(dir); }
  });

  it(`caps consecutive carries at the documented depth — the next carry-forward exits 1`, () => {
    const { dir, g } = repoAt('export const x = 0;\n');
    try {
      g('checkout', '-q', '-b', 'feat');
      writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 1;\n');
      g('add', '-A'); g('commit', '-qm', 'the reviewed change');

      let rev = JSON.parse(runBin(['record-cross-model', '--ticket', 'T1', '--provider', 'openai', '--author-provider', 'anthropic', '--verdict', 'approve', '--base', 'main', '--dir', '.adlc', '--json'], dir).stdout).data.revision;

      const advanceMainAndRebase = (label) => {
        g('checkout', '-q', 'main');
        writeFileSync(join(dir, `${label}.md`), `${label}\n`);
        g('add', '-A'); g('commit', '-qm', label);
        g('checkout', '-q', 'feat');
        g('rebase', '-q', 'main');
      };

      let depth = 0;
      for (let i = 0; i < 3; i += 1) {
        advanceMainAndRebase(`docs-${i}`);
        const r = runBin(['record-cross-model', '--ticket', 'T1', '--carry-forward', rev, '--base', 'main', '--dir', '.adlc', '--json'], dir);
        assert.equal(r.status, 0, `carry #${i + 1} within the cap must succeed`);
        const data = JSON.parse(r.stdout).data;
        depth = data.carryDepth;
        rev = data.revision;
      }
      assert.equal(depth, 3);

      advanceMainAndRebase('docs-final');
      const overCap = runBin(['record-cross-model', '--ticket', 'T1', '--carry-forward', rev, '--base', 'main', '--dir', '.adlc'], dir);
      assert.equal(overCap.status, 1, 'the 4th consecutive carry-forward must fail closed and demand a fresh review');
      assert.match(overCap.stderr, /fresh/i);
    } finally { cleanup(dir); }
  });
});
