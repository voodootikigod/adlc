import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRevision, sha256 } from '@adlc/core';
import { appendManifestEntry as realAppend } from '@adlc/gate-manifest';
import { ticketHash } from '@adlc/tickets';
import { TRACK_REQUIREMENTS, allPhases, allTracks, assertPhase } from '../lib/assertions.mjs';
import { VALID_TRACKS, evaluateTriage } from '../lib/triage.mjs';
import { scanRepositoryBloat } from '../lib/simplify.mjs';

const RUNNER_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'adlc.mjs');
const appendEntry = (entry, dir, key = null) => realAppend(entry, dir, { key });

function makeTempDir(t, prefix = 'adlc-triage-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeGitRepo(t) {
  const dir = makeTempDir(t, 'adlc-track-repo-');
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@adlc.local');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  return { dir, g };
}

function writeFullP5(dir, { ticket = 'T1', revision, cwd }) {
  const tDef = { id: ticket, title: 'fixture', scope: ['src/**'], rails: ['test/**'], edges: [] };
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [tDef] }));
  const evDir = join(cwd, '.adlc');
  mkdirSync(evDir, { recursive: true });
  const trPath = join(evDir, 'p5-tr.txt');
  const prPath = join(evDir, 'p5-pr.txt');
  const inPath = join(evDir, 'p5-in.txt');
  writeFileSync(trPath, `ticket: ${ticket}\nreviewed revision: ${revision}\n${'verified review line\n'.repeat(4)}`);
  writeFileSync(prPath, `prompt ${revision}\n`);
  writeFileSync(inPath, `inputs ${revision}\n`);
  const lenses = ['security', 'correctness', 'tests'];
  lenses.forEach((lens, idx) => {
    const pass = idx + 1;
    appendEntry({ type: 'p5-dry-pass', ticket, revision, pass, lens, consecutiveDry: pass }, dir);
    appendEntry({ type: 'p5-pass-completed', ticket, revision, pass, lens, dry: true, consecutiveDry: pass }, dir);
  });
  appendEntry({
    type: 'p5-complete',
    ticket,
    revision,
    pass: 3,
    consecutiveDry: 3,
    provenance: { reviewer: 'rev', command: 'cmd', transcript: trPath },
    transcript: { path: trPath, hash: sha256(readFileSync(trPath)) },
    reviewPacket: {
      prompt: { path: prPath, hash: sha256(readFileSync(prPath)) },
      inputs: { path: inPath, hash: sha256(readFileSync(inPath)) },
      cleanWorktree: revision,
    },
    dryLenses: lenses,
    ticketHash: ticketHash(tDef),
  }, dir);
}

