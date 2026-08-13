// run-tests plugin-segment completeness — every plugin test directory on disk must be
// covered by a SEGMENT command in scripts/run-tests.mjs, so a new plugin (or a new test
// dir inside an existing plugin) can't be silently untested.
// Seam 7 remediation (delta.md / PR #486): packages/* segments are auto-derived by
// packageSegments(), but the plugins/* segments are hand-enumerated with no guard.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEGMENTS } from '../run-tests.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Every `test` directory anywhere under plugins/ (plugins/X/test, plugins/X/hooks/test, …).
function pluginTestDirs(root = REPO_ROOT) {
  const out = [];
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules') continue;
      const rel = `${relDir}/${e.name}`;
      if (e.name === 'test') out.push(rel);
      else walk(join(absDir, e.name), rel);
    }
  };
  for (const plugin of readdirSync(join(root, 'plugins'), { withFileTypes: true })) {
    if (plugin.isDirectory()) walk(join(root, 'plugins', plugin.name), `plugins/${plugin.name}`);
  }
  return out.sort();
}

// A plugin test dir is covered iff some segment command references its path.
function uncoveredDirs(dirs, commands) {
  return dirs.filter((dir) => !commands.some((cmd) => cmd.includes(dir)));
}

const segmentCommands = SEGMENTS.map(([, cmd]) => cmd);

describe('run-tests plugin-segment completeness', () => {
  it('every plugin test dir on disk is run by some SEGMENT', () => {
    const missing = uncoveredDirs(pluginTestDirs(), segmentCommands);
    assert.deepEqual(
      missing,
      [],
      `unlisted plugin test dir(s): ${missing.join(', ')} — add a segment to scripts/run-tests.mjs`,
    );
  });

  it('the check FAILS for an unlisted plugin dir (guard is load-bearing, not vacuous)', () => {
    const missing = uncoveredDirs(['plugins/adlc-brandnew/test'], segmentCommands);
    assert.deepEqual(missing, ['plugins/adlc-brandnew/test']);
  });

  it('enumerates a plausible number of plugin test dirs (walk not silently broken)', () => {
    assert.ok(pluginTestDirs().length >= 8, `only found ${pluginTestDirs().length} plugin test dirs`);
  });
});
