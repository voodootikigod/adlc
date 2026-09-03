import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findPackageJsonUpward, packageJsonFromEntry, packageJsonPath, resolveBin, resolveRunnerBin } from '../lib/dispatch.mjs';
import { isTool, suggest, TOOLS } from '../lib/registry.mjs';
import { renderHelp } from '../lib/help.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'adlc.mjs');

function runAdlc(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      cwd: options.cwd,
      input: options.input,
      stderr: 'pipe',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

function withTempSpec(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cli-'));
  try {
    const path = join(dir, 'spec.md');
    writeFileSync(path, contents);
    return fn(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('registry exposes the suite tools and omits internal packages', () => {
  // 30 as of the autopilot's registration (T-01M0Z3FN7SAS4HAH7CS63YQ0DH) — bump
  // deliberately when a tool is intentionally added/removed from the registry.
  assert.equal(TOOLS.length, 30);
  assert.equal(isTool('autopilot'), true);
  assert.equal(isTool('spec-lint'), true);
  assert.equal(isTool('prosecute'), true);
  assert.equal(isTool('ticket'), true);
  assert.equal(isTool('review'), true);
  assert.equal(isTool('ticket-prune'), true);
  assert.equal(isTool('build-gate'), true);
  assert.equal(isTool('handoff'), true);
  assert.equal(isTool('fleet'), true);
  assert.equal(isTool('init'), true);
  assert.equal(isTool('spend'), true);
  assert.equal(isTool('rails-guard-ci'), true);
  assert.equal(isTool('core'), false);
  assert.equal(isTool('runner'), false);
});

test('suggest returns near misses only', () => {
  assert.equal(suggest('spec-lnt'), 'spec-lint');
  assert.equal(suggest('railsguard'), 'rails-guard');
  assert.equal(suggest('zzzzzzzz'), null);
});

test('resolves package-local tool bins without PATH lookup', () => {
  assert.match(resolveBin('spec-lint') ?? '', /packages\/spec-lint\/bin\/spec-lint\.mjs$/);
  assert.match(resolveBin('prosecute') ?? '', /packages\/prosecute\/bin\/adlc-prosecute\.mjs$/);
  assert.match(resolveBin('ticket') ?? '', /packages\/tickets\/bin\/adlc-tickets\.mjs$/);
  assert.match(resolveBin('ticket-prune') ?? '', /packages\/ticket-prune\/bin\/ticket-prune\.mjs$/);
  assert.match(resolveBin('handoff') ?? '', /packages\/context-handoff\/bin\/handoff\.mjs$/);
  assert.match(resolveBin('init') ?? '', /packages\/init\/bin\/adlc-init\.mjs$/);
  // spend shares the gate-manifest package but resolves to its OWN bin entry
  // (binName: 'adlc-spend'), not gate-manifest's default 'gate-manifest' bin —
  // proves multi-bin resolution picks the requested binName, not the first key.
  assert.match(resolveBin('spend') ?? '', /packages\/gate-manifest\/bin\/spend\.mjs$/);
  assert.equal(resolveBin('definitely-not-real'), null);
});

test('adlc spend end-to-end: records usage via gate-manifest, then aggregates it by phase', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cli-spend-'));
  try {
    const recorded = runAdlc([
      'gate-manifest', 'record', 'coldstart',
      '--dir', dir,
      '--data', JSON.stringify({ usage: { inputTokens: 500, outputTokens: 100, cachedTokens: 0, provider: 'anthropic', model: 'claude-haiku-4-5', tier: 'cheap' } }),
    ]);
    assert.equal(recorded.code, 0, recorded.stderr);

    const spend = runAdlc(['spend', '--dir', dir, '--json']);
    assert.equal(spend.code, 0, spend.stderr);
    const parsed = JSON.parse(spend.stdout);
    assert.equal(parsed.entriesWithUsage, 1);
    assert.equal(parsed.byPhase.P2.inputTokens, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('umbrella package declares both local ticket and external-sync dispatch targets', () => {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@adlc/tickets'], pkg.version);
  assert.equal(pkg.dependencies['@adlc/ticket-sync'], pkg.version);
  assert.equal(pkg.dependencies['@adlc/init'], pkg.version);
  assert.equal(pkg.dependencies['@adlc/fleet'], pkg.version);
});

test('external verbs like "review" have no local bin to resolve (they are npx passthroughs)', () => {
  assert.equal(resolveBin('review'), null);
});

test('resolves runner bin for run and accept verbs', () => {
  assert.match(resolveRunnerBin() ?? '', /packages\/runner\/bin\/adlc\.mjs$/);
});

test('help lists every routed tool and exits 0', () => {
  const { code, stdout } = runAdlc(['--help']);
  assert.equal(code, 0);
  for (const tool of TOOLS) assert.match(stdout, new RegExp(`\\b${tool.name}\\b`));
});

test('renderHelp embeds version and tool count', () => {
  const output = renderHelp('9.9.9');
  assert.match(output, /adlc 9\.9\.9/);
  // Derived from the live registry rather than a hardcoded literal: a
  // hardcoded count (e.g. `/Tools \(22\)/`) silently goes stale every time a
  // tool is registered/removed (this exact test was still asserting 22 after
  // build-gate's registration bumped TOOLS.length to 23 — closes #48 CI red).
  assert.match(output, new RegExp(`Tools \\(${TOOLS.length}\\)`));
});

test('version prints a semver-shaped string', () => {
  const { code, stdout } = runAdlc(['--version']);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('unknown tool exits 1 with suggestion', () => {
  const { code, stderr } = runAdlc(['spec-lnt']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown tool/);
  assert.match(stderr, /did you mean "spec-lint"/);
});

test('routes to spec-lint and propagates exit 0', () => {
  withTempSpec('## Acceptance Criteria\n- Returns 200, verified by `curl -sf localhost`\n', (path) => {
    assert.equal(runAdlc(['spec-lint', path]).code, 0);
  });
});

test('routes to spec-lint and propagates exit 2', () => {
  withTempSpec('## Acceptance Criteria\n- It should feel fast and delightful\n', (path) => {
    assert.equal(runAdlc(['spec-lint', path]).code, 2);
  });
});

test('routes run verb to runner', () => {
  const { code, stdout } = runAdlc(['run', 'p5', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /adlc run <phase>/);
});

test('routes accept verb to runner', () => {
  const { code, stdout } = runAdlc(['accept', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /adlc accept --ticket id/);
});

test('mcp-server is a stable hidden entrypoint that initializes and lists ADLC tools', () => {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((request) => JSON.stringify(request)).join('\n');
  const { code, stdout, stderr } = runAdlc(['mcp-server'], { input: `${input}\n` });
  assert.equal(code, 0, stderr);
  const responses = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.name, 'adlc-codex');
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['adlc_gate', 'adlc_prosecute']);
});

test('resolveBin resolves tool bins and returns null for non-existent tools', () => {
  const bin = resolveBin('spec-lint');
  assert.ok(bin && bin.includes('spec-lint'));
  assert.equal(resolveBin('nonexistent-tool-xyz'), null);
});

test('packageJsonPath resolves local worktree devPath directly without escaping to parent repo node_modules', () => {
  const devPath = packageJsonPath('@adlc/spec-lint');
  assert.ok(devPath);
  const worktreeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  assert.ok(devPath.startsWith(worktreeRoot), `packageJsonPath (${devPath}) must resolve within current worktree (${worktreeRoot})`);
});

test('packageJsonPath falls back to require.resolve if the local package.json has a mismatched name', () => {
  const worktreeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const fakePkgDir = join(worktreeRoot, 'packages', 'fake-mismatch');
  try {
    mkdirSync(fakePkgDir, { recursive: true });
    writeFileSync(join(fakePkgDir, 'package.json'), JSON.stringify({ name: 'wrong-name' }));
    
    const result = packageJsonPath('@adlc/fake-mismatch');
    assert.equal(result, null);
  } finally {
    rmSync(fakePkgDir, { recursive: true, force: true });
  }
});

test('packageJsonFromEntry finds package.json for a package whose exports map omits it (regression)', () => {
  // @adlc/context-handoff's exports map lists many `./lib/*.mjs` subpaths but
  // never `./package.json`, so Node's exports encapsulation makes the naive
  // `require.resolve('@adlc/context-handoff/package.json')` throw
  // ERR_PACKAGE_PATH_NOT_EXPORTED. That subpath call is exactly what the old
  // packageJsonPath() fallback used — unreachable in this monorepo (the devPath
  // rung always wins first), so it was undetected until a real install (global
  // `npm i -g @adlc/cli`) hit it and `adlc handoff <verb>` failed with
  // "tool not installed: @adlc/context-handoff".
  const require = createRequire(import.meta.url);
  assert.throws(
    () => require.resolve('@adlc/context-handoff/package.json'),
    /ERR_PACKAGE_PATH_NOT_EXPORTED/,
    'this pins the Node behavior that motivated the fix — if it stops throwing, the fix (and this test) can be simplified',
  );

  const found = packageJsonFromEntry('@adlc/context-handoff');
  assert.ok(found, 'packageJsonFromEntry must locate the package.json without using the exports-restricted subpath');
  assert.match(found, /context-handoff\/package\.json$/);
  const pkg = JSON.parse(readFileSync(found, 'utf8'));
  assert.equal(pkg.name, '@adlc/context-handoff');
});

test('packageJsonFromEntry must never be the ONLY rung for a bin-only package with no root entry (regression)', () => {
  // Most tools in this suite (@adlc/rails-guard, @adlc/fleet, @adlc/hollow-test,
  // ...) declare only `bin`, no `main` and no `exports` — no `.` entry point at
  // all. `require.resolve(packageName)` (bare, no subpath) throws
  // MODULE_NOT_FOUND for these, so packageJsonFromEntry alone returns null for
  // them. An earlier version of packageJsonPath() tried this rung
  // unconditionally as the sole fallback and broke `adlc <tool>` dispatch for
  // every bin-only tool in a real (non-monorepo-devPath) install — the fix it
  // was meant to deliver for @adlc/context-handoff regressed far more tools
  // than it fixed. Pin both halves: the entry-only rung fails for a bin-only
  // package, and the full packageJsonPath() ladder (subpath-first, entry-based
  // fallback only on ERR_PACKAGE_PATH_NOT_EXPORTED) still succeeds for it.
  const require = createRequire(import.meta.url);
  assert.doesNotThrow(
    () => require.resolve('@adlc/rails-guard/package.json'),
    'this pins that rails-guard has no exports map — if it grows one without listing ./package.json, this test (not packageJsonPath) should start failing here',
  );
  assert.equal(
    packageJsonFromEntry('@adlc/rails-guard'),
    null,
    'the entry-based rung alone must fail for a bin-only package (no `.` entry) — it must never be the sole resolution path',
  );

  const found = packageJsonPath('@adlc/rails-guard');
  assert.ok(found, 'packageJsonPath must still resolve a bin-only package via the direct subpath rung');
  assert.match(found, /rails-guard\/package\.json$/);
});

test('findPackageJsonUpward respects its depth cap at the boundary (mutation regression)', () => {
  // A synthetic tree, independent of Node's own module resolution, so the cap
  // itself is directly testable. `for (let i = 0; i < maxDepth; i += 1)` checks
  // the START dir on i=0, then walks up on each subsequent iteration — with
  // maxDepth=8 that's 8 checks covering 0..7 levels up, never 8. So a
  // package.json 7 levels up is the last one still found; 8 levels up is one
  // past the cap.
  const root = mkdtempSync(join(tmpdir(), 'adlc-cli-depth-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@adlc/depth-fixture' }));
    let deepDir = root;
    for (let i = 0; i < 8; i += 1) {
      deepDir = join(deepDir, `d${i}`);
    }
    mkdirSync(deepDir, { recursive: true });
    // deepDir is 8 levels below root; its parent (d0..d6) is 7 levels below.
    const sevenLevelsUp = dirname(deepDir);

    assert.equal(
      findPackageJsonUpward(sevenLevelsUp, '@adlc/depth-fixture', 8),
      join(root, 'package.json'),
      'a package.json exactly 7 directories up (the last level the cap reaches) must still be found',
    );
    assert.equal(
      findPackageJsonUpward(deepDir, '@adlc/depth-fixture', 8),
      null,
      'one directory PAST the cap (8 levels up) must not be found — proves the loop bound is live, not decorative',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('`adlc <tool> --help` answers for tools that declare no usage of their own (#107)', () => {
  // These seven crashed with a raw ERR_PARSE_ARGS_UNKNOWN_OPTION stack trace,
  // through this dispatcher as much as directly — the first command a new npm
  // consumer runs. @adlc/core now synthesizes a listing for them.
  for (const tool of [
    'behavior-diff', 'consensus-fix', 'lesson-foundry', 'model-router',
    'preflight', 'rejection-mining', 'skill-rot',
  ]) {
    const run = runAdlc([tool, '--help']);
    assert.equal(run.code, 0, `adlc ${tool} --help exited ${run.code}\n${run.stderr}`);
    assert.doesNotMatch(run.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
    // The listing names the TOOL, not the dispatcher that spawned it: the child
    // carries its own argv[1], and a listing headed `usage: adlc` would send the
    // reader back to the wrong command.
    assert.match(run.stdout, new RegExp(`^usage: ${tool} \\[options\\]\\n`));
  }
});
