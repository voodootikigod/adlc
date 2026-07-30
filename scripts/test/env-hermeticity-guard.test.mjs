// env-hermeticity-guard.test.mjs — the drift gate for ambient-env spawn hermeticity
// (T-01KYQMPBWFP2Y8CTVWR3W38X2Z, spec .adlc/specs/manifest-key-hermeticity.md Layer 4).
//
// #398 was three instances of the same class: a test spawns an ADLC entrypoint with
// `...process.env`, inheriting whatever the OPERATOR's shell happened to have set —
// the tier-check clock race and RAILS_BASE leak (both fixed in #399), and the
// ADLC_MANIFEST_KEY leak (0/2 gate-manifest+tickets segments passing with it exported,
// 2/2 without — #398's comment thread). Layers 1–2 of the spec made the class mostly
// harmless (the runner scrubs it; libraries take the key as an explicit parameter), so
// THIS guard is a backstop against a NEW spawn site reintroducing the leak, not a
// currently load-bearing check.
//
// It is a static, deterministic, offline scan (no subprocesses, no network) —
// findEnvHermeticityViolations(files) → [{file, variable, message}] for every spawn
// site that inherits `...process.env` while spawning a known ADLC entrypoint, without
// EITHER (a) neutralizing that entrypoint's ambient-sensitive variables (an inline
// `VARNAME: ''`/literal key, or a `process.env.VARNAME = <literal>` pin anywhere in the
// file — both patterns already in use by real tests, e.g.
// packages/prosecute/test/prosecute-tier-check-cli.test.mjs's file-top key pin) OR
// (b) a suppression comment naming the variable and a non-empty reason.
//
// DECLARE-AND-NEUTRALIZE, not blanket scrub: which variables are "sensitive" is
// PER-ENTRYPOINT, derived from what that entrypoint's own source actually reads —
// `scripts/rails-guard-ci.mjs` (and packages/rails-guard/bin/rails-guard-ci.mjs, the
// same tool) resolves --base from RAILS_BASE/BASE_REF
// (packages/rails-guard/lib/ci/args.mjs defaultBase()) and never touches the manifest
// key; every OTHER matched entrypoint (packages/rails-guard/bin/rails-guard.mjs,
// bin/adlc-*.mjs) signs/verifies manifest evidence via getKey()/resolveKeyFromEnv() and
// does not read RAILS_BASE/BASE_REF at all. A blanket "all three, always" rule would
// flag packages/rails-guard/test/ci-bin.test.mjs and
// scripts/test/rails-guard-bootstrap-ci.test.mjs — the two ALREADY-COMPLIANT examples
// the ticket names — for not neutralizing a variable their spawn target never reads.
//
// PER-CALL, not per-file: a file can contain multiple spawn call sites for DIFFERENT
// targets (see packages/runner/test/codex-integration.test.mjs, which spawns
// packages/prosecute/bin/adlc-prosecute.mjs with no `env` key at all — full ambient
// inherit, but not a `...process.env` SPREAD, so out of this guard's literal scope —
// alongside unrelated spawns that DO spread `...process.env`). A per-file scan would
// flag that file for the unrelated spread; per-call analysis correctly does not.
//
// Proven ALL FOUR ways (AC4.1): flags a planted violating fixture; passes against
// current HEAD; a suppression marker with an EMPTY reason still flags; the real tree's
// known entrypoint variable indirection (BIN/GATE_BIN constants, not inline literals at
// the call site) resolves correctly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── the detector (pure; exercised on both inline fixtures and the real tree) ──────

/**
 * The ambient variables a matched entrypoint PATH genuinely reads, or null if the
 * path does not match any of the three patterns this guard covers (out of scope —
 * e.g. packages/gate-manifest/bin/gate-manifest.mjs, not named `adlc-*.mjs`).
 * @param {string} pathText
 * @returns {string[]|null}
 */
