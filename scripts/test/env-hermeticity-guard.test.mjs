// env-hermeticity-guard.test.mjs — the drift gate for ambient-env spawn hermeticity
// (T-01KYQMPBWFP2Y8CTVWR3W38X2Z, spec .adlc/specs/manifest-key-hermeticity.md Layer 4).
//
// #398 was three instances of the same class: a test spawns an ADLC entrypoint with
// `...process.env`, inheriting whatever the OPERATOR's shell happened to have set —
// the tier-check clock race and RAILS_BASE leak (both fixed in #399), and the
// ADLC_MANIFEST_KEY leak (0/2 gate-manifest+tickets segments passing with it exported,
// 2/2 without — #398's comment thread). Layers 1-2 of the spec made the class mostly
// harmless (the runner scrubs it; libraries take the key as an explicit parameter), so
// THIS guard is a backstop against a NEW spawn site reintroducing the leak, not a
// currently load-bearing check.
//
// findEnvHermeticityViolations(files) -> [{file, variable, message}] for every spawn
// site that inherits `...process.env` while spawning a known ADLC entrypoint, without
// EITHER (a) neutralizing the variables THAT ENTRYPOINT reads (an inline `VARNAME: ''`
// / string literal in the SAME env object that spawn actually uses, or a file-top
// `process.env.VARNAME = '<literal>'` pin, which is legitimately global — it mutates
// the runtime environment every later unqualified spread reads) OR (b) a suppression
// comment attached to that spawn, naming the variable and a non-empty reason.
//
// PARSED WITH ACORN, not regex/text-heuristics. A hand-rolled scanner shipped here
// first; three concrete bypasses survived it before this version: (1) a literal safe
// spawn ANYWHERE in a file wrongly protected an unrelated unsafe spawn (file-wide
// object-key search instead of scoping the check to the actual env object THAT call
// evaluates); (2) `const inheritedKey = process.env.ADLC_MANIFEST_KEY;` used as
// `ADLC_MANIFEST_KEY: inheritedKey` passed as "neutralized" because the check only
// excluded the exact self-referential expression, not dynamic aliases generally; (3) an
// argument string containing `)` (e.g. a regex or diagnostic literal) desynced a
// paren-depth counter, truncating extraction before the env object was ever reached.
// This repo already hit the identical class of failure once before and fixed it the
// same way — see scripts/release.mjs's relativeSpecifiers(), which replaced an earlier
// hand-rolled import lexer after it silently missed a real import by walking into a
// regex body on a backtick. acorn is a devDependency of the private root package only;
// no published @adlc/* package gains a runtime dependency from it.
//
// PER-ENTRYPOINT, not blanket: which variables are "sensitive" is derived from what
// that entrypoint's OWN source genuinely reads — `rails-guard-ci.mjs` resolves --base
// from RAILS_BASE/BASE_REF and never touches the manifest key; every OTHER matched
// entrypoint (`rails-guard.mjs`, `bin/adlc-*.mjs`) signs/verifies manifest evidence and
// never reads RAILS_BASE/BASE_REF. A blanket "all three, always" rule would flag
// packages/rails-guard/test/ci-bin.test.mjs and scripts/test/rails-guard-bootstrap-ci
// .test.mjs — the two ALREADY-COMPLIANT examples the ticket names — for not
// neutralizing a variable their spawn target never reads.
//
// ONLY A STATICALLY-PROVABLE LITERAL counts as neutralization or a pin (never an
// identifier, member expression, call, or interpolated template) — a dynamic
// expression cannot be verified not to resolve back to the ambient value at runtime,
// so it is treated as unsafe. Fail-closed on ambiguity, not fail-open on optimism.
//
// A file that fails to parse is NOT reported clean — it throws (the same three-state
// discipline scripts/release.mjs documents for its own acorn use): "could not check"
// must never render as "verified".
//
// Regression fixtures below each prove both directions (flags the unsafe form, passes
// the safe one) for a specific bypass this scanner must not permit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACORN_OPTIONS = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true };
const SPAWN_FN_NAMES = new Set(['execFileSync', 'spawnSync', 'exec']);

