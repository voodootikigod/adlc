// Repo scripts must run their CLI entry when invoked from a checkout whose path
// needs URL-encoding (a space, or any Windows path).
//
// import.meta.url is percent-encoded (a space becomes %20) while process.argv[1]
// is the raw path, so a guard written as `import.meta.url === \`file://${argv[1]}\``
// is false from such a path: the script exits 0 having run nothing. For a gate
// that is a silent green, and for the secret-exposure hook it is a silent allow.
// The entry guard must compare against pathToFileURL(process.argv[1]).href.
//
// Each script below is copied into a directory whose name contains a space and
// run from there; the assertion is on output only the CLI entry can produce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const SPAWN_TIMEOUT_MS = 30_000;

/** Scanned for the hand-built guard; every .mjs under these trees. */
const SCANNED_DIRS = ['scripts', 'apps/docs/scripts'];
const HAND_BUILT_GUARD = /['"`]file:\/\/\$\{\s*process\.argv\[1\]\s*\}/;

/** Node resolves bare imports by walking up; a worktree has no node_modules of its own. */
function findNodeModules(from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`no node_modules found walking up from ${from}`);
  }
}

/**
 * A private root `<tmp>/<prefix>/a b/` mirroring the repo layout the scripts
 * import from. realpath first: a symlinked tmpdir (macOS) would itself make the
 * guard compare two different paths and mask what this test measures.
 */
function spacedCheckout(t) {
  const fixture = mkdtempSync(join(tmpdir(), 'adlc-entry-guard-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const real = realpathSync(fixture);
  const spaced = join(real, 'a b');
  mkdirSync(spaced);
  symlinkSync(findNodeModules(ROOT), join(spaced, 'node_modules'), 'junction');
  symlinkSync(join(ROOT, 'packages'), join(spaced, 'packages'), 'junction');
  const work = join(real, 'work');
  mkdirSync(work);
  return { spaced, work };
}

/** Copy one repo script under the spaced root and run it with node. */
function runFromSpacedPath(t, repoPath, { args = [], input = '', cwd } = {}) {
  const { spaced, work } = spacedCheckout(t);
  const target = join(spaced, repoPath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(ROOT, repoPath), target);
  assert.match(target, / /, 'the script path under test must contain a space');
  const result = spawnSync(process.execPath, [target, ...args], {
    cwd: cwd ?? work,
    input,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, BASE_REF: 'origin/main' },
  });
  assert.equal(result.error, undefined, `spawn failed: ${result.error?.message}`);
  return { ...result, work };
}

test('the secret-exposure hook denies from a checkout path containing a space', (t) => {
  // Built by concatenation so this file's own text does not trip the live hook.
  const command = 'set ' + '-x; cat .env' + '.local';
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const { stdout, status } = runFromSpacedPath(t, 'scripts/block-secret-exposure.mjs', { input });
  assert.equal(status, 0);
  assert.ok(stdout.trim(), 'empty stdout is an allow: the hook never read its input');
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('scan-findings-ledger scans from a checkout path containing a space', (t) => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'adlc-entry-ledger-'));
  t.after(() => rmSync(ledgerDir, { recursive: true, force: true }));
  const ledger = join(ledgerDir, 'findings.jsonl');
  writeFileSync(ledger, 'not json\n');
  const { stderr, stdout, status } = runFromSpacedPath(t, 'scripts/scan-findings-ledger.mjs', { args: [ledger] });
  assert.notEqual(status, 0, 'a malformed ledger must fail the scan, not pass it unread');
  assert.match(stdout + stderr, /scan-findings-ledger:/);
});

test('guard-findings-ledger-append-only runs its CLI from a checkout path containing a space', (t) => {
  const { stderr, status } = runFromSpacedPath(t, 'scripts/guard-findings-ledger-append-only.mjs');
  assert.equal(status, 1, 'a missing base ref must be a usage error, not a silent pass');
  assert.match(stderr, /usage: guard-findings-ledger-append-only\.mjs <base-ref>/);
});

test('ceremony-drift runs main() from a checkout path containing a space', (t) => {
  // The empty cwd has no ticket store, so main() fails loudly before any gh call.
  const { stderr, status } = runFromSpacedPath(t, 'scripts/ceremony-drift.mjs');
  assert.equal(status, 1, 'a broken reporter must exit 1, not exit 0 having run nothing');
  assert.match(stderr, /ceremony-drift: could not compute drift/);
});

test('check-links prints its usage from a checkout path containing a space', (t) => {
  const { stderr, status } = runFromSpacedPath(t, 'apps/docs/scripts/check-links.mjs');
  assert.equal(status, 1);
  assert.match(stderr, /usage: node apps\/docs\/scripts\/check-links\.mjs <base-url>/);
});

function mjsFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return mjsFiles(full);
    return entry.name.endsWith('.mjs') ? [full] : [];
  });
}

/** Lines that build the entry-guard URL by hand, excluding comments. */
export function handBuiltGuards(body) {
  return body.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line) && HAND_BUILT_GUARD.test(line))
    .map(({ n }) => n);
}

test('no repo script builds its entry-guard URL by hand', () => {
  const offenders = SCANNED_DIRS
    .flatMap((dir) => mjsFiles(join(ROOT, dir)))
    .flatMap((file) => handBuiltGuards(readFileSync(file, 'utf8'))
      .map((n) => `${relative(ROOT, file).replaceAll('\\', '/')}:${n}`));
  assert.deepEqual(offenders, [], 'use pathToFileURL(process.argv[1]).href');
});

test('the hand-built guard detector bites and ignores comments', () => {
  // Split so this file's own source does not match the scan above.
  const guard = '`file:/' + '/${process.argv[1]}`';
  const planted = [
    `// ${guard} in a comment is fine`,
    `if (import.meta.url === ${guard}) main();`,
  ].join('\n');
  assert.deepEqual(handBuiltGuards(planted), [2]);
  assert.deepEqual(handBuiltGuards('if (import.meta.url === pathToFileURL(process.argv[1]).href) main();'), []);
});
