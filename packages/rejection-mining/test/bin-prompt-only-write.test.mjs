// bin-prompt-only-write.test.mjs — issues #743 and #746.
//
// #743: `--prompt-only` used to print a prompt built from a hardcoded placeholder
// cluster BEFORE any gh call, so an operator answered a question about a fake
// objection and recorded C13 as mined over zero PRs. It must now mine real PR
// rejections (gh required) and print one prompt per real cluster.
//
// #746: `--write` used a bare writeFileSync — a second run clobbered curated
// lens files, two clusters with the same slug overwrote each other while the
// report claimed both, and the JSON was printed before any write landed.
//
// These tests drive the REAL bin with a fake `gh` prepended to PATH.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { dedupeSlugs, planLensEmissions, writeDecision } from '../lib/lens.mjs';
import { buildJsonResult } from '../lib/report.mjs';
import { placeLens, tempPathFor, tempToken, writeExclusive } from '../lib/lens-write.mjs';

const BIN = fileURLToPath(new URL('../bin/rejection-mining.mjs', import.meta.url));

// Every fixture directory is registered here and removed once, after the file.
const fixtures = new Set();
after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  fixtures.clear();
});

function fixtureDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtures.add(dir);
  return dir;
}

// Two identical objection bodies always cluster (Jaccard 1.0) and both carry a
// negative signal ("do not").
const CLUSTERING_BODY = 'do not expose raw errors to clients';
// Two unrelated objections never cluster, so --min 2 yields zero clusters.
const LONE_BODY_A = 'do not expose raw errors to clients';
const LONE_BODY_B = 'missing null check before dereferencing the handle';

/**
 * Write a fake `gh` into `dir`. `views` maps PR number -> { reviews, comments }.
 * The shim is a node script (execFileSync passes no stdin, so nothing to drain).
 */
