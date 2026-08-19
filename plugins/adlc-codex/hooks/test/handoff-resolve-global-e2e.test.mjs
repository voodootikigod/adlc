// handoff-resolve-global-e2e.test.mjs — drive the REAL Codex handoff hook from
// a plugin directory that has no monorepo above it, the way an installed plugin
// actually runs, and prove a global @adlc/cli install is enough to keep the
// session usable.
//
// Issue #526: every other handoff test runs the hook out of this checkout, so
// the resolver's walk-up from the plugin's own directory always found the
// workspace copy of @adlc/context-handoff and the resolution failure the
// documented install produces was never exercised. Here the plugin is copied
// out of the repo first, so the only route left is the global one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(HOOKS_DIR, '..', '..', '..');
const REAL_PACKAGE = realpathSync(join(REPO_ROOT, 'packages', 'context-handoff'));

/**
 * A plugin install and a project, both outside this repo — so neither the
 * project's node_modules nor the plugin's ancestry can reach the package.
 */
function detachedInstall() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-codex-global-')));
  const hooks = join(root, 'plugin', 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const name of readdirSync(HOOKS_DIR)) {
    if (!name.endsWith('.mjs')) continue;
    copyFileSync(join(HOOKS_DIR, name), join(hooks, name));
  }

  const project = join(root, 'project');
  mkdirSync(join(project, '.adlc'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'app.mjs'), 'export {}\n');

  return { root, hooks, project, hook: join(hooks, 'adlc-handoff-gate.mjs'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A global-install directory holding @adlc/context-handoff, exposed via NODE_PATH. */
function globalInstall(root) {
  const dir = join(root, 'npm-global', 'lib', 'node_modules');
  mkdirSync(join(dir, '@adlc'), { recursive: true });
  symlinkSync(REAL_PACKAGE, join(dir, '@adlc', 'context-handoff'), 'dir');
  return dir;
}

function runHook({ hook, project, env }) {
  const payload = JSON.stringify({
    tool_name: 'apply_patch',
    session_id: 'sess-global',
    file_path: join(project, 'src', 'app.mjs'),
  });
  try {
    execFileSync(process.execPath, [hook], {
      input: payload,
      encoding: 'utf8',
      cwd: project,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stderr: e.stderr ?? '' };
  }
}

/** process.env minus anything that would leak this repo into the subprocess. */
function bareEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!('NODE_PATH' in extra)) delete env.NODE_PATH;
  return env;
}

test('a detached plugin allows a mutating call when only a global install is reachable', () => {
  const box = detachedInstall();
  try {
    const nodePath = globalInstall(box.root);
    const r = runHook({ hook: box.hook, project: box.project, env: bareEnv({ NODE_PATH: nodePath }) });
    assert.equal(r.status, 0, `expected allow, got ${r.status}:\n${r.stderr}`);
  } finally {
    box.cleanup();
  }
});

test('a resolvable but unusable global install still denies — fail-closed is intact', () => {
  const box = detachedInstall();
  try {
    // NODE_PATH is consulted ahead of the interpreter-derived global root, so
    // this stub wins over any real @adlc/cli the running machine happens to
    // have installed — the assertion does not depend on the host's setup.
    const stubRoot = join(box.root, 'stub-modules');
    const stub = join(stubRoot, '@adlc', 'context-handoff');
    mkdirSync(join(stub, 'lib'), { recursive: true });
    writeFileSync(
      join(stub, 'package.json'),
      JSON.stringify({ name: '@adlc/context-handoff', version: '0.0.0-stub', type: 'module', exports: { '.': './lib/index.mjs' } }),
    );
    writeFileSync(join(stub, 'lib', 'index.mjs'), 'export const nothingUseful = true;\n');

    const r = runHook({
      hook: box.hook,
      project: box.project,
      env: bareEnv({ NODE_PATH: [stubRoot, join(box.root, 'unused')].join(delimiter) }),
    });
    assert.equal(r.status, 2, `expected deny, got ${r.status}:\n${r.stderr}`);
    assert.match(r.stderr, /@adlc\/context-handoff/);
  } finally {
    box.cleanup();
  }
});

test('the recovery diagnostic stops naming a monorepo path when nothing resolves', async () => {
  const { recoveryDiagnostic } = await import('../adlc-handoff-gate.mjs');
  const message = recoveryDiagnostic('sess-global', { resolveEntry: () => null });

  assert.equal(typeof message, 'string');
  assert.ok(message.length > 0, 'an operator with no install still needs a way out');
  assert.match(message, /@adlc\/context-handoff/, 'it must name what could not be resolved');
  assert.match(message, /npm install -g @adlc\/cli/, 'and how to make it resolvable');
  assert.doesNotMatch(
    message,
    /packages\/context-handoff\//,
    'a path that exists only in a source checkout of this monorepo is not a recovery route',
  );
});
