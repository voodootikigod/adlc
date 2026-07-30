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
 *     assignments whose resolved path text matches a known entrypoint pattern. NOT
 *     excluded on a parameter-name collision (see below) — a dropped entry does not
 *     make a call ambiguous, it makes the call INVISIBLE to this guard entirely.
 *   objectLiteralVars: varName -> the ObjectExpression node, for EVERY
 *     `const X = { ... };` object-literal assignment — used to resolve both a bare
 *     `env: X` reference AND a `...X` spread nested inside a LARGER env object (the
 *     `env: { ...process.env, ...HERMETIC_ENV, BASE_REF: 'main' }` shape). Excluded on
 *     a parameter-name collision — see `collectParameterNames`.
 *   processEnvAliasVars: every name bound directly to `process.env` itself (e.g.
 *     `const inherited = process.env;`) — NOT an object literal, so it is invisible to
 *     `objectLiteralVars`, but spreading it is exactly as unsafe as `...process.env`.
 * @param {object} ast
 * @returns {{entrypointVars: Map<string,string[]>, objectLiteralVars: Map<string,object>, processEnvAliasVars: Set<string>}}
 */
function resolveModuleVariables(ast) {
  const entrypointVars = new Map();
  const objectLiteralVars = new Map();
  const processEnvAliasVars = new Set();
  const paramNames = collectParameterNames(ast);
  walk(ast, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) return;
    const name = node.id.name;
    if (node.init.type === 'ObjectExpression') {
      // Excluding on a parameter-name collision is safe for OBJECT-LITERAL resolution
      // specifically: resolveEnvArgument treats a missing entry as AMBIGUOUS (flagged),
      // never as silently clean, so dropping it can only ever be over-cautious.
      if (!paramNames.has(name)) objectLiteralVars.set(name, node.init);
    }
    if (isProcessEnv(node.init) && !paramNames.has(name)) processEnvAliasVars.add(name);
    const pathText = resolveCallToPathText(node.init);
    if (pathText) {
      const sensitive = sensitiveVarsForEntrypoint(pathText);
      // An entrypoint match is kept even if `name` collides with an unrelated
      // parameter elsewhere in the file: dropping it (as object-literal resolution
      // does) would make this spawn call INVISIBLE to the guard — a real ADLC
      // entrypoint (e.g. `const BIN = new URL('.../adlc-prosecute.mjs', ...)`) hidden
      // by an unrelated function accepting a same-named parameter, with no
      // "ambiguous" fallback to catch it. A false collision only risks flagging a call
      // that a human can confirm or annotate — never a missed real leak.
      if (sensitive) entrypointVars.set(name, sensitive);
    }
  });
  return { entrypointVars, objectLiteralVars, processEnvAliasVars };
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
 * True iff `objExpr` spreads ambient env — directly (`...process.env`), through a
 * `...NAME` alias of `process.env` itself, or through a `...NAME` spread where NAME
 * resolves (via `objectLiteralVars`) to an object that itself spreads ambient env,
 * recursively (the `{ ...process.env, ...HERMETIC_ENV }` template-of-a-template
 * shape). Cycle-guarded.
 * @param {object} objExpr
 * @param {Map<string,object>} objectLiteralVars
 * @param {Set<string>} processEnvAliasVars
 * @param {Set<object>} [seen]
 * @returns {boolean}
 */
function spreadsProcessEnvDeep(objExpr, objectLiteralVars, processEnvAliasVars, seen = new Set()) {
  if (seen.has(objExpr)) return false;
  seen.add(objExpr);
  return objExpr.properties.some((p) => {
    if (p.type !== 'SpreadElement') return false;
    if (isProcessEnv(p.argument)) return true;
    if (p.argument.type === 'Identifier' && processEnvAliasVars.has(p.argument.name)) return true;
    if (p.argument.type === 'Identifier' && objectLiteralVars.has(p.argument.name)) {
      return spreadsProcessEnvDeep(objectLiteralVars.get(p.argument.name), objectLiteralVars, processEnvAliasVars, seen);
    }
    return false;
  });
}

/**
 * True iff spreading `objExpr` (a STATICALLY KNOWN object literal, reached only through
 * `objectLiteralVars` resolution) might reintroduce `varName` — a non-literal (or not
 * provably neutralized) property for `varName`, or a nested spread of ambient env, a
 * process.env alias, another resolved object that may reintroduce it, or anything this
 * scanner cannot resolve at all. An object literal that provably never touches
 * `varName` and never spreads anything unresolved (e.g. `{ SOME_OTHER_VAR: 'x' }`)
 * returns false: it cannot undo a pin for a key it never mentions. Cycle-guarded.
 * @param {object} objExpr
 * @param {string} varName
 * @param {Map<string,object>} objectLiteralVars
 * @param {Set<string>} processEnvAliasVars
 * @param {Set<object>} seen
 * @returns {boolean}
 */
