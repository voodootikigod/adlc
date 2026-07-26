// skills-add-smoke.test.mjs — offline coverage for scripts/skills-add-smoke.mjs.
//
// The FILENAME is load-bearing. scripts/mutation-gate.mjs maps a changed
// `scripts/<name>.mjs` to `scripts/test/<name>.test.mjs` when that exact file
// exists, and only then takes the fast single-file path. Without this file the
// smoke script has "no known fast test target", so the gate falls back to the
// FULL monorepo suite — which is both slow and fragile, since that fallback runs
// in a job whose environment does not provision the globally-installed CLIs some
// segments need. Coverage living in skills-catalog.test.mjs satisfied a human
// reading it, but not the convention the tooling actually keys off.
//
// The smoke itself is network-dependent (it drives the real `npx skills add`)
// and is NOT run here. What is testable offline is the part that silently
// breaks: which directory it targets, and whether it refuses a tree with no
// catalog instead of reporting a pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SMOKE = path.join(repoRoot, 'scripts/skills-add-smoke.mjs');

const runSmoke = (target) =>
  spawnSync(process.execPath, [SMOKE, target], {
    encoding: 'utf8',
    cwd: repoRoot,
    timeout: 30_000,
  });

test('the smoke resolves its target from argv and refuses a tree with no catalog', () => {
  // Without this, an off-by-one in argv silently retargets the smoke at the CWD.
  // It would still "pass" against this repo while testing nothing the operator
  // asked about — the repo's mutation-gate caught exactly that mutant surviving.
  const emptyDir = mkdtempSync(path.join(tmpdir(), 'adlc-no-catalog-'));
  try {
    const result = runSmoke(emptyDir);

    assert.equal(result.status, 1, 'a tree with no skills/ must fail the smoke, not pass it');
    assert.ok(
      result.stdout.includes(emptyDir),
      `the smoke must report the target it resolved from argv; stdout was:\n${result.stdout}`,
    );
    assert.match(
      result.stderr,
      /does not exist/,
      'the smoke must say why it refused, naming the missing catalog',
    );
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('the smoke refuses a target whose skills/ directory is empty', () => {
  // A `skills/` that exists but holds nothing is the shape a botched move or a
  // partial checkout leaves behind. The smoke must not treat "the directory is
  // there" as "the catalog is there" — that is the same class of false pass as
  // trusting `npx skills add`'s exit code without checking what landed on disk.
  const dir = mkdtempSync(path.join(tmpdir(), 'adlc-empty-catalog-'));
  try {
    mkdirSync(path.join(dir, 'skills'), { recursive: true });
    const result = runSmoke(dir);
    assert.notEqual(result.status, 0, 'an empty catalog must not pass the smoke');
    assert.match(result.stderr, /missing from the catalog/, 'it must name what is absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--layout-only passes on this repo without touching the network', () => {
  // The SUCCESS path, reachable offline. Without an exit-0 case the failure
  // handling can only ever be observed on the failure side — mutation-gate
  // proved that by flipping `let failed = false` to `true` and surviving every
  // test, because they all exited before reaching it.
  const result = spawnSync(process.execPath, [SMOKE, repoRoot, '--layout-only'], {
    encoding: 'utf8',
    cwd: repoRoot,
    timeout: 30_000,
  });

  assert.equal(result.status, 0, `layout check failed on this repo:\n${result.stderr}`);
  assert.match(result.stdout, /catalog layout OK/);
  assert.ok(
    !result.stdout.includes('npx'),
    'the layout check must not invoke the skills CLI',
  );
});

test('the smoke names the skills it expects to be installed', () => {
  // The smoke asserts specific skills land on disk rather than trusting the
  // CLI's exit code, because `skills add` exits 0 having installed nothing when
  // it walks past a layout it does not recognise. Adding a skill to the catalog
  // without adding it here would silently narrow that check.
  const source = readSmokeSource();
  for (const skill of ['adlc', 'adlc-init', 'adlc-prosecute']) {
    assert.ok(
      new RegExp(`'${skill}'`).test(source),
      `the smoke must verify "${skill}" is installed, not just that the CLI exited 0`,
    );
  }
});

function readSmokeSource() {
  return readFileSync(SMOKE, 'utf8');
}

test('the smoke leaves no writes outside a throwaway HOME', () => {
  // It drives a real installer, so it must never touch the operator's own agent
  // configuration. The guarantee comes from pointing HOME and USERPROFILE at a
  // temp dir; losing either would let an install land in the real ~/.claude.
  const source = readSmokeSource();
  assert.match(source, /HOME:\s*home/, 'the smoke must override HOME');
  assert.match(source, /USERPROFILE:\s*home/, 'the smoke must override USERPROFILE for Windows parity');
  assert.match(source, /rmSync\(home/, 'the throwaway HOME must be cleaned up');
});