function sensitiveVarsForEntrypoint(pathText) {
  if (pathText.includes('rails-guard-ci.mjs')) return ['RAILS_BASE', 'BASE_REF'];
  // Negative lookbehind for a preceding word-char/hyphen: 'rails-guard.mjs' must be a
  // whole path SEGMENT (preceded by '/', a quote, or nothing), not part of a longer
  // name — plugins/adlc-codex/hooks/adlc-rails-guard.mjs is an UNRELATED hook that
  // happens to share the "rails-guard.mjs" suffix and must NOT match here.
  if (/(?<![\w-])rails-guard\.mjs/.test(pathText)) return ['ADLC_MANIFEST_KEY'];
  if (/bin\/adlc-[\w-]+\.mjs/.test(pathText)) return ['ADLC_MANIFEST_KEY'];
  return null;
}

/**
 * Map of local variable name -> sensitive-vars, for every `const`/`let` assignment
 * in `source` whose right-hand side names a matched entrypoint path (the common
 * `const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;` /
 * `const GATE_BIN = join(ROOT, 'packages', 'rails-guard', 'bin', 'rails-guard-ci.mjs');`
 * shape every candidate file in this repo uses — the target is a constant, not
 * re-typed at each call site).
 * @param {string} source
 * @returns {Map<string, string[]>}
 */