function mayReintroduce(objExpr, varName, objectLiteralVars, processEnvAliasVars, seen) {
  if (seen.has(objExpr)) return false;
  seen.add(objExpr);
  for (const p of objExpr.properties) {
    if (p.type === 'SpreadElement') {
      if (isProcessEnv(p.argument)) return true;
      if (p.argument.type === 'Identifier' && processEnvAliasVars.has(p.argument.name)) return true;
      if (p.argument.type === 'Identifier' && objectLiteralVars.has(p.argument.name)) {
        if (mayReintroduce(objectLiteralVars.get(p.argument.name), varName, objectLiteralVars, processEnvAliasVars, seen)) return true;
        continue;
      }
      return true; // an unresolvable nested spread cannot be proven to exclude varName
    }
    if (p.type !== 'Property' && p.type !== 'ObjectProperty') continue;
    const key = p.key;
    const keyName = key?.type === 'Identifier' ? key.name : (isStringLiteral(key) ? key.value : null);
    if (keyName === varName && !isStringLiteral(p.value)) return true; // a dynamic value for this key
  }
  return false;
}

/**
 * True iff `objExpr` contains a `VARNAME: <string literal>` property that DOMINATES —
 * i.e. no LATER property in the SAME object (source order, since object-literal
 * evaluation is order-sensitive: a later spread can silently override an earlier
 * literal) reintroduces the ambient value for `varName`. A spread is checked
 * recursively via `objectLiteralVars`; a resolved object literal is trusted to
 * preserve neutralization when IT ITSELF proves a literal pin for `varName`, and
 * otherwise only when it provably CANNOT reintroduce `varName` (`mayReintroduce`) — a
 * resolved object that merely has unrelated keys does not undo a pin for a different
 * one. A direct `...process.env` spread, or a spread of an identifier this scanner has
 * proven aliases `process.env` itself (e.g. `const inherited = process.env`), always
 * overrides: both are definitively unsafe, not merely unresolved. An otherwise
 * UNRESOLVABLE spread (a bare function parameter, a call expression, etc. — this
 * scanner cannot determine its shape at all) is left alone rather than assumed unsafe:
 * the common, deliberate "safe defaults the caller may override" shape (`{ ...process.env,
 * VAR: '', ...callerOverrides }`) is not itself an ambient leak, and flagging it would
 * make already-compliant code fail for no discoverable reason. INCLUDING an empty
 * string for the literal itself, but NOT `VARNAME: process.env.VARNAME` (a no-op
 * re-injection) and NOT any other dynamic expression: only a provable literal is
 * trusted, and only when nothing after it in the SAME object undoes it.
 * @param {object} objExpr
 * @param {string} varName
 * @param {Map<string,object>} objectLiteralVars
 * @param {Set<string>} processEnvAliasVars
 * @param {Set<object>} [seen]
 * @returns {boolean}
 */
function hasLiteralNeutralization(objExpr, varName, objectLiteralVars, processEnvAliasVars, seen = new Set()) {
  if (seen.has(objExpr)) return false;
  seen.add(objExpr);
  let neutralized = false;
  for (const p of objExpr.properties) {
    if (p.type === 'SpreadElement') {
      if (isProcessEnv(p.argument) || (p.argument.type === 'Identifier' && processEnvAliasVars.has(p.argument.name))) {
        neutralized = false; // definitively ambient — always overrides whatever came before
        continue;
      }
      if (p.argument.type === 'Identifier' && objectLiteralVars.has(p.argument.name)) {
        const resolved = objectLiteralVars.get(p.argument.name);
        if (hasLiteralNeutralization(resolved, varName, objectLiteralVars, processEnvAliasVars, seen)) { neutralized = true; continue; }
        if (mayReintroduce(resolved, varName, objectLiteralVars, processEnvAliasVars, new Set())) neutralized = false;
        continue;
      }
      // Unresolvable (a bare function parameter, a call expression, etc.) — cannot be
      // proven either way, so it is left alone: preserve whatever neutralization state
      // came before it rather than assume this spread undoes it.
      continue;
    }
    if (p.type !== 'Property' && p.type !== 'ObjectProperty') continue;
    const key = p.key;
    const keyName = key?.type === 'Identifier' ? key.name : (isStringLiteral(key) ? key.value : null);
    if (keyName !== varName) continue;
    neutralized = isStringLiteral(p.value); // a later property with the same key always wins outright
  }
  return neutralized;
}

