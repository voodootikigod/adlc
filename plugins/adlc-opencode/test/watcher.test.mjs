// watcher.test.mjs — Phases 2.4/2.5: the file.edited post-hoc watcher.
// Uses REAL git in a temp repo (the restore path is git-backed), plus the real
// exported event handler for the end-to-end synthetic third-party-tool proof.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleFileEdited, createWatcherState, allowedSuppressions, MAX_RESTORES_PER_FILE, SUPPRESSION_MARKERS } from '../lib/watcher.mjs';
import { adlcRailsGuard } from '../index.mjs';

const RAIL_CONTENT = 'export const frozen = true;\n';
// Marker literals are concatenated so this test file does not trip the repo's
// rails-guard suppression scan on its own fixtures (runtime values are exact).
const TS_IGNORE = '@ts' + '-ignore';
const SKIP = '.sk' + 'ip(';
const NOQA = '# no' + 'qa';

function gitRepo({ tickets }) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-watch-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify(tickets));
  writeFileSync(join(dir, 'test', 'x.mjs'), RAIL_CONTENT);
  writeFileSync(join(dir, 'src', 'ok.mjs'), 'export const ok = 1;\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return dir;
}

const T1 = { tickets: [{ id: 'T1', rails: ['test/**'], scope: ['src/**', 'test/**'] }] };
const ON = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' };

