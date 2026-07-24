// RAIL (t-herdr-6): the executable contract for the Phase-2 palette actions
// (ticket-complete, adlc-init) and the keybinding docs. planAction stays the
// pure planner; every spawn plan is a fixed argv resolved on the trusted PATH,
// and the docs cannot silently drift from the declared action set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planAction } from '../lib/actions.mjs';
import { parseManifest } from '../lib/manifest.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const OK = { ok: true, repoRoot: '/repo' };
const ACTIVE = { state: 'active', id: 't-x' };
const opts = { pluginRoot: '/plug' };

/** The spawned command is the argv AFTER the herdr `--` end-of-options marker. */
const spawned = (plan) => plan.herdrArgs.slice(plan.herdrArgs.indexOf('--') + 1);
const manifest = () => parseManifest(readFileSync(join(pluginRoot, 'herdr-plugin.toml'), 'utf8'));
const actionIds = () => manifest().sections.filter((s) => s.name === 'actions').map((s) => s.entries.id);

// ---- ticket-complete ----

test('AC1 ticket-complete refuses when the pane resolves to no repo', () => {
  assert.equal(planAction('ticket-complete', { ok: false }, null, opts).kind, 'refuse');
});

test('AC2 ticket-complete refuses when there is no active ticket', () => {
  const plan = planAction('ticket-complete', OK, { state: 'absent' }, opts);
  assert.equal(plan.kind, 'refuse');
});

test('AC3 ticket-complete spawns the fixed dry-run argv for the active ticket', () => {
  const plan = planAction('ticket-complete', OK, ACTIVE, opts);
  assert.equal(plan.kind, 'spawn-pane');
  assert.equal(plan.requiresBin, 'adlc');
  assert.deepEqual(spawned(plan), ['adlc', 'ticket', 'complete', 't-x']); // no --write: human drives the actual completion
});

test('ticket-complete rejects an active id that fails validation (CWE-88 arg-injection guard)', () => {
  assert.equal(planAction('ticket-complete', OK, { state: 'active', id: '-rf' }, opts).kind, 'refuse');
});

// ---- adlc-init ----

test('AC4 adlc-init refuses when the pane resolves to no repo', () => {
  assert.equal(planAction('adlc-init', { ok: false }, null, opts).kind, 'refuse');
});

test('AC5 adlc-init spawns the fixed init argv without requiring an active ticket', () => {
  const plan = planAction('adlc-init', OK, { state: 'absent' }, opts);
  assert.equal(plan.kind, 'spawn-pane');
  assert.equal(plan.requiresBin, 'adlc');
  assert.deepEqual(spawned(plan), ['adlc', 'init']);
});

// ---- AC6 manifest declares both actions through the shared dispatcher ----

test('AC6 the manifest declares ticket-complete and adlc-init as pane actions', () => {
  const { sections } = manifest();
  const ids = actionIds();
  for (const id of ['ticket-complete', 'adlc-init']) assert.ok(ids.includes(id), `manifest missing action ${id}`);
  for (const s of sections.filter((s) => s.name === 'actions')) {
    assert.deepEqual(s.entries.command, ['node', 'bin/action.mjs'], `action ${s.entries.id} must dispatch through bin/action.mjs`);
    assert.deepEqual(s.entries.contexts, ['pane'], `action ${s.entries.id} must be a pane action`);
  }
});

// ---- AC7 keybinding docs name every action (docs cannot drift from the action set) ----

test('AC7 the README keybinding docs mention every manifest action id', () => {
  const readme = readFileSync(join(pluginRoot, 'README.md'), 'utf8');
  assert.ok(/keybinding/i.test(readme), 'README must have a Keybindings section');
  for (const id of actionIds()) assert.ok(readme.includes(id), `README keybinding docs omit action "${id}"`);
});