function resolveEntrypointVariables(source) {
  const vars = new Map();
  // Spans a FEW lines (not just to the first '\n'): join()/new URL() entrypoint
  // assignments are occasionally formatter-wrapped across lines. Bounded by ';' so it
  // still terminates at the statement end, not runs away across the whole file.
  const assignRe = /(?:const|let)\s+(\w+)\s*=[\s\S]*?;/g;
  let m;
  while ((m = assignRe.exec(source))) {
    // Two candidate forms: the raw text (catches `new URL('../bin/adlc-x.mjs', ...)`,
    // a single string already containing the pattern), and every quoted string token
    // joined with '/' (catches `join(ROOT, 'packages', 'x', 'bin', 'adlc-x.mjs')` —
    // segmented arguments that never appear as one contiguous substring).
    const tokens = [...m[0].matchAll(/['"`]([^'"`]+)['"`]/g)].map((t) => t[1]);
    const sensitive = sensitiveVarsForEntrypoint(m[0]) || sensitiveVarsForEntrypoint(tokens.join('/'));
    if (sensitive) vars.set(m[1], sensitive);
  }
  return vars;
}

/**
 * Extract the balanced-parenthesis argument text of every `execFileSync(`/
 * `spawnSync(`/`exec(` call in `source`, from the opening paren to its match.
 * A repo-shape lint, not a JS parser: depth-counts parens only (no string-literal
 * skipping) — sufficient for this codebase's spawn calls, which pass file paths and
 * flag arrays, not nested parenthesized expressions, as arguments.
 * @param {string} source
 * @returns {string[]}
 */
function extractSpawnCallTexts(source) {
  const calls = [];
  const fnRe = /\b(?:execFileSync|spawnSync|exec)\s*\(/g;
  let m;
  while ((m = fnRe.exec(source))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    calls.push(source.slice(start, i - 1));
  }
  return calls;
}

/**
 * Map of local variable name -> true, for every `const`/`let` object-literal
 * assignment whose body contains a literal `...process.env` spread (the
 * `const HERMETIC_ENV = { ...process.env, RAILS_BASE: '' };` shape used as a shared
 * template, then referenced by bare identifier at the actual spawn call).
 * @param {string} source
 * @returns {Set<string>}
 */
function resolveAmbientEnvVariables(source) {
  const names = new Set();
  const assignRe = /(?:const|let)\s+(\w+)\s*=\s*\{[\s\S]*?\};/g;
  let m;
  while ((m = assignRe.exec(source))) {
    if (m[0].includes('...process.env')) names.add(m[1]);
  }
  return names;
}

/**
 * True iff `varText` (the source of ONE variable's required-var check) is satisfied
 * anywhere in `source` — an inline object key (`VARNAME: <anything>`), a
 * `process.env.VARNAME = <literal>` pin, or a suppression comment
 * `// env-hermeticity: inherits VARNAME — <non-empty reason>`.
 * @param {string} source
 * @param {string} varName
 * @returns {boolean}
 */
function isNeutralizedOrSuppressed(source, varName) {
  // `VARNAME:` alone is not enough — `VARNAME: process.env.VARNAME` is a complete
  // no-op that re-injects the ambient value under a different-looking key. Require the
  // key form to match ANY `VARNAME:` occurrence EXCEPT one whose RHS (up to the next
  // comma/brace) is exactly `process.env.VARNAME`.
  const keyOccurrenceRe = new RegExp(`\\b${varName}\\s*:\\s*([^,}\n]*)`, 'g');
  let keyForm = false;
  let km;
  while ((km = keyOccurrenceRe.exec(source))) {
    if (km[1].trim() !== `process.env.${varName}`) { keyForm = true; break; }
  }
  const pinForm = new RegExp(`process\\.env\\.${varName}\\s*=`);
  // The reason must be on the SAME LINE as the dash: `\s*` between the dash and the
  // required non-whitespace char would otherwise span the newline into whatever code
  // follows on the NEXT line, turning an empty reason into a false "suppressed".
  const suppressForm = new RegExp(`//[ \\t]*env-hermeticity:[ \\t]*inherits[ \\t]+${varName}[ \\t]*(?:—|--|-)[ \\t]*\\S`);
  return keyForm || pinForm.test(source) || suppressForm.test(source);
}

/**
 * Scan one file's source for spawn sites that inherit `...process.env` while
 * targeting a known ADLC entrypoint, without neutralizing or suppressing every
 * variable that entrypoint reads.
 * @param {string} filePath  used only for the reported message
 * @param {string} source
 * @returns {{file: string, variable: string, message: string}[]}
 */
function findViolationsInSource(filePath, source) {
  const entrypointVars = resolveEntrypointVariables(source);
  const ambientEnvVars = resolveAmbientEnvVariables(source);
  const violations = [];
  const flaggedVars = new Set();
  for (const callText of extractSpawnCallTexts(source)) {
    const spreadsAmbient = callText.includes('...process.env')
      || [...ambientEnvVars].some((v) => new RegExp(`\\b${v}\\b`).test(callText));
    if (!spreadsAmbient) continue;
    let required = null;
    // Direct literal match (an entrypoint path typed inline at the call site).
    required = sensitiveVarsForEntrypoint(callText);
    // Indirect: the call references a resolved entrypoint variable by bare token.
    if (!required) {
      for (const [varName, vars] of entrypointVars) {
        if (new RegExp(`\\b${varName}\\b`).test(callText)) { required = vars; break; }
      }
    }
    if (!required) continue; // spawns something, but not a matched ADLC entrypoint
    for (const varName of required) {
      if (flaggedVars.has(varName)) continue;
      if (!isNeutralizedOrSuppressed(source, varName)) {
        flaggedVars.add(varName);
        violations.push({
          file: filePath,
          variable: varName,
          message: `${filePath} spawns an ADLC entrypoint with ...process.env but never neutralizes ${varName} ` +
            `(add ${varName}: '' or a literal to the env object, or pin process.env.${varName} = '<literal>') ` +
            `nor suppresses it (// env-hermeticity: inherits ${varName} — <reason>).`,
        });
      }
    }
  }
  return violations;
}

/** *.test.mjs files directly under `dir` (non-recursive — test dirs are flat here). */
function testFilesIn(dir) {
  if (!(() => { try { return readdirSync(dir); } catch { return null; } })()) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
      .map((e) => join(dir, e.name));
  } catch { return []; }
}

/** Every candidate test file this guard covers: packages/*\/test and scripts/test. */
function candidateFiles(repoRoot) {
  const files = [];
  for (const pkg of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    files.push(...testFilesIn(join(repoRoot, 'packages', pkg.name, 'test')));
  }
  files.push(...testFilesIn(join(repoRoot, 'scripts', 'test')));
  // Exclude the guard's OWN file: its inline fixture strings deliberately contain
  // matching entrypoint/spread patterns as TEXT, not real spawn code, and would
  // otherwise self-flag.
  return files.filter((f) => !f.endsWith('env-hermeticity-guard.test.mjs'));
}

/**
 * Scan the given absolute file paths and return every violation, each message
 * prefixed with the path RELATIVE to `repoRoot` for a stable, portable report.
 * @param {string[]} filePaths
 * @param {string} [repoRoot]
 * @returns {{file: string, variable: string, message: string}[]}
 */
export function findEnvHermeticityViolations(filePaths, repoRoot = REPO_ROOT) {
  const out = [];
  for (const abs of filePaths) {
    const rel = abs.startsWith(repoRoot) ? abs.slice(repoRoot.length + 1) : abs;
    out.push(...findViolationsInSource(rel, readFileSync(abs, 'utf8')));
  }
  return out;
}

// ── AC4.1.1: a planted violating fixture is flagged ───────────────────────────────

test('a spawn of bin/adlc-prosecute.mjs with ...process.env and no neutralization is flagged for ADLC_MANIFEST_KEY', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args, cwd) {
      return execFileSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/violating.test.mjs', fixture);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].variable, 'ADLC_MANIFEST_KEY');
  assert.match(violations[0].message, /never neutralizes ADLC_MANIFEST_KEY/);
  assert.match(violations[0].message, /ADLC_MANIFEST_KEY: ''/);
  assert.match(violations[0].message, /env-hermeticity: inherits ADLC_MANIFEST_KEY/);
});

test('a spawn of rails-guard-ci.mjs with ...process.env and no neutralization is flagged for RAILS_BASE and BASE_REF, never ADLC_MANIFEST_KEY', () => {
  const fixture = `
    import { spawnSync } from 'node:child_process';
    const GATE_BIN = join(ROOT, 'packages', 'rails-guard', 'bin', 'rails-guard-ci.mjs');
    function run(args) {
      return spawnSync(process.execPath, [GATE_BIN, ...args], { env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/violating-rails.test.mjs', fixture);
  assert.deepEqual(violations.map((v) => v.variable).sort(), ['BASE_REF', 'RAILS_BASE']);
});

// ── AC4.1.2: the fixed guard passes against current HEAD ──────────────────────────

test('the guard finds NO violations across the real repo tree', () => {
  const violations = findEnvHermeticityViolations(candidateFiles(REPO_ROOT));
  assert.deepEqual(
    violations.map((v) => v.message),
    [],
    `env-hermeticity guard found violations:\n${violations.map((v) => v.message).join('\n')}`,
  );
});

// ── AC4.1.3: suppression requires a REASON — an empty one still flags ─────────────

test('a suppression marker with no reason text still flags (an empty reason is not a suppression)', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-tickets.mjs', import.meta.url).pathname;
    // env-hermeticity: inherits ADLC_MANIFEST_KEY —
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/empty-reason.test.mjs', fixture);
  assert.equal(violations.length, 1, 'an empty-reason marker must not suppress the finding');
  assert.equal(violations[0].variable, 'ADLC_MANIFEST_KEY');
});

test('a suppression marker WITH a reason does suppress the finding', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-tickets.mjs', import.meta.url).pathname;
    // env-hermeticity: inherits ADLC_MANIFEST_KEY — this test deliberately exercises the
    // operator's real shell key against a scratch store, see #123.
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/reasoned.test.mjs', fixture);
  assert.deepEqual(violations, []);
});

// ── AC4.1.4 / robustness: entrypoint-variable indirection and non-matches ─────────

test('an inline entrypoint-var pin (VARNAME: literal) satisfies neutralization, matching the "or a literal" rule', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args, key) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env, ADLC_MANIFEST_KEY: key } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/inline-pin.test.mjs', fixture), []);
});

test('a file-top process.env.VARNAME = literal pin satisfies neutralization even for a later spawn in the same file', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    process.env.ADLC_MANIFEST_KEY = 'test-signing-key';
    const BIN = new URL('../bin/adlc-tickets.mjs', import.meta.url).pathname;
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/env-pin.test.mjs', fixture), []);
});

test('an entrypoint NOT matching any of the three patterns is never flagged, regardless of ...process.env', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = join(ROOT, 'packages', 'gate-manifest', 'bin', 'gate-manifest.mjs');
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/unmatched.test.mjs', fixture), []);
});

test('a spawn WITHOUT ...process.env (fully controlled env, or env omitted) is never flagged', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runControlled(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH } });
    }
    function runOmitted(args, cwd) {
      return execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/no-spread.test.mjs', fixture), []);
});

test('a per-file scan does not false-positive: an unrelated spawn\'s ...process.env does not taint a DIFFERENT, non-spreading call to a matched entrypoint', () => {
  // Mirrors packages/runner/test/codex-integration.test.mjs: one spawn targets an ADLC
  // entrypoint with NO env key (full ambient inherit, but no literal `...process.env`
  // spread — out of this guard's stated scope); a SEPARATE, unrelated spawn elsewhere
  // in the file does spread `...process.env`. Per-call (not per-file) analysis must not
  // let the unrelated spread trigger a flag on the entrypoint spawn.
  const fixture = `
    import { execFileSync, spawnSync } from 'node:child_process';
    const prosecute = join(repoRoot, 'packages', 'prosecute', 'bin', 'adlc-prosecute.mjs');
    const common = { cwd: dir, encoding: 'utf8' };
    const p5Record = execFileSync(process.execPath, [prosecute, '--ticket', 'T1'], common);
    const smoke = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'codex-install-smoke.mjs')], {
      env: { ...process.env, HOME: home },
    });
  `;
  assert.deepEqual(findViolationsInSource('fixtures/mixed-spawns.test.mjs', fixture), []);
});

// ── codex adversarial review findings, closed ──────────────────────────────────────

test('a self-referential no-op (VARNAME: process.env.VARNAME) does NOT count as neutralization', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], {
        env: { ...process.env, ADLC_MANIFEST_KEY: process.env.ADLC_MANIFEST_KEY },
      });
    }
  `;
  const violations = findViolationsInSource('fixtures/self-referential.test.mjs', fixture);
  assert.equal(violations.length, 1, 'a same-value re-injection neutralizes nothing');
  assert.equal(violations[0].variable, 'ADLC_MANIFEST_KEY');
});

test('a multi-line (formatter-wrapped) entrypoint assignment still resolves', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = join(
      ROOT,
      'packages',
      'prosecute',
      'bin',
      'adlc-prosecute.mjs',
    );
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/multiline-assign.test.mjs', fixture);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].variable, 'ADLC_MANIFEST_KEY');
});

test('a shared ambient-env template variable (const X = { ...process.env }; env: X) is scanned like an inline spread', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    const AMBIENT_ENV = { ...process.env };
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: AMBIENT_ENV });
    }
  `;
  const violations = findViolationsInSource('fixtures/shared-ambient-env.test.mjs', fixture);
  assert.equal(violations.length, 1, 'a call referencing a known ambient-env template must be scanned');
  assert.equal(violations[0].variable, 'ADLC_MANIFEST_KEY');
});

test('a shared ambient-env template that ALSO neutralizes inline is compliant', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    const AMBIENT_ENV = { ...process.env, ADLC_MANIFEST_KEY: 'test-key' };
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: AMBIENT_ENV });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/shared-ambient-env-safe.test.mjs', fixture), []);
});