describe('evaluateTriage track precedence and git collection', () => {
  it('classifies trivial, bounded, substantial, and architectural boundaries', (t) => {
    const cwd = makeTempDir(t);
    assert.deepEqual(allTracks(), ['trivial', 'bounded', 'substantial', 'architectural']);
    assert.deepEqual(VALID_TRACKS, ['trivial', 'bounded', 'substantial', 'architectural']);
    assert.deepEqual(allPhases(), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);

    const triv = evaluateTriage({ cwd, files: ['packages/a/lib/x.mjs', 'packages/a/lib/y.ts', 'packages/a/test/x.test.mjs'], linesAdded: 20, linesDeleted: 10 });
    assert.equal(triv.track, 'trivial');
    assert.equal(triv.ticketRequired, false);
    assert.equal(triv.requireFreshContext, false);
    assert.equal(triv.codeFilesChanged, 2);
    assert.deepEqual(triv.requiredGates, TRACK_REQUIREMENTS.trivial);

    const bndMin = evaluateTriage({ cwd, files: ['packages/a/lib/x.mjs'], linesAdded: 20, linesDeleted: 11 });
    assert.equal(bndMin.track, 'bounded');
    assert.equal(bndMin.ticketRequired, true);
    assert.equal(bndMin.requireFreshContext, false);

    const bndMax = evaluateTriage({ cwd, files: ['packages/a/a.py', 'packages/a/b.go', 'packages/a/c.rs', 'packages/a/test_a.py', 'packages/a/b_test.go'], linesAdded: 100, linesDeleted: 50 });
    assert.equal(bndMax.track, 'bounded');
    assert.equal(bndMax.codeFilesChanged, 3);

    const subLines = evaluateTriage({ cwd, files: ['packages/a/lib/x.mjs'], linesAdded: 151, linesDeleted: 0 });
    assert.equal(subLines.track, 'substantial');
    assert.equal(subLines.requireFreshContext, true);

    const subPart = evaluateTriage({ cwd, files: ['packages/a/lib/x.mjs', 'packages/b/lib/y.mjs', 'crates/c/lib.rs'], linesAdded: 4, linesDeleted: 0 });
    assert.equal(subPart.track, 'substantial');
    assert.deepEqual(subPart.partitions, ['crates/c', 'packages/a', 'packages/b']);

    const subRiskTwoPart = evaluateTriage({ cwd, files: ['packages/a/x.mjs', 'plugins/b/auth/guard.mjs'] });
    assert.equal(subRiskTwoPart.track, 'substantial');

    const subContract = evaluateTriage({ cwd, files: ['packages/a/package.json'], linesAdded: 1, linesDeleted: 1 });
    assert.equal(subContract.track, 'substantial');
    assert.equal(subContract.contractSurfaceChanged, true);

    const archContract = evaluateTriage({ cwd, files: ['packages/a/index.d.ts', 'services/api/main.go'], linesAdded: 2, linesDeleted: 0 });
    assert.equal(archContract.track, 'architectural');
    assert.deepEqual(archContract.requiredGates, TRACK_REQUIREMENTS.architectural);

    const archRisk = evaluateTriage({ cwd, files: ['packages/a/x.mjs', 'plugins/b/y.mjs', 'crates/c/src/auth/guard.rs'] });
    assert.equal(archRisk.track, 'architectural');
  });

  it('reads live git diff numstat and untracked files when --files is omitted', (t) => {
    const { dir, g } = makeGitRepo(t);
    mkdirSync(join(dir, 'packages/alpha/lib'), { recursive: true });
    mkdirSync(join(dir, 'packages/alpha/test'), { recursive: true });
    writeFileSync(join(dir, 'packages/alpha/lib/mod.mjs'), 'export const a = 1;\nexport const b = 2;\n');
    g('add', '-A');
    g('commit', '-qm', 'init');

    writeFileSync(join(dir, 'packages/alpha/lib/mod.mjs'), 'export const a = 10;\n');
    writeFileSync(join(dir, 'packages/alpha/test/mod.test.mjs'), `${'// test\n'.repeat(80)}`);
    writeFileSync(join(dir, 'packages/alpha/lib/extra.mjs'), `${'export const line = 1;\n'.repeat(30)}`);
    const res = evaluateTriage({ cwd: dir });
    assert.equal(res.track, 'bounded');
    assert.equal(res.linesAdded, 31);
    assert.equal(res.linesDeleted, 2);
    assert.equal(res.totalCodeLines, 33);
    assert.equal(res.codeFilesChanged, 2);
  });
});

