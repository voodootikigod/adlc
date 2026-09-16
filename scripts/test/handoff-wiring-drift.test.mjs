// handoff-wiring-drift.test.mjs — the plugin's self-description must agree with
// its actual wiring (#995, #996).
//
// PR #966 disconnected the context-rot handoff gate by removing its entries
// from hooks.json, deliberately leaving the enforcement code intact. Nothing
// updated the code's own description of itself, so for two releases the most
// -read orientation comment in the plugin, a security guard's scope-justifying
// comment, and the published integration table all stated that a dead verb was
// ENFORCING. That cost real debugging time in a live session: hooks.json said
// disconnected, every comment said enforcing, and the contradiction was the
// bug.
//
// Correcting the prose alone leaves the next disconnect free to re-create this
// exact state, so the agreement is asserted here instead. Everything is parsed
// STRUCTURALLY — a prose rewording is free, a false claim is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ENFORCING_MODES } from '../../plugins/adlc-claude-code/hooks/adlc-hook-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const HOOKS_JSON = 'plugins/adlc-claude-code/hooks/hooks.json';
const HOOK_SRC = 'plugins/adlc-claude-code/hooks/adlc-hook.mjs';
const INTEGRATION_DOC = 'docs/integrations/claude-code.md';

/** Every verb hooks.json actually dispatches: the last token of each command. */
function wiredVerbs() {
  const cfg = JSON.parse(read(HOOKS_JSON));
  const verbs = new Set();
  for (const entries of Object.values(cfg.hooks ?? {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        const m = /adlc-hook-run\.mjs\s+([a-z]+)\s*$/.exec(hook.command ?? '');
        if (m) verbs.add(m[1]);
      }
    }
  }
  assert.ok(verbs.size > 0, 'parsed no verbs out of hooks.json — the parser has drifted');
  return verbs;
}

/**
 * The header block's mode table: `//   <mode> (<Event>) → <desc> [<annotation>]`.
 * The annotation may wrap across continuation lines, so the block is flattened
 * before matching.
 */
function declaredModes() {
  const src = read(HOOK_SRC);
  const header = src.slice(0, src.indexOf('// CONTRACT:'));
  assert.ok(header.length > 0, 'the header block was not found');
  const flat = header.replace(/\n\/\/\s{10,}/g, ' ');
  const modes = new Map();
  for (const line of flat.split('\n')) {
    const m = /^\/\/\s{2,}([a-z]+)\s*\(([A-Za-z/]+)\)\s*(?:→|->)\s*(.*?)\s*\[([^\]]+)\]\s*$/.exec(line);
    if (m) modes.set(m[1], { event: m[2], description: m[3], annotation: m[4] });
  }
  assert.ok(modes.size > 0, 'parsed no modes out of the header block — the parser has drifted');
  return modes;
}

const isEnforcing = (a) => /\bENFORCING\b/.test(a);
const isDisconnected = (a) => /\bDISCONNECTED\b/.test(a);

test('every mode the header calls ENFORCING is actually wired in hooks.json', () => {
  const wired = wiredVerbs();
  for (const [mode, { annotation }] of declaredModes()) {
    if (!isEnforcing(annotation)) continue;
    assert.ok(
      wired.has(mode),
      `adlc-hook.mjs calls "${mode}" [${annotation}] but hooks.json never dispatches it. ` +
        `Either wire it, or annotate it DISCONNECTED with the issue that disconnected it.`
    );
  }
});

test('an unwired mode is annotated DISCONNECTED and names the issue that disconnected it', () => {
  const wired = wiredVerbs();
  for (const [mode, { annotation }] of declaredModes()) {
    if (wired.has(mode)) continue;
    assert.ok(
      isDisconnected(annotation),
      `"${mode}" is not wired in hooks.json but the header annotates it [${annotation}]. ` +
        `An unwired mode must say DISCONNECTED so the next reader is not misled.`
    );
    assert.match(
      annotation, /#\d+/,
      `"${mode}" is annotated DISCONNECTED but does not name the issue or PR that disconnected it`
    );
  }
});

test('every verb hooks.json dispatches is described in the header block', () => {
  const declared = declaredModes();
  for (const verb of wiredVerbs()) {
    assert.ok(
      declared.has(verb),
      `hooks.json dispatches "${verb}" but the header block does not describe it — ` +
        `the orientation comment is incomplete, which is how this drift starts.`
    );
  }
});

test('a disconnected mode kept in ENFORCING_MODES explains why it is still listed', () => {
  // ENFORCING_MODES drives fail-closed-on-timeout/crash, so a dead entry is a
  // security-relevant claim. #966's disconnect is temporary, so `handoff`
  // stays listed deliberately — but the reason has to be written down, or the
  // set silently becomes wrong when the mode is re-wired or half-wired.
  const wired = wiredVerbs();
  const runSrc = read('plugins/adlc-claude-code/hooks/adlc-hook-run.mjs');
  for (const mode of ENFORCING_MODES) {
    if (wired.has(mode)) continue;
    const near = runSrc.slice(0, runSrc.indexOf('ENFORCING_MODES'));
    assert.match(
      near.split('\n').slice(-12).join('\n'),
      /DISCONNECTED|#966/,
      `"${mode}" is in ENFORCING_MODES but is not wired, and nothing near the ` +
        `declaration explains why a dead mode is still treated as fail-closed.`
    );
  }
});

test('the published integration table does not call an unwired hook Enforcing', () => {
  const wired = wiredVerbs();
  const doc = read(INTEGRATION_DOC);
  const row = doc.split('\n').find((l) => /^\|\s*\*\*context-handoff\*\*\s*\|/.test(l));
  assert.ok(row, `no context-handoff row found in ${INTEGRATION_DOC}`);
  if (!wired.has('handoff')) {
    // `**Enforcing**` is this table's STATUS vocabulary — every other row uses
    // the bold marker to state what ships. Describing what the gate would do
    // once re-wired is fine in prose; claiming the shipped status is not.
    assert.ok(
      !/\*\*Enforcing\*\*/.test(row),
      `${INTEGRATION_DOC} still documents context-handoff as **Enforcing**, but ` +
        `hooks.json does not wire the handoff verb.`
    );
    assert.match(
      row, /#966|disconnect/i,
      `${INTEGRATION_DOC}'s context-handoff row must say the gate ships disconnected and point at #966`
    );
  }
});

test('the operator recovery path for a handoff deny is documented', () => {
  // Under an active deny EVERY Bash call fails closed, read-only ones included:
  // `git status` and `ls` are denied, so the agent cannot diagnose its own
  // wedge. The deny message suggests `resume` and "continue in a fresh
  // session", neither of which clears an orphaned-unbound marker. `doctor` is
  // the remedy and was discoverable only from doctor's own stderr.
  const docs = read(INTEGRATION_DOC);
  assert.match(docs, /adlc handoff doctor/, 'the recovery path must name `adlc handoff doctor`');
  assert.match(docs, /--clear/, 'the recovery path must name the --clear flag that actually clears markers');
  assert.match(docs, /orphaned-unbound/i, 'the docs must name the orphaned-unbound case doctor exists for');
  assert.match(
    docs, /no env(ironment)? (kill switch|override|bypass)/i,
    'the docs must state that no env kill switch exists, unlike ADLC_RAILS_BYPASS'
  );
});
