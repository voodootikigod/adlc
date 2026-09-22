import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');

/**
 * Suite directories, mirroring scripts/test/ticket-store-boundary.test.mjs.
 * A fixture directory minted anywhere else is production code creating a real
 * temp dir (atomic writes, clones, locks) and is deliberately out of scope.
 */
const SUITE_DIRECTORIES = new Set(['test', 'cli-test', 'adapter-test']);

/**
 * Files that mint fixture directories without pairing them with a removal, as
 * of the scan that introduced this guard. THIS LIST MAY ONLY SHRINK: the test
 * below fails if an entry has become compliant and was left behind, so the
 * ratchet cannot silently stall. Do not add to it — a new or modified test file
 * that leaks is what this guard exists to stop.
 */
const ALLOWLIST = new Set([
  'packages/autopilot/test/helpers/gates-fixture.mjs',
  'packages/autopilot/test/helpers/review-ctx.mjs',
  'packages/autopilot/test/init.test.mjs',
  'packages/autopilot/test/input.test.mjs',
  'packages/autopilot/test/lock.test.mjs',
  'packages/autopilot/test/loop.test.mjs',
  'packages/autopilot/test/paths.test.mjs',
  'packages/autopilot/test/tools.test.mjs',
  'packages/backlog-groom/test/apply-e2e.test.mjs',
  'packages/backlog-groom/test/cli-e2e.test.mjs',
  'packages/context-handoff/adapter-test/recovery-exception.test.mjs',
  'packages/context-handoff/test/continue-cli-support.mjs',
  'packages/context-handoff/test/continue-ownership-bytes.test.mjs',
  'packages/context-handoff/test/doctor.test.mjs',
  'packages/context-handoff/test/supervise-cli-support.mjs',
  'packages/core/test/prosecutor-record-finding.test.mjs',
  'packages/core/test/railpath.test.mjs',
  'packages/core/test/revision-change-set.test.mjs',
  'packages/core/test/scaffold-hygiene.test.mjs',
  'packages/fleet/test/config.test.mjs',
  'packages/fleet/test/egress.test.mjs',
  'packages/fleet/test/extensions.test.mjs',
  'packages/fleet/test/flail-contract.test.mjs',
  'packages/fleet/test/flail-e2e.test.mjs',
  'packages/fleet/test/fleet-entry.test.mjs',
  'packages/fleet/test/linked-worktree.test.mjs',
  'packages/fleet/test/lock-recovery.test.mjs',
  'packages/fleet/test/model-plane-read.test.mjs',
  'packages/fleet/test/model-plane-sandbox.test.mjs',
  'packages/fleet/test/preflight.test.mjs',
  'packages/fleet/test/status-schema.test.mjs',
  'packages/fleet/test/status.test.mjs',
  'packages/fleet/test/synthetic-home-bwrap.test.mjs',
  'packages/gate-fuzzing/test/isolation.test.mjs',
  'packages/gate-manifest/test/key-ceremony.test.mjs',
  'packages/gate-manifest/test/migrate-branch.test.mjs',
  'packages/gate-manifest/test/migrate.test.mjs',
  'packages/gate-manifest/test/spend.test.mjs',
  'packages/gate-manifest/test/usage-roundtrip.test.mjs',
  'packages/hollow-test/test/hollow-test.test.mjs',
  'packages/hollow-test/test/unit.test.mjs',
  'packages/preflight/test/integration.test.mjs',
  'packages/preflight/test/unit.test.mjs',
  'packages/quartermaster/test/registry-isolation.test.mjs',
  'packages/runner/test/cli-exit-codes.test.mjs',
  'packages/runner/test/codex-integration.test.mjs',
  'packages/runner/test/runner.test.mjs',
  'packages/skill-rot/test/frontmatter-preserve.test.mjs',
  'packages/skill-rot/test/skill-rot.test.mjs',
  'packages/spec-lint/test/readme-exit-codes.test.mjs',
  'packages/spec-lint/test/record.test.mjs',
  'packages/tickets/test/directory.test.mjs',
  'packages/tickets/test/manifest-rails.test.mjs',
  'packages/tickets/test/pointer-bounded.test.mjs',
  'packages/tickets/test/pointer.test.mjs',
  'plugins/adlc-claude-code/hooks/test/handoff-continuation-start.test.mjs',
  'plugins/adlc-claude-code/hooks/test/handoff-resolve-global.test.mjs',
  'plugins/adlc-claude-code/hooks/test/handoff-secret-scrub.test.mjs',
  'plugins/adlc-claude-code/hooks/test/manifest.test.mjs',
  'plugins/adlc-claude-code/hooks/test/wrapper-entry-point.test.mjs',
  'plugins/adlc-codex/hooks/test/build-gate-space-path.test.mjs',
  'plugins/adlc-codex/hooks/test/build-gate.test.mjs',
  'plugins/adlc-codex/hooks/test/handoff-deny.test.mjs',
  'plugins/adlc-codex/hooks/test/handoff-resolve-global-e2e.test.mjs',
  'plugins/adlc-codex/hooks/test/handoff-secret-scrub.test.mjs',
  'plugins/adlc-copilot/hooks/test/build-gate-space-path.test.mjs',
  'plugins/adlc-copilot/hooks/test/isMain-space-path.test.mjs',
  'plugins/adlc-cursor/test/build-gate.test.mjs',
  'plugins/adlc-cursor/test/mcp-roots-proxy-lifecycle.test.mjs',
  'plugins/adlc-cursor/test/mcp-wrapper.test.mjs',
  'plugins/adlc-cursor/test/session-start.test.mjs',
  'plugins/adlc-gemini/test/case-sensitivity.test.mjs',
  'plugins/adlc-gemini/test/decide.test.mjs',
  'plugins/adlc-gemini/test/projection.test.mjs',
  'plugins/adlc-gemini/test/root.test.mjs',
  'plugins/adlc-herdr/test/fleet-bridge.test.mjs',
  'plugins/adlc-opencode/test/handoff-deny.test.mjs',
  'plugins/adlc-opencode/test/scaffold.test.mjs',
  'plugins/adlc-opencode/test/session-hooks.test.mjs',
  'plugins/adlc-pi/test/build-gate-flail.test.mjs',
  'plugins/adlc-pi/test/classifier-single-source.test.mjs',
  'plugins/adlc-pi/test/commands.test.mjs',
  'plugins/adlc-pi/test/compaction.test.mjs',
  'plugins/adlc-pi/test/completion-prosecute.test.mjs',
  'plugins/adlc-pi/test/evidence-custom-tools.test.mjs',
  'plugins/adlc-pi/test/exec-fail-closed.test.mjs',
  'plugins/adlc-pi/test/extension.test.mjs',
  'plugins/adlc-pi/test/gate-tool.test.mjs',
  'plugins/adlc-pi/test/handoff-deny.test.mjs',
  'plugins/adlc-pi/test/phase4c.test.mjs',
  'plugins/adlc-pi/test/rails-checker.test.mjs',
  'plugins/adlc-pi/test/reactive-gate.test.mjs',
  'plugins/adlc-pi/test/widget-wiring.test.mjs',
  'scripts/test/ceremony-drift-exit.test.mjs',
  'scripts/test/check-reviewer-directed-comments.test.mjs',
  'scripts/test/rails-guard-ci.test.mjs',
  'scripts/test/release-audit-collect.test.mjs',
  'scripts/test/store-loader-bounded.test.mjs',
  'scripts/test/sync-herdr-mirror.test.mjs',
  'scripts/test/toolkit-floor.test.mjs',
]);