// ---- 2.5 rail backstop ----
test('rail write is quarantined and restored from HEAD (tool-name independent)', () => {
  const dir = gitRepo({ tickets: T1 });
  try {
    writeFileSync(join(dir, 'test', 'x.mjs'), 'OVERWRITTEN\n');
    const { actions } = handleFileEdited({ file: join(dir, 'test', 'x.mjs'), root: dir, env: { ...ON }, state: createWatcherState() });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].check, 'rails');
    assert.equal(actions[0].action, 'restored');
    assert.equal(readFileSync(join(dir, 'test', 'x.mjs'), 'utf8'), RAIL_CONTENT, 'rail restored');
    const qDir = join(dir, '.adlc', 'quarantine');
    assert.ok(existsSync(qDir), 'quarantine dir created');
    const q = readdirSync(qDir);
    assert.equal(q.length, 1);
    assert.equal(readFileSync(join(qDir, q[0]), 'utf8'), 'OVERWRITTEN\n', 'offending content preserved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restore loop guard: stops restoring after MAX_RESTORES_PER_FILE', () => {
  const dir = gitRepo({ tickets: T1 });
  try {
    const state = createWatcherState();
    for (let i = 0; i < MAX_RESTORES_PER_FILE; i++) {
      writeFileSync(join(dir, 'test', 'x.mjs'), `attack ${i}\n`);
      const { actions } = handleFileEdited({ file: join(dir, 'test', 'x.mjs'), root: dir, env: { ...ON }, state });
      assert.equal(actions[0].action, 'restored', `restore ${i + 1} still active`);
    }
    writeFileSync(join(dir, 'test', 'x.mjs'), 'attack final\n');
    const { actions } = handleFileEdited({ file: join(dir, 'test', 'x.mjs'), root: dir, env: { ...ON }, state });
    assert.equal(actions[0].action, 'warned');
    assert.match(actions[0].message, /loop guard/);
    assert.equal(readFileSync(join(dir, 'test', 'x.mjs'), 'utf8'), 'attack final\n', 'no revert war');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rails backstop inert when enforcement off / outside project / own quarantine', () => {
  const dir = gitRepo({ tickets: T1 });
  try {
    writeFileSync(join(dir, 'test', 'x.mjs'), 'OVERWRITTEN\n');
    assert.equal(handleFileEdited({ file: join(dir, 'test', 'x.mjs'), root: dir, env: { ADLC_TICKET: 'T1' }, state: createWatcherState() }).actions.length, 0);
    assert.equal(handleFileEdited({ file: '/etc/hosts', root: dir, env: { ...ON }, state: createWatcherState() }).actions.length, 0);
    assert.equal(handleFileEdited({ file: join(dir, '.adlc', 'quarantine', 'x'), root: dir, env: { ...ON }, state: createWatcherState() }).actions.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- P5 fix: trust-root tampering under a conflicting active-ticket signal ----
test('spoofed .adlc/current-ticket.json (creating a conflict) is restored, not skipped', () => {
  const dir = gitRepo({ tickets: T1 });
  try {
    // Commit an initial current-ticket pointer so HEAD has the clean version.
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'pin ticket'], { cwd: dir, stdio: 'pipe' });
    // A spoof writes a DIFFERENT id — with ADLC_TICKET=T1 this creates a conflict.
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T2' }));
    const { actions } = handleFileEdited({ file: join(dir, '.adlc', 'current-ticket.json'), root: dir, env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' }, state: createWatcherState() });
    assert.equal(actions[0]?.check, 'rails');
    assert.equal(actions[0]?.action, 'restored');
    assert.match(actions[0].message, /conflicting active-ticket/);
    assert.equal(JSON.parse(readFileSync(join(dir, '.adlc', 'current-ticket.json'), 'utf8')).id, 'T1', 'trust root restored');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('symlink alias resolving to a trust root is restored under a conflict', () => {
  const dir = gitRepo({ tickets: T1 });
  try {
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
    // alias.json → .adlc/current-ticket.json, committed so HEAD has the clean target.
    symlinkSync(join(dir, '.adlc', 'current-ticket.json'), join(dir, 'alias.json'));
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'pin+alias'], { cwd: dir, stdio: 'pipe' });
    // Spoof the trust root THROUGH the alias, and report the alias path in the event.
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T2' })); // creates the conflict
    const { actions } = handleFileEdited({ file: join(dir, 'alias.json'), root: dir, env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' }, state: createWatcherState() });
    assert.equal(actions[0]?.check, 'rails');
    assert.equal(actions[0]?.action, 'restored');
    assert.match(actions[0].message, /trust root/);
    assert.equal(JSON.parse(readFileSync(join(dir, '.adlc', 'current-ticket.json'), 'utf8')).id, 'T1', 'resolved trust root restored, not the alias');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('non-trust-root edit under a conflict is left alone (no spurious restores)', () => {
  const dir = gitRepo({ tickets: T1 });
  try {
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T2' })); // conflict vs ADLC_TICKET=T1
    writeFileSync(join(dir, 'src', 'ok.mjs'), 'const x = 9;\n');
    const { actions } = handleFileEdited({ file: join(dir, 'src', 'ok.mjs'), root: dir, env: { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' }, state: createWatcherState() });
    assert.deepEqual(actions, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 2.4 suppression markers (advisory only — never auto-reverts) ----
test('added suppression marker → advisory warning; file is NOT reverted (no data loss)', () => {
  const dir = gitRepo({ tickets: T1 });
  try {
    const original = readFileSync(join(dir, 'src', 'ok.mjs'), 'utf8');
    const dirty = `${original}// ${TS_IGNORE}\nconst x = 1;\n`;
    writeFileSync(join(dir, 'src', 'ok.mjs'), dirty);
    const advisory = handleFileEdited({ file: join(dir, 'src', 'ok.mjs'), root: dir, env: { ...ON }, state: createWatcherState() });
    assert.equal(advisory.actions.length, 1);
    assert.equal(advisory.actions[0].check, 'suppression');
    assert.equal(advisory.actions[0].action, 'warned');
    assert.ok(advisory.actions[0].message.includes(TS_IGNORE));
    // The user's work (incl. the unrelated lines) is untouched — advisory, not destructive.
    assert.equal(readFileSync(join(dir, 'src', 'ok.mjs'), 'utf8'), dirty);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('suppression/scope never git-checkout (env "enforcement" flags do not revert unrelated work)', () => {
  const dir = gitRepo({ tickets: { tickets: [{ id: 'T1', rails: ['test/**'], scope: ['src/**'] }] } });
  try {
    const original = readFileSync(join(dir, 'src', 'ok.mjs'), 'utf8');
    const dirty = `${original}const unrelated = 'work in progress';\n// ${TS_IGNORE}\n`;
    writeFileSync(join(dir, 'src', 'ok.mjs'), dirty);
    // Even with the old opt-in flags set, no checkout happens — unrelated work survives.
    handleFileEdited({ file: join(dir, 'src', 'ok.mjs'), root: dir, env: { ...ON, ADLC_SUPPRESSION_ENFORCEMENT: '1', ADLC_SCOPE_ENFORCEMENT: '1' }, state: createWatcherState() });
    assert.equal(readFileSync(join(dir, 'src', 'ok.mjs'), 'utf8'), dirty, 'unrelated in-progress work preserved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ticket-allowed suppressions are not flagged', () => {
  const dir = gitRepo({ tickets: { tickets: [{ id: 'T1', rails: ['test/**'], scope: ['src/**'], allowedSuppressions: [TS_IGNORE] }] } });
  try {
    writeFileSync(join(dir, 'src', 'ok.mjs'), `const y = 2; // ${TS_IGNORE}\n`);
    const { actions } = handleFileEdited({ file: join(dir, 'src', 'ok.mjs'), root: dir, env: { ...ON }, state: createWatcherState() });
    assert.deepEqual(actions.filter((a) => a.check === 'suppression'), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('allowedSuppressions: ticket field + allow-suppression body lines (pi contract)', () => {
  const a = allowedSuppressions({ allowedSuppressions: [SKIP], body: `stuff\nallow-suppression: ${NOQA}\nmore` });
  assert.ok(a.has(SKIP));
  assert.ok(a.has(NOQA));
  assert.ok(!a.has(TS_IGNORE));
  assert.ok(SUPPRESSION_MARKERS.includes(TS_IGNORE)); // marker list sanity
});

// ---- 2.4 scope (advisory only) ----
test('out-of-scope edit → advisory warning; file untouched', () => {
  const dir = gitRepo({ tickets: { tickets: [{ id: 'T1', rails: ['test/**'], scope: ['src/**'] }] } });
  try {
    mkdirSync(join(dir, 'other'), { recursive: true });
    writeFileSync(join(dir, 'other', 'new.mjs'), 'const z = 3;\n');
    const advisory = handleFileEdited({ file: join(dir, 'other', 'new.mjs'), root: dir, env: { ...ON }, state: createWatcherState() });
    assert.equal(advisory.actions.length, 1);
    assert.equal(advisory.actions[0].check, 'scope');
    assert.equal(advisory.actions[0].action, 'warned');
    assert.equal(readFileSync(join(dir, 'other', 'new.mjs'), 'utf8'), 'const z = 3;\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- P5 fix: path traversal cannot skip the rail backstop ----
test('non-normalized traversal path resolving to a rail is still restored', () => {
  const dir = gitRepo({ tickets: T1 });
  try {
    writeFileSync(join(dir, 'test', 'x.mjs'), 'OVERWRITTEN\n');
    // A file.edited path that lexically starts with the quarantine dir but
    // resolves to a frozen rail must NOT be treated as an exempt quarantine write.
    const sneaky = join(dir, '.adlc', 'quarantine', '..', '..', 'test', 'x.mjs');
    const { actions } = handleFileEdited({ file: sneaky, root: dir, env: { ...ON }, state: createWatcherState() });
    assert.equal(actions[0]?.check, 'rails');
    assert.equal(actions[0]?.action, 'restored');
    assert.equal(readFileSync(join(dir, 'test', 'x.mjs'), 'utf8'), RAIL_CONTENT);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('in-scope and .adlc/ writes are not flagged; tickets without scope are exempt', () => {
  const dir = gitRepo({ tickets: T1 });
  try {
    writeFileSync(join(dir, 'src', 'ok.mjs'), 'const ok = 2;\n');
    assert.deepEqual(handleFileEdited({ file: join(dir, 'src', 'ok.mjs'), root: dir, env: { ...ON }, state: createWatcherState() }).actions, []);
    writeFileSync(join(dir, '.adlc', 'notes.json'), '{}');
    assert.deepEqual(handleFileEdited({ file: join(dir, '.adlc', 'notes.json'), root: dir, env: { ...ON }, state: createWatcherState() }).actions, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- end-to-end through the REAL event handler: synthetic third-party tool ----
test('handler: a write from an UNKNOWN tool (no before-hook interception) is restored via file.edited', async () => {
  const dir = gitRepo({ tickets: T1 });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    const toasts = [];
    const client = { tui: { showToast: async (req) => { toasts.push(req.body); } } };
    const hooks = await adlcRailsGuard({ worktree: dir, client });
    // Simulate a co-installed plugin's write tool the before-hook never saw:
    // the write simply LANDS, then OpenCode emits file.edited.
    writeFileSync(join(dir, 'test', 'x.mjs'), 'SPOOFED WRITE\n');
    await hooks.event({ event: { type: 'file.edited', properties: { file: join(dir, 'test', 'x.mjs') } } });
    assert.equal(readFileSync(join(dir, 'test', 'x.mjs'), 'utf8'), RAIL_CONTENT, 'rail restored');
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].message, /rails-backstop/);
    assert.equal(toasts[0].variant, 'error');
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

// ---- dormant permission.ask lever (2.1) ----
test('permission.ask (dormant): rail-target permission → status deny, both payload shapes', async () => {
  const dir = gitRepo({ tickets: T1 });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    const hooks = await adlcRailsGuard({ worktree: dir });
    // V1 shape: { type, pattern }
    const v1 = { status: 'ask' };
    await hooks['permission.ask']({ type: 'edit', pattern: 'test/x.mjs' }, v1);
    assert.equal(v1.status, 'deny');
    // V2 shape: { action, resources[] }
    const v2 = { status: 'ask' };
    await hooks['permission.ask']({ action: 'write', resources: ['test/x.mjs'] }, v2);
    assert.equal(v2.status, 'deny');
    // Non-rail target and read-type permissions untouched
    const ok = { status: 'ask' };
    await hooks['permission.ask']({ type: 'edit', pattern: 'src/ok.mjs' }, ok);
    assert.equal(ok.status, 'ask');
    const read = { status: 'ask' };
    await hooks['permission.ask']({ type: 'read', pattern: 'test/x.mjs' }, read);
    assert.equal(read.status, 'ask');
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});