// ── the detector (pure; exercised on both inline fixtures and the real tree) ──────

/**
 * The ambient variables a matched entrypoint PATH genuinely reads, or null if the
 * path does not match any of the three patterns this guard covers (out of scope —
 * e.g. packages/gate-manifest/bin/gate-manifest.mjs, not named `adlc-*.mjs`, or
 * plugins/adlc-codex/hooks/adlc-rails-guard.mjs, an unrelated hook that merely shares
 * the "rails-guard.mjs" suffix — the boundary check below rejects that collision).
 * @param {string} pathText
 * @returns {string[]|null}
 */
function sensitiveVarsForEntrypoint(pathText) {
  if (pathText.includes('rails-guard-ci.mjs')) return ['RAILS_BASE', 'BASE_REF'];
  if (/(?:^|[/'"`])rails-guard\.mjs(?:$|['"`])/.test(pathText)) return ['ADLC_MANIFEST_KEY'];
  if (/bin\/adlc-[\w-]+\.mjs/.test(pathText)) return ['ADLC_MANIFEST_KEY'];
  return null;
}

/** True iff `node` is a string Literal — the ONLY form this guard trusts as a value. */
function isStringLiteral(node) {
  return !!node && node.type === 'Literal' && typeof node.value === 'string';
}

/** Generic recursive walk: visit(node) is called on every node reachable from `root`. */
function walk(root, visit) {
  const seen = new Set();
  const go = (node) => {
    if (!node || typeof node.type !== 'string' || seen.has(node)) return;
    seen.add(node);
    visit(node);
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(go);
      else if (child && typeof child === 'object') go(child);
    }
  };
  go(root);
}

/**
 * Statically resolve a CallExpression to a joined path string when EVERY argument the
 * detector can extract is a string Literal — handles both
 * `new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname` (one literal
 * already containing '/') and `join(ROOT, 'packages', 'x', 'bin', 'adlc-x.mjs')`
 * (literal segments joined with '/'; a non-literal argument like `ROOT` is simply
 * skipped rather than aborting the whole resolution — the goal is "does this call
 * MENTION a matching path", not full path resolution).
 * @param {object} node  a CallExpression or MemberExpression/CallExpression chain
 * @returns {string|null}
 */
function resolveCallToPathText(node) {
  const literals = [];
  walk(node, (n) => { if (isStringLiteral(n)) literals.push(n.value); });
  return literals.length ? literals.join('/') : null;
}

/**
 * Every name bound as a FUNCTION PARAMETER anywhere in the file (plain identifiers and
 * default-valued `= …` params; a destructured/rest param is not a bare name-collision
 * risk and is skipped). A parameter always SHADOWS any outer same-named declaration —
 * without real scope resolution, a name-based lookup cannot tell "the `env` object
 * literal declared inside cleanEnv()'s body" from "the unrelated `env` PARAMETER of a
 * different function" apart; both are named `env`. Excluding every parameter name from
 * `objectLiteralVars` is a conservative, name-collision-safe fix: it can only cause a
 * MISSED indirection (a call flagged that a human would recognize as fine, cheap to
 * confirm or annotate) — never a missed real leak.
 * @param {object} ast
 * @returns {Set<string>}
 */
function collectParameterNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (node.type !== 'FunctionDeclaration' && node.type !== 'FunctionExpression' &&
      node.type !== 'ArrowFunctionExpression') return;
    for (const p of node.params) {
      if (p.type === 'Identifier') names.add(p.name);
      else if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') names.add(p.left.name);
    }
  });
  return names;
}

