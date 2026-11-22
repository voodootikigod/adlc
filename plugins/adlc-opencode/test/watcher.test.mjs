// watcher.test.mjs — Phases 2.4/2.5: the file.edited post-hoc watcher.
// Uses REAL git in a temp repo (the restore path is git-backed), plus the real
// exported event handler for the end-to-end synthetic third-party-tool proof.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleFileEdited, createWatcherState, allowedSuppressions, MAX_RESTORES_PER_FILE, SUPPRESSION_MARKERS } from '../lib/watcher.mjs';
import { loadPlugin, captureStderr, filesystemChanged } from './helpers/fake-ctx.mjs';

// Every fixture the factories below mint; removed once this file's tests finish.
const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

const RAIL_CONTENT = 'export const frozen = true;\n';
// Marker literals are concatenated so this test file does not trip the repo's
// rails-guard suppression scan on its own fixtures (runtime values are exact).
const TS_IGNORE = '@ts' + '-ignore';
const SKIP = '.sk' + 'ip(';
const NOQA = '# no' + 'qa';

function gitRepo({ tickets }) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-watch-'));
  fixtureDirs.add(dir);
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  tickets = structuredClone(tickets);
  for (const ticket of tickets.tickets ?? []) ticket.title ??= `${ticket.id} fixture`;
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify(tickets));
  writeFileSync(join(dir, 'test', 'x.mjs'), RAIL_CONTENT);
  writeFileSync(join(dir, 'src', 'ok.mjs'), 'export const ok = 1;\n');
  const git = (...args) => execFileSync('git', args, {
    cwd: dir,
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
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
    assert.equal(handleFileEdited({ file: join(dir, 'test', 'x.mjs'), root: dir, env: { ADLC_P4_ENFORCEMENT: '0', ADLC_TICKET: 'T1' }, state: createWatcherState() }).actions.length, 0);
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
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'pin ticket'], { cwd: dir, stdio: 'pipe' });
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
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'pin+alias'], { cwd: dir, stdio: 'pipe' });
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
test('handler: a write from an UNKNOWN tool (no before-hook interception) is restored via filesystem.changed', async () => {
  const dir = gitRepo({ tickets: T1 });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    const plugin = await loadPlugin({ root: dir });
    // Simulate a co-installed plugin's write tool the before-hook never saw:
    // the write simply LANDS, then OpenCode emits filesystem.changed.
    writeFileSync(join(dir, 'test', 'x.mjs'), 'SPOOFED WRITE\n');
    const { lines } = await captureStderr(() => plugin.emit(filesystemChanged(join(dir, 'test', 'x.mjs'), { directory: dir })));
    plugin.cleanup();
    assert.equal(readFileSync(join(dir, 'test', 'x.mjs'), 'utf8'), RAIL_CONTENT, 'rail restored');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[adlc\] error: .*rails-backstop/);
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

test('handler: DELETING a frozen tracked rail (unlink event) is restored from HEAD', async () => {
  const dir = gitRepo({ tickets: T1 });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    const plugin = await loadPlugin({ root: dir });
    rmSync(join(dir, 'test', 'x.mjs'));
    const { lines } = await captureStderr(() => plugin.emit(filesystemChanged(join(dir, 'test', 'x.mjs'), { event: 'unlink', directory: dir })));
    plugin.cleanup();
    assert.equal(readFileSync(join(dir, 'test', 'x.mjs'), 'utf8'), RAIL_CONTENT, 'deleted rail restored');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[adlc\] error: .*rails-backstop/);
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

test('handler: a deleted rail that CANNOT be restored is surfaced as a warning; out-of-scope deletions stay silent', async () => {
  const dir = gitRepo({ tickets: T1 });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    const plugin = await loadPlugin({ root: dir });
    const { lines } = await captureStderr(async () => {
      // not in HEAD, so `git checkout HEAD --` cannot bring it back
      await plugin.emit(filesystemChanged(join(dir, 'test', 'never-tracked.mjs'), { event: 'unlink', directory: dir }));
      // a plain out-of-scope file that is simply gone is not a rail problem
      await plugin.emit(filesystemChanged(join(dir, 'src', 'gone.mjs'), { event: 'unlink', directory: dir }));
    });
    plugin.cleanup();
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^\[adlc\] warning: .*could NOT restore test\/never-tracked\.mjs/);
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

test('handler: a filesystem event with no location and a RELATIVE path is not guessed onto this project', async () => {
  const dir = gitRepo({ tickets: T1 });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    const plugin = await loadPlugin({ root: dir });
    writeFileSync(join(dir, 'test', 'x.mjs'), 'SOMEONE ELSES WRITE\n');
    const { lines } = await captureStderr(() => plugin.emit(filesystemChanged('test/x.mjs', {})));
    plugin.cleanup();
    assert.equal(readFileSync(join(dir, 'test', 'x.mjs'), 'utf8'), 'SOMEONE ELSES WRITE\n', 'not restored: the event cannot be tied to this project');
    assert.deepEqual(lines, []);
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

test('handler: a RELATIVE path from a nested location is resolved against that location, not the project root', async () => {
  const dir = gitRepo({ tickets: T1 });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    // 'x.mjs' relative to <dir>/test is the frozen rail <dir>/test/x.mjs.
    const plugin = await loadPlugin({ root: dir });
    writeFileSync(join(dir, 'test', 'x.mjs'), 'SPOOFED WRITE\n');
    const { lines } = await captureStderr(() => plugin.emit(filesystemChanged('x.mjs', { directory: join(dir, 'test') })));
    assert.equal(readFileSync(join(dir, 'test', 'x.mjs'), 'utf8'), RAIL_CONTENT, 'restored via the nested location');
    assert.equal(lines.length, 1);
    // And a relative path that merely LOOKS like a rail under the root is not
    // mistaken for one: <dir>/src + 'x.mjs' is <dir>/src/x.mjs, not <dir>/x.mjs.
    writeFileSync(join(dir, 'src', 'x.mjs'), 'const fine = 1;\n');
    const quiet = await captureStderr(() => plugin.emit(filesystemChanged('x.mjs', { directory: join(dir, 'src') })));
    plugin.cleanup();
    assert.deepEqual(quiet.lines, []);
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

// ---- root resolution: v2 `location` has no `worktree`; the project root is `project.directory` ----
test('nested launch: rails resolve against the project root, not the launch directory', async () => {
  const dir = gitRepo({ tickets: T1 });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    const launchDir = join(dir, 'src');
    const plugin = await loadPlugin({ root: dir, launchDir });
    await assert.rejects(() => plugin.before('write', { filePath: join(dir, 'test', 'x.mjs') }), /rails-guard/, 'a frozen rail is still denied');
    // The host tags events with the directory OpenCode was launched in.
    writeFileSync(join(dir, 'test', 'x.mjs'), 'SPOOFED WRITE\n');
    const { lines } = await captureStderr(() => plugin.emit(filesystemChanged(join(dir, 'test', 'x.mjs'), { directory: launchDir })));
    plugin.cleanup();
    assert.equal(readFileSync(join(dir, 'test', 'x.mjs'), 'utf8'), RAIL_CONTENT, 'the watcher backstop works from the nested launch too');
    assert.equal(lines.length, 1);
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

test('a project directory that does not contain the launch directory is ignored (global project)', async () => {
  const dir = gitRepo({ tickets: T1 });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    for (const projectDir of ['/', '/somewhere/else']) {
      const plugin = await loadPlugin({ root: dir, projectDir });
      await assert.rejects(() => plugin.before('write', { filePath: join(dir, 'test', 'x.mjs') }), /rails-guard/, `projectDir=${projectDir}`);
      plugin.cleanup();
    }
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

// ---- permission.evaluate lever (2.1) ----
test('permission.evaluate: rail-target permission → effect deny with a message', async () => {
  const dir = gitRepo({ tickets: T1 });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    const plugin = await loadPlugin({ root: dir });
    const { result: hit } = await captureStderr(() => plugin.permission({ action: 'edit', resources: ['test/x.mjs'] }));
    assert.equal(hit.effect, 'deny');
    assert.match(hit.message, /ADLC rails-guard: denied permission "edit" — frozen rail/);
    // Non-rail target and read-type permissions untouched
    const ok = await plugin.permission({ action: 'edit', resources: ['src/ok.mjs'] });
    assert.equal(ok.effect, 'ask');
    const read = await plugin.permission({ action: 'read', resources: ['test/x.mjs'] });
    assert.equal(read.effect, 'ask');
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});
