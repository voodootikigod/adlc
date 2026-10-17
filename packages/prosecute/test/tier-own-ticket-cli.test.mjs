// Concern: the recorder and `tier-check` pass the ticket under prosecution to
// classifyTrustRootTier as `ownTicket` (#1180), end-to-end at the process
// boundary in a real git repo.
//
// Properties pinned:
//   - `tier-check --ticket T2` on a change that adds T2 with a rail and edits
//     that rail does NOT tier; stderr names the skipped rail and --json lists it;
//   - the same change without --ticket still tiers (the CI form is unchanged);
//   - --ticket naming ANOTHER ticket still tiers on T2's rail;
//   - an own rail already on the base still tiers, and the base copy's rails
//     still apply when HEAD narrows them;
//   - base rails come from the canonical store and an in-repo --dir table at
//     the base, only for the named ticket, found through a symlinked or
//     case-variant --dir; a --dir table new on the branch or outside the repo
//     adds none, and a malformed base table exits 1;
//   - every --json branch, the no-key one included, carries skippedOwnRails;
//   - the recorder on an own-new-rail change with a dry panel and no attestation
//     exits 0 and writes no p5-cross-model-missing entry.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sha256 } from '@adlc/core';
import { resolveProsecutionRevision } from '../lib/run.mjs';

const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

process.env.ADLC_MANIFEST_KEY = 'test-tier-own-ticket-signing-key';

// spawnSync so stderr is captured on the exit-0 path too (the skipped-rail line).
function runBin(args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const PINNED_GIT_DATE = '2026-01-01T00:00:00Z';

const T = (over = {}) => ({ id: 'T1', title: 'x', scope: ['src/**'], rails: [], edges: [], ...over });

const writeTickets = (dir, tickets) => writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }));

function writeFile(dir, rel, content) {
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

// Scratch repo: `baseTickets` and `baseFiles` committed on main, then on a feat
// branch `headTickets` replaces the table and `headFiles` are written and
// committed. The review-packet placeholders are committed on main so no
// untracked evidence file perturbs the changed-file set.
function scratchRepo({ baseTickets, headTickets, baseFiles = {}, headFiles = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-tier-own-ticket-'));
  fixtureDirs.add(dir);
  const g = (...a) => execFileSync('git', a, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_DATE: PINNED_GIT_DATE, GIT_COMMITTER_DATE: PINNED_GIT_DATE },
  });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFile(dir, 'README.md', 'baseline\n');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeTickets(dir, baseTickets);
  for (const [rel, content] of Object.entries(baseFiles)) writeFile(dir, rel, content);
  writeFile(dir, '.adlc/review.txt', 'placeholder\n');
  writeFile(dir, '.adlc/prompt.txt', 'review prompt\n');
  writeFile(dir, '.adlc/inputs.txt', 'reviewed input packet\n');
  g('add', '-A'); g('commit', '-qm', 'baseline');
  g('checkout', '-q', '-b', 'feat');
  writeTickets(dir, headTickets);
  for (const [rel, content] of Object.entries(headFiles)) writeFile(dir, rel, content);
  g('add', '-A'); g('commit', '-qm', 'feat change');
  return dir;
}

// The bounded-ticket shape from #1180: the change ADDS ticket T2, declares its
// RED test as a rail, and writes that test.
const ownNewRailRepo = () => scratchRepo({
  baseTickets: [T()],
  headTickets: [T(), T({ id: 'T2', rails: ['test/own/**'] })],
  headFiles: { 'test/own/red.test.mjs': 'export const red = 1;\n' },
});

// Platform capabilities the alias tests need, probed once in a scratch dir.
function probe(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-tier-own-ticket-probe-'));
  fixtureDirs.add(dir);
  try { return fn(dir); } catch { return false; }
}
const CAN_SYMLINK = probe((dir) => { mkdirSync(join(dir, 'a')); symlinkSync('a', join(dir, 'b'), 'dir'); return true; });
const CASE_INSENSITIVE = probe((dir) => { writeFileSync(join(dir, 'probe'), ''); return existsSync(join(dir, 'PROBE')); });