function installFakeGh(dir, views) {
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh version 2.40.0'); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify(${JSON.stringify(Object.keys(views).map((n) => ({ number: Number(n), title: `PR ${n}` })))}));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const views = ${JSON.stringify(views)};
  if (views[args[2]] === 'FAIL') { console.error('HTTP 403: rate limit exceeded'); process.exit(1); }
  console.log(JSON.stringify(views[args[2]]));
  process.exit(0);
}
console.error('unexpected gh invocation', args);
process.exit(1);
`;
  writeFileSync(join(dir, 'gh'), script, { mode: 0o755 });
}

function review(body, login = 'alice') {
  return { reviews: [{ body, author: { login } }], comments: [] };
}

const ONE_CLUSTER_VIEWS = { 1: review(CLUSTERING_BODY, 'alice'), 2: review(CLUSTERING_BODY, 'bob') };
const ZERO_CLUSTER_VIEWS = { 1: review(LONE_BODY_A), 2: review(LONE_BODY_B) };

function runBin(args, { ghDir, cwd }) {
  const env = {
    ...process.env,
    PATH: ghDir ? `${ghDir}:${process.env.PATH}` : ghDir === null ? '' : process.env.PATH,
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    GEMINI_API_KEY: '',
    ADLC_AGY: 'off',
    ADLC_PROVIDER: '',
  };
  return spawnSync(process.execPath, [BIN, ...args], { env, cwd, encoding: 'utf8', timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// AC1 / AC2 — --prompt-only mines real PRs
// ---------------------------------------------------------------------------

test('AC1: --prompt-only prints a prompt built from the REAL fixture comments and exits 0', () => {
  const dir = fixtureDir('rm-prompt-real-');
  installFakeGh(dir, ONE_CLUSTER_VIEWS);
  const res = runBin(['--prompt-only', '--min', '2'], { ghDir: dir, cwd: dir });

  assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stdout, /expose raw errors to clients/, 'the prompt quotes a real fixture comment body');
  assert.match(res.stdout, /"prNumber": 1/, 'the prompt carries a real PR number');
  assert.doesNotMatch(res.stdout, /example-cluster/);
  assert.doesNotMatch(res.stdout, /<sample PR rejection comment>/);
});

test('AC1: the placeholder cluster and signal are gone from the bin source', () => {
  const src = readFileSync(BIN, 'utf8');
  assert.doesNotMatch(src, /example-cluster/);
  assert.doesNotMatch(src, /sample PR rejection comment/);
});

test('AC1: --prompt-only prints one prompt per cluster, in cluster order', () => {
  const dir = fixtureDir('rm-prompt-two-');
  // Two distinct clusters of two identical bodies each.
  installFakeGh(dir, {
    1: review(CLUSTERING_BODY, 'a'),
    2: review(CLUSTERING_BODY, 'b'),
    3: review(LONE_BODY_B, 'c'),
    4: review(LONE_BODY_B, 'd'),
  });
  const res = runBin(['--prompt-only', '--min', '2'], { ghDir: dir, cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /--- prompt 1 of 2 ---/);
  assert.match(res.stdout, /--- prompt 2 of 2 ---/);
  assert.ok(res.stdout.indexOf('expose raw errors') < res.stdout.indexOf('null check'), 'cluster order preserved');
});

test('--prompt-only with a partial gh failure still prompts but says on stderr how many PRs were not mined, with the first error', () => {
  const dir = fixtureDir('rm-prompt-partial-');
  installFakeGh(dir, { 1: review(CLUSTERING_BODY, 'a'), 2: review(CLUSTERING_BODY, 'b'), 3: 'FAIL', 4: 'FAIL' });
  const res = runBin(['--prompt-only', '--min', '2'], { ghDir: dir, cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /expose raw errors to clients/, 'the prompt for the mined cluster is still printed');
  assert.match(res.stderr, /rejection-mining: 2 of 4 PR\(s\) could not be fetched \(first error: HTTP 403: rate limit exceeded\); the prompts below cover only the 2 that were/);
});

test('--prompt-only with every detail fetch succeeding prints no partial-fetch warning', () => {
  const dir = fixtureDir('rm-prompt-complete-');
  installFakeGh(dir, ONE_CLUSTER_VIEWS);
  const res = runBin(['--prompt-only', '--min', '2'], { ghDir: dir, cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /could not be fetched/);
});

test('AC2: zero clusters → exit 0, empty stdout, stderr names the threshold and says nothing to prompt', () => {
  const dir = fixtureDir('rm-prompt-zero-');
  installFakeGh(dir, ZERO_CLUSTER_VIEWS);
  const res = runBin(['--prompt-only', '--min', '2'], { ghDir: dir, cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /rejection-mining: no clusters at --min 2 over 2 PR\(s\); nothing to prompt/);
});

test('AC2: gh absent from PATH → --prompt-only exits 1 with the gh error, never a fake prompt', () => {
  const dir = fixtureDir('rm-prompt-nogh-');
  const emptyBin = join(dir, 'empty-bin');
  mkdirSync(emptyBin);
  const res = spawnSync(process.execPath, [BIN, '--prompt-only'], {
    env: { ...process.env, PATH: emptyBin },
    cwd: dir,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /gh CLI not found/);
  assert.equal(res.stdout, '');
});

// ---------------------------------------------------------------------------
// AC3 — slug de-duplication is pure and planLensEmissions applies it
// ---------------------------------------------------------------------------

test('AC3: dedupeSlugs suffixes repeats in input order and never mutates its input', () => {
  const input = ['a', 'b', 'a', 'a'];
  const frozen = Object.freeze([...input]);
  assert.deepEqual(dedupeSlugs(frozen), ['a', 'b', 'a-2', 'a-3']);
  assert.deepEqual(input, ['a', 'b', 'a', 'a']);
  assert.deepEqual(dedupeSlugs([]), []);
  assert.deepEqual(dedupeSlugs(['x']), ['x']);
  assert.deepEqual(dedupeSlugs(['x', 'x', 'y', 'x']), ['x', 'x-2', 'y', 'x-3']);
});

test('AC3: planLensEmissions yields distinct paths for two clusters with the same slug, without mutating the clusters', () => {
  const signals = [
    { body: 'do not expose raw errors', author: 'a', prNumber: 1 },
    { body: 'do not expose raw errors', author: 'b', prNumber: 2 },
  ];
  const clusters = [
    { slug: 'expose-raw-errors', indices: [0], count: 1, prNumbers: new Set([1]) },
    { slug: 'expose-raw-errors', indices: [1], count: 1, prNumbers: new Set([2]) },
  ];
  const plans = planLensEmissions(clusters, signals, 'out');
  assert.equal(plans.length, 2);
  assert.notEqual(plans[0].path, plans[1].path);
  assert.equal(plans[0].path, 'out/lens-expose-raw-errors.md');
  assert.equal(plans[1].path, 'out/lens-expose-raw-errors-2.md');
  assert.equal(plans[1].slug, 'expose-raw-errors-2');
  assert.equal(clusters[1].slug, 'expose-raw-errors', 'input cluster slug untouched');
});

test('duplicate slugs: lenses[].slug stays the cluster slug in dry-run and write JSON; only path is de-duplicated', () => {
  const signals = [
    { body: 'do not expose raw errors', author: 'a', prNumber: 1 },
    { body: 'do not expose raw errors', author: 'b', prNumber: 2 },
  ];
  const clusters = [
    { slug: 'expose-raw-errors', indices: [0], count: 1, prNumbers: new Set([1]) },
    { slug: 'expose-raw-errors', indices: [1], count: 1, prNumbers: new Set([2]) },
  ];
  const plans = planLensEmissions(clusters, signals, 'out');
  const dry = buildJsonResult({ clusters, lensPlans: plans, totalSignals: 2, totalPRs: 2, skippedPRs: 0 });
  assert.deepEqual(dry.lenses.map((l) => l.slug), ['expose-raw-errors', 'expose-raw-errors']);
  assert.deepEqual(dry.lenses.map((l) => l.path), ['out/lens-expose-raw-errors.md', 'out/lens-expose-raw-errors-2.md']);
  const written = buildJsonResult({ clusters, lensPlans: plans.map((p) => ({ ...p, written: true, skipped: null })), totalSignals: 2, totalPRs: 2, skippedPRs: 0 });
  assert.deepEqual(written.lenses.map((l) => l.slug), ['expose-raw-errors', 'expose-raw-errors']);
  assert.deepEqual(written.lenses.map((l) => l.written), [true, true]);
});

test('AC4: writeDecision is a pure two-outcome predicate', () => {
  assert.equal(writeDecision({ exists: false, force: false }), 'write');
  assert.equal(writeDecision({ exists: false, force: true }), 'write');
  assert.equal(writeDecision({ exists: true, force: true }), 'write');
  assert.equal(writeDecision({ exists: true, force: false }), 'skip-exists');
});

// ---------------------------------------------------------------------------
// AC4 / AC5 — --write never clobbers; JSON after writes
// ---------------------------------------------------------------------------

function lensPathFromDryRun(dir) {
  const dry = runBin(['--json', '--min', '2'], { ghDir: dir, cwd: dir });
  assert.equal(dry.status, 0, dry.stderr);
  const parsed = JSON.parse(dry.stdout);
  assert.equal(parsed.lenses.length, 1);
  assert.equal(parsed.lenses[0].written, false);
  assert.equal(parsed.lenses[0].skipped, null);
  assert.equal('error' in parsed.lenses[0], false, 'no error field unless a write failed');
  return parsed.lenses[0].path;
}

test('AC4: --write leaves an existing lens byte-identical, reports skipped (exists), exit 0', () => {
  const dir = fixtureDir('rm-write-skip-');
  installFakeGh(dir, ONE_CLUSTER_VIEWS);
  const relPath = lensPathFromDryRun(dir);
  const absPath = join(dir, relPath);
  mkdirSync(join(dir, '.adlc', 'lenses'), { recursive: true });
  writeFileSync(absPath, 'CUSTOM CURATED LENS\n');

  const res = runBin(['--write', '--min', '2'], { ghDir: dir, cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(absPath, 'utf8'), 'CUSTOM CURATED LENS\n');
  assert.match(res.stdout, new RegExp(`skipped \\(exists\\): ${relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(res.stdout, /wrote:/);

  const json = runBin(['--write', '--json', '--min', '2'], { ghDir: dir, cwd: dir });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.lenses[0].written, false);
  assert.equal(parsed.lenses[0].skipped, 'exists');
  assert.equal(readFileSync(absPath, 'utf8'), 'CUSTOM CURATED LENS\n');
});