describe('scanRepositoryBloat simplify radar', () => {
  it('detects 12-line clones across files and reinvented core helpers while honoring exclusions', (t) => {
    const root = makeTempDir(t, 'adlc-simplify-');
    mkdirSync(join(root, 'packages/core/lib'), { recursive: true });
    mkdirSync(join(root, 'packages/pkg-a/lib'), { recursive: true });
    mkdirSync(join(root, 'packages/pkg-b/lib'), { recursive: true });
    mkdirSync(join(root, 'packages/pkg-b/test'), { recursive: true });

    const shared12 = Array.from({ length: 12 }, (_, i) => `const s${i} = fetchUrl("https://ex.test/*x*/", ${i});`).join('\n');
    const short11 = Array.from({ length: 11 }, (_, i) => `const u${i} = otherCall(${i});`).join('\n');
    writeFileSync(join(root, 'packages/pkg-a/lib/one.mjs'), `// comment\n${shared12}\nexport function writeFileAtomic(p, c) { return [p, c]; }\n`);
    writeFileSync(join(root, 'packages/pkg-b/lib/two.mjs'), `/* block\ncomment */\n\n${shared12}\nimport { redactSecrets } from '@adlc/core';\nexport const redactSecrets = (v) => v;\nexport const canonicalJson = (x) => JSON.stringify(x);\n`);
    writeFileSync(join(root, 'packages/pkg-a/lib/short-a.mjs'), `${short11}\n`);
    writeFileSync(join(root, 'packages/pkg-b/lib/short-b.mjs'), `${short11}\n`);
    writeFileSync(join(root, 'packages/pkg-b/lib/same.mjs'), `${Array.from({ length: 12 }, (_, i) => `const z${i} = solo(${i});`).join('\n')}\n${Array.from({ length: 12 }, (_, i) => `const z${i} = solo(${i});`).join('\n')}\n`);
    writeFileSync(join(root, 'packages/pkg-b/lib/ignore.bundle.mjs'), `${shared12}\nfunction globMatch() {}\n`);
    writeFileSync(join(root, 'packages/pkg-b/test/ignore.mjs'), `${shared12}\nfunction acquireDirLock() {}\n`);
    writeFileSync(join(root, 'packages/core/lib/prims.mjs'), `export function writeFileAtomic() {}\n`);

    const report = scanRepositoryBloat({ root });
    assert.equal(report.duplicateBlocks.length, 1);
    assert.equal(report.duplicateBlocks[0].lineCount, 12);
    assert.deepEqual(report.duplicateBlocks[0].locations.map((l) => l.file), [
      'packages/pkg-a/lib/one.mjs',
      'packages/pkg-b/lib/two.mjs',
    ]);
    assert.deepEqual(report.coreReinventions, [
      { helper: 'writeFileAtomic', file: 'packages/pkg-a/lib/one.mjs', line: 14 },
      { helper: 'canonicalJson', file: 'packages/pkg-b/lib/two.mjs', line: 18 },
    ]);
  });
});