/**
 * Two maps built from EVERY top-level-shaped VariableDeclarator in the file (no real
 * scope tracking — this codebase declares these at module top; a repo-shape lint, not
 * a scope-resolving compiler — but SEE `collectParameterNames` for the one shadowing
 * case this guard defends against by exclusion rather than by full resolution):
 *   entrypointVars: varName -> sensitiveVars, for `const BIN = new URL(...)`/`join(...)`
 *     assignments whose resolved path text matches a known entrypoint pattern.
 *   objectLiteralVars: varName -> the ObjectExpression node, for EVERY
 *     `const X = { ... };` object-literal assignment — used to resolve both a bare
 *     `env: X` reference AND a `...X` spread nested inside a LARGER env object (the
 *     `env: { ...process.env, ...HERMETIC_ENV, BASE_REF: 'main' }` shape).
 * @param {object} ast
 * @returns {{entrypointVars: Map<string,string[]>, objectLiteralVars: Map<string,object>}}
 */
function resolveModuleVariables(ast) {
  const entrypointVars = new Map();
  const objectLiteralVars = new Map();
  const paramNames = collectParameterNames(ast);
  walk(ast, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) return;
    const name = node.id.name;
    if (paramNames.has(name)) return; // shadowed elsewhere — do not trust a name-based match
    if (node.init.type === 'ObjectExpression') objectLiteralVars.set(name, node.init);
    const pathText = resolveCallToPathText(node.init);
    if (pathText) {
      const sensitive = sensitiveVarsForEntrypoint(pathText);
      if (sensitive) entrypointVars.set(name, sensitive);
    }
  });
  return { entrypointVars, objectLiteralVars };
}

/** True iff `node` (MemberExpression) is exactly `process.env`. */
function isProcessEnv(node) {
  return !!node && node.type === 'MemberExpression' && !node.computed &&
    node.object?.type === 'Identifier' && node.object.name === 'process' &&
    node.property?.type === 'Identifier' && node.property.name === 'env';
}

/** True iff `node` (MemberExpression) is exactly `process.env.VARNAME`. */
function isProcessEnvVar(node, varName) {
  return !!node && node.type === 'MemberExpression' && !node.computed &&
    isProcessEnv(node.object) &&
    node.property?.type === 'Identifier' && node.property.name === varName;
}

/**
 * True iff `objExpr` spreads ambient env — directly (`...process.env`) or through a
 * `...NAME` spread where NAME resolves (via `objectLiteralVars`) to an object that
 * itself spreads ambient env, recursively (the `{ ...process.env, ...HERMETIC_ENV }`
 * template-of-a-template shape). Cycle-guarded.
 * @param {object} objExpr
 * @param {Map<string,object>} objectLiteralVars
 * @param {Set<object>} [seen]
 * @returns {boolean}
 */
function spreadsProcessEnvDeep(objExpr, objectLiteralVars, seen = new Set()) {
  if (seen.has(objExpr)) return false;
  seen.add(objExpr);
  return objExpr.properties.some((p) => {
    if (p.type !== 'SpreadElement') return false;
    if (isProcessEnv(p.argument)) return true;
    if (p.argument.type === 'Identifier' && objectLiteralVars.has(p.argument.name)) {
      return spreadsProcessEnvDeep(objectLiteralVars.get(p.argument.name), objectLiteralVars, seen);
    }
    return false;
  });
}

/**
 * True iff `objExpr` contains a `VARNAME: <string literal>` property — directly, or
 * inside a `...NAME` spread resolved the same recursive way as `spreadsProcessEnvDeep`
 * — INCLUDING an empty string, but NOT `VARNAME: process.env.VARNAME` (a no-op
 * re-injection) and NOT any other dynamic expression (identifier alias, member
 * expression, call, template with interpolation): only a provable literal is trusted.
 * @param {object} objExpr
 * @param {string} varName
 * @param {Map<string,object>} objectLiteralVars
 * @param {Set<object>} [seen]
 * @returns {boolean}
 */
