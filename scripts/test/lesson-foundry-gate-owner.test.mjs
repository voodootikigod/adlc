// `adlc lesson-foundry --gate` fails when a recurring finding cluster has no
// banked lesson yet (T79). The gate is worthless if nothing invokes it: a
// distillation run could end with clusters still undefended and no one is told,
// which is exactly the silent-rot failure the P5→P7 bridge exists to prevent.
//
// The gate cannot go in CI while `.adlc/findings.jsonl` is machine-local, so its
// owners are the two docs that run where the ledger lives: every /adlc-distill
// workflow must CLOSE on the gate (after writing/refining lessons it must exit
// 0), and every /adlc-maintain workflow must run it among the decay-driven
// checks. This is prose that a test guards, so a future harness can't ship a
// distill/maintain workflow that forgets the gate and lets clusters sit silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * DISCOVERED from disk, never a hardcoded list. Collects every doc that ships an
 * `adlc-<verb>` workflow across both plugin layouts: command-layout harnesses
 * keep it in command/commands/prompts/adlc-<verb>.md, skills-layout harnesses in
 * skills/<name>/SKILL.md where <name> matches the verb. Both layouts are
 * collected (no precedence) — a harness that ships the workflow in both places
 * must carry the gate in both, since either can be the one a user runs.
 *
 * Walked with readdirSync rather than fs.globSync: globSync is Node 22+, and this
 * repo's CI runs the suite on Node 18, 20 and 22.
 */
function discoverDocs(verb) {
  const out = [];
  const seen = new Set(); // dedupe by real path (cursor ships a commands -> command symlink)
  const verbRe = new RegExp(verb, 'i');
  const add = (p) => {
    const abs = resolve(REPO, p);
    if (!existsSync(abs)) return;
    const real = realpathSync(abs);
    if (seen.has(real)) return;
    seen.add(real);
    out.push({ path: p, text: readFileSync(abs, 'utf8') });
  };
  const pluginsDir = resolve(REPO, 'plugins');
  for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    for (const sub of ['command', 'commands', 'prompts']) {
      add(`plugins/${plugin.name}/${sub}/adlc-${verb}.md`);
    }
    const skillsDir = resolve(REPO, `plugins/${plugin.name}/skills`);
    if (!existsSync(skillsDir)) continue;
    for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory() || !verbRe.test(skill.name)) continue;
      add(`plugins/${plugin.name}/skills/${skill.name}/SKILL.md`);
    }
  }
  return out;
}

const DISTILL = discoverDocs('distill');
const MAINTAIN = discoverDocs('maintain');

test('the distill and maintain docs are actually discovered', async () => {
  // A walk that finds nothing would make every assertion below vacuous.
  assert.ok(DISTILL.length >= 7, `expected the distill docs, found ${DISTILL.length}`);
  assert.ok(MAINTAIN.length >= 5, `expected the maintain docs, found ${MAINTAIN.length}`);

  const distillHarnesses = new Set(DISTILL.map((d) => d.path.split('/')[1]));
  for (const h of [
    'adlc-claude-code', 'adlc-codex', 'adlc-copilot',
    'adlc-cursor', 'adlc-opencode', 'adlc-pi',
  ]) {
    assert.ok(distillHarnesses.has(h), `${h} must ship a discoverable /adlc-distill workflow`);
  }

  const maintainHarnesses = new Set(MAINTAIN.map((d) => d.path.split('/')[1]));
  for (const h of ['adlc-claude-code', 'adlc-copilot', 'adlc-cursor', 'adlc-opencode', 'adlc-pi']) {
    assert.ok(maintainHarnesses.has(h), `${h} must ship a discoverable /adlc-maintain workflow`);
  }
});

test('every /adlc-distill workflow closes on the lesson-foundry gate', async () => {
  const missing = DISTILL.filter((d) => !d.text.includes('lesson-foundry --gate')).map((d) => d.path);

  assert.deepEqual(
    missing, [],
    'these distill workflows never run `adlc lesson-foundry --gate`, so a run can ' +
    'end with recurring finding clusters still unbanked and nothing tells the operator',
  );
});

test('every /adlc-maintain workflow runs the lesson-foundry gate as a decay check', async () => {
  const missing = MAINTAIN.filter((d) => !d.text.includes('lesson-foundry --gate')).map((d) => d.path);

  assert.deepEqual(
    missing, [],
    'these maintenance workflows never run `adlc lesson-foundry --gate`, so unbanked ' +
    'clusters are never surfaced during the decay-driven maintenance pass',
  );
});

test('the gate the docs invoke still exists in the lesson-foundry CLI', async () => {
  // Guards against the docs outliving the flag they teach.
  const cli = readFileSync(resolve(REPO, 'packages/lesson-foundry/bin/lesson-foundry.mjs'), 'utf8');
  assert.match(cli, /gate:\s*\{\s*type:\s*'boolean'/, 'the --gate flag must still be parsed');
});