/** @param {string} name directory entry name */
export function isSuiteDirectory(name) {
  return SUITE_DIRECTORIES.has(name);
}

/**
 * Every .mjs file that lives inside a suite directory, at any depth.
 * Helper modules count: packages/prosecute/test/helpers.mjs is not a
 * *.test.mjs file, yet its exported factories mint a fixture per call.
 */
function suiteFiles(path, inSuite = false) {
  const files = [];
  if (!existsSync(path)) return files;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) files.push(...suiteFiles(full, inSuite || isSuiteDirectory(entry.name)));
    else if (inSuite && entry.name.endsWith('.mjs')) files.push(full);
  }
  return files;
}

/** Line number (1-based) of a character offset, for actionable failures. */
function lineOf(body, index) {
  return body.slice(0, index).split('\n').length;
}

/**
 * Names of local one-argument helpers whose body removes their own parameter,
 * e.g. `const cleanup = (p) => rmSync(p, { recursive: true, force: true })`.
 * Calling one of these with a fixture binding counts as removing it.
 */
export function removalHelpers(body) {
  const names = new Set();
  const arrow = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(?\s*(\w+)\s*\)?\s*=>\s*\{?([^;}]*)/g;
  const declared = /function\s+(\w+)\s*\(\s*(\w+)\s*\)\s*\{([\s\S]{0,400}?)\n\}/g;
  for (const re of [arrow, declared]) {
    for (const match of body.matchAll(re)) {
      const [, name, param, tail] = match;
      if (new RegExp(String.raw`rmSync\s*\(\s*${param}\b`).test(tail)) names.add(name);
    }
  }
  return names;
}