function hasLiteralNeutralization(objExpr, varName, objectLiteralVars, seen = new Set()) {
  if (seen.has(objExpr)) return false;
  seen.add(objExpr);
  return objExpr.properties.some((p) => {
    if (p.type === 'SpreadElement') {
      return p.argument.type === 'Identifier' && objectLiteralVars.has(p.argument.name) &&
        hasLiteralNeutralization(objectLiteralVars.get(p.argument.name), varName, objectLiteralVars, seen);
    }
    if (p.type !== 'Property' && p.type !== 'ObjectProperty') return false;
    const key = p.key;
    const keyName = key?.type === 'Identifier' ? key.name : (isStringLiteral(key) ? key.value : null);
    if (keyName !== varName) return false;
    return isStringLiteral(p.value); // isProcessEnvVar values are MemberExpressions, never Literal — excluded by construction.
  });
}

/**
 * Resolve a spawn call's effective `env` OBJECT — the ObjectExpression the call's
 * `env:` property evaluates to, following ONE level of identifier indirection through
 * `objectLiteralVars` (the realistic `const AMBIENT_ENV = {...}; ...; env: AMBIENT_ENV`
 * shape). Returns null if there is no `env` property, or it isn't (an alias of) an
 * object literal — deliberately conservative: a fully-controlled/omitted env or a
 * form this detector cannot statically resolve is OUT OF SCOPE, matching the ticket's
 * literal wording ("with `...process.env` in its env argument").
 * @param {object} optionsArg  the spawn call's options ObjectExpression argument
 * @param {Map<string,object>} objectLiteralVars
 * @returns {object|null}
 */
function resolveEnvObject(optionsArg, objectLiteralVars) {
  if (!optionsArg || optionsArg.type !== 'ObjectExpression') return null;
  const envProp = optionsArg.properties.find(
    (p) => (p.type === 'Property' || p.type === 'ObjectProperty') &&
      (p.key?.name === 'env' || p.key?.value === 'env'),
  );
  if (!envProp) return null;
  const value = envProp.value;
  if (value.type === 'ObjectExpression') return value;
  if (value.type === 'Identifier' && objectLiteralVars.has(value.name)) return objectLiteralVars.get(value.name);
  return null;
}

/** Every top-level `process.env.VARNAME = <string literal>` assignment — legitimately
 * GLOBAL (it mutates the shared runtime env object every later unqualified spread
 * reads), unlike an inline object key, which is scoped to the object it appears in. */
function fileTopPinsFor(ast, varName) {
  let found = false;
  walk(ast, (node) => {
    if (node.type === 'AssignmentExpression' && node.operator === '=' &&
      isProcessEnvVar(node.left, varName) && isStringLiteral(node.right)) found = true;
  });
  return found;
}

/**
 * True iff a comment attached near `node` (within `comments`, ending on one of the
 * `WINDOW_LINES` lines immediately before `node`'s start line) suppresses `varName`
 * with a non-empty reason: `// env-hermeticity: inherits VARNAME — <reason>`.
 * @param {object} node
 * @param {{value: string, loc: object}[]} comments
 * @param {string} varName
 * @returns {boolean}
 */
const WINDOW_LINES = 6;
function hasNearbySuppression(node, comments, varName) {
  const nodeLine = node.loc.start.line;
  const re = new RegExp(`env-hermeticity:\\s*inherits\\s+${varName}\\s*(?:—|--|-)\\s*\\S`);
  return comments.some((c) => c.loc.end.line <= nodeLine && nodeLine - c.loc.end.line <= WINDOW_LINES && re.test(c.value));
}

/**
 * Scan one file's source for spawn sites that inherit ambient env while targeting a
 * known ADLC entrypoint, without neutralizing or suppressing every variable that
 * entrypoint reads. Throws (does not report clean) on a parse failure.
 * @param {string} filePath  used only for the reported message
 * @param {string} source
 * @returns {{file: string, variable: string, message: string}[]}
 */