/**
 * Resolve a spawn call's effective `env` argument into one of three OUTCOMES,
 * distinguished on purpose (collapsing them was the round-3 review's core finding):
 *   - {present: false}                — no `env` property at all: OUT OF SCOPE, matching
 *     the ticket's literal wording ("with `...process.env` in its env argument") and the
 *     codex-integration.test.mjs precedent (a fully-omitted env is full ambient inherit,
 *     but not a literal SPREAD).
 *   - {present: true, object: <node>} — the property resolves (directly, or through ONE
 *     level of `objectLiteralVars` indirection) to an actual object literal: proceed with
 *     the normal spread/neutralization analysis.
 *   - {present: true, object: null}   — the property EXISTS but is an expression this
 *     detector cannot statically resolve (a bare function PARAMETER being the common real
 *     case — e.g. `function runBin(args, cwd, env) { execFileSync(..., { cwd, env }); }`,
 *     where `env` is data flowing in from each CALLER's own `cleanEnv(overrides)` call,
 *     invisible from here without interprocedural analysis). AMBIGUOUS, not clean: this
 *     detector cannot verify hermeticity, so it must not report it as verified.
 * @param {object} optionsArg  the spawn call's options ObjectExpression argument
 * @param {Map<string,object>} objectLiteralVars
 * @returns {{present: boolean, object?: object|null}}
 */
function resolveEnvArgument(optionsArg, objectLiteralVars) {
  if (!optionsArg || optionsArg.type !== 'ObjectExpression') return { present: false };
  const envProp = optionsArg.properties.find(
    (p) => (p.type === 'Property' || p.type === 'ObjectProperty') &&
      (p.key?.name === 'env' || p.key?.value === 'env'),
  );
  if (!envProp) return { present: false };
  const value = envProp.value;
  if (value.type === 'ObjectExpression') return { present: true, object: value };
  if (value.type === 'Identifier' && objectLiteralVars.has(value.name)) {
    return { present: true, object: objectLiteralVars.get(value.name) };
  }
  return { present: true, object: null };
}

/**
 * A `process.env.VARNAME = <string literal>` assignment is legitimately GLOBAL (it
 * mutates the shared runtime env object every later unqualified spread reads), unlike
 * an inline object key, which is scoped to the object it appears in — BUT only when it
 * is a Program-level (module top) statement: one nested inside a function body may
 * never execute (the function is never called, or only conditionally), so it must not
 * be trusted as an unconditional pin. Scans only `ast.body` directly, not the full
 * recursive walk, to enforce that restriction.
 * @param {object} ast
 * @param {string} varName
 * @returns {boolean}
 */
function fileTopPinsFor(ast, varName) {
  return ast.body.some((stmt) =>
    stmt.type === 'ExpressionStatement' && stmt.expression.type === 'AssignmentExpression' &&
    stmt.expression.operator === '=' &&
    isProcessEnvVar(stmt.expression.left, varName) && isStringLiteral(stmt.expression.right));
}

/**
 * Merge consecutive `//` line comments with no gap (each starting the line right after
 * the previous one ends) into single logical blocks — acorn reports every `//` line as
 * its OWN separate comment, so a human-readable multi-line explanation has its marker
 * text on the FIRST line but its proximity-to-code measured from the LAST: without
 * merging, a 5-line suppression comment's marker would read as 5 lines further from
 * the spawn than it visually is.
 * @param {{value: string, loc: object}[]} comments
 * @returns {{value: string, loc: object}[]}
 */
function mergeAdjacentLineComments(comments) {
  const sorted = [...comments].sort((a, b) => a.loc.start.line - b.loc.start.line);
  const merged = [];
  for (const c of sorted) {
    const prev = merged.at(-1);
    if (prev && c.loc.start.line === prev.loc.end.line + 1) {
      prev.value += `\n${c.value}`;
      prev.loc = { start: prev.loc.start, end: c.loc.end };
    } else {
      merged.push({ value: c.value, loc: { start: c.loc.start, end: c.loc.end } });
    }
  }
  return merged;
}

/**
 * True iff a comment BLOCK attached near `node` (within `comments`, ending on one of
 * the `WINDOW_LINES` lines immediately before `node`'s start line) suppresses
 * `varName` with a non-empty reason: `// env-hermeticity: inherits VARNAME — <reason>`
 * — the marker may appear on any line of a merged multi-line block, not only its last.
 * @param {object} node
 * @param {{value: string, loc: object}[]} comments
 * @param {string} varName
 * @returns {boolean}
 */
