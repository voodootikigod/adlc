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
import { existsSync, readdirSync, realpathSync } from 'node:fs';
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

// Ambient trust-root variables the OPERATOR's shell may carry that must not decide
// test outcomes (spec: .adlc/specs/manifest-key-hermeticity.md, Layer 1):
//   ADLC_MANIFEST_KEY — flips key-present/key-absent branches deep in library code
//     (measured: gate-manifest + tickets segments 0/2 with it exported, 2/2 without);
//   RAILS_BASE / BASE_REF — retarget rails-guard base resolution at branches the
//     tests' scratch repos don't contain (75/80 bootstrap tests failed);
//   ADLC_RAILS_BYPASS / ADLC_BUILD_GATE_BYPASS — documented operator overrides that
//     flip gate outcomes: a bypass exported for legitimate maintenance would make a
//     test expecting exit 2 see a recorded override and exit 0 (codex review finding);
//   ADLC_GATE_MOCK_RESPONSE — a test seam that, exported ambiently, makes LLM-backed
//     gates return canned verdicts instead of exercising the real path.
// Tests that NEED one of these set their own value inline and are unaffected.
export const PRESERVE_EMPTY = new Set(['ADLC_MANIFEST_KEY']);
export const SCRUBBED_ENV_VARS = [
  'ADLC_MANIFEST_KEY',
  'RAILS_BASE',
  'BASE_REF',
  'ADLC_RAILS_BYPASS',
  'ADLC_BUILD_GATE_BYPASS',
  'ADLC_GATE_MOCK_RESPONSE',
];

/**
 * Build the env every segment is spawned with: the caller's env with the repo's
 * node_modules/.bin prepended to PATH, and each SCRUBBED_ENV_VARS member DELETED when
 * its value is non-empty. An explicitly-empty value ('') is PRESERVED: presence beats
 * truthiness for these variables — an empty ADLC_MANIFEST_KEY is a deliberate
 * fail-closed that blocks the .env.local file loader (load-env-local.mjs rule 2), and
 * deleting it would re-enable file fallback inside spawned bins. Unset stays absent.
 *
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {{env: NodeJS.ProcessEnv, scrubbed: string[]}} scrubbed lists what was deleted
 */
export function buildSegmentEnv(baseEnv = process.env, { platform = process.platform } = {}) {
  const env = {
    ...baseEnv,
    PATH: `${join(REPO_ROOT, 'node_modules', '.bin')}${delimiter}${baseEnv.PATH ?? ''}`,
  };
  const scrubbed = [];
  // Windows environment names are case-insensitive: a child process resolves
  // `adlc_manifest_key` as ADLC_MANIFEST_KEY, so an uppercase-only check would let a
  // mixed-case export defeat the scrub there. On POSIX, casing is significant and a
  // lowercase variant is a DIFFERENT variable nothing reads — scrubbing it would be
  // overreach — so the fold applies on win32 only. Reported names are canonical.
  const caseInsensitive = platform === 'win32';
  for (const name of SCRUBBED_ENV_VARS) {
    const matches = caseInsensitive
      ? Object.keys(env).filter((k) => k.toUpperCase() === name)
      : (Object.hasOwn(env, name) ? [name] : []);
    let removed = false;
    for (const match of matches) {
      // The explicit-'' carve-out applies ONLY to the key: its presence (even empty)
      // is a deliberate fail-closed that blocks the .env.local loader. The other
      // variables have PRESENCE-checked consumers (e.g. ADLC_GATE_MOCK_RESPONSE
      // present-but-empty can still select a mock path), so for them any present
      // value — empty included — is scrubbed (codex review finding).
      if (env[match] === '' && PRESERVE_EMPTY.has(name)) continue;
      delete env[match];
      removed = true;
    }
    if (removed) scrubbed.push(name);
  }
  return { env, scrubbed };
}

const TSC_FLAGS = '--noEmit --allowJs --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck true';

/**
 * True when a workspace package has a runnable test suite directory.
 * Inject `existsSync` in tests so the directory/file filter polarity is observable.
 */
export function packageHasTests(name, { existsSync: exists = existsSync, packagesDir = 'packages' } = {}) {
  return exists(join(packagesDir, name, 'test')) || exists(join(packagesDir, name, 'cli-test'));
}

/** Each package's tests run as their OWN segment: one failing package must not hide the others. */
export function packageSegments({ existsSync: exists = existsSync, readdirSync: readDir = readdirSync } = {}) {
  return readDir('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => packageHasTests(entry.name, { existsSync: exists }))
    .map((entry) => {
      const globs = [];
      if (exists(join('packages', entry.name, 'test'))) {
        globs.push(`packages/${entry.name}/test/*.test.mjs`);
      }
      // Slice-2+ CLI contract tests live outside test/ so they do not match
      // T154's frozen `packages/context-handoff/test/**/*.test.mjs` rail glob.
      if (exists(join('packages', entry.name, 'cli-test'))) {
        globs.push(`packages/${entry.name}/cli-test/*.test.mjs`);
      }
      return [`packages/${entry.name}`, `node --test ${globs.join(' ')}`];
    });
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
  ['gemini', 'node --test plugins/adlc-gemini/test/*.test.mjs'],
  ['gemini install smoke', 'node scripts/gemini-install-smoke.mjs .'],
  ['herdr', 'node --test plugins/adlc-herdr/test/*.test.mjs'],
  ['docs app', 'node --test apps/docs/test/*.test.mjs'],
];

function main() {
  const { env: segmentEnv, scrubbed } = buildSegmentEnv(process.env);
  if (scrubbed.length) {
    console.log(`note: ${scrubbed.join(', ')} set in your shell — scrubbed for test segments`);
  }

  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const segments = only.length ? SEGMENTS.filter(([name]) => only.some((o) => name.includes(o))) : SEGMENTS;
  if (only.length && segments.length === 0) {
    console.error(`no test segment matches ${JSON.stringify(only)}. Known: ${SEGMENTS.map(([n]) => n).join(', ')}`);
    process.exit(1);
  }

  const failed = [];
  for (const [name, command] of segments) {
    console.log(`\n─── ${name}`);
    const result = spawnSync(command, { shell: true, stdio: 'inherit', env: segmentEnv });
    // A signal (status null) is a failure too — never let a killed segment read as a pass.
    if (result.status !== 0) failed.push({ name, status: result.status, signal: result.signal });
  }

  console.log(`\n═══ ${segments.length - failed.length}/${segments.length} segments passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED  ${f.name}${f.signal ? ` (${f.signal})` : ` (exit ${f.status})`}`);
    process.exit(1);
  }
  console.log('  all green');
}

// Only run the suite when executed directly — the hermeticity test imports this module
// for buildSegmentEnv, and an import must never launch every test segment. realpathSync
// on BOTH sides: macOS /tmp is a symlink, so a path-string comparison can disagree
// locally while agreeing on Linux CI (or vice versa).
const invokedDirectly = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invokedDirectly) main();
