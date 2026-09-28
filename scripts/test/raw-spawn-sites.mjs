// raw-spawn-sites.mjs — locate raw spawns of a Node process in a test module.
//
// Shared by hook-spawn-timeout-drift.test.mjs (which enforces that plugin test
// directories spawn Node only through their bounded helper) and by the tests
// that pin this detector's own behaviour.

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'acorn';

/**
 * Every plugin test directory that exists under `root`, repo-relative: both
 * plugins/<p>/hooks/test and plugins/<p>/test, since several hosts keep the
 * tests that spawn their hooks in the latter.
 */
export function pluginTestDirectories(root) {
  return readdirSync(join(root, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [`plugins/${entry.name}/hooks/test`, `plugins/${entry.name}/test`])
    .filter((dir) => existsSync(join(root, dir)))
    .sort();
}

/** Child-process spawners that can start a Node process. */
const SPAWN_FNS = new Set(['execFileSync', 'spawnSync', 'execFile', 'spawn', 'fork', 'execSync', 'exec']);

/** `process.execPath`, written as a dotted or computed member access. */
function isProcessExecPath(node) {
  if (!node || node.type !== 'MemberExpression') return false;
  if (node.object?.type !== 'Identifier' || node.object.name !== 'process') return false;
  return node.computed
    ? node.property?.type === 'Literal' && node.property.value === 'execPath'
    : node.property?.type === 'Identifier' && node.property.name === 'execPath';
}

/** `process.argv[0]`, the running Node binary. */
function isProcessArgv0(node) {
  if (!node || node.type !== 'MemberExpression' || !node.computed) return false;
  const argv = node.object;
  const isArgv =
    argv?.type === 'MemberExpression' &&
    !argv.computed &&
    argv.object?.type === 'Identifier' &&
    argv.object.name === 'process' &&
    argv.property?.name === 'argv';
  return isArgv && node.property?.type === 'Literal' && node.property.value === 0;
}

/** A command string naming the `node` binary: `node` alone or `node <args>`. */
const NODE_COMMAND = /^node(?:\s|$)/;

/** The leftmost operand of a `+` chain: `'node ' + a + b` → `'node '`. */
function leftmostOperand(node) {
  let current = node;
  while (current?.type === 'BinaryExpression' && current.operator === '+') current = current.left;
  return current;
}

/**
 * Locate every raw spawn of a Node process, with its 1-based line.
 *
 * Parsed, not pattern-matched: formatting and line wrapping are free. Resolved
 * rather than evaded: named and aliased imports, namespace and default imports,
 * a computed `process['execPath']`, a local binding of the exec path
 * (`const node = process.execPath`), and a local rebinding of the spawner
 * itself (`const f = spawnSync`), including one destructured off a namespace
 * import. The Node binary is recognised as `process.execPath` (or an alias),
 * `process.argv[0]`, or the bare name `node`, including as the head of an
 * execSync/exec command line. A module that does not parse is reported with
 * `reason: 'unparseable'` rather than scanned clean.
 *
 * Known limit, stated rather than implied: bindings are collected across the
 * whole module without scope analysis, so a shadowed name in a nested function
 * is treated as the outer one. That errs toward reporting, which is the safe
 * direction for a guard. Indirection through a property bag or a computed
 * method name would still pass unseen; this is a drift guard against the next
 * accidental raw spawn, not a sandbox against a determined bypass.
 */
export function rawSpawnSites(source) {
  let ast;
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (err) {
    // Fail closed: a module this detector cannot read has not been shown to be
    // free of raw spawns, so it is reported rather than scanned clean.
    return [{ line: err?.loc?.line ?? 1, reason: 'unparseable' }];
  }

  // Local names bound to a child_process spawner, plus namespace/default
  // imports of the module itself: `import * as cp` and `import cp from` both
  // reach the same spawners through a member expression.
  const spawners = new Set();
  const namespaces = new Set();
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    if (!String(node.source.value).endsWith('child_process')) continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier') {
        namespaces.add(spec.local.name);
        continue;
      }
      const imported = spec.imported?.name ?? spec.local?.name;
      if (SPAWN_FNS.has(imported)) spawners.add(spec.local.name);
    }
  }

  // Locals bound to process.execPath (`const node = process.execPath`) and
  // locals rebound to a spawner (`const f = spawnSync`, or one destructured off
  // a namespace import). Both shapes produce a real Node spawn that a check on
  // the callee name or the argument's member expression alone would miss.
  // Repeated to a fixed point so a chain of rebindings resolves.
  const execPathAliases = new Set();
  for (let pass = 0, added = true; added && pass < 5; pass += 1) {
    added = false;
    const collect = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'VariableDeclarator') {
        const { id, init } = node;
        if (id?.type === 'Identifier' && isProcessExecPath(init) && !execPathAliases.has(id.name)) {
          execPathAliases.add(id.name);
          added = true;
        }
        // const f = spawnSync    /    const f = cp.spawnSync
        if (id?.type === 'Identifier' && !spawners.has(id.name)) {
          const fromIdentifier = init?.type === 'Identifier' && spawners.has(init.name);
          const fromNamespace =
            init?.type === 'MemberExpression' &&
            !init.computed &&
            SPAWN_FNS.has(init.property?.name) &&
            (namespaces.has(init.object?.name) || init.object?.name === 'child_process');
          if (fromIdentifier || fromNamespace) {
            spawners.add(id.name);
            added = true;
          }
        }
        // const { spawnSync: f } = cp
        if (id?.type === 'ObjectPattern' && init?.type === 'Identifier' && namespaces.has(init.name)) {
          for (const prop of id.properties) {
            const key = prop.key?.name ?? prop.key?.value;
            const local = prop.value?.name;
            if (SPAWN_FNS.has(key) && local && !spawners.has(local)) {
              spawners.add(local);
              added = true;
            }
          }
        }
      }
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object' && value.type) collect(value);
      }
    };
    collect(ast);
  }

  const isNodeBinary = (arg) =>
    isProcessExecPath(arg) || isProcessArgv0(arg) || (arg?.type === 'Identifier' && execPathAliases.has(arg.name));

  // The binary itself, or a command line (execSync/exec) that starts with it:
  // 'node …', `node …`, `${process.execPath} …`, or 'node ' + … concatenated.
  const isNodeTarget = (arg) => {
    if (isNodeBinary(arg)) return true;
    if (arg?.type === 'Literal') return typeof arg.value === 'string' && NODE_COMMAND.test(arg.value);
    if (arg?.type === 'TemplateLiteral') {
      const head = arg.quasis[0]?.value.cooked ?? '';
      return NODE_COMMAND.test(head) || (head === '' && isNodeBinary(arg.expressions[0]));
    }
    if (arg?.type === 'BinaryExpression') return isNodeTarget(leftmostOperand(arg));
    return false;
  };

  const isSpawnCallee = (callee) => {
    if (callee?.type === 'Identifier') return spawners.has(callee.name) || SPAWN_FNS.has(callee.name);
    if (callee?.type === 'MemberExpression' && !callee.computed) {
      const objectName = callee.object?.name;
      const method = callee.property?.name;
      // `cp.spawnSync(…)`, and the bare `child_process.spawnSync(…)` shape.
      return Boolean(method && SPAWN_FNS.has(method) && (namespaces.has(objectName) || objectName === 'child_process'));
    }
    return false;
  };

  const sites = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && isSpawnCallee(node.callee) && isNodeTarget(node.arguments?.[0])) {
      sites.push({ line: node.loc.start.line });
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object' && value.type) walk(value);
    }
  };
  walk(ast);
  return sites.sort((a, b) => a.line - b.line);
}
