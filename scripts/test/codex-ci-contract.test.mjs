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
  assert.match(rootPackage.scripts.test, /plugins\/adlc-codex\/hooks\/test/);
  assert.match(rootPackage.scripts.test, /plugins\/adlc-codex\/mcp\/test/);
  assert.match(rootPackage.scripts.test, /scripts\/codex-install-smoke\.mjs/);
});
