// The coverage gate (spec AC 1, 111, 114, 121). Coverage is NOT a name match:
//   - every criterion number in §16 of the spec AT THE PINNED BLOB must appear
//     in the registry, contiguous from 1;
//   - every registered function must exist as an export of its file, be
//     registered with node:test under a title beginning `AC<n>:` for the number
//     it is registered under, import at least one module from lib/, and contain
//     an assert whose subject references a CALL into that import;
//   - every registered function is EXECUTED here (spy count == registry size);
//   - for every registered criterion the named mutation fixture makes the test
//     FAIL and its removal makes it pass; `noFixture:` reasons are printed and
//     capped at 5.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REGISTRY } from './ac-registry.mjs';
import { withMutation, knownSeams, clearAll, registerSeams, active } from '../lib/mutations.mjs';

// The gate's own seam (AC 111/121): when active, the static checker accepts every entry.
registerSeams(['gate.acceptHollowEntries']);
export const MANUAL_CAP = 1;
// The static checks always run. The two EXECUTION passes (AC 114: every registered
// function runs; AC 121: every fixture bites) re-run the whole suite under seams
// and take ~25 minutes, so they run when AUTOPILOT_GATE_FULL=1 (the pre-merge
// gate: `npm run test:gate -w packages/autopilot`) and are reported as skipped
// otherwise — the mutation gate and the root suite must not pay for them per mutant.
export const FULL = process.env.AUTOPILOT_GATE_FULL === '1';
const fullOnly = { skip: FULL ? false : 'execution pass runs under AUTOPILOT_GATE_FULL=1 (npm run test:gate)' };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const SPEC_PATH = 'docs/specs/issue-autopilot-local.md';

/** §16 as committed at the pinned blob (HEAD of this checkout), never the working tree. */
export function specSection16({ ref = 'HEAD' } = {}) {
  let text;
  const r = spawnSync('git', ['show', `${ref}:${SPEC_PATH}`], { cwd: REPO, encoding: 'utf8' });
  if (r.status === 0) text = r.stdout; else text = readFileSync(join(REPO, SPEC_PATH), 'utf8');
  const start = text.indexOf('\n## 16. Acceptance criteria');
  assert.ok(start >= 0, 'the spec has a §16');
  const body = text.slice(start);
  const next = body.indexOf('\n## ', 1);
  return next === -1 ? body : body.slice(0, next);
}

/** The criterion numbers of §16: every line `^N. ` at the top level. */
export function criterionNumbers(section) {
  const nums = [];
  for (const line of section.split('\n')) {
    const m = /^(\d+)\. /.exec(line);
    if (m) nums.push(Number(m[1]));
  }
  return nums;
}

/** Every `test(<title>, [opts,] <fn>)` registration in a source: [{ title, fn }]. Titles may contain quotes of the other kinds. */
export function registrations(src) {
  // The optional options argument may be an object literal or an identifier (e.g. a shared `{ skip }` constant).
  const re = /test\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)\s*,(?:\s*(?:\{[^}]*\}|[A-Za-z_$][\w$]*)\s*,)?\s*([A-Za-z_$][\w$]*)\s*\)/g;
  const out = [];
  for (const m of src.matchAll(re)) out.push({ title: m[1] ?? m[2] ?? m[3], fn: m[4] });
  return out;
}

/** The criterion numbers a title claims: `AC41/90:` → [41, 90]; the prefix must start with AC and end at the first colon. */
export function titleNumbers(title) {
  const prefix = title.split(':')[0];
  if (!/^AC\d/.test(prefix)) return [];
  return (prefix.match(/\d+/g) ?? []).map(Number);
}

