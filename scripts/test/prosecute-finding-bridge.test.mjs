// Every harness's prosecution workflow must record what it found (T72 / #322).
//
// `@adlc/core`'s recordFinding states the contract: "a finding surfaced by the
// prosecutor must leave a durable trail, or the compounding step has nothing to
// mine." That trail was being left by exactly one harness — pi, whose prosecutor
// is programmatic and calls recordFinding automatically. The other four are
// markdown workflows, and none of them mentioned the recorder at all, so every
// finding they surfaced was reported in prose, fixed, and lost.
//
// The failure was invisible because an unfed ledger reads as "nothing has
// recurred yet" rather than "nothing was recorded". Prose that nothing checks is
// what rotted here, so the defense is a test rather than more prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * DISCOVERED from disk, never a hardcoded list — a further harness must not be
 * able to ship a prosecution workflow that silently starves P7.
 *
 * Two layouts ship a prosecute workflow. Command-layout harnesses (claude-code,
 * cursor, opencode, pi) keep it in command/commands/prompts/adlc-prosecute.md.
 * Skills-layout harnesses (codex, copilot, gemini) express the same
 * loop as a SKILL.md under skills/<name>/ where <name> matches /prosecut/
 * (adlc-prosecute, gemini's adlc-prosecutor). We consult the skills layout
 * only when a harness ships no command-layout doc, so a harness like pi — whose
 * skills-layout adlc-prosecute is an evidence-recording helper that does NOT run
 * the finding-surfacing loop — stays covered by its command-layout (prompts/)
 * workflow rather than being double-counted against a doc that legitimately has
 * no findings to record.
 *
 * Walked with readdirSync rather than fs.globSync: globSync is Node 22+, and
 * this repo's CI runs the suite on Node 18, 20 and 22.
 */
function discoverProsecuteDocs() {
  const out = [];
  const pluginsDir = resolve(REPO, 'plugins');
  for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;

    let found = false;
    for (const sub of ['command', 'commands', 'prompts']) {
      const p = `plugins/${plugin.name}/${sub}/adlc-prosecute.md`;
      if (existsSync(resolve(REPO, p))) {
        out.push({ path: p, text: readFileSync(resolve(REPO, p), 'utf8') });
        found = true;
      }
    }
    if (found) continue;

    const skillsDir = resolve(REPO, `plugins/${plugin.name}/skills`);
    if (!existsSync(skillsDir)) continue;
    for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory() || !/prosecut/i.test(skill.name)) continue;
      const p = `plugins/${plugin.name}/skills/${skill.name}/SKILL.md`;
      if (existsSync(resolve(REPO, p))) out.push({ path: p, text: readFileSync(resolve(REPO, p), 'utf8') });
    }
  }
  return out;
}

const DOCS = discoverProsecuteDocs();

test('the harness prosecute docs are actually discovered', async () => {
  // A walk that finds nothing would make every assertion below vacuous.
  assert.ok(DOCS.length >= 7, `expected the harness prosecute docs, found ${DOCS.length}`);
  const harnesses = new Set(DOCS.map((d) => d.path.split('/')[1]));
  for (const h of [
    'adlc-claude-code', 'adlc-cursor', 'adlc-opencode', 'adlc-pi',
    'adlc-codex', 'adlc-copilot', 'adlc-gemini',
  ]) {
    assert.ok(harnesses.has(h), `${h} must have a discoverable prosecute workflow`);
  }
});

test('every harness prosecute workflow documents the P5 to P7 finding bridge', async () => {
  const missing = DOCS.filter((d) => !d.text.includes('--record-finding')).map((d) => d.path);

  assert.deepEqual(
    missing, [],
    'these prosecution workflows surface findings but never record them, so ' +
    'lesson-foundry (P7) has nothing to cluster and the lifecycle cannot compound',
  );
});

test('the documented invocation satisfies the recorder fail-closed contract', async () => {
  // recordFinding throws without `file` or `desc` — a doc that omits either
  // teaches an invocation that errors out, which is no better than not recording.
  for (const { path, text } of DOCS) {
    const line = text.split('\n').find((l) => l.includes('--record-finding'));
    assert.ok(line, `${path}: no --record-finding invocation`);
    assert.match(text, /--record-finding[\s\S]{0,240}--file/, `${path}: must pass --file`);
    assert.match(text, /--record-finding[\s\S]{0,240}--desc/, `${path}: must pass --desc`);
  }
});

test('recording is placed at verification time, not only in the final verdict step', async () => {
  // A CLEAR verdict means nothing survived, so a bridge that only fires in the
  // final "record + verdict" step records exactly the findings that no longer
  // exist. The step must sit where a finding is confirmed and still real.
  for (const { path, text } of DOCS) {
    const at = text.indexOf('--record-finding');
    const verdictAt = text.search(/^#+\s*\d*\.?\s*Record \+ verdict/im);
    if (verdictAt === -1) continue; // harness uses a different structure
    assert.ok(
      at < verdictAt,
      `${path}: the finding bridge must appear before the record+verdict step — ` +
      'on a CLEAR verdict there is nothing left to record',
    );
  }
});

test('the recorder itself still exists and is reachable as documented', async () => {
  // Guards against the docs outliving the CLI contract they teach.
  const cli = readFileSync(resolve(REPO, 'packages/prosecute/bin/adlc-prosecute.mjs'), 'utf8');

  assert.match(cli, /'record-finding':\s*\{\s*type:\s*'boolean'/, 'the flag must still be parsed');
  assert.match(cli, /recordFinding\(/, 'and still call the core recorder');
});
