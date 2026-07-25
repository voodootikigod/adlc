#!/usr/bin/env node
// windows-core-tests.mjs — run the core gate suites on a platform where the
// POSIX-only pieces cannot run.
//
// `npm test` is not usable on Windows: run-tests.mjs shells its segments with
// `*` globs (not expanded by cmd.exe) and includes suites that shell out to
// /bin/sh. This runner spawns node directly (no shell) and hands the glob to
// node --test, which expands it ITSELF — so pattern matching does not depend on
// the platform's shell. Passing a bare directory is not equivalent: this Node
// resolves that as a module path and fails.
//
// EXCLUDED, deliberately and visibly:
//   packages/fleet — hard-codes /bin/sh and POSIX sandbox backends. It is not
//   "broken on Windows", it is not offered on Windows. Every claim we make
//   about Windows support excludes it, and this runner prints the exclusion so
//   a green CI log can never be read as full parity.
//
// Exit 0 = every included suite passed. Exit 1 = at least one failed, and every
// failing suite is named (never stop at the first).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** POSIX-only suites. Each entry needs a reason — an unexplained exclusion is a hidden gap. */
const EXCLUDED = new Map([
  ['fleet', 'shells out through /bin/sh and uses POSIX sandbox backends'],
]);

const packages = readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(repoRoot, 'packages', entry.name, 'test')))
  .map((entry) => entry.name);

const included = packages.filter((name) => !EXCLUDED.has(name));
const skipped = packages.filter((name) => EXCLUDED.has(name));

console.log(`platform: ${process.platform} · node ${process.version}`);
console.log(`running ${included.length} package suite(s)`);
for (const name of skipped) {
  console.log(`  SKIPPED  packages/${name} — ${EXCLUDED.get(name)}`);
}

const failed = [];
for (const name of included) {
  // POSIX separators on purpose: this is a glob for node --test, not a path.
  const pattern = `packages/${name}/test/*.test.mjs`;
  console.log(`\n─── packages/${name}`);
  const result = spawnSync(process.execPath, ['--test', pattern], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  // A signal (status null) is a failure too — a killed suite must never read as a pass.
  if (result.status !== 0) failed.push({ name, status: result.status, signal: result.signal });
}

console.log(`\n═══ ${included.length - failed.length}/${included.length} package suites passed`);
if (skipped.length > 0) {
  console.log(`    ${skipped.length} POSIX-only suite(s) not run: ${skipped.join(', ')}`);
}
if (failed.length > 0) {
  for (const entry of failed) {
    console.log(`  FAILED  packages/${entry.name}${entry.signal ? ` (${entry.signal})` : ` (exit ${entry.status})`}`);
  }
  process.exit(1);
}
console.log('    all green');