const WINDOW_LINES = 6;
function hasNearbySuppression(node, comments, varName) {
  const nodeLine = node.loc.start.line;
  const re = new RegExp(`env-hermeticity:\\s*inherits\\s+${varName}\\s*(?:—|--|-)\\s*\\S`);
  return mergeAdjacentLineComments(comments)
    .some((c) => c.loc.end.line <= nodeLine && nodeLine - c.loc.end.line <= WINDOW_LINES && re.test(c.value));
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
  const { entrypointVars, objectLiteralVars, processEnvAliasVars } = resolveModuleVariables(ast);
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
    const envArg = resolveEnvArgument(optionsArg, objectLiteralVars);
    if (!envArg.present) return; // no `env` property at all — out of scope (matches the ticket's literal wording)

    // env EXISTS but could not be resolved to an object literal (the common real case:
    // a bare function parameter fed by each caller's own, invisible-from-here
    // construction) — AMBIGUOUS. Flag every required var: "cannot verify" must not
    // render as "verified".
    if (!envArg.object) {
      for (const varName of required) {
        if (hasNearbySuppression(node, comments, varName) || fileTopPinsFor(ast, varName)) continue;
        violations.push({
          file: filePath,
          variable: varName,
          message: `${filePath}:${node.loc.start.line} spawns an ADLC entrypoint via an env argument this scanner cannot statically ` +
            `resolve to an object literal (likely a function parameter constructed by each caller) — cannot verify ${varName} is ` +
            `neutralized. Restructure so the env object is a literal at this call site, pin process.env.${varName} = '<literal>' at ` +
            `module top, or suppress it (// env-hermeticity: inherits ${varName} — <reason>, within ${WINDOW_LINES} lines above the spawn).`,
        });
      }
      return;
    }

    if (!spreadsProcessEnvDeep(envArg.object, objectLiteralVars, processEnvAliasVars)) return; // no ambient spread reaches this call

    for (const varName of required) {
      const neutralized = hasLiteralNeutralization(envArg.object, varName, objectLiteralVars, processEnvAliasVars) || fileTopPinsFor(ast, varName);
      const suppressed = hasNearbySuppression(node, comments, varName);
      if (!neutralized && !suppressed) {
        violations.push({
          file: filePath,
          variable: varName,
          message: `${filePath}:${node.loc.start.line} spawns an ADLC entrypoint with an ambient env spread but never neutralizes ${varName} ` +
            `(add a literal ${varName}: '' to the env object it actually uses, ordered AFTER any ambient spread, or pin ` +
            `process.env.${varName} = '<literal>' at module top) ` +
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

// ── an env argument this scanner cannot resolve is AMBIGUOUS, not clean ───────────

test('a bare env PARAMETER (not resolvable to any object literal) at a matched entrypoint is flagged — cannot verify is not verified', () => {
  // Mirrors packages/prosecute/test/prosecute-env-local-cli.test.mjs's runBin(args,
  // cwd, env): `env` is data flowing in from each CALLER's own construction, invisible
  // to a scanner with no interprocedural analysis. A same-named, UNRELATED object
  // literal declared elsewhere in the file (cleanEnv's own local `env`) must not be
  // mistaken for this parameter's value either — see the next test.
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args, cwd, env) {
      return execFileSync(process.execPath, [BIN, ...args], { cwd, env });
    }
  `;
  const violations = findViolationsInSource('fixtures/unresolvable-param.test.mjs', fixture);
  assert.equal(violations.length, 1, 'an unresolvable env must be flagged as ambiguous, not silently passed');
  assert.equal(violations[0].variable, 'ADLC_MANIFEST_KEY');
  assert.match(violations[0].message, /cannot statically resolve/);
});

test('a same-named but UNRELATED object literal elsewhere in the file does not fool the unresolvable-param check (the real scope-confusion bug)', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function cleanEnv(overrides = {}) {
      const env = { ...process.env };
      delete env.ADLC_MANIFEST_KEY;
      return { ...env, ...overrides };
    }
    function runBin(args, cwd, env) {
      return execFileSync(process.execPath, [BIN, ...args], { cwd, env });
    }
  `;
  const violations = findViolationsInSource('fixtures/scope-confusion.test.mjs', fixture);
  assert.equal(violations.length, 1, "cleanEnv's local env must not be treated as the SAME binding as runBin's parameter");
});

test('a suppression on the unresolvable-env case documents verification by inspection', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    // env-hermeticity: inherits ADLC_MANIFEST_KEY — every caller passes cleanEnv(...),
    // verified hermetic by inspection, not by this scanner.
    function runBin(args, cwd, env) {
      return execFileSync(process.execPath, [BIN, ...args], { cwd, env });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/suppressed-unresolvable.test.mjs', fixture), []);
});

test('a spawn whose env key is OMITTED ENTIRELY remains out of scope, distinct from an unresolvable env value', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args, cwd) {
      return execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/omitted-env.test.mjs', fixture), []);
});

// ── order sensitivity: a later spread can silently undo an earlier literal ────────

test('a literal placed BEFORE the ambient spread is overridden by it and does NOT count as neutralization', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ADLC_MANIFEST_KEY: '', ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/reversed-order.test.mjs', fixture);
  assert.equal(violations.length, 1, 'a later ...process.env spread overrides an earlier literal — order matters');
});

test('a literal placed AFTER the ambient spread correctly overrides it (the normal, safe order)', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env, ADLC_MANIFEST_KEY: '' } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/correct-order.test.mjs', fixture), []);
});

