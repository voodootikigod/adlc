#!/usr/bin/env node
// skills-add-smoke.mjs — prove the top-level skills/ catalog is actually
// resolvable by the skills.sh CLI (`npx skills add`).
//
// This is the ONE property the catalog exists for and the one the offline unit
// suite cannot check: skills-catalog.test.mjs asserts the catalog's shape, but
// only the real CLI knows whether that shape is discoverable. The failure this
// guards against is silent — a layout the CLI walks right past reports nothing,
// it just installs zero skills.
//
// NOT part of `npm test`: it downloads the skills CLI. Run it before a release
// and whenever the catalog layout changes.
//
//   node scripts/skills-add-smoke.mjs [repo-root]
//
// Exit 0 = the CLI discovered and installed the catalog. Exit 1 = it did not.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(process.argv[2] ?? '.');
const EXPECTED = ['adlc', 'adlc-init', 'adlc-prosecute'];

if (!existsSync(join(repoRoot, 'skills'))) {
  console.error(`✗ ${repoRoot}/skills does not exist — nothing for the skills CLI to discover`);
  process.exit(1);
}

// A throwaway HOME so the smoke never writes into the operator's real agent
// config. The skills CLI resolves install targets relative to HOME.
const home = mkdtempSync(join(tmpdir(), 'adlc-skills-smoke-'));
let failed = false;

try {
  console.log(`> npx --yes skills add ${repoRoot} (HOME=${home})`);
  const result = spawnSync(
    'npx',
    ['--yes', 'skills', 'add', repoRoot, '--agent', 'claude-code', '--yes'],
    {
      cwd: home,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, DISABLE_TELEMETRY: '1' },
      timeout: 180_000,
    },
  );

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);

  if (result.error) {
    console.error(`✗ could not run the skills CLI: ${result.error.message}`);
    failed = true;
  } else if (result.status !== 0) {
    console.error(`✗ skills add exited ${result.status}`);
    failed = true;
  }

  // Exit 0 is necessary but not sufficient: the CLI succeeds having installed
  // nothing when it walks past a layout it does not recognize. Require the
  // skills to actually land on disk.
  const installed = new Set();
  for (const dir of [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) installed.add(entry);
  }

  const missing = EXPECTED.filter((name) => !installed.has(name));
  if (missing.length > 0) {
    console.error(
      `✗ skills add did not install: ${missing.join(', ')}\n` +
        `  found on disk: ${[...installed].join(', ') || '(nothing)'}\n` +
        '  the catalog layout is not discoverable — expected skills/<name>/SKILL.md',
    );
    failed = true;
  } else {
    console.log(`✓ skills CLI installed ${EXPECTED.join(', ')} from the catalog`);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
