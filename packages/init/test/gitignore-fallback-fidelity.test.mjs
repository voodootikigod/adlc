import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADLC_GITIGNORE_LINES } from '../lib/gitignore-defaults.mjs';
import {
  REQUIRED_COMMITTABLE_PATHS,
  evaluateEffectiveGitignoreContract,
  evaluateGitignoreContract,
} from '../lib/scaffold.mjs';

const NEGATIONS = ADLC_GITIGNORE_LINES.slice(1);

// Shapes a hand-written or tool-written .gitignore plausibly takes, including
// every one on which a looser matcher reports fewer ignored paths than git.
const CORPUS = [
  ADLC_GITIGNORE_LINES,
  ['*/', '!.adlc/config.json'],
  ['**/.adlc/*', '!.adlc/config.json'],
  ['**/.adlc/*', ...NEGATIONS],
  ['.adlc/**', '!.adlc/config.json', '!.adlc/tickets/', '!.adlc/manifest.d/'],
  ['.adlc/*', '!.adlc/tickets/**', '!.adlc/manifest.d/**', '!.adlc/config.json'],
  ['.adlc/config.jso?'],
  ['.adlc/[cm]*'],
  ['.adlc/[!c]*'],
  ['.adlc/', '!.adlc/tickets/'],
  ['.adlc', '!.adlc/config.json'],
  ['/.adlc/*', '!/.adlc/config.json'],
  ['*.json', '!.adlc/config.json'],
  ['*.jsonl'],
  ['manifest.d/'],
  ['**/manifest.d'],
  ['.adlc/**/seg-*.jsonl'],
  ['.adlc/**/*.jsonl', '!.adlc/manifest.d/**'],
  ['**'],
  ['**', '!**/'],
  ['build(', 'c++/', 'foo)bar', 'Build (Release)/', 'a|b', '$x', '^y', '{z}'],
  ['.adlc/config.json  ', '# .adlc/*', '\\#.adlc'],
  ['!.adlc/manifest.jsonl', '.adlc/*'],
  ['.adlc/*', '!.adlc/manifest.d/', '.adlc/manifest.d/*.jsonl'],
];

function gitVerdicts(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-fidelity-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), `${lines.join('\n')}\n`);
    return REQUIRED_COMMITTABLE_PATHS.filter(
      (p) => spawnSync('git', ['check-ignore', '--no-index', '-q', '--', p], { cwd: dir }).status === 0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the JavaScript matcher agrees with git on every corpus shape', () => {
  for (const lines of CORPUS) {
    assert.deepEqual(evaluateGitignoreContract(lines), gitVerdicts(lines), JSON.stringify(lines));
  }
});

test('regex metacharacters in unrelated lines never throw', () => {
  for (const line of ['build(', 'c++/', 'foo)bar', 'x[', 'a\\', '[]', '[!]']) {
    assert.doesNotThrow(() => evaluateGitignoreContract([line, '.adlc/*']), line);
  }
});

test('outside a repository the contract is still decided by git, not the JavaScript model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-norepo-'));
  try {
    assert.equal(spawnSync('git', ['check-ignore', '--no-index', '-q', '--', 'x'], { cwd: dir }).status, 128);
    for (const shape of CORPUS) {
      assert.deepEqual(evaluateEffectiveGitignoreContract(dir, shape), gitVerdicts(shape), JSON.stringify(shape));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a repository, a mis-ordered .gitignore fails init', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-norepo-'));
  try {
    writeFileSync(join(dir, '.gitignore'), `${[...ADLC_GITIGNORE_LINES, '.adlc/config.jso?'].join('\n')}\n`);
    const bin = new URL('../bin/adlc-init.mjs', import.meta.url).pathname;
    const res = spawnSync(process.execPath, [bin, '--root', dir, '--harness', 'codex', '--json'], { encoding: 'utf8' });
    assert.equal(res.status, 1, res.stdout);
    assert.ok(JSON.parse(res.stdout).warnings.some((w) => w.includes('mis-ordered') && w.includes('.adlc/config.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a git binary the JavaScript model decides, and fails closed on parent-directory exclusion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-nogit-'));
  try {
    const emptyBin = join(dir, 'empty-bin');
    mkdirSync(emptyBin);
    const scaffoldUrl = new URL('../lib/scaffold.mjs', import.meta.url).href;
    const script = `import(${JSON.stringify(scaffoldUrl)}).then((m) => console.log(JSON.stringify(
      m.evaluateEffectiveGitignoreContract(process.cwd(), ['*/', '!.adlc/config.json']))))`;
    const res = spawnSync(process.execPath, ['-e', script], {
      cwd: dir,
      env: { ...process.env, PATH: emptyBin },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), [...REQUIRED_COMMITTABLE_PATHS]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