function findViolationsInSource(filePath, source) {
  const comments = [];
  const ast = parse(source, { ...ACORN_OPTIONS, onComment: comments });
  const { entrypointVars, objectLiteralVars } = resolveModuleVariables(ast);
  const violations = [];

  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee.type !== 'Identifier' || !SPAWN_FN_NAMES.has(callee.name)) return;

    // Which entrypoint does this call target? Scan every argument for a direct literal
    // match or a reference to a resolved entrypoint variable (position-independent —
    // matches this codebase's varied call shapes: `[BIN, ...args]`, `[BIN, 'sub', ...]`).
    let required = null;
    for (const arg of node.arguments) {
      const literalPath = resolveCallToPathText(arg);
      if (literalPath) { required = sensitiveVarsForEntrypoint(literalPath); if (required) break; }
      if (arg.type === 'Identifier' && entrypointVars.has(arg.name)) { required = entrypointVars.get(arg.name); break; }
      if (arg.type === 'ArrayExpression') {
        for (const el of arg.elements) {
          if (!el) continue;
          const elPath = resolveCallToPathText(el);
          if (elPath) { required = sensitiveVarsForEntrypoint(elPath); if (required) break; }
          if (el.type === 'Identifier' && entrypointVars.has(el.name)) { required = entrypointVars.get(el.name); break; }
        }
      }
      if (required) break;
    }
    if (!required) return; // spawns something, but not a matched ADLC entrypoint

    const optionsArg = node.arguments.at(-1);
    const envObj = resolveEnvObject(optionsArg, objectLiteralVars);
    if (!envObj || !spreadsProcessEnvDeep(envObj, objectLiteralVars)) return; // no ambient spread reaches this call

    for (const varName of required) {
      const neutralized = hasLiteralNeutralization(envObj, varName, objectLiteralVars) || fileTopPinsFor(ast, varName);
      const suppressed = hasNearbySuppression(node, comments, varName);
      if (!neutralized && !suppressed) {
        violations.push({
          file: filePath,
          variable: varName,
          message: `${filePath}:${node.loc.start.line} spawns an ADLC entrypoint with an ambient env spread but never neutralizes ${varName} ` +
            `(add a literal ${varName}: '' to the env object it actually uses, or pin process.env.${varName} = '<literal>') ` +
            `nor suppresses it (// env-hermeticity: inherits ${varName} — <reason>, within ${WINDOW_LINES} lines above the spawn).`,
        });
      }
    }
  });
  return violations;
}

