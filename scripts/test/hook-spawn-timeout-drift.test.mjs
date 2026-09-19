// hook-spawn-timeout-drift.test.mjs — every child Node process a hook test
// spawns must carry a timeout (#1042).
//
// WHAT THIS IS, STATED HONESTLY. This is DEFENCE IN DEPTH, not a fix for an
// observed hang. The test call sites were investigated and CLEARED: every one
// either passes `input:`, which makes Node write the payload and close the pipe
// deterministically, or uses pipe/ignore stdio — none inherits stdin, and the
// hung leaves seen in the wild were parked on a UNIX SOCKET, which these call
// sites never hand a child. The hook's own unbounded `git`/`adlc` spawns were
// bounded in #1044/#1045; what remains of the diagnosis is tracked in #1048. A
// timeout here is enforced by the PARENT process, and the orphans observed in
// the wild had no live parent, so this guard would not have prevented them.
//
// It earns its place anyway: `spawnSync` with no `timeout` waits forever on a
// child that never exits, and a test directory whose whole subject is spawning
// hooks is exactly where the next unbounded spawn gets written. The bound is
// cheap; discovering it the other way cost days of wall clock.
//
// Enforced STRUCTURALLY: raw `execFileSync/spawnSync(process.execPath, …)` is
// banned outright inside these directories and must go through the shared
// bounded helper, so there is no per-call-site property for a new test to
// forget. A reformat cannot red this; a new raw spawn can.
//
// COVERAGE IS 68 OF 69 SITES, not all of them. copilot-io-contract.test.mjs
// keeps one raw spawn because it is a frozen rail of another open ticket — see
// RAILED_EXCEPTIONS below, which pins that exemption to a count so the one
// known spawn cannot mask a second. Until that ticket lands, a hung child in
// that single file can still stall a run; the exemption is recorded rather than
// implied so nobody reads this guard as a stronger promise than it is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');

/**
 * Hook test directories. Each must own exactly one bounded spawn helper.
 *
 * Every directory matching plugins/*\/hooks/test belongs here. A guard that
 * scans a subset reports green for directories it never looked at, which is the
 * failure mode this file exists to prevent — so the list is asserted against
 * the filesystem below rather than trusted.
 */
const HOOK_TEST_DIRS = [
  'plugins/adlc-claude-code/hooks/test',
  'plugins/adlc-codex/hooks/test',
  'plugins/adlc-copilot/hooks/test',
];

/** The single file per directory allowed to spawn a raw child process. */
const HELPER_RELATIVE = 'helpers/run-hook.mjs';

/**
 * Files inside a scanned directory that keep a raw spawn because converting
 * them is not this lane's to do, mapped to the ticket that blocks it.
 *
 * copilot-io-contract.test.mjs is a frozen rail of ACTIVE ticket
 * T-01M1P61RGPBWHCPRZX1RE9PPPB ("adlc-copilot: stop denying every pathless
 * non-mutating tool call under active rails"). Editing a rail another open
 * ticket froze is not ours; when that ticket lands, route the spawn through the
 * helper and DELETE this entry — the test below fails if the entry outlives the
 * raw spawn that justifies it, so it cannot quietly become a general escape
 * hatch. An exception inside a scanned directory is honest; leaving the whole
 * directory unscanned would not be.
 */
const RAILED_EXCEPTIONS = new Map([
  [
    'plugins/adlc-copilot/hooks/test/copilot-io-contract.test.mjs',
    { ticket: 'T-01M1P61RGPBWHCPRZX1RE9PPPB', rawSpawns: 1 },
  ],
]);

/** Every `.mjs` under dir, recursively, repo-relative. */
function mjsFilesUnder(dir) {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.mjs')) out.push(relative(ROOT, p));
    }
  };
  walk(absolute);
  return out;
}

/** Child-process spawners that can start a Node process. */
const SPAWN_FNS = new Set(['execFileSync', 'spawnSync', 'execFile', 'spawn', 'fork']);

/** `process.execPath`, written as a dotted or computed member access. */
function isProcessExecPath(node) {
  if (!node || node.type !== 'MemberExpression') return false;
  if (node.object?.type !== 'Identifier' || node.object.name !== 'process') return false;
  return node.computed
    ? node.property?.type === 'Literal' && node.property.value === 'execPath'
    : node.property?.type === 'Identifier' && node.property.name === 'execPath';
}

