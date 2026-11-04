import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('package.json scripts.test covers test/, hooks/test/, lib/test/, and mcp/test/ (#814)', () => {
  const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  for (const glob of ['test/*.test.mjs', 'hooks/test/*.test.mjs', 'lib/test/*.test.mjs', 'mcp/test/*.test.mjs']) {
    assert.ok(pkg.scripts?.test?.includes(glob), `scripts.test must include ${glob}`);
  }
});

test('README discloses that build-gate is currently inert on Copilot (#810)', () => {
  const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\|\s*Build-gate context fitness\s*\|\s*`preToolUse` hook\s*\|\s*\*\*Inert on Copilot\*\*[^\n]*never denies/i);
  assert.match(readme, /Build-gate is currently inert on Copilot[\s\S]*never denies on\s+Copilot/i);
});

test('skills use the adlc run p0/p1 dispatcher form and link interrogation-protocol.md (#812, #813)', () => {
  const ticketSkill = readFileSync(join(PLUGIN_ROOT, 'skills/adlc-ticket/SKILL.md'), 'utf8');
  const routerSkill = readFileSync(join(PLUGIN_ROOT, 'skills/adlc/SKILL.md'), 'utf8');
  assert.doesNotMatch(ticketSkill, /adlc-runner run p0/);
  assert.match(ticketSkill, /`adlc run p0` requires `--ticket <id>`/);
  assert.doesNotMatch(routerSkill, /adlc-runner run p1/);
  assert.match(routerSkill, /`adlc run p1` requires and validates that record/);
  const url = 'https://github.com/voodootikigod/adlc/blob/main/docs/interrogation-protocol.md';
  assert.ok(ticketSkill.includes(url), 'adlc-ticket/SKILL.md must link interrogation-protocol.md to its GitHub URL');
  assert.ok(routerSkill.includes(url), 'adlc/SKILL.md must link interrogation-protocol.md to its GitHub URL');
});