test('AC4: --write --force replaces the existing lens and leaves no temp file behind', () => {
  const dir = fixtureDir('rm-write-force-');
  installFakeGh(dir, ONE_CLUSTER_VIEWS);
  const relPath = lensPathFromDryRun(dir);
  const absPath = join(dir, relPath);
  mkdirSync(join(dir, '.adlc', 'lenses'), { recursive: true });
  writeFileSync(absPath, 'CUSTOM CURATED LENS\n');

  const res = runBin(['--write', '--force', '--json', '--min', '2'], { ghDir: dir, cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.lenses[0].written, true);
  assert.equal(parsed.lenses[0].skipped, null);
  assert.equal('error' in parsed.lenses[0], false);
  const content = readFileSync(absPath, 'utf8');
  assert.match(content, /^# Lens: /);
  assert.doesNotMatch(content, /CUSTOM CURATED/);
  const leftovers = readdirSync(join(dir, '.adlc', 'lenses')).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('AC4: a fresh --write writes the lens atomically (file present, no temp file) and says wrote:', () => {
  const dir = fixtureDir('rm-write-fresh-');
  installFakeGh(dir, ONE_CLUSTER_VIEWS);
  const res = runBin(['--write', '--min', '2'], { ghDir: dir, cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /wrote: \.adlc\/lenses\/lens-/);
  const files = readdirSync(join(dir, '.adlc', 'lenses'));
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith('lens-') && files[0].endsWith('.md'), files[0]);
  assert.match(readFileSync(join(dir, '.adlc', 'lenses', files[0]), 'utf8'), /^# Lens: /);
});

test('dry-run hint: printed for exactly one cluster without --write, never with --write, never with zero clusters', () => {
  const HINT = /\(dry-run — add --write to emit lens files\)/;

  const one = fixtureDir('rm-hint-one-');
  installFakeGh(one, ONE_CLUSTER_VIEWS);
  const dry = runBin(['--min', '2'], { ghDir: one, cwd: one });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, HINT, 'one cluster, no --write: the hint is shown');
  assert.equal(dry.stdout.match(/dry-run — add --write/g).length, 1, 'shown exactly once');

  const written = runBin(['--write', '--min', '2'], { ghDir: one, cwd: one });
  assert.equal(written.status, 0, written.stderr);
  assert.doesNotMatch(written.stdout, HINT, 'with --write the hint is never shown');

  const zero = fixtureDir('rm-hint-zero-');
  installFakeGh(zero, ZERO_CLUSTER_VIEWS);
  const none = runBin(['--min', '2'], { ghDir: zero, cwd: zero });
  assert.equal(none.status, 0, none.stderr);
  assert.doesNotMatch(none.stdout, HINT, 'zero clusters: nothing to write, no hint');
  assert.match(none.stdout, /No clusters met --min threshold/);
});

test('AC5: with --write --json the JSON is the only (and last) thing on stdout and its written flags match disk', () => {
  const dir = fixtureDir('rm-write-json-');
  installFakeGh(dir, {
    1: review(CLUSTERING_BODY, 'a'),
    2: review(CLUSTERING_BODY, 'b'),
    3: review(LONE_BODY_B, 'c'),
    4: review(LONE_BODY_B, 'd'),
  });
  // Pre-create the second lens so one is written and one is skipped.
  const dry = runBin(['--json', '--min', '2'], { ghDir: dir, cwd: dir });
  const dryParsed = JSON.parse(dry.stdout);
  assert.equal(dryParsed.lenses.length, 2);
  const skippedRel = dryParsed.lenses[1].path;
  mkdirSync(join(dir, '.adlc', 'lenses'), { recursive: true });
  writeFileSync(join(dir, skippedRel), 'KEEP\n');

  const res = runBin(['--write', '--json', '--min', '2'], { ghDir: dir, cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  const trimmed = res.stdout.trim();
  assert.ok(trimmed.startsWith('{') && trimmed.endsWith('}'), 'stdout is exactly one JSON document');
  const parsed = JSON.parse(trimmed);
  assert.equal(parsed.lenses.length, 2);
  for (const lens of parsed.lenses) {
    const onDisk = existsSync(join(dir, lens.path)) ? readFileSync(join(dir, lens.path), 'utf8') : null;
    if (lens.written) {
      assert.equal(lens.skipped, null);
      assert.match(onDisk ?? '', /^# Lens: /);
    } else {
      assert.equal(lens.skipped, 'exists');
      assert.equal(onDisk, 'KEEP\n');
    }
  }
  assert.equal(parsed.lenses.filter((l) => l.written).length, 1);
});

// ---------------------------------------------------------------------------
// placeLens — the write is atomic and no-replace regardless of any pre-check
// ---------------------------------------------------------------------------

test('placeLens: a file that exists at placement time is never replaced without force, even with no pre-check', () => {
  const dir = fixtureDir('rm-place-exists-');
  const target = join(dir, 'lens-x.md');
  writeFileSync(target, 'CURATED\n');
  assert.equal(placeLens(target, 'NEW\n', { force: false }), 'skip-exists');
  assert.equal(readFileSync(target, 'utf8'), 'CURATED\n');
  assert.deepEqual(readdirSync(dir), ['lens-x.md'], 'no temp file left behind');
});

test('placeLens: skipping an existing lens needs no write access to its directory and writes no temp file', () => {
  // (Under root the chmod has no effect and this case degrades to the plain
  // existing-file skip above; CI runners and developers are not root.)
  const dir = fixtureDir('rm-place-ro-');
  const target = join(dir, 'lens-ro.md');
  writeFileSync(target, 'CURATED\n');
  chmodSync(dir, 0o555);
  try {
    assert.equal(placeLens(target, 'NEW\n', { force: false }), 'skip-exists');
    assert.equal(readFileSync(target, 'utf8'), 'CURATED\n');
    assert.deepEqual(readdirSync(dir), ['lens-ro.md']);
  } finally {
    chmodSync(dir, 0o755);
  }
});

test('placeLens: a directory entry the pre-check cannot see (dangling symlink) is still a skip, never a throw or a replace', () => {
  // existsSync follows symlinks and reports false for a dangling one, so the
  // fast path says "write"; the link then collides with the entry (EEXIST).
  // This is the race-window path, reproduced deterministically.
  const dir = fixtureDir('rm-place-dangling-');
  const target = join(dir, 'lens-dangling.md');
  symlinkSync(join(dir, 'nowhere.md'), target);
  assert.equal(existsSync(target), false, 'precondition: the pre-check cannot see the entry');
  assert.equal(placeLens(target, 'NEW\n', { force: false }), 'skip-exists');
  assert.ok(lstatSync(target).isSymbolicLink(), 'the existing entry is untouched');
  assert.deepEqual(readdirSync(dir), ['lens-dangling.md'], 'no temp file left behind');
});

test('writeExclusive: a planted symlink or file at the temp path is never followed, truncated or replaced', () => {
  const dir = fixtureDir('rm-excl-');
  const victim = join(dir, 'victim.txt');
  writeFileSync(victim, 'SECRET\n');
  const viaSymlink = join(dir, 'planted-link.tmp');
  symlinkSync(victim, viaSymlink);
  assert.throws(() => writeExclusive(viaSymlink, 'PAYLOAD\n'), (err) => err.code === 'EEXIST');
  assert.equal(readFileSync(victim, 'utf8'), 'SECRET\n', 'the symlink target is untouched');

  const dangling = join(dir, 'dangling.tmp');
  symlinkSync(join(dir, 'nowhere'), dangling);
  assert.throws(() => writeExclusive(dangling, 'PAYLOAD\n'), (err) => err.code === 'EEXIST');
  assert.equal(existsSync(join(dir, 'nowhere')), false, 'a dangling symlink is not created through');

  const plain = join(dir, 'plain.tmp');
  writeFileSync(plain, 'KEEP\n');
  assert.throws(() => writeExclusive(plain, 'PAYLOAD\n'), (err) => err.code === 'EEXIST');
  assert.equal(readFileSync(plain, 'utf8'), 'KEEP\n');

  const fresh = join(dir, 'fresh.tmp');
  writeExclusive(fresh, 'OK\n');
  assert.equal(readFileSync(fresh, 'utf8'), 'OK\n');
});

test('writeExclusive: a failure after the exclusive create removes the temp file and rethrows; nothing can be published', () => {
  const dir = fixtureDir('rm-excl-fail-');
  const tmp = join(dir, 'lens-f.md.tmp-deadbeef');
  assert.throws(() => writeExclusive(tmp, 42), TypeError);
  assert.equal(existsSync(tmp), false, 'the temp file is removed on failure');
  assert.deepEqual(readdirSync(dir), []);
  // placeLens with the same bad content: nothing written, nothing left behind.
  const target = join(dir, 'lens-f.md');
  assert.throws(() => placeLens(target, 42, { force: false }), TypeError);
  assert.deepEqual(readdirSync(dir), [], 'no target, no temp file');
});

test('writeExclusive: the whole content lands, byte for byte, including multi-byte text well past one write buffer', () => {
  const dir = fixtureDir('rm-excl-full-');
  const tmp = join(dir, 'big.tmp');
  const content = 'ünïcödé — '.repeat(300_000); // ~4.5 MB of UTF-8
  writeExclusive(tmp, content);
  assert.equal(readFileSync(tmp, 'utf8'), content);
  assert.equal(statSize(tmp), Buffer.byteLength(content, 'utf8'));
  // The smallest non-empty write is a complete write, not a short one.
  const one = join(dir, 'one.tmp');
  writeExclusive(one, 'x');
  assert.equal(readFileSync(one, 'utf8'), 'x');
  const empty = join(dir, 'empty.tmp');
  writeExclusive(empty, '');
  assert.equal(statSize(empty), 0);
});

function statSize(p) {
  return lstatSync(p).size;
}

test('tempPathFor is pure and distinct tokens give distinct sibling paths; placeLens temp names are not predictable from the pid', () => {
  assert.equal(tempPathFor('/x/lens-a.md', 'abc'), '/x/lens-a.md.tmp-abc');
  const tokens = new Set(Array.from({ length: 64 }, () => tempToken()));
  assert.equal(tokens.size, 64, 'tokens are unique');
  for (const tok of tokens) assert.match(tok, /^[0-9a-f]{16}$/, 'exactly 64 random bits as 16 hex chars');
  assert.notEqual(tempPathFor('/x/lens-a.md', 'a'), tempPathFor('/x/lens-a.md', 'b'));
  const dir = fixtureDir('rm-tmpname-');
  const target = join(dir, 'lens-z.md');
  // A planted entry at the old predictable name must not interfere with placement.
  const predictable = `${target}.tmp-${process.pid}`;
  symlinkSync(join(dir, 'elsewhere'), predictable);
  assert.equal(placeLens(target, 'OK\n', { force: false }), 'written');
  assert.equal(readFileSync(target, 'utf8'), 'OK\n');
  assert.equal(existsSync(join(dir, 'elsewhere')), false, 'nothing was written through the planted symlink');
  assert.deepEqual(readdirSync(dir).sort(), ['lens-z.md', `lens-z.md.tmp-${process.pid}`], 'only the target and the planted entry remain');
});

test('placeLens: force replaces atomically; absent target is written; temp file never survives', () => {
  const dir = fixtureDir('rm-place-force-');
  const target = join(dir, 'lens-y.md');
  assert.equal(placeLens(target, 'FIRST\n', { force: false }), 'written');
  assert.equal(readFileSync(target, 'utf8'), 'FIRST\n');
  assert.equal(placeLens(target, 'SECOND\n', { force: true }), 'written');
  assert.equal(readFileSync(target, 'utf8'), 'SECOND\n');
  assert.deepEqual(readdirSync(dir), ['lens-y.md']);
});

test('placeLens: a failing placement rethrows and still removes its temp file', () => {
  const dir = fixtureDir('rm-place-throw-');
  const target = join(dir, 'lens-dir.md');
  mkdirSync(target); // a non-empty directory cannot be renamed over
  writeFileSync(join(target, 'keep'), 'k');
  assert.throws(() => placeLens(target, 'X\n', { force: true }));
  assert.deepEqual(readdirSync(dir), ['lens-dir.md'], 'temp file cleaned up after the throw');
  assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'k');
});

// ---------------------------------------------------------------------------
// Partial failure — the report still describes every plan, then exit 1
// ---------------------------------------------------------------------------

function twoClusterFixture(prefix) {
  const dir = fixtureDir(prefix);
  installFakeGh(dir, {
    1: review(CLUSTERING_BODY, 'a'),
    2: review(CLUSTERING_BODY, 'b'),
    3: review(LONE_BODY_B, 'c'),
    4: review(LONE_BODY_B, 'd'),
  });
  const dry = runBin(['--json', '--min', '2'], { ghDir: dir, cwd: dir });
  const paths = JSON.parse(dry.stdout).lenses.map((l) => l.path);
  assert.equal(paths.length, 2);
  // Make the SECOND plan's target un-writable even with --force: a non-empty directory.
  mkdirSync(join(dir, paths[1]), { recursive: true });
  writeFileSync(join(dir, paths[1], 'keep'), 'k');
  return { dir, paths };
}

test('partial failure (--json): the first lens is written, the second reports its error, JSON is emitted, exit 1', () => {
  const { dir, paths } = twoClusterFixture('rm-partial-json-');
  const res = runBin(['--write', '--force', '--json', '--min', '2'], { ghDir: dir, cwd: dir });
  assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.lenses[0].written, true);
  assert.equal('error' in parsed.lenses[0], false, 'a successful lens carries no error field');
  assert.match(readFileSync(join(dir, paths[0]), 'utf8'), /^# Lens: /);
  assert.equal(parsed.lenses[1].written, false);
  assert.equal(parsed.lenses[1].skipped, null);
  assert.equal(typeof parsed.lenses[1].error, 'string');
  assert.match(res.stderr, new RegExp(`rejection-mining: failed to write "${paths[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  const leftovers = readdirSync(join(dir, '.adlc', 'lenses')).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('partial failure (human): the wrote: line for the first lens is printed before the exit-1 error', () => {
  const { dir, paths } = twoClusterFixture('rm-partial-human-');
  const res = runBin(['--write', '--force', '--min', '2'], { ghDir: dir, cwd: dir });
  assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stdout, new RegExp(`wrote: ${paths[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(res.stdout, /rejection-mining: done\./, 'a failed run never claims done');
  assert.match(res.stderr, /failed to write/);
});