describe('assertPhase track modes and witnessed fresh-context gates', () => {
  it('enforces trivial, bounded, invalid --track, non-dry pass, and forged rails-check failures', (t) => {
    const { dir: cwd, g } = makeGitRepo(t);
    const adlcDir = join(cwd, '.adlc');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    mkdirSync(adlcDir, { recursive: true });
    const railFile = join(cwd, 'test/r.test.mjs');
    writeFileSync(railFile, 'export const ok = true;\n');
    g('add', '-A');
    g('commit', '-qm', 'base');

    assert.equal(assertPhase('trivial', { dir: adlcDir, cwd, track: 'bounded' }).operational, true);
    assert.equal(assertPhase('bounded', { dir: adlcDir, cwd, ticket: 'T1', track: 'trivial' }).operational, true);
    assert.equal(assertPhase('p0', { dir: adlcDir, cwd, ticket: 'T1', track: 'unknown' }).operational, true);
    assert.equal(assertPhase('bounded', { dir: adlcDir, cwd }).operational, true);
    assert.equal(assertPhase('trivial', { dir: adlcDir, cwd: makeTempDir(t) }).operational, true);

    const rev = resolveRevision({ cwd });
    appendEntry({ type: 'rails-check' }, adlcDir);
    appendEntry({ gate: 'hollow-test' }, adlcDir);
    appendEntry({ type: 'p5-pass-completed', revision: rev, dry: false, lens: 'correctness' }, adlcDir);
    assert.equal(spawnSync(process.execPath, [RUNNER_BIN, 'run', 'trivial', '--dir', adlcDir], { cwd, encoding: 'utf8' }).status, 2);

    appendEntry({ type: 'rails-check', railsDiffEmpty: true, suppressionsClean: true, railFiles: { 'test/r.test.mjs': sha256(readFileSync(railFile)) } }, adlcDir);
    assert.equal(assertPhase('trivial', { dir: adlcDir, cwd }).ok, false);

    appendEntry({ type: 'p5-pass-completed', revision: rev, dry: true, lens: 'correctness' }, adlcDir);
    assert.equal(assertPhase('trivial', { dir: adlcDir, cwd, track: 'trivial' }).ok, true);

    const bDir = join(cwd, '.adlc-bounded');
    mkdirSync(bDir, { recursive: true });
    const bRev = resolveRevision({ cwd, ignorePaths: [bDir] });
    appendEntry({ gate: 'rails-red', ticket: 'T1' }, bDir);
    appendEntry({ gate: 'hollow-test', ticket: 'T1' }, bDir);
    appendEntry({ type: 'rails-check', ticket: 'T1', railsDiffEmpty: true, suppressionsClean: true, railFiles: { 'test/r.test.mjs': sha256(readFileSync(railFile)) } }, bDir);
    writeFullP5(bDir, { ticket: 'T1', revision: bRev, cwd });
    assert.equal(assertPhase('bounded', { dir: bDir, ticket: 'T1', revision: bRev, cwd, track: 'bounded' }).ok, true);
  });

  it('enforces witnessed provenance on substantial, architectural, and requireFreshContext', (t) => {
    const cwd = makeTempDir(t, 'adlc-fresh-');
    const dir = join(cwd, '.adlc');
    mkdirSync(dir, { recursive: true });
    const tDef = { id: 'T1', title: 'fresh', scope: ['src/**'], rails: [], edges: [] };
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [tDef] }));
    const tHash = ticketHash(tDef);
    const specPath = join(cwd, 'spec.md');
    writeFileSync(specPath, '# Spec\n- Verified by `node --test`\n');
    const sHash = sha256(readFileSync(specPath));

    appendEntry({ gate: 'coldstart', ticket: 'T1', data: { promptOnly: true, verdict: JSON.stringify({ gaps: [], ticketHash: tHash }) } }, dir);
    assert.equal(spawnSync(process.execPath, [RUNNER_BIN, 'run', 'p0', '--dir', dir, '--ticket', 'T1', '--track', 'substantial'], { cwd, encoding: 'utf8' }).status, 2);
    appendEntry({ gate: 'coldstart', ticket: 'T1', data: { cache: { ticketHash: tHash, model: '', gaps: [] } } }, dir);
    assert.equal(assertPhase('p0', { dir, ticket: 'T1', cwd, requireFreshContext: true }).ok, false);
    appendEntry({ gate: 'coldstart', ticket: 'T1', data: { cache: { ticketHash: tHash, model: 'm1', gaps: [] } } }, dir);
    assert.equal(assertPhase('p0', { dir, ticket: 'T1', cwd, track: 'substantial' }).ok, true);

    appendEntry({ gate: 'spec-lint', ticket: 'T1', files: { [specPath]: sHash }, data: { verified: true } }, dir);
    appendEntry({ gate: 'premortem', ticket: 'T1', files: { [specPath]: sHash }, data: { cache: { ticketHash: tHash, model: 'm1', gaps: [] } } }, dir);
    appendEntry({ gate: 'spec-approval', ticket: 'T1', files: { [specPath]: sHash }, data: { verdict: 'approved', approver: 'op', spec_hash: sHash, rounds: 1, questions: 1, sources: ['premortem'], unresolved: 0 } }, dir);
    assert.equal(assertPhase('p1', { dir, ticket: 'T1', cwd, track: 'substantial' }).ok, false);

    appendEntry({ gate: 'premortem', ticket: 'T1', files: { [specPath]: sHash }, data: { usage: { provider: 'anthropic' } } }, dir);
    appendEntry({ gate: 'spec-approval', ticket: 'T1', files: { [specPath]: sHash }, data: { verdict: 'approved', approver: 'op', spec_hash: sHash, rounds: 1, questions: 1, sources: ['premortem'], unresolved: 0 } }, dir);
    assert.equal(assertPhase('p1', { dir, ticket: 'T1', cwd, track: 'substantial' }).ok, true);

    assert.deepEqual(assertPhase('p1', { dir, ticket: 'T1', cwd, track: 'architectural' }).missing, ['parallax']);
    appendEntry({ gate: 'parallax', ticket: 'T1', data: { promptOnly: true, executionWitnessed: true } }, dir);
    assert.equal(assertPhase('p1', { dir, ticket: 'T1', cwd, track: 'architectural' }).ok, false);
    appendEntry({ gate: 'parallax', ticket: 'T1', data: { executionWitnessed: true, provider: 'claude-cli' } }, dir);
    assert.equal(assertPhase('p1', { dir, ticket: 'T1', cwd, track: 'architectural' }).ok, true);
  });
});
