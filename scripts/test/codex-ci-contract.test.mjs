import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const rootPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('required matrix proves a pinned native Codex install', () => {
  const requiredJob = workflow.slice(workflow.indexOf('  test:'), workflow.indexOf('  opencode-live-latest:'));
  assert.match(requiredJob, /Codex native plugin live install proof \(pinned\)/);
  assert.match(requiredJob, /if: matrix\.node-version == 22/);
  assert.match(requiredJob, /npm install -g @openai\/codex@0\.144\.1/);
  assert.match(requiredJob, /ADLC_CODEX_LIVE_INSTALL=1 node scripts\/codex-install-smoke\.mjs \./);
});

test('latest Codex drift canary is advisory', () => {
  const latestJob = workflow.slice(workflow.indexOf('  codex-live-latest:'));
  assert.match(latestJob, /continue-on-error: true/);
  assert.match(latestJob, /npm install -g @openai\/codex@latest/);
});

test('#326 F1: the gate job installs with --ignore-scripts and rebuilds EVERY install-script dep', () => {
  // The test job runs the trust-root cross-model gate, so a candidate lifecycle script
  // must never execute in it (it could shim node/npm onto $GITHUB_PATH and defeat the
  // gate). We install --ignore-scripts and then rebuild ONLY a trusted allowlist. This
  // guard fails if that install is weakened OR if a new dependency declares an install
  // script that the allowlist does not cover — otherwise the allowlist would silently
  // drift, either breaking the build or tempting a maintainer to drop --ignore-scripts
  // and reopen the hole.
  const requiredJob = workflow.slice(workflow.indexOf('  test:'), workflow.indexOf('  opencode-live-latest:'));
  assert.match(requiredJob, /npm install --ignore-scripts/, 'the gate job must install with --ignore-scripts');
  const rebuild = requiredJob.match(/npm rebuild ([^\n]+)/);
  assert.ok(rebuild, 'the gate job must rebuild the trusted native-dep allowlist');
  const allowlist = new Set(rebuild[1].trim().split(/\s+/));

  const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  const needScripts = [...new Set(
    Object.entries(lock.packages || {})
      .filter(([, v]) => v && v.hasInstallScript)
      .map(([k]) => k.split('node_modules/').pop()) // last path segment = package name
  )];
  const missing = needScripts.filter((name) => !allowlist.has(name));
  assert.deepEqual(
    missing,
    [],
    `install-script dep(s) missing from the ci.yml \`npm rebuild\` allowlist: ${missing.join(', ')} — add them, or their native build is skipped`,
  );
});

test('ordinary npm test always exercises the offline Codex contracts', () => {
  // The contract is that `npm test` RUNS these, not that package.json spells them
  // out. The test script now delegates to a runner (so one failing suite cannot
  // abort the rest), which moved the segment list one level down — asserting only
  // against the top-level string would make this guard stop seeing what it guards.
  // Follow the delegation and assert against everything `npm test` actually executes.
  const sources = [rootPackage.scripts.test];
  const runner = rootPackage.scripts.test.match(/node\s+(scripts\/[\w.-]+\.mjs)/);
  if (runner) sources.push(readFileSync(new URL(`../../${runner[1]}`, import.meta.url), 'utf8'));
  const executed = sources.join('\n');

  assert.match(executed, /plugins\/adlc-codex\/hooks\/test/);
  assert.match(executed, /plugins\/adlc-codex\/mcp\/test/);
  assert.match(executed, /scripts\/codex-install-smoke\.mjs/);
});
