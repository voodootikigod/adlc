// t-herdr-3 verification: the action dispatcher's logic surface. Pinned
// against the LIVE-probed contract (2026-07-23): actions dispatch on
// HERDR_PLUGIN_ACTION_ID with HERDR_PLUGIN_CONTEXT_JSON providing
// focused_pane_id / focused_pane_cwd (launch cwd — the live foreground_cwd
// still comes from `pane get`). Invariants (plan §5.3/§6.2): fail closed on
// malformed context or unresolvable repo (clear notification, nothing
// spawned); fixed argv arrays from trusted PATH only; every action echoes the
// resolved repo + ticket; all rendered text sanitized.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContext, resolveTarget, planAction, gateNotification, notifyArgs } from '../lib/actions.mjs';

const CTX = JSON.stringify({
  workspace_id: 'w4', workspace_cwd: '/repo',
  focused_pane_id: 'w4:p2', focused_pane_cwd: '/repo',
  invocation_source: 'cli',
});

// ---- parseContext ----

test('parseContext accepts the probed shape', () => {
  const res = parseContext(CTX);
  assert.equal(res.ok, true);
  assert.equal(res.ctx.focused_pane_id, 'w4:p2');
  assert.equal(res.ctx.focused_pane_cwd, '/repo');
});

test('parseContext fails closed on malformed JSON, missing pane id, or hostile pane id', () => {
  assert.equal(parseContext('{not json').ok, false);
  assert.equal(parseContext(undefined).ok, false);
  assert.equal(parseContext(JSON.stringify({ workspace_id: 'w4' })).ok, false);
  assert.equal(parseContext(JSON.stringify({ focused_pane_id: 'w4:p2; rm -rf /' })).ok, false);
});

// ---- resolveTarget ----

test('resolveTarget prefers live foreground_cwd, then pane cwd, then context cwd', () => {
  const resolver = (dir) => `${dir}/ROOT`;
  const ctx = { focused_pane_cwd: '/ctx' };
  assert.deepEqual(
    resolveTarget({ ctx, paneInfo: { foreground_cwd: '/fg', cwd: '/launch' }, resolveRepoRoot: resolver }),
    { ok: true, repoRoot: '/fg/ROOT' },
  );
  assert.deepEqual(
    resolveTarget({ ctx, paneInfo: { cwd: '/launch' }, resolveRepoRoot: resolver }),
    { ok: true, repoRoot: '/launch/ROOT' },
  );
  assert.deepEqual(
    resolveTarget({ ctx, paneInfo: null, resolveRepoRoot: resolver }),
    { ok: true, repoRoot: '/ctx/ROOT' },
  );
});

test('resolveTarget fails closed when nothing resolves to a repo', () => {
  const res = resolveTarget({ ctx: {}, paneInfo: null, resolveRepoRoot: () => null });
  assert.equal(res.ok, false);
  const res2 = resolveTarget({ ctx: { focused_pane_cwd: '/x' }, paneInfo: null, resolveRepoRoot: () => null });
  assert.equal(res2.ok, false);
});

// ---- planAction ----

const target = { ok: true, repoRoot: '/repo' };
const active = { state: 'active', id: 't-x1' };

test('unknown action ids refuse with a sanitized notification, nothing spawned', () => {
  const plan = planAction('\x1b[31mevil\x07', target, active);
  assert.equal(plan.kind, 'refuse');
  assert.ok(!plan.body.includes('\x1b'));
});

test('an unresolvable repo refuses every action (fail closed)', () => {
  for (const id of ['gate', 'ticket-show', 'prosecute']) {
    const plan = planAction(id, { ok: false, reason: 'no-repo' }, active);
    assert.equal(plan.kind, 'refuse');
    assert.ok(plan.body.toLowerCase().includes('repo'));
  }
});

test('gate plans the exact trusted argv and echoes repo + ticket', () => {
  const plan = planAction('gate', target, active);
  assert.equal(plan.kind, 'gate');
  assert.deepEqual(plan.argv, ['adlc', 'gate-manifest', 'verify', '--json']);
  assert.equal(plan.cwd, '/repo');
  assert.ok(plan.echo.includes('/repo'));
  assert.ok(plan.echo.includes('t-x1'));
});

test('gate echoes "none" when no ticket is active', () => {
  const plan = planAction('gate', target, { state: 'absent' });
  assert.equal(plan.kind, 'gate');
  assert.ok(plan.echo.includes('none'));
});