/** *.test.mjs files directly under `dir` (non-recursive — test dirs are flat here). */
function testFilesIn(dir) {
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
  return files;
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

test('a spawn of bin/adlc-prosecute.mjs with an ambient env spread and no neutralization is flagged for ADLC_MANIFEST_KEY', () => {
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

test('a spawn of rails-guard-ci.mjs with an ambient env spread and no neutralization is flagged for RAILS_BASE and BASE_REF, never ADLC_MANIFEST_KEY', () => {
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
  const violations = findEnvHermeticityViolations(
    candidateFiles(REPO_ROOT).filter((f) => !f.endsWith('env-hermeticity-guard.test.mjs')),
  );
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
    function runBin(args) {
      // env-hermeticity: inherits ADLC_MANIFEST_KEY —
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/empty-reason.test.mjs', fixture);
  assert.equal(violations.length, 1, 'an empty-reason marker must not suppress the finding');
  assert.equal(violations[0].variable, 'ADLC_MANIFEST_KEY');
});

test('a suppression marker WITH a reason, near the spawn, does suppress the finding', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-tickets.mjs', import.meta.url).pathname;
    function runBin(args) {
      // env-hermeticity: inherits ADLC_MANIFEST_KEY — this test deliberately exercises
      // the operator's real shell key against a scratch store, see #123.
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/reasoned.test.mjs', fixture), []);
});

test('a suppression comment FAR from the spawn (beyond the line window) does not suppress it', () => {
  const pad = Array.from({ length: WINDOW_LINES + 2 }, () => '// padding').join('\n');
  const fixture = `
    import { execFileSync } from 'node:child_process';
    // env-hermeticity: inherits ADLC_MANIFEST_KEY — reasoned, but too far away
    const BIN = new URL('../bin/adlc-tickets.mjs', import.meta.url).pathname;
    ${pad}
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/far-suppression.test.mjs', fixture);
  assert.equal(violations.length, 1, 'a suppression must be attached to the actual spawn, not merely present somewhere earlier');
});

// ── AC4.1.4 / robustness: entrypoint-variable indirection and non-matches ─────────

test('a literal inline pin (VARNAME: string literal) satisfies neutralization, matching the "or a literal" rule', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env, ADLC_MANIFEST_KEY: 'test-signing-key' } });
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

test('an entrypoint NOT matching any of the three patterns is never flagged, regardless of an ambient env spread', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = join(ROOT, 'packages', 'gate-manifest', 'bin', 'gate-manifest.mjs');
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/unmatched.test.mjs', fixture), []);
});

test('a spawn WITHOUT an ambient env spread (fully controlled env, or env omitted) is never flagged', () => {
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

test('a per-call scan does not false-positive: an unrelated spawn\'s ambient spread does not taint a DIFFERENT, non-spreading call to a matched entrypoint', () => {
  // Mirrors packages/runner/test/codex-integration.test.mjs: one spawn targets an ADLC
  // entrypoint with NO env key (full ambient inherit, but no literal ambient SPREAD —
  // out of this guard's stated scope); a SEPARATE, unrelated spawn elsewhere in the
  // file does spread ambient env. Per-call analysis must not let the unrelated spread
  // trigger a flag on the entrypoint spawn.
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

test('a call whose own path text merely SHARES a suffix with rails-guard.mjs (an unrelated hook) is never matched', () => {
  const fixture = `
    import { spawnSync } from 'node:child_process';
    const hook = join(repoRoot, 'plugins', 'adlc-codex', 'hooks', 'adlc-rails-guard.mjs');
    function run() {
      return spawnSync(process.execPath, [hook], { env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/unrelated-hook.test.mjs', fixture), []);
});

// ── regression cases: per-call scoping and static-literal-only trust ─────────────

test('one call\'s inline literal key does NOT protect a DIFFERENT call\'s env object in the same file', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runSafe(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env, ADLC_MANIFEST_KEY: 'test-key' } });
    }
    function runUnsafe(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/mixed-safety.test.mjs', fixture);
  assert.equal(violations.length, 1, 'the second, unsafe call must still be flagged despite the first call\'s literal key');
});

test('a dynamic alias of the ambient key (const x = process.env.VARNAME; VARNAME: x) does NOT count as neutralization', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args) {
      const inheritedKey = process.env.ADLC_MANIFEST_KEY;
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env, ADLC_MANIFEST_KEY: inheritedKey } });
    }
  `;
  const violations = findViolationsInSource('fixtures/dynamic-alias.test.mjs', fixture);
  assert.equal(violations.length, 1, 'copying the ambient value into a local variable and re-injecting it is still fully ambient');
  assert.equal(violations[0].variable, 'ADLC_MANIFEST_KEY');
});

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

test('an argument string containing a closing parenthesis does not desync call extraction (real parser, not paren-counting)', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin() {
      return execFileSync(process.execPath, [BIN, 'match', '/[a-z]\\\\)/'], { env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/paren-in-string.test.mjs', fixture);
  assert.equal(violations.length, 1, 'the env spread after the parenthesized-looking argument must still be seen');
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

test('a shared ambient-env template variable (const X = { ...process.env }; env: X) is scoped and scanned like an inline spread', () => {
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

test('a shared ambient-env template that ALSO neutralizes inline (on the template itself) is compliant', () => {
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

// ── fail-closed on the unparseable, not silently clean ────────────────────────────

test('a file that fails to parse THROWS rather than reporting clean', () => {
  assert.throws(() => findViolationsInSource('fixtures/broken.test.mjs', 'this is not { valid js ('));
});