/**
 * Locate every raw spawn of a Node process, with its 1-based line.
 *
 * Parsed, not pattern-matched: formatting and line wrapping are free. Resolved
 * rather than evaded: named and aliased imports, namespace and default imports,
 * a computed `process['execPath']`, a local binding of the exec path
 * (`const node = process.execPath`), and a local rebinding of the spawner
 * itself (`const f = spawnSync`), including one destructured off a namespace
 * import.
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
  } catch {
    // An unparseable test file is a different failure, surfaced by the suite
    // that runs it; this guard reports nothing rather than guessing.
    return [];
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

  const isNodeTarget = (arg) =>
    isProcessExecPath(arg) || (arg?.type === 'Identifier' && execPathAliases.has(arg.name));

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

/**
 * Report directories missing their bounded helper. Injectable so the
 * missing-helper case can be proven rather than assumed: an earlier version
 * skipped absent helpers, which passed vacuously on exactly the directory that
 * needed reporting.
 */
export function directoriesMissingHelper(dirs, { exists = existsSync, root = ROOT } = {}) {
  return dirs.filter((dir) => !exists(join(root, dir, HELPER_RELATIVE)));
}

test('the scanned directory list covers every plugin hook test directory', () => {
  // Against the filesystem, so adding a plugin cannot leave a directory
  // silently unscanned.
  const onDisk = readdirSync(join(ROOT, 'plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `plugins/${e.name}/hooks/test`)
    .filter((dir) => existsSync(join(ROOT, dir)))
    .sort();
  assert.deepEqual(
    [...HOOK_TEST_DIRS].sort(),
    onDisk,
    'HOOK_TEST_DIRS must list every plugins/*/hooks/test directory that exists',
  );
});

test('every hook test directory has a bounded spawn helper', () => {
  assert.deepEqual(
    directoriesMissingHelper(HOOK_TEST_DIRS),
    [],
    `each hook test directory owns one ${HELPER_RELATIVE}`,
  );
});

test('a directory without a helper is reported, not skipped', () => {
  // The planted absence an earlier version let through: with the helper
  // missing, the check must name the directory rather than pass quietly.
  assert.deepEqual(
    directoriesMissingHelper(['plugins/adlc-nonexistent/hooks/test'], { exists: () => false }),
    ['plugins/adlc-nonexistent/hooks/test'],
  );
  assert.deepEqual(directoriesMissingHelper(['any/dir'], { exists: () => true }), []);
});

test('the shared helper bounds every spawn it makes', async () => {
  for (const dir of HOOK_TEST_DIRS) {
    const helperPath = join(ROOT, dir, HELPER_RELATIVE);
    assert.ok(existsSync(helperPath), `${dir}/${HELPER_RELATIVE} is missing`);
    const sites = rawSpawnSites(readFileSync(helperPath, 'utf8'));
    assert.ok(sites.length > 0, `${dir}/${HELPER_RELATIVE} spawns nothing — it is not the helper`);

    // Behavioural, not textual: ask the helper itself what options it would
    // pass. A text scan cannot tell `timeout: undefined` from a real bound.
    const { resolveSpawnOptions, HOOK_TIMEOUT_MS } = await import(helperPath);
    assert.ok(
      Number.isFinite(HOOK_TIMEOUT_MS) && HOOK_TIMEOUT_MS > 0,
      `${dir}: default timeout must be a finite positive number, got ${HOOK_TIMEOUT_MS}`,
    );
    assert.equal(resolveSpawnOptions({}).timeout, HOOK_TIMEOUT_MS, `${dir}: default must be bounded`);
  }
});

test('a call site cannot unset or weaken the bound', async () => {
  for (const dir of HOOK_TEST_DIRS) {
    const { resolveSpawnOptions, HOOK_TIMEOUT_MS } = await import(join(ROOT, dir, HELPER_RELATIVE));

    // The two properties that make the bound enforceable are not the caller's
    // to remove: `timeout: undefined` and `timeout: 0` both mean "no timeout"
    // to Node, and a softer kill signal would not reap a wedged child.
    assert.equal(resolveSpawnOptions({ timeout: undefined }).timeout, HOOK_TIMEOUT_MS, `${dir}: undefined`);
    assert.equal(resolveSpawnOptions({ timeout: 0 }).timeout, HOOK_TIMEOUT_MS, `${dir}: zero`);
    assert.equal(resolveSpawnOptions({ timeout: -1 }).timeout, HOOK_TIMEOUT_MS, `${dir}: negative`);
    assert.equal(resolveSpawnOptions({ timeout: Infinity }).timeout, HOOK_TIMEOUT_MS, `${dir}: Infinity`);
    assert.equal(resolveSpawnOptions({ killSignal: 'SIGTERM' }).killSignal, 'SIGKILL', `${dir}: killSignal`);

    // A deliberate, usable override still wins, or tests could not ask for a
    // shorter deadline than the generous default.
    assert.equal(resolveSpawnOptions({ timeout: 500 }).timeout, 500, `${dir}: explicit override`);
    // Unrelated options pass through untouched.
    assert.equal(resolveSpawnOptions({ input: 'x' }).input, 'x', `${dir}: passthrough`);
  }
});

test('each wrapper actually reaps a child that never exits', async () => {
  // resolveSpawnOptions returning a timeout proves nothing on its own: a future
  // edit could keep the resolver and have a wrapper pass raw options straight
  // through, leaving every other test in this file green. So drive the exported
  // wrappers against a child that would otherwise run forever.
  const NEVER_EXITS = ['-e', 'setInterval(() => {}, 1000)'];
  for (const dir of HOOK_TEST_DIRS) {
    const { runHook, spawnHook } = await import(join(ROOT, dir, HELPER_RELATIVE));

    const started = Date.now();
    const result = spawnHook(NEVER_EXITS, { timeout: 800 });
    const elapsed = Date.now() - started;
    // `signal` and `timedOut` stay readable; stdout/status do not (below).
    assert.ok(
      result.error?.code === 'ETIMEDOUT' || result.signal,
      `${dir}: spawnHook must reap a non-terminating child; signal=${result.signal}`,
    );
    assert.ok(elapsed < 20_000, `${dir}: reaped in ${elapsed}ms`);

    // execFileSync semantics: the deadline must reach the caller as a throw
    // rather than blocking the run.
    assert.throws(
      () => runHook(NEVER_EXITS, { timeout: 800 }),
      (err) => err?.code === 'ETIMEDOUT' || err?.signal === 'SIGKILL' || err?.signal === 'SIGTERM',
      `${dir}: runHook must surface the deadline as an error`,
    );
  }
});

test('a killed run cannot be read as the hook answering', async () => {
  // The failure mode a deadline introduces: 50 catch blocks in these suites do
  // `catch (e) { out = e.stdout ?? ''; }`, and for an advisory hook empty output
  // is a PASS. A timeout must not be able to impersonate deliberate silence.
  for (const dir of HOOK_TEST_DIRS) {
    const { runHook, spawnHook } = await import(join(ROOT, dir, HELPER_RELATIVE));

    const killed = spawnHook(['-e', 'setInterval(() => {}, 1000)'], { timeout: 600 });
    assert.equal(killed.timedOut, true, `${dir}: a killed run is flagged`);
    assert.throws(() => killed.stdout, /not a result/, `${dir}: stdout of a killed run must not read as output`);
    assert.throws(() => killed.status, /not a result/, `${dir}: status of a killed run must not read as an exit`);

    let swallowed = null;
    try {
      runHook(['-e', 'setInterval(() => {}, 1000)'], { timeout: 600 });
    } catch (err) {
      // Exactly the shape the existing call sites use.
      assert.throws(() => err.stdout ?? '', /not a result/, `${dir}: the swallow path must fail loudly`);
      swallowed = err;
    }
    assert.ok(swallowed, `${dir}: runHook must throw on a deadline`);

    // A REAL nonzero exit is untouched: those catch blocks exist for this case
    // and must keep working. The child sets `exitCode` and returns rather than
    // calling process.exit(), which can truncate a pending pipe write and would
    // make this assertion depend on flush timing instead of on the behaviour
    // under test.
    try {
      runHook(['-e', "process.exitCode = 3; process.stdout.write('real output');"], { timeout: 10_000 });
      assert.fail(`${dir}: expected a nonzero exit to throw`);
    } catch (err) {
      assert.equal(err.status, 3, `${dir}: a real exit code stays readable`);
      assert.match(String(err.stdout), /real output/, `${dir}: real stdout stays readable`);
    }
  }
});

test('the detector resolves namespace imports and execPath aliases', () => {
  const namespaced = ["import * as cp from 'node:child_process';", 'cp.spawnSync(process.execPath, [HOOK], {});'].join('\n');
  assert.deepEqual(rawSpawnSites(namespaced), [{ line: 2 }], 'a namespace import must not evade the guard');

  const defaulted = ["import cp from 'node:child_process';", 'cp.execFileSync(process.execPath, [HOOK], {});'].join('\n');
  assert.deepEqual(rawSpawnSites(defaulted), [{ line: 2 }], 'a default import must not evade the guard');

  const aliasedPath = [
    "import { spawnSync } from 'node:child_process';",
    'const nodeBin = process.execPath;',
    'spawnSync(nodeBin, [HOOK], {});',
  ].join('\n');
  assert.deepEqual(rawSpawnSites(aliasedPath), [{ line: 3 }], 'a local execPath binding must not evade the guard');

  const rebound = [
    "import { spawnSync } from 'node:child_process';",
    'const f = spawnSync;',
    'f(process.execPath, [HOOK], {});',
  ].join('\n');
  assert.deepEqual(rawSpawnSites(rebound), [{ line: 3 }], 'a local spawner rebinding must not evade the guard');

  const destructured = [
    "import * as cp from 'node:child_process';",
    'const { spawnSync: s } = cp;',
    's(process.execPath, [HOOK], {});',
  ].join('\n');
  assert.deepEqual(rawSpawnSites(destructured), [{ line: 3 }], 'a destructured spawner must not evade the guard');

  const chained = [
    "import { execFileSync } from 'node:child_process';",
    'const a = execFileSync;',
    'const b = a;',
    'const bin = process.execPath;',
    'b(bin, [HOOK], {});',
  ].join('\n');
  assert.deepEqual(rawSpawnSites(chained), [{ line: 5 }], 'a chain of rebindings must resolve');
});

test('the detector resolves import aliases and computed access', () => {
  const aliased = [
    "import { spawnSync as sp } from 'node:child_process';",
    "sp(process.execPath, [HOOK], {});",
  ].join('\n');
  assert.deepEqual(rawSpawnSites(aliased), [{ line: 2 }], 'an aliased import must not evade the guard');

  const computed = "import { spawnSync } from 'node:child_process';\nspawnSync(process['execPath'], [HOOK], {});";
  assert.deepEqual(rawSpawnSites(computed), [{ line: 2 }], "process['execPath'] must not evade the guard");

  // A spawn of something that is not a Node process is not this guard's
  // business — bounding `git` and `adlc` is the hook's own concern.
  const otherBinary = "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['status'], {});";
  assert.deepEqual(rawSpawnSites(otherBinary), []);
});

test('the detector finds a raw spawn regardless of formatting', () => {
  const planted = [
    "execFileSync(process.execPath, [HOOK, 'rails'], { input });",
    "spawnSync(process.execPath, [HOOK], {});",
    'execFileSync(\n  process.execPath,\n  [HOOK],\n  { input },\n);',
    "execFileSync  (  process.execPath , [HOOK], {} );",
  ];
  for (const source of planted) {
    assert.equal(rawSpawnSites(source).length, 1, `not detected: ${JSON.stringify(source)}`);
  }

  // Reformatting the same call must not change the verdict — structural, not
  // string equality.
  const oneLine = "const out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8' });";
  const wrapped = "const out = execFileSync(\n  process.execPath,\n  [HOOK, 'rails'],\n  { input, encoding: 'utf8' },\n);";
  assert.equal(rawSpawnSites(oneLine).length, rawSpawnSites(wrapped).length);
});

test('the detector reports the offending line and ignores routed calls', () => {
  const source = ['// a comment', "import { runHook } from './helpers/run-hook.mjs';", '', "runHook([HOOK, 'rails'], { input });", "spawnSync(process.execPath, [HOOK], {});"].join('\n');
  const sites = rawSpawnSites(source);
  assert.deepEqual(sites, [{ line: 5 }], 'must name the raw spawn line and skip the routed call');

  // Once routed through the helper, the same file is clean.
  const routed = source.replace("spawnSync(process.execPath, [HOOK], {});", 'spawnHook([HOOK], {});');
  assert.deepEqual(rawSpawnSites(routed), []);
});

test('a railed exception covers its known spawns and no more', () => {
  // The exception is pinned to a COUNT, not just a filename. Exempting the file
  // wholesale would let the one allowed spawn mask every raw spawn added to it
  // later — the file is frozen, but "frozen" is a rail on this lane, not a
  // guarantee that its owning ticket will not add one.
  const wrong = [];
  for (const [file, { ticket, rawSpawns }] of RAILED_EXCEPTIONS) {
    const absolute = join(ROOT, file);
    if (!existsSync(absolute)) {
      wrong.push(`${file}: gone — remove the entry (was blocked by ${ticket})`);
      continue;
    }
    const actual = rawSpawnSites(readFileSync(absolute, 'utf8')).length;
    if (actual === 0) {
      wrong.push(`${file}: no raw spawn left — remove the entry (was blocked by ${ticket})`);
    } else if (actual !== rawSpawns) {
      wrong.push(`${file}: ${actual} raw spawns, exception covers ${rawSpawns} — a new one was added`);
    }
  }
  assert.deepEqual(wrong, [], `RAILED_EXCEPTIONS is stale or under-counted:\n  ${wrong.join('\n  ')}`);
});

test('no hook test spawns a raw child process outside the shared helper', () => {
  const violations = [];
  for (const dir of HOOK_TEST_DIRS) {
    const helperRel = relative(ROOT, join(ROOT, dir, HELPER_RELATIVE));
    for (const file of mjsFilesUnder(dir)) {
      if (file === helperRel || RAILED_EXCEPTIONS.has(file)) continue;
      for (const site of rawSpawnSites(readFileSync(join(ROOT, file), 'utf8'))) {
        violations.push(`${file}:${site.line}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `raw child-process spawns found outside the bounded helper — route them through ` +
      `${HELPER_RELATIVE} so a missing timeout is impossible rather than merely unlikely:\n  ` +
      violations.join('\n  '),
  );
});