test('ticket-show plans a split-pane spawn of the plugin renderer with a validated id', () => {
  const plan = planAction('ticket-show', target, active, { pluginRoot: '/plug' });
  assert.equal(plan.kind, 'spawn-pane');
  assert.deepEqual(plan.herdrArgs, [
    'agent', 'start', 'adlc-ticket', '--cwd', '/repo', '--split', 'down', '--',
    'node', '/plug/bin/show-ticket.mjs', '/repo', 't-x1',
  ]);
});

test('ticket-show refuses when there is no active or readable ticket', () => {
  assert.equal(planAction('ticket-show', target, { state: 'absent' }).kind, 'refuse');
  assert.equal(planAction('ticket-show', target, { state: 'unreadable' }).kind, 'refuse');
});

test('ticket-show refuses a ticket id with characters outside [A-Za-z0-9._-]', () => {
  const plan = planAction('ticket-show', target, { state: 'active', id: 't-x1;rm -rf' });
  assert.equal(plan.kind, 'refuse');
});

test('ticket-show refuses a leading-hyphen ticket id (argument-injection guard)', () => {
  for (const id of ['--help', '-rf', '-x']) {
    assert.equal(planAction('ticket-show', target, { state: 'active', id }).kind, 'refuse',
      `leading-hyphen id ${id} must refuse`);
  }
});

test('parseContext rejects a leading-hyphen pane id', () => {
  assert.equal(parseContext(JSON.stringify({ focused_pane_id: '-rf' })).ok, false);
  assert.equal(parseContext(JSON.stringify({ focused_pane_id: '--flag' })).ok, false);
});

test('prosecute plans a split-pane adversarial-review from trusted PATH', () => {
  const plan = planAction('prosecute', target, active);
  assert.equal(plan.kind, 'spawn-pane');
  assert.equal(plan.requiresBin, 'adversarial-review');
  assert.deepEqual(plan.herdrArgs, [
    'agent', 'start', 'adlc-p5', '--cwd', '/repo', '--split', 'right', '--',
    'adversarial-review', '--base', 'main',
  ]);
  assert.ok(plan.echo.includes('/repo'));
});

test('no plan ever carries a shell string — argv arrays only', () => {
  for (const id of ['gate', 'ticket-show', 'prosecute']) {
    const plan = planAction(id, target, active, { pluginRoot: '/plug' });
    for (const key of ['argv', 'herdrArgs']) {
      if (plan[key] !== undefined) {
        assert.ok(Array.isArray(plan[key]));
        for (const part of plan[key]) assert.equal(typeof part, 'string');
      }
    }
  }
});

// ---- notifyArgs ----

test('notifyArgs emits the exact herdr notification argv, sanitized', () => {
  assert.deepEqual(
    notifyArgs('ADLC', 'body text', 'done'),
    ['notification', 'show', 'ADLC', '--body', 'body text', '--sound', 'done'],
  );
  const hostile = notifyArgs('\x1b[31mtitle', 'b\x07ody');
  assert.equal(hostile[2], 'title');
  assert.equal(hostile[4], 'body');
  assert.equal(hostile[6], 'request');
});

// ---- gateNotification ----

test('gateNotification renders a passing verify with the echo line', () => {
  const note = gateNotification('{"valid":true,"message":"manifest ok (11 entries)","count":11}', 'repo /repo · ticket t-x1');
  assert.ok(note.title.includes('gate'));
  assert.ok(note.body.includes('manifest ok (11 entries)'));
  assert.ok(note.body.includes('repo /repo'));
  assert.equal(note.sound, 'done');
});

test('gateNotification renders a failing verify with the request sound', () => {
  const note = gateNotification('{"valid":false,"message":"chain break at seq 4"}', 'repo /repo · ticket none');
  assert.ok(note.body.includes('chain break'));
  assert.equal(note.sound, 'request');
});

test('gateNotification fails soft on unreadable output and strips escapes', () => {
  const note = gateNotification('garbage {', 'repo /repo · ticket t-x1');
  assert.ok(note.body.toLowerCase().includes('unreadable'));
  const hostile = gateNotification('{"valid":true,"message":"ok\\u001b[31mred"}', 'echo');
  assert.ok(!hostile.body.includes('\x1b'));
});
