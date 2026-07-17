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
