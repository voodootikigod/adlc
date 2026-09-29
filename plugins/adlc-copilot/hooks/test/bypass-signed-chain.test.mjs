// bypass-signed-chain.test.mjs — the audited-bypass recorder hands its child no
// signing key, so on a manifest chain that already carries signatures it must
// refuse to append rather than write an unsigned entry after a signed one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, chmodSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { runHook } from './helpers/run-hook.mjs';

const BUILD_GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-build-gate.mjs');

/** A PATH directory whose `adlc` leaves `markerPath` behind when it runs. */
function markingAdlc(t, markerPath) {
  const dir = tmp(t, 'adlc-copilot-signed-bin-');
  const impl = join(dir, 'adlc-impl.mjs');
  writeFileSync(impl, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, 'ran');\n`);
  chmodSync(impl, 0o755);
  symlinkSync(impl, join(dir, 'adlc'));
  return dir;
}

/** A repo root whose manifest segment holds `entry`. */
function repoWithSegment(t, entry) {
  const cwd = tmp(t, 'adlc-copilot-signed-cwd-');
  mkdirSync(join(cwd, '.adlc', 'manifest.d'), { recursive: true });
  if (entry !== undefined) writeFileSync(join(cwd, '.adlc', 'manifest.d', 'main-x.jsonl'), `${entry}\n`);
  return cwd;
}

function recordInChild(cwd, pathEnv) {
  const script = [
    `import { recordBuildGateBypass } from ${JSON.stringify(pathToFileURL(BUILD_GATE).href)};`,
    "const ok = recordBuildGateBypass('T2', ['declared-risk-high'], 55, 300000, { cwd: process.env.BYPASS_CWD });",
    'process.stdout.write(JSON.stringify({ ok }));',
  ].join('\n');
  const stdout = runHook(['--input-type=module', '-e', script], {
    cwd,
    timeout: 30_000,
    env: { ...process.env, BYPASS_CWD: cwd, PATH: `${pathEnv}:${dirname(process.execPath)}` },
  });
  return JSON.parse(stdout);
}

test('a signed manifest chain refuses the keyless bypass record and spawns nothing', { timeout: 60_000 }, (t) => {
  const marker = join(tmp(t, 'adlc-copilot-signed-marker-'), 'ran');
  const cwd = repoWithSegment(t, JSON.stringify({ seq: 1, gate: 'x', sig: 'deadbeef' }));
  assert.deepEqual(recordInChild(cwd, markingAdlc(t, marker)), { ok: false });
  assert.equal(existsSync(marker), false, 'no adlc may run against a signed chain');
});

test('an unreadable manifest line counts as signed', { timeout: 60_000 }, (t) => {
  const marker = join(tmp(t, 'adlc-copilot-signed-marker-'), 'ran');
  const cwd = repoWithSegment(t, '{not json');
  assert.deepEqual(recordInChild(cwd, markingAdlc(t, marker)), { ok: false });
  assert.equal(existsSync(marker), false);
});

test('an unsigned chain still records the bypass', { timeout: 60_000 }, (t) => {
  const marker = join(tmp(t, 'adlc-copilot-signed-marker-'), 'ran');
  const cwd = repoWithSegment(t, JSON.stringify({ seq: 1, gate: 'x' }));
  assert.deepEqual(recordInChild(cwd, markingAdlc(t, marker)), { ok: true });
  assert.equal(existsSync(marker), true);
});