const tierCheck = (dir, extra = []) =>
  runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc', ...extra], dir);

const SKIP_LINE = 'tier: skipped own new rail of ticket T2: test/own/** (not on base main)';

describe('tier-check --ticket skips only that ticket\'s own new rails (#1180)', () => {
  it('an own new rail does not tier; stderr names it and --json lists it', () => {
    const dir = ownNewRailRepo();
    const r = tierCheck(dir, ['--ticket', 'T2', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      trustRootTier: false, reasons: [], crossModelRequired: false, satisfied: true, skippedOwnRails: ['test/own/**'],
    });
    assert.ok(r.stderr.includes(SKIP_LINE), r.stderr);
  });

  it('without --ticket the same change still tiers (unchanged CI behaviour)', () => {
    const dir = ownNewRailRepo();
    const r = tierCheck(dir, ['--json']);
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.trustRootTier, true);
    assert.deepEqual(out.reasons, ['touches rails deny-path of ticket T2: test/own/**']);
    assert.deepEqual(out.skippedOwnRails, []);
    assert.ok(!r.stderr.includes('skipped own new rail'), r.stderr);
  });

  it('--ticket naming another ticket still tiers on the added ticket\'s rail', () => {
    const dir = ownNewRailRepo();
    const r = tierCheck(dir, ['--ticket', 'T1', '--json']);
    assert.equal(r.status, 2);
    assert.deepEqual(JSON.parse(r.stdout).reasons, ['touches rails deny-path of ticket T2: test/own/**']);
  });

  it('own ticket on the base with rail a, HEAD adds rail b: a tiers, b does not', () => {
    const repo = (file) => scratchRepo({
      baseTickets: [T({ rails: ['src/a/**'] })],
      headTickets: [T({ rails: ['src/a/**', 'src/b/**'] })],
      baseFiles: { 'src/a/x.mjs': 'v1\n', 'src/b/x.mjs': 'v1\n' },
      headFiles: { [file]: 'v2\n' },
    });
    const a = tierCheck(repo('src/a/x.mjs'), ['--ticket', 'T1', '--json']);
    assert.equal(a.status, 2);
    assert.deepEqual(JSON.parse(a.stdout).reasons, ['touches rails deny-path of ticket T1: src/a/**']);
    const b = tierCheck(repo('src/b/x.mjs'), ['--ticket', 'T1', '--json']);
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(JSON.parse(b.stdout).skippedOwnRails, ['src/b/**']);
  });

  it('a base rail still tiers when HEAD narrows the ticket\'s rails', () => {
    const dir = scratchRepo({
      baseTickets: [T({ rails: ['src/a/**', 'src/b/**'] })],
      headTickets: [T({ rails: ['src/a/**'] })],
      baseFiles: { 'src/b/x.mjs': 'v1\n' },
      headFiles: { 'src/b/x.mjs': 'v2\n' },
    });
    const r = tierCheck(dir, ['--ticket', 'T1', '--json']);
    assert.equal(r.status, 2);
    assert.deepEqual(JSON.parse(r.stdout).reasons, ['touches rails deny-path of ticket T1: src/b/**']);
  });

  it('an in-repo --dir table is read at the base too: its base rail tiers, its new rail is skipped', () => {
    const table = (rails) => JSON.stringify({ tickets: [T({ rails })] });
    const repo = (file) => scratchRepo({
      baseTickets: [],
      headTickets: [],
      baseFiles: { 'custom/tickets.json': table(['src/a/**']), 'src/a/x.mjs': 'v1\n', 'src/b/x.mjs': 'v1\n' },
      headFiles: { 'custom/tickets.json': table(['src/a/**', 'src/b/**']), [file]: 'v2\n' },
    });
    const custom = (dir) => runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'custom', '--ticket', 'T1', '--json'], dir);
    const a = custom(repo('src/a/x.mjs'));
    assert.equal(a.status, 2, 'a rail the base --dir table already declares must still tier');
    assert.deepEqual(JSON.parse(a.stdout).reasons, ['touches rails deny-path of ticket T1: src/a/**']);
    const b = custom(repo('src/b/x.mjs'));
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(JSON.parse(b.stdout).skippedOwnRails, ['src/b/**']);
  });

  it('a malformed --dir table at the base fails closed (exit 1) instead of reading as "no base rails"', () => {
    const dir = scratchRepo({
      baseTickets: [],
      headTickets: [],
      baseFiles: { 'custom/tickets.json': '{"tickets": null}' },
      headFiles: { 'custom/tickets.json': JSON.stringify({ tickets: [T({ rails: ['src/**'] })] }), 'src/app.mjs': 'v2\n' },
    });
    const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'custom', '--ticket', 'T1'], dir);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /non-array `tickets` field/);
  });

  it('an in-repo --dir table the base does not have yet contributes no base rails (not an error)', () => {
    const dir = scratchRepo({
      baseTickets: [],
      headTickets: [],
      headFiles: { 'custom/tickets.json': JSON.stringify({ tickets: [T({ id: 'T2', rails: ['test/own/**'] })] }), 'test/own/red.test.mjs': 'x\n' },
    });
    const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'custom', '--ticket', 'T2', '--json'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).skippedOwnRails, ['test/own/**']);
  });

  // The worktree read follows a symlinked or case-variant --dir, so the base
  // read must find the same table; otherwise a base rail reads as new.
  const aliasRepo = () => scratchRepo({
    baseTickets: [],
    headTickets: [],
    baseFiles: { 'custom/tickets.json': JSON.stringify({ tickets: [T({ rails: ['docs/secret.md'] })] }), 'docs/secret.md': 'a\n' },
    headFiles: { 'docs/secret.md': 'b\n' },
  });
  const viaDir = (dir, ticketDir) =>
    runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', ticketDir, '--ticket', 'T1', '--json'], dir);

  it('a symlinked --dir still finds the base table: its base rail tiers', { skip: !CAN_SYMLINK && 'symlinks unavailable here' }, () => {
    const dir = aliasRepo();
    symlinkSync('custom', join(dir, 'alias'), 'dir');
    const r = viaDir(dir, 'alias');
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).reasons, ['touches rails deny-path of ticket T1: docs/secret.md']);
    assert.ok(!r.stderr.includes('skipped own new rail'), r.stderr);
  });

  it('a case-variant --dir still finds the base table on a case-insensitive filesystem', { skip: !CASE_INSENSITIVE && 'case-sensitive filesystem' }, () => {
    const dir = aliasRepo();
    const r = viaDir(dir, 'CUSTOM');
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).reasons, ['touches rails deny-path of ticket T1: docs/secret.md']);
  });

  it('an out-of-repo --dir is not read at the base, the same containment rule as the ticket set', () => {
    const dir = ownNewRailRepo();
    const outside = mkdtempSync(join(tmpdir(), 'adlc-tier-own-ticket-outside-'));
    fixtureDirs.add(outside);
    writeFileSync(join(outside, 'tickets.json'), JSON.stringify({ tickets: [T({ id: 'T2', rails: ['test/own/**'] })] }));
    const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', outside, '--ticket', 'T2', '--json'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).skippedOwnRails, ['test/own/**']);
  });

  it('an in-repo symlink to an out-of-repo --dir is outside the repo: its table is not read, so its rails are not exempted', { skip: !CAN_SYMLINK && 'symlinks unavailable here' }, () => {
    const dir = scratchRepo({ baseTickets: [], headTickets: [], headFiles: { 'test/own/red.test.mjs': 'x\n' } });
    const outside = mkdtempSync(join(tmpdir(), 'adlc-tier-own-ticket-outside-'));
    fixtureDirs.add(outside);
    writeFileSync(join(outside, 'tickets.json'), JSON.stringify({ tickets: [T({ id: 'T2', rails: ['test/own/**'] })] }));
    symlinkSync(outside, join(dir, 'alias'), 'dir');
    const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'alias', '--ticket', 'T2', '--json'], dir);
    assert.ok(!r.stdout.includes('skippedOwnRails') || !JSON.parse(r.stdout).skippedOwnRails?.includes('test/own/**'), r.stdout + r.stderr);
    assert.ok(!r.stderr.includes('skipped own new rail'), r.stderr);
  });

  it('an in-repo --dir whose tickets.json is a symlink to an out-of-repo file is not read either', { skip: !CAN_SYMLINK && 'symlinks unavailable here' }, () => {
    const dir = scratchRepo({ baseTickets: [], headTickets: [], headFiles: { 'test/own/red.test.mjs': 'x\n' } });
    const outside = mkdtempSync(join(tmpdir(), 'adlc-tier-own-ticket-outside-'));
    fixtureDirs.add(outside);
    writeFileSync(join(outside, 'tickets.json'), JSON.stringify({ tickets: [T({ id: 'T2', rails: ['test/own/**'] })] }));
    mkdirSync(join(dir, 'custom'));
    symlinkSync(join(outside, 'tickets.json'), join(dir, 'custom', 'tickets.json'), 'file');
    const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'custom', '--ticket', 'T2', '--json'], dir);
    assert.ok(!r.stderr.includes('skipped own new rail'), r.stderr);
    assert.ok(!(JSON.parse(r.stdout || '{}').skippedOwnRails ?? []).includes('test/own/**'), r.stdout + r.stderr);
  });

  it('a branch that retargets a symlinked --dir does not hide the rail the base table froze', { skip: !CAN_SYMLINK && 'symlinks unavailable here' }, () => {
    const table = JSON.stringify({ tickets: [T({ rails: ['docs/secret.md'] })] });
    const dir = scratchRepo({
      baseTickets: [],
      headTickets: [],
      baseFiles: { 'custom/tickets.json': table, 'docs/secret.md': 'a\n' },
      headFiles: { 'other/tickets.json': table, 'docs/secret.md': 'b\n' },
    });
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('checkout', '-q', 'main');
    symlinkSync('custom', join(dir, 'alias'), 'dir');
    g('add', '-A'); g('commit', '-qm', 'base alias');
    g('checkout', '-q', 'feat');
    g('merge', '-q', '--no-edit', 'main');
    rmSync(join(dir, 'alias'));
    symlinkSync('other', join(dir, 'alias'), 'dir');
    g('add', '-A'); g('commit', '-qm', 'retarget alias');
    const r = viaDir(dir, 'alias');
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).reasons, ['touches rails deny-path of ticket T1: docs/secret.md']);
    assert.ok(!r.stderr.includes('skipped own new rail'), r.stderr);
  });

  it('an absolute base symlink target is outside the repo: a same-named in-repo path is not read as the base table', { skip: !CAN_SYMLINK && 'symlinks unavailable here' }, () => {
    const table = JSON.stringify({ tickets: [T({ rails: ['docs/secret.md'] })] });
    const dir = scratchRepo({
      baseTickets: [],
      headTickets: [],
      baseFiles: { 'abs/tickets.json': table, 'docs/secret.md': 'a\n' },
      headFiles: { 'other/tickets.json': table, 'docs/secret.md': 'b\n' },
    });
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('checkout', '-q', 'main');
    symlinkSync('/abs', join(dir, 'alias'), 'dir');
    g('add', '-A'); g('commit', '-qm', 'base alias');
    g('checkout', '-q', 'feat');
    g('merge', '-q', '--no-edit', 'main');
    rmSync(join(dir, 'alias'));
    symlinkSync('other', join(dir, 'alias'), 'dir');
    g('add', '-A'); g('commit', '-qm', 'retarget alias');
    const r = viaDir(dir, 'alias');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).skippedOwnRails, ['docs/secret.md']);
  });

  // A base tickets.json that is itself a symlink holds a path, not JSON.
  const fileLinkRepo = (target) => {
    const table = JSON.stringify({ tickets: [T({ rails: ['docs/secret.md'] })] });
    const dir = scratchRepo({
      baseTickets: [],
      headTickets: [],
      baseFiles: { 'real/tickets.json': table, 'docs/secret.md': 'a\n' },
      headFiles: { 'docs/secret.md': 'b\n' },
    });
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('checkout', '-q', 'main');
    mkdirSync(join(dir, 'custom'));
    symlinkSync(target, join(dir, 'custom', 'tickets.json'), 'file');
    g('add', '-A'); g('commit', '-qm', 'base file link');
    g('checkout', '-q', 'feat');
    g('merge', '-q', '--no-edit', 'main');
    return dir;
  };

  it('a base tickets.json symlink to an in-repo table is followed, not parsed as text: its rail tiers', { skip: !CAN_SYMLINK && 'symlinks unavailable here' }, () => {
    const r = viaDir(fileLinkRepo('../real/tickets.json'), 'custom');
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).reasons, ['touches rails deny-path of ticket T1: docs/secret.md']);
  });

  it('a base tickets.json symlink to an external target is skipped, not parsed as text', { skip: !CAN_SYMLINK && 'symlinks unavailable here' }, () => {
    const r = viaDir(fileLinkRepo('/nonexistent/tickets.json'), 'custom');
    assert.notEqual(r.status, 1, r.stderr);
  });

  it('a base table path that is a directory fails closed instead of reading as absent', () => {
    const table = JSON.stringify({ tickets: [T({ rails: ['docs/secret.md'] })] });
    const dir = scratchRepo({
      baseTickets: [],
      headTickets: [],
      baseFiles: { 'custom/tickets.json/keep': 'x\n', 'docs/secret.md': 'a\n' },
      headFiles: { 'docs/secret.md': 'b\n' },
    });
    rmSync(join(dir, 'custom', 'tickets.json'), { recursive: true });
    writeFile(dir, 'custom/tickets.json', table);
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('add', '-A'); g('commit', '-qm', 'replace dir with table');
    const r = viaDir(dir, 'custom');
    assert.equal(r.status, 1, r.stdout + r.stderr);
  });

  it('base rails are only the named ticket\'s: another base ticket with the same glob tiers, the own copy is skipped', () => {
    const dir = scratchRepo({
      baseTickets: [T({ id: 'T9', rails: ['test/own/**'] })],
      headTickets: [T({ id: 'T9', rails: ['test/own/**'] }), T({ id: 'T2', rails: ['test/own/**'] })],
      headFiles: { 'test/own/red.test.mjs': 'x\n' },
    });
    const r = tierCheck(dir, ['--ticket', 'T2', '--json']);
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.reasons, ['touches rails deny-path of ticket T9: test/own/**']);
    assert.deepEqual(out.skippedOwnRails, ['test/own/**']);
  });

  it('the no-key --json output carries skippedOwnRails too', () => {
    const dir = scratchRepo({
      baseTickets: [T()],
      headTickets: [T(), T({ id: 'T2', rails: ['test/own/**'] })],
      headFiles: { 'test/own/red.test.mjs': 'x\n', 'packages/prosecute/lib/x.mjs': 'export const z = 1;\n' },
    });
    const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc', '--ticket', 'T2', '--json'], dir, { ADLC_MANIFEST_KEY: '' });
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.keyAvailable, false);
    assert.deepEqual(out.reasons, ['touches enforcement package packages/prosecute/']);
    assert.deepEqual(out.skippedOwnRails, ['test/own/**']);
  });
});

// Bind the transcript to `revision` and write a dry, converging passes input
// (all under the ticket dir, so the resolved revision stays stable).
function writePasses(dir, ticket, revision, ticketDir = '.adlc') {
  const adlc = join(dir, ticketDir);
  writeFileSync(join(adlc, 'review.txt'), [
    `ticket: ${ticket}`,
    `reviewed revision: ${revision}`,
    'review transcript fixture with enough detail to be accepted as evidence',
    'review transcript fixture with enough detail to be accepted as evidence',
  ].join('\n'));
  const prompt = join(adlc, 'prompt.txt');
  const inputs = join(adlc, 'inputs.txt');
  writeFileSync(join(adlc, 'passes.json'), JSON.stringify({
    provenance: { reviewer: 'r', session: 's', command: 'c', transcript: join(adlc, 'review.txt') },
    review_packet: {
      prompt, prompt_hash: sha256(readFileSync(prompt)),
      inputs, inputs_hash: sha256(readFileSync(inputs)),
      clean_worktree: revision,
    },
    no_findings_attestation: { reason: 'none', method: 'audit', evidence: 'review.txt' },
    passes: [
      { lens: 'security', findings: [], dry_evidence: 'no security findings' },
      { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
      { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
    ],
  }));
}

function record(dir, ticket, ticketDir = '.adlc') {
  const inputPath = `${ticketDir}/passes.json`;
  writePasses(dir, ticket, 'placeholder', ticketDir);
  const input = JSON.parse(readFileSync(join(dir, ticketDir, 'passes.json'), 'utf8'));
  const revision = resolveProsecutionRevision({ cwd: dir, dir: ticketDir, input, inputPath });
  assert.ok(revision, 'the recorder resolves a revision');
  writePasses(dir, ticket, revision, ticketDir);
  return runBin(['--input', inputPath, '--ticket', ticket, '--base', 'main', '--dir', ticketDir, '--author-provider', 'anthropic', '--json'], dir);
}

const manifest = (dir) => {
  const path = join(dir, '.adlc', 'manifest.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

describe('the recorder passes its --ticket as ownTicket (#1180)', () => {
  it('an own-new-rail change with a dry panel and no attestation exits 0 with no p5-cross-model-missing', () => {
    const dir = ownNewRailRepo();
    const r = record(dir, 'T2');
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(r.stderr.includes(SKIP_LINE), r.stderr);
    assert.doesNotMatch(r.stderr, /cross-model adversarial approve REQUIRED/);
    assert.doesNotMatch(manifest(dir), /"type":"p5-cross-model-missing"/);
    assert.match(manifest(dir), /"type":"p5-complete"/);
  });

  it('control: recording the same change under another ticket still requires cross-model (exit 2)', () => {
    const dir = ownNewRailRepo();
    const r = record(dir, 'T1');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /touches rails deny-path of ticket T2: test\/own\/\*\*/);
    assert.match(manifest(dir), /"type":"p5-cross-model-missing"/);
  });

  it('a malformed --dir table at the base fails the recorder closed (exit 1), not "no base rails"', () => {
    // The recorder reads the --dir table's ticket set from the worktree, so the
    // base read in ownTicketAtBase is the only thing that sees the bad base copy.
    const placeholders = { 'custom/review.txt': 'placeholder\n', 'custom/prompt.txt': 'review prompt\n', 'custom/inputs.txt': 'reviewed input packet\n' };
    const dir = scratchRepo({
      baseTickets: [],
      headTickets: [],
      baseFiles: { 'custom/tickets.json': '{"tickets": null}', ...placeholders },
      headFiles: { 'custom/tickets.json': JSON.stringify({ tickets: [T({ rails: ['src/**'] })] }), 'src/app.mjs': 'v2\n' },
    });
    const r = record(dir, 'T1', 'custom');
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /non-array `tickets` field/);
    assert.ok(!r.stderr.includes('skipped own new rail'), r.stderr);
  });
});