test('a nested template spread (...HERMETIC_ENV) followed by a raw ...process.env re-spread is NOT neutralized (order-sensitive across levels too)', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    const HERMETIC_ENV = { ADLC_MANIFEST_KEY: '' };
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...HERMETIC_ENV, ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/template-then-reraw.test.mjs', fixture);
  assert.equal(violations.length, 1, 'a raw ambient re-spread after a safe template still wins — order is checked across levels');
});

// ── module-top-only pins: a pin buried inside a function body is not trusted ──────

test('a process.env.VARNAME = literal pin INSIDE a function body (not Program-level) does not count — it may never execute', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function maybeNeverCalled() {
      process.env.ADLC_MANIFEST_KEY = 'test-key';
    }
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/buried-pin.test.mjs', fixture);
  assert.equal(violations.length, 1, 'a pin inside a function that might never run must not be trusted as unconditional');
});

test('a process.env.VARNAME = literal pin at Program (module) top level is trusted, as before', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    process.env.ADLC_MANIFEST_KEY = 'test-key';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/module-top-pin.test.mjs', fixture), []);
});

// ── round-4 review: an unresolved spread must fail closed, and entrypoint matches ──
// ── must not be discarded on an unrelated parameter-name collision ────────────────

test('a later spread of an identifier ALIASING process.env (not an object literal) still overrides an earlier literal', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    const inherited = process.env;
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env, ADLC_MANIFEST_KEY: '', ...inherited } });
    }
  `;
  const violations = findViolationsInSource('fixtures/aliased-process-env-respread.test.mjs', fixture);
  assert.equal(violations.length, 1, 'a spread of an unresolvable alias of process.env must not be silently trusted as a no-op');
});

test('a later spread of a resolved object literal that never mentions the pinned variable does NOT override it', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    const EXTRA = { SOME_OTHER_VAR: 'x' };
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env, ADLC_MANIFEST_KEY: '', ...EXTRA } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/unrelated-template-respread.test.mjs', fixture), [],
    'a resolved object literal with no bearing on the pinned key cannot undo its pin');
});

test('a later spread of a resolved object literal that DOES dynamically set the pinned variable overrides it', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    const OVERRIDES = { ADLC_MANIFEST_KEY: process.env.SOME_OTHER_SOURCE };
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env, ADLC_MANIFEST_KEY: '', ...OVERRIDES } });
    }
  `;
  const violations = findViolationsInSource('fixtures/dynamic-template-respread.test.mjs', fixture);
  assert.equal(violations.length, 1, 'a resolved object literal that itself sets the pinned key to a non-literal value can reintroduce the ambient value');
});

test('a later spread of an UNRESOLVABLE identifier (e.g. a caller-supplied override parameter) does not undo an earlier literal pin — the common safe-defaults-plus-override shape', () => {
  const fixture = `
    import { spawnSync } from 'node:child_process';
    const BIN = join(ROOT, 'packages', 'rails-guard', 'bin', 'rails-guard-ci.mjs');
    function run(args, { env = {} } = {}) {
      return spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, RAILS_BASE: '', BASE_REF: '', ...env } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/safe-defaults-plus-override.test.mjs', fixture), [],
    'a caller-supplied override merged after a literal pin is not itself an ambient leak — this scanner cannot resolve it, so it is left alone rather than assumed unsafe');
});

test('an unrelated function parameter sharing a name with a real entrypoint variable does not hide that entrypoint from the guard', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function unrelatedHelper(BIN) {
      return BIN.toUpperCase();
    }
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/entrypoint-name-collision.test.mjs', fixture);
  assert.equal(violations.length, 1, 'a real entrypoint match must not be dropped because an unrelated parameter elsewhere reuses its name');
  assert.equal(violations[0].variable, 'ADLC_MANIFEST_KEY');
});
