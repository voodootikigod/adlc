import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide } from '../hooks/adlc-rails-guard.mjs';

// Projection-shape contract tests (adlc#142, antigravity-booster#11).
//
// The antigravity-booster projects a SINGLE-ticket .adlc/tickets.json into each
// build worktree: exactly one ticket (the active build ticket). decide.test.mjs
// only ever writes a ticket that happens to be alone but carries no edges, so
// the two projection shapes that MATTER at the booster boundary — a clean
// single-ticket file, and one whose outgoing edge dangles because the target
// ticket was projected away — were never pinned. This file pins both.

const ENF = { ADLC_P4_ENFORCEMENT: '1' };

// Build a booster-style SINGLE-ticket projection. `edges` is opt-in so a test can
// reproduce the dangling-edge shape the booster produces when it fails to strip a
// projected-away edge target.
function projectionRepo({ rails = [], scope = ['src/**'], edges, id = 'T1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agy-proj-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  const ticket = { id, title: 't', body: 'b', scope, rails };
  if (edges !== undefined) ticket.edges = edges;
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id }));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}
const call = (name, args, env = ENF, extra = {}) => decide({ toolCall: { name, args }, ...extra }, { env });

test('single-ticket projection (no edges): enforces the rail (denies a rail write) and allows an in-scope non-rail write', () => {
  const root = projectionRepo({ rails: ['src/frozen.js'], scope: ['src/**'] });

  // The declared rail is frozen: a structured write to it is denied.
  const railWrite = call('write_to_file', { TargetFile: join(root, 'src', 'frozen.js') });
  assert.equal(railWrite.allow_tool, false);
  assert.match(railWrite.deny_reason, /frozen rail/i);

  // An in-scope, non-rail path is the normal P4 edit surface and stays allowed.
  const nonRailWrite = call('write_to_file', { TargetFile: join(root, 'src', 'feature.js') });
  assert.equal(nonRailWrite.allow_tool, true);
});

test('single-ticket projection WITH a dangling edge: current fail-closed deny-all (pins the antigravity-booster#11 / adlc#142 regression)', () => {
  // When the booster projects a single ticket but leaves an outgoing edge whose
  // target was projected away, core-inline.mjs loadTickets reports
  // "edge to unknown ticket <id>"; rails-checker.mjs railPreconditions reads ANY
  // validation error as tamper and returns { state: 'deny' }, so checkRail/decide
  // deny EVERY mutating tool call for the whole session — not just rail paths.
  //
  // This is deliberate, documented fail-closed behavior: the plugin does not try
  // to repair a malformed trust root. The booster-side fix strips edges from the
  // single-ticket projection so this state never occurs in practice. We assert the
  // deny-all EXPLICITLY here so the failure mode stays visible and intentional in
  // the suite rather than being silently "discovered" by a future projection bug.
  //   https://github.com/voodootikigod/antigravity-booster/issues/11
  //   https://github.com/voodootikigod/adlc/issues/142
  const root = projectionRepo({ rails: ['src/frozen.js'], scope: ['src/**'], edges: [{ to: 'T2' }] });

  // The rail write is denied — but so is EVERYTHING, so the rail deny alone does
  // not distinguish deny-all from healthy enforcement.
  const railWrite = call('write_to_file', { TargetFile: join(root, 'src', 'frozen.js') });
  assert.equal(railWrite.allow_tool, false);
  assert.match(railWrite.deny_reason, /failed to validate/i);

  // The tell-tale of deny-all: an in-scope, NON-RAIL write that the no-edges case
  // above allowed is ALSO denied here — the dangling edge trips the fail-closed
  // precondition before any per-path rail matching runs.
  const nonRailWrite = call('write_to_file', { TargetFile: join(root, 'src', 'feature.js') });
  assert.equal(
    nonRailWrite.allow_tool,
    false,
    'a dangling edge must fail closed and deny even a non-rail, in-scope write'
  );
  assert.match(nonRailWrite.deny_reason, /failed to validate.*failing closed/i);

  // The deny-all is scoped to MUTATING tool calls: read-only tools are classified
  // before preconditions run, so a read of the same path is still allowed. This
  // pins that the fail-closed blast radius is "every mutation", not "every tool".
  const read = decide(
    { toolCall: { name: 'view_file', args: { AbsolutePath: join(root, 'src', 'feature.js') } } },
    { env: ENF }
  );
  assert.equal(read.allow_tool, true);
});
