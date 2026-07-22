#!/usr/bin/env node
// run-tests.mjs — run EVERY suite, then report every failure.
//
// The test script was a 16-segment `&&` chain with a nested `|| exit 1` inside its
// packages/* loop. Both abort on the first failure, which is worse than slow: it
// makes a broken change look UNCHANGED. One pre-existing failure early in the
// chain silently skipped every later suite, so `npm test` reported the same
// "1375 pass / 2 fail" before and after a change that actually broke two cursor
// suites — the totals were stable because the run never reached them. The failures
// only surfaced once the earlier one was fixed, three runs later.
//
// A test harness that hides failures behind other failures cannot answer the one
// question it exists to answer. So: run all segments, always; print a summary that
// names every failing one; exit non-zero if any failed.
//
// Ordering is preserved and output still streams through, so a normal green run
// looks the same as before.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Put the repo's node_modules/.bin on PATH for every segment. Some tests spawn
// the workspace `adlc` bin (e.g. recordBuildGateBypass, the rails-guard-ci
// rail-freeze tests). Under `npm test` npm prepends .bin to PATH so they resolve;
// but this runner is also invoked DIRECTLY as `node scripts/run-tests.mjs` (the
// mutation-gate's slow-path baseline does exactly this), where .bin is NOT on
// PATH and those spawns fail with ENOENT on a runner without a global adlc — a
// silent false red. Prepending it here makes the runner self-sufficient either way.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SEGMENT_ENV = {
  ...process.env,
  PATH: `${join(REPO_ROOT, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`,
};

const TSC_FLAGS = '--noEmit --allowJs --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck true';

/** Each package's tests run as their OWN segment: one failing package must not hide the others. */
function packageSegments() {
  return readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join('packages', entry.name, 'test')))
    .map((entry) => [`packages/${entry.name}`, `node --test packages/${entry.name}/test/*.test.mjs`]);
}

const SEGMENTS = [
  ['generated-reader drift', 'node scripts/ticket-readers/generate.mjs --check'],
  ...packageSegments(),
  ['claude-code hooks', 'node --test plugins/adlc-claude-code/hooks/test/*.test.mjs'],
  ['claude-code lib', 'node --test plugins/adlc-claude-code/lib/test/*.test.mjs'],
  ['codex hooks', 'node --test plugins/adlc-codex/hooks/test/*.test.mjs'],
  ['codex lib', 'node --test plugins/adlc-codex/lib/test/*.test.mjs'],
  ['codex agents', 'node --test plugins/adlc-codex/agents/test/*.test.mjs'],
  ['codex mcp', 'node --test plugins/adlc-codex/mcp/test/*.test.mjs'],
  ['codex install smoke', 'node scripts/codex-install-smoke.mjs .'],
  ['copilot contract', 'node --test plugins/adlc-copilot/test/*.test.mjs'],
  ['copilot hooks', 'node --test plugins/adlc-copilot/hooks/test/*.test.mjs'],
  ['copilot lib', 'node --test plugins/adlc-copilot/lib/test/*.test.mjs'],
  ['copilot mcp', 'node --test plugins/adlc-copilot/mcp/test/*.test.mjs'],
  ['copilot install smoke', 'node scripts/copilot-install-smoke.mjs .'],
  ['scripts', 'node --test scripts/test/*.test.mjs'],
  ['pi typecheck', `npx tsc ${TSC_FLAGS} plugins/adlc-pi/index.ts`],
  ['pi', 'node --test plugins/adlc-pi/test/*.test.mjs'],
  ['opencode', 'node --test plugins/adlc-opencode/test/*.test.mjs'],
  ['cursor', 'node --test plugins/adlc-cursor/test/*.test.mjs'],
  ['cursor install smoke', 'node scripts/cursor-install-smoke.mjs .'],
  ['antigravity', 'node --test plugins/adlc-antigravity/test/*.test.mjs'],
  ['antigravity install smoke', 'node scripts/antigravity-install-smoke.mjs .'],
  ['docs app', 'node --test apps/docs/test/*.test.mjs'],
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const segments = only.length ? SEGMENTS.filter(([name]) => only.some((o) => name.includes(o))) : SEGMENTS;
if (only.length && segments.length === 0) {
  console.error(`no test segment matches ${JSON.stringify(only)}. Known: ${SEGMENTS.map(([n]) => n).join(', ')}`);
  process.exit(1);
}

const failed = [];
for (const [name, command] of segments) {
  console.log(`\n─── ${name}`);
  const result = spawnSync(command, { shell: true, stdio: 'inherit', env: SEGMENT_ENV });
  // A signal (status null) is a failure too — never let a killed segment read as a pass.
  if (result.status !== 0) failed.push({ name, status: result.status, signal: result.signal });
}

console.log(`\n═══ ${segments.length - failed.length}/${segments.length} segments passed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED  ${f.name}${f.signal ? ` (${f.signal})` : ` (exit ${f.status})`}`);
  process.exit(1);
}
console.log('  all green');