/**
 * Fixture bindings that nothing in the file ever removes.
 *
 * Pairing is per BINDING, never per file: a file-level "does an rmSync appear
 * anywhere" test passes a file whose only rmSync calls delete a subdirectory of
 * the fixture so a symlink can take its place — setup, not cleanup — while every
 * fixture root survives the run.
 *
 * Compliant shapes, per the ticket contract:
 *   (a) rmSync(X ...)                      direct removal
 *   (b) cleanup(X)                         a local one-arg helper that rmSyncs its param
 *   (c) dirs.add(X) / dirs.push(X)         registration drained by an after() hook
 * An unassigned call is non-compliant by definition: nothing can remove a value
 * that was never bound to a name.
 */
export function unremovedFixtures(body) {
  const helpers = removalHelpers(body);
  const drains = /after\s*\(/.test(body) && /rmSync\s*\(/.test(body);
  const count = (re) => (body.match(re) || []).length;
  const leaks = [];

  /**
   * Removal SITES for a name, not merely "does one exist". `dir` and `root` are
   * the common fixture names here, so a file-wide existence test lets one
   * cleaned fixture launder every later fixture that reuses the name. Counting
   * keeps removals in step with creations.
   *
   * Registration is the exception and stays uncounted: one collection drained
   * by an after() hook covers any number of members, so a single add() site
   * inside a helper legitimately serves every call.
   */
  const removalSites = (name) =>
    count(new RegExp(String.raw`rmSync\s*\(\s*${name}\b`, 'g'))
    + [...helpers].reduce((n, helper) => n + count(new RegExp(String.raw`\b${helper}\s*\(\s*${name}\s*\)`, 'g')), 0);

  const registered = (name) =>
    drains && new RegExp(String.raw`\w+\s*\.\s*(?:add|push)\s*\(\s*${name}\b`).test(body);

  const seen = new Map();
  for (const match of body.matchAll(/mkdtempSync\s*\(/g)) {
    const before = body.slice(Math.max(0, match.index - 120), match.index);
    // A declaration is the common shape, but `let dir;` at describe() scope with
    // `dir = mkdtempSync(...)` inside before() and `after(() => rmSync(dir))` is
    // just as common and just as cleaned — reading only the declaration form
    // reported those as unbound and reddened correct files. A bare assignment
    // still has to pair with a removal below; only the BINDING is recognised here.
    // Member assignments (`obj.dir = ...`) stay unbound: nothing pairs them.
    const binding = before.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?$/)
      ?? before.match(/(?:^|[;{}()\n,])\s*(\w+)\s*=\s*(?:await\s+)?$/);
    const line = lineOf(body, match.index);

    if (!binding) {
      leaks.push(`line ${line}: mkdtempSync result is never bound to a name, so nothing can remove it`);
      continue;
    }
    const name = binding[1];
    const nth = (seen.get(name) ?? 0) + 1;
    seen.set(name, nth);

    if (registered(name) || nth <= removalSites(name)) continue;
    leaks.push(
      `line ${line}: fixture "${name}" is never removed (no rmSync, cleanup helper, or registered after() hook)`,
    );
  }
  return leaks;
}

/**
 * This guard's own fixtures are SOURCE TEXT — string literals fed to the
 * detector to prove it bites — not calls that ever create a directory. Scanning
 * itself would report every one of them. The exemption is by exact path, so a
 * file that merely looks similar is still scanned (proven below).
 */
const SELF = 'scripts/test/tmp-fixture-boundary.test.mjs';

export function leakingSuiteFiles(files) {
  return files
    .map((path) => ({ name: relative(ROOT, path).replaceAll('\\', '/'), body: readFileSync(path, 'utf8') }))
    .filter(({ name, body }) => name !== SELF && body.includes('mkdtempSync'))
    .map(({ name, body }) => ({ name, leaks: unremovedFixtures(body) }))
    .filter(({ leaks }) => leaks.length > 0);
}

function scanRepo() {
  return leakingSuiteFiles(['packages', 'plugins', 'scripts', 'apps'].flatMap((dir) => suiteFiles(join(ROOT, dir))));
}

test('no un-allowlisted suite file leaks a fixture directory', () => {
  const offenders = scanRepo().map(({ name, leaks }) => `${name}\n    ${leaks.join('\n    ')}`);
  const unexpected = offenders.filter((entry) => !ALLOWLIST.has(entry.split('\n')[0]));
  assert.deepEqual(
    unexpected,
    [],
    `these suite files mint fixture directories nothing removes — register cleanup `
      + `(an after() hook draining a registry, or rmSync on the binding):\n  ${unexpected.join('\n  ')}`,
  );
});

test('the allowlist may only shrink', () => {
  const stillLeaking = new Set(scanRepo().map(({ name }) => name));
  const stale = [...ALLOWLIST].filter((name) => !stillLeaking.has(name)).sort();
  assert.deepEqual(
    stale,
    [],
    `these files are compliant now and must be removed from ALLOWLIST so the ratchet keeps tightening: ${stale.join(', ')}`,
  );
});

test('the detector bites on a planted leak', () => {
  const planted = `
    import { mkdtempSync } from 'node:fs';
    test('x', () => {
      const dir = mkdtempSync(join(tmpdir(), 'planted-'));
      assert.ok(dir);
    });
  `;
  const leaks = unremovedFixtures(planted);
  assert.equal(leaks.length, 1, 'an unremoved fixture binding must be reported');
  assert.match(leaks[0], /fixture "dir" is never removed/);
  assert.match(leaks[0], /line 4/, 'the failure must name the line');
});

test('an unassigned mkdtempSync call is a leak by definition', () => {
  const inline = `const mkRepo = () => mkdtempSync(join(tmpdir(), 'x-'));`;
  const leaks = unremovedFixtures(inline);
  assert.equal(leaks.length, 1);
  assert.match(leaks[0], /never bound to a name/);
});

test('each compliant shape in the contract is accepted', () => {
  const direct = `
    const dir = mkdtempSync(join(tmpdir(), 'a-'));
    rmSync(dir, { recursive: true, force: true });
  `;
  assert.deepEqual(unremovedFixtures(direct), [], 'direct rmSync on the binding');

  const helper = `
    const cleanup = (p) => rmSync(p, { recursive: true, force: true });
    const dir = mkdtempSync(join(tmpdir(), 'a-'));
    cleanup(dir);
  `;
  assert.deepEqual(unremovedFixtures(helper), [], 'a local one-arg removal helper');

  const registry = `
    const dirs = new Set();
    after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
    const dir = mkdtempSync(join(tmpdir(), 'a-'));
    dirs.add(dir);
  `;
  assert.deepEqual(unremovedFixtures(registry), [], 'registration drained by an after() hook');
});

test('a registry that is never drained is still a leak', () => {
  // Registration only counts because an after() hook removes the members. Without
  // the hook the Set is just a list of directories that outlive the run.
  const undrained = `
    const dirs = new Set();
    const dir = mkdtempSync(join(tmpdir(), 'a-'));
    dirs.add(dir);
  `;
  assert.equal(unremovedFixtures(undrained).length, 1);
});

test('one cleaned fixture does not launder a second fixture of the same name', () => {
  // `dir` and `root` are the two most common fixture names in this repo, so a
  // file-wide "is there an rmSync(dir) anywhere" test would mark every later
  // `const dir = mkdtempSync(...)` clean because an earlier one was removed.
  // Removal sites must therefore keep pace with creation sites.
  const reused = `
    test('a', () => {
      const dir = mkdtempSync(join(tmpdir(), 'x-'));
      rmSync(dir, { recursive: true, force: true });
    });
    test('b', () => {
      const dir = mkdtempSync(join(tmpdir(), 'x-'));
      assert.ok(dir);
    });
  `;
  const leaks = unremovedFixtures(reused);
  assert.equal(leaks.length, 1, 'the second, uncleaned "dir" must still be reported');
  assert.match(leaks[0], /line 7/, 'and it must name the uncleaned site, not the cleaned one');

  // The registry shape stays N-safe: one drained collection covers any number
  // of fixtures, so it must not be penalised by the same counting rule.
  const manyViaRegistry = `
    const dirs = new Set();
    after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
    test('a', () => { const dir = mkdtempSync(join(tmpdir(), 'x-')); dirs.add(dir); });
    test('b', () => { const dir = mkdtempSync(join(tmpdir(), 'x-')); dirs.add(dir); });
  `;
  assert.deepEqual(unremovedFixtures(manyViaRegistry), [], 'a drained registry covers every member');
});

test('the scan tolerates a missing top-level directory', () => {
  // scanRepo walks a fixed list; a repo without one of them must fail with a
  // clear empty result, never an ENOENT crash inside the test runner.
  assert.deepEqual(suiteFiles(join(ROOT, "no-such-directory-here")), []);
});

test('a same-file rmSync on a DIFFERENT binding does not launder a leak', () => {
  // The shape that motivated per-binding pairing: rmSync deletes a
  // subdirectory of the fixture as test setup, and the fixture root itself
  // survives. A file-level "contains rmSync" check passes this; pairing catches it.
  const setupNotCleanup = `
    const root = mkdtempSync(join(tmpdir(), 'a-'));
    const dir = join(root, '.adlc');
    rmSync(dir, { recursive: true, force: true });
    symlinkSync(shadow, dir);
  `;
  const leaks = unremovedFixtures(setupNotCleanup);
  assert.equal(leaks.length, 1, 'the unremoved root must still be reported');
  assert.match(leaks[0], /fixture "root" is never removed/);
});

test('production mkdtempSync call sites are out of scope', () => {
  const scanned = ['packages', 'plugins'].flatMap((dir) => suiteFiles(join(ROOT, dir)))
    .map((path) => relative(ROOT, path).replaceAll('\\', '/'));

  for (const production of [
    'packages/tickets/lib/edit.mjs',
    'packages/autopilot/lib/lock.mjs',
    'packages/gate-fuzzing/lib/clone.mjs',
    'packages/fleet/bin/fleet.mjs',
  ]) {
    assert.ok(!scanned.includes(production), `${production} is production code and must not be scanned`);
  }
  assert.ok(
    scanned.some((name) => name.startsWith('packages/prosecute/test/')),
    'suite directories must still be scanned',
  );
  assert.equal(isSuiteDirectory('test'), true);
  assert.equal(isSuiteDirectory('lib'), false);
  assert.equal(isSuiteDirectory('bin'), false);
});