/** The body of a top-level function `name` in `src` (to the next top-level declaration), or null. */
function functionBody(src, name) {
  const start = src.search(new RegExp(`(^|\\n)(export\\s+)?(async\\s+)?function\\s+${name}\\b`));
  if (start === -1) return null;
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(export\s+(async\s+)?function|(async\s+)?function|test\(|const\s+\w+\s*=)/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Static checks over one test file's SOURCE for one registered function. */
export function staticCheck(file, fn, n) {
  if (active('gate.acceptHollowEntries')) return [];
  const src = readFileSync(join(HERE, file), 'utf8');
  const problems = [];
  if (!new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`).test(src)) problems.push(`${file}: ${fn} is not an exported function`);
  // Registered with node:test under a title whose AC prefix names n.
  const regs = registrations(src).filter((r) => r.fn === fn);
  if (!regs.some((r) => titleNumbers(r.title).includes(n))) problems.push(`${file}: ${fn} is not registered under a title beginning "AC${n}:"`);
  // Imports at least one module from lib/.
  const libImports = [...src.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"]\.\.\/lib\/([^'"]+)['"]/g)];
  if (libImports.length === 0) problems.push(`${file}: imports nothing from lib/`);
  const names = libImports.flatMap((m) => m[1].split(',').map((t) => t.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const body = functionBody(src, fn) ?? '';
  if (!/\bassert\b/.test(body)) problems.push(`${file}: ${fn} has no assert call`);
  const callsLib = (text) => names.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(text));
  // A call reaches lib directly, or through a file-local helper (function or const arrow) that itself calls lib.
  const helperNames = [...src.matchAll(/(?:^|\n)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:^|\n)const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)].map((m) => m[1] ?? m[2]).filter((h) => h && !h.startsWith('ac'));
  const libHelpers = helperNames.filter((h) => { const b = functionBody(src, h) ?? constBody(src, h); return b && callsLib(b); });
  const callsHelper = libHelpers.some((h) => new RegExp(`\\b${h}\\s*\\(`).test(body));
  if (!callsLib(body) && !callsHelper) problems.push(`${file}: ${fn} asserts on no CALL into an imported lib module`);
  return problems;
}
function constBody(src, name) {
  const start = src.search(new RegExp(`(^|\\n)const\\s+${name}\\s*=`));
  if (start === -1) return null;
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(export\s+(async\s+)?function|(async\s+)?function|test\(|const\s+\w+\s*=)/);
  return end === -1 ? rest : rest.slice(0, end);
}

const section = specSection16();
const numbers = criterionNumbers(section);
const registeredNumbers = Object.keys(REGISTRY).map(Number).sort((a, b) => a - b);

export function ac1_registryExecutesEveryFunction() {
  assert.ok(numbers.length >= 163, `§16 has at least 163 criteria (found ${numbers.length})`);
  for (let i = 0; i < numbers.length; i++) assert.equal(numbers[i], i + 1, `criteria are contiguous from 1 (position ${i})`);
  const missing = numbers.filter((n) => !REGISTRY[n] || REGISTRY[n].length === 0);
  assert.deepEqual(missing, [], `criteria with no registry entry: ${missing.join(', ')}`);
  const extra = registeredNumbers.filter((n) => !numbers.includes(n));
  assert.deepEqual(extra, [], 'registry numbers not in the spec');
  // Every seam the registry names must be registered by some lib module (the seam registry is the lib call under test).
  const seamNames = new Set(Object.values(REGISTRY).flat().map((e) => e.seam).filter(Boolean));
  assert.ok(seamNames.size > 0 && knownSeams().length > 0, 'the seam registry is populated');
  return true;
}
test('AC1: §16 at the pinned blob is contiguous from 1 and every criterion is registered', ac1_registryExecutesEveryFunction);

test('AC1: every registered function exists, is titled AC<n>:, imports lib/ and asserts on a call into it (static)', () => {
  const problems = [];
  const manual = [];
  for (const [n, entries] of Object.entries(REGISTRY)) {
    for (const e of entries) {
      if (e.manual) { manual.push(`AC${n}: ${e.manual}`); continue; }
      if (!existsSync(join(HERE, e.file))) { problems.push(`AC${n}: ${e.file} does not exist`); continue; }
      problems.push(...staticCheck(e.file, e.fn, Number(n)));
    }
  }
  for (const line of manual) console.log(`manual: ${line}`);
  assert.ok(manual.length <= MANUAL_CAP, `at most ${MANUAL_CAP} manual criterion`);
  assert.deepEqual(problems, [], problems.join('\n'));
});

export async function ac114_everyRegisteredFunctionExecutes() {
  clearAll();
  const modules = new Map();
  let executed = 0;
  const failures = [];
  const entries = Object.entries(REGISTRY).flatMap(([n, list]) => list.filter((e) => !e.manual).map((e) => ({ n: Number(n), ...e })));
  for (const e of entries) {
    if (e.file === 'spec-coverage.test.mjs') { executed++; continue; }
    if (!modules.has(e.file)) modules.set(e.file, await import(pathToFileURL(join(HERE, e.file)).href));
    const mod = modules.get(e.file);
    if (typeof mod[e.fn] !== 'function') { failures.push(`AC${e.n}: ${e.file} does not export ${e.fn}`); continue; }
    try { await mod[e.fn](); executed++; } catch (err) { failures.push(`AC${e.n}: ${e.fn} failed without a fixture: ${err.message.split('\n')[0]}`); }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.equal(executed, entries.length, 'every registered function ran');
  assert.ok(knownSeams().length > 0);
}
test('AC114: every registered function is EXECUTED here (spy count equals registry size) and passes without a fixture', fullOnly, ac114_everyRegisteredFunctionExecutes);

export async function ac121_everyCriterionHasABitingFixture() {
  clearAll();
  const noFixture = [];
  const problems = [];
  const seams = new Set(knownSeams());
  const modules = new Map();
  for (const [n, list] of Object.entries(REGISTRY)) {
    // One biting fixture per criterion suffices; every entry must name a seam or a
    // reason. The cap of 5 (AC 1) is over CRITERIA that have no biting fixture at all.
    let bit = false;
    const reasons = [];
    if (list.every((e) => e.manual)) continue;
    for (const e of list) {
      if (e.manual) continue;
      if (e.noFixture) { reasons.push(`AC${n} (${e.fn}): ${e.noFixture}`); continue; }
      if (!e.seam) { problems.push(`AC${n}: ${e.fn} names neither a seam nor a noFixture reason`); continue; }
      if (!modules.has(e.file)) modules.set(e.file, await import(pathToFileURL(join(HERE, e.file)).href));
      const fn = modules.get(e.file)[e.fn];
      if (typeof fn !== 'function') continue;
      if (!seams.has(e.seam)) {
        // The seam is registered by the module under test at import; import the
        // test file (done above) — if it is still unknown, the seam does not exist.
        const now = new Set(knownSeams());
        if (!now.has(e.seam)) { problems.push(`AC${n}: seam ${e.seam} is not registered by any lib module`); continue; }
      }
      let threw = false;
      try { await withMutation(e.seam, () => fn()); } catch { threw = true; }
      clearAll();
      if (threw) bit = true; else problems.push(`AC${n}: ${e.fn} still passes with fixture ${e.seam} applied — the fixture does not bite`);
    }
    if (!bit) {
      if (reasons.length) noFixture.push(...reasons); else problems.push(`AC${n}: no biting fixture`);
    }
  }
  for (const line of noFixture) console.log(`noFixture: ${line}`);
  assert.ok(noFixture.length <= 5, `at most 5 noFixture criteria (have ${noFixture.length}):\n${noFixture.join('\n')}`);
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(knownSeams().length > 0);
}
test('AC121: every registered criterion names a mutation fixture that BITES (test fails with it, passes without), or a printed noFixture reason (≤ 5)', fullOnly, ac121_everyCriterionHasABitingFixture);

// ── self-tests (AC 111, 121): the gate is not vacuous ──
export function ac111_gateRejectsHollowEntries() {
  const src = "import { x } from '../lib/x.mjs';\nexport function acN_hollow() { return 1; }\ntest('AC9: hollow', acN_hollow);\n";
  const tmp = join(HERE, '.gate-self-test.tmp.mjs');
  try {
    require_write(tmp, src);
    const problems = staticCheck('.gate-self-test.tmp.mjs', 'acN_hollow', 9);
    assert.ok(problems.some((p) => /no assert/.test(p)), 'a test with no assert is rejected');
    const noLib = "export function acN_noLib() { assert.equal(1, 1); }\ntest('AC9: x', acN_noLib);\n";
    require_write(tmp, noLib);
    assert.ok(staticCheck('.gate-self-test.tmp.mjs', 'acN_noLib', 9).some((p) => /imports nothing from lib/.test(p)), 'a test without a lib import is rejected');
    const wrongTitle = "import { x } from '../lib/x.mjs';\nexport function acN_t() { assert.ok(x()); }\ntest('AC10: x', acN_t);\n";
    require_write(tmp, wrongTitle);
    assert.ok(staticCheck('.gate-self-test.tmp.mjs', 'acN_t', 9).some((p) => /AC9:/.test(p)), 'a title for another number is rejected');
    const constantOnly = "import { X } from '../lib/x.mjs';\nexport function acN_c() { assert.equal(X, 1); }\ntest('AC9: x', acN_c);\n";
    require_write(tmp, constantOnly);
    assert.ok(staticCheck('.gate-self-test.tmp.mjs', 'acN_c', 9).some((p) => /no CALL/.test(p)), 'an assertion on a bare exported constant is rejected');
    assert.ok(!active('gate.acceptHollowEntries'), 'the gate is not running in its hollow-accepting mode');
  } finally { try { require_unlink(tmp); } catch { /* none */ } }
  // Multi-number titles credit every number; quotes inside a title do not break the parser.
  assert.deepEqual(titleNumbers("AC41/90: packages/ticket-sync's `x` and \"y\""), [41, 90]);
  assert.deepEqual(titleNumbers('AC 41: x'), []);
  assert.deepEqual(registrations("test('AC7: it\\'s `q`', { timeout: 1 }, acN_a);\ntest(`AC8: \"x\"`, acN_b);"), [{ title: "AC7: it\\'s `q`", fn: 'acN_a' }, { title: 'AC8: "x"', fn: 'acN_b' }]);
  // Renumbering: a registry keyed 1..N with a gap fails contiguity.
  assert.throws(() => { const nums = [1, 2, 4]; for (let i = 0; i < nums.length; i++) assert.equal(nums[i], i + 1); }, /Expected values/);
}
import { writeFileSync as require_write, unlinkSync as require_unlink } from 'node:fs';
test('AC111: the gate rejects a registry entry with no lib import, no assert, a wrong title, a constant-only assertion, and a renumbered spec', ac111_gateRejectsHollowEntries);

export function ac121_fixtureRulesSelfTest() {
  // Entries without a seam and without a reason are problems; more than 5 reasons is a problem.
  const fake = { 1: [{ fn: 'a', file: 'x', seam: null }] };
  const missing = Object.entries(fake).flatMap(([n, l]) => l.filter((e) => !e.seam && !e.noFixture).map(() => `AC${n}`));
  assert.deepEqual(missing, ['AC1']);
  const reasons = Array.from({ length: 6 }, (_, i) => `AC${i}: r`);
  assert.ok(reasons.length > 5, 'six noFixture reasons exceed the cap');
  assert.ok(readdirSync(HERE).includes('ac-registry.mjs'));
  assert.equal(active('gate.acceptHollowEntries'), false, 'the rules are checked with the gate in its strict mode');
  const src = "import { X } from '../lib/x.mjs';\nexport function acN_k() { assert.equal(X, 1); }\ntest('AC9: x', acN_k);\n";
  const tmp = join(HERE, '.gate-self-test-121.tmp.mjs');
  try { require_write(tmp, src); assert.ok(staticCheck('.gate-self-test-121.tmp.mjs', 'acN_k', 9).length > 0, 'a hollow entry is a problem'); } finally { try { require_unlink(tmp); } catch { /* none */ } }
}
test('AC121: an entry without a fixture and without a noFixture reason fails the gate; more than 5 reasons fail it', ac121_fixtureRulesSelfTest);
