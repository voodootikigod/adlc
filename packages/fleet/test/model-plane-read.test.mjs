// Bounded model-plane READ policy (fleet ticket AC12; autopilot spec §6.4, AC95, AC113).
//
// Two layers. The PURE layer (invariant + argv assembly) needs no sandbox binary
// and pins the policy as data. The REAL layer runs `/usr/bin/sh` scripts through
// a real bubblewrap profile and asserts what the process can and cannot see.
// The real layer SKIPS LOUDLY — with the reason — when bwrap is absent: a
// containment test that quietly passes because nothing enforced anything is
// worse than none.
//
// The in-sandbox shell is `/usr/bin/sh`, not `/bin/sh`: there is no root bind, and
// `/bin` (a merged-usr symlink on the host) is not one of the spec's fixed roots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { detectBackend } from '../lib/sandbox.mjs';
import { probeBwrap } from './helpers/bwrap-probe.mjs';
import {
  SYSTEM_ROOTS, classifyReadOnlyEntry, checkReadSetInvariant, buildBoundedModelPlaneArgv, BoundedModelSandbox,
} from '../lib/bounded-model-plane.mjs';

const backend = detectBackend();
const probe = probeBwrap();
const bwrapSkip = probe.ok ? false : `bounded model plane needs a USABLE bubblewrap; ${probe.reason}`;
const SH = '/usr/bin/sh';

const scratch = (prefix) => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
const spawnExec = (argv, opts) => spawnSync(argv[0], argv.slice(1), { ...opts, encoding: 'utf8' });

// A host layout the pure tests describe without touching a filesystem.
const HOME = '/home/op';
const FILES = new Set(['/home/op/.local/bin/claude', '/usr/bin/git', '/opt/fnm/node']);
const isFile = (p) => FILES.has(p);
const homeBinds = [
  { source: '/stage/credentials.json', target: `${HOME}/.claude/.credentials.json` },
  { source: '/stage/settings.json', target: `${HOME}/.claude/settings.json` },
  { source: '/home/op/.claude/plugins', target: `${HOME}/.claude/plugins` },
];
const scratchDirs = [`${HOME}/.claude/projects`, `${HOME}/.claude/todos`];

// ── classification ────────────────────────────────────────────────────────────

test('a SYSTEM_ROOT is bound whole, a regular file as a single file, anything else as a directory', () => {
  assert.equal(classifyReadOnlyEntry('/usr', { isFile }), 'system-root');
  assert.equal(classifyReadOnlyEntry('/usr/', { isFile }), 'system-root', 'a trailing slash does not change identity');
  assert.equal(classifyReadOnlyEntry('/home/op/.local/bin/claude', { isFile }), 'file');
  assert.equal(classifyReadOnlyEntry('/home/op/.local/bin', { isFile }), 'directory');
  assert.deepEqual([...SYSTEM_ROOTS], ['/usr', '/lib', '/lib64', '/etc/ssl', '/etc/resolv.conf', '/etc/hosts'],
    'the fixed root list is a security contract — widening it must be a visible diff');
});

// ── the invariant (spec §6.4; AC113; AC156's three-leaf rule) ─────────────────

test('a read-only entry that is an ancestor of (or equal to) a writable root is a violation', () => {
  const r = checkReadSetInvariant({ readOnlyPaths: ['/usr', '/srv'], writableRoots: ['/srv/wt'], home: HOME, homeBinds, isFile });
  assert.equal(r.ok, false);
  assert.match(r.violations.join('\n'), /\/srv equals or is an ancestor of writable root \/srv\/wt/);
  const eq = checkReadSetInvariant({ readOnlyPaths: ['/srv/wt'], writableRoots: ['/srv/wt'], home: HOME, homeBinds, isFile });
  assert.equal(eq.ok, false, 'equal counts as an ancestor');
});

test('HOME and /tmp are writable roots even when the caller does not list them', () => {
  for (const p of ['/', '/home', HOME, '/tmp']) {
    const r = checkReadSetInvariant({ readOnlyPaths: [p], writableRoots: [], home: HOME, homeBinds, isFile });
    assert.equal(r.ok, false, `${p} must be rejected`);
  }
});

test('/usr/bin/git with /usr in the set is REDUNDANT, not a violation (AC113)', () => {
  const r = checkReadSetInvariant({ readOnlyPaths: ['/usr', '/usr/bin/git'], writableRoots: ['/srv/wt'], home: HOME, homeBinds, isFile });
  assert.equal(r.ok, true, r.violations.join('\n'));
  assert.equal(r.redundant.length, 1);
  assert.match(r.redundant[0], /\/usr\/bin\/git is already covered by system root \/usr/);
});

test('~/.local/bin as a DIRECTORY entry is a violation when only ~/.local/bin/claude is pinned (AC113)', () => {
  const dir = checkReadSetInvariant({ readOnlyPaths: ['/usr', '/home/op/.local/bin'], writableRoots: ['/srv/wt'], home: HOME, homeBinds, isFile });
  assert.equal(dir.ok, false);
  assert.match(dir.violations.join('\n'), /\/home\/op\/\.local\/bin is a directory bind/);

  const file = checkReadSetInvariant({ readOnlyPaths: ['/usr', '/home/op/.local/bin/claude'], writableRoots: ['/srv/wt'], home: HOME, homeBinds, isFile });
  assert.equal(file.ok, true, file.violations.join('\n'));

  // With both present the directory exposes the pinned file's parent — the very
  // thing single-file binds exist to prevent — and is a violation even without isFile.
  const both = checkReadSetInvariant({ readOnlyPaths: ['/home/op/.local/bin', '/home/op/.local/bin/claude'], writableRoots: [], home: HOME, homeBinds });
  assert.equal(both.ok, false);
  assert.match(both.violations.join('\n'), /exposing the parent of \/home\/op\/\.local\/bin\/claude/);
});

test('the npm/corepack trees are the only permitted directory binds (allowedDirs)', () => {
  const npm = '/opt/fnm/lib/node_modules/npm';
  const r = checkReadSetInvariant({ readOnlyPaths: ['/usr', npm], writableRoots: [], home: HOME, homeBinds, isFile, allowedDirs: [npm] });
  assert.equal(r.ok, true, r.violations.join('\n'));
  const not = checkReadSetInvariant({ readOnlyPaths: ['/usr', npm], writableRoots: [], home: HOME, homeBinds, isFile });
  assert.equal(not.ok, false, 'the same tree without the allowance is a directory bind and is refused');
});

test('three homeBinds under HOME are accepted; a fourth read-only path under HOME is rejected (AC156)', () => {
  const ok = checkReadSetInvariant({ readOnlyPaths: ['/usr'], writableRoots: ['/srv/wt'], home: HOME, homeBinds, homeScratchDirs: scratchDirs, isFile });
  assert.equal(ok.ok, true, ok.violations.join('\n'));

  const fourth = checkReadSetInvariant({
    readOnlyPaths: ['/usr', `${HOME}/.claude/hooks`], writableRoots: ['/srv/wt'], home: HOME, homeBinds, homeScratchDirs: scratchDirs, isFile,
  });
  assert.equal(fourth.ok, false);
  assert.match(fourth.violations.join('\n'), /\.claude\/hooks lies inside writable root \/home\/op and is not an enumerated home bind/);

  // The ONE admitted shape under HOME: a pinned executable `isFile` attests
  // (the spec's own `~/.local/bin/claude` example lives under `$HOME`). Without
  // the attestation the same entry is refused — fail closed, not "probably a file".
  const pinned = checkReadSetInvariant({ readOnlyPaths: ['/usr', `${HOME}/.local/bin/claude`], writableRoots: ['/srv/wt'], home: HOME, homeBinds, homeScratchDirs: scratchDirs, isFile });
  assert.equal(pinned.ok, true, pinned.violations.join('\n'));
  const unattested = checkReadSetInvariant({ readOnlyPaths: ['/usr', `${HOME}/.local/bin/claude`], writableRoots: ['/srv/wt'], home: HOME, homeBinds, homeScratchDirs: scratchDirs });
  assert.equal(unattested.ok, false, 'no isFile → no file leaf is admitted under HOME');
  // A file leaf under any OTHER writable root (the worktree, the mirror) is still a violation.
  const inWt = checkReadSetInvariant({ readOnlyPaths: ['/usr', '/srv/wt/pinned'], writableRoots: ['/srv/wt'], home: HOME, homeBinds, isFile: () => true });
  assert.equal(inWt.ok, false);
});

test('a homeBinds entry outside HOME is rejected (AC156)', () => {
  const r = checkReadSetInvariant({
    readOnlyPaths: ['/usr'], writableRoots: [], home: HOME,
    homeBinds: [...homeBinds, { source: '/stage/x', target: '/etc/passwd' }], isFile,
  });
  assert.equal(r.ok, false);
  assert.match(r.violations.join('\n'), /home bind \/etc\/passwd is not under the synthetic HOME/);
  // Plain target strings (the `--json` echo shape) are accepted too.
  const s = checkReadSetInvariant({ readOnlyPaths: [], writableRoots: [], home: HOME, homeBinds: ['/elsewhere'] });
  assert.equal(s.ok, false);
});

test('a read-only bind of a scratch directory is rejected (AC156)', () => {
  const r = checkReadSetInvariant({
    readOnlyPaths: ['/usr'], writableRoots: [], home: HOME,
    homeBinds: [...homeBinds, { source: '/host/.claude/projects', target: `${HOME}/.claude/projects` }],
    homeScratchDirs: scratchDirs, isFile,
  });
  assert.equal(r.ok, false);
  assert.match(r.violations.join('\n'), /equals or is an ancestor of scratch directory \/home\/op\/\.claude\/projects/);
  // …and so is a bind ABOVE one (`.claude` itself), which would make every scratch dir read-only.
  const above = checkReadSetInvariant({
    readOnlyPaths: [], writableRoots: [], home: HOME, homeBinds: [{ source: '/h/.claude', target: `${HOME}/.claude` }], homeScratchDirs: scratchDirs,
  });
  assert.equal(above.ok, false);
});

test('duplicate entries are collapsed before the rules run', () => {
  const r = checkReadSetInvariant({ readOnlyPaths: ['/usr', '/usr/', '/usr'], writableRoots: [], home: HOME, homeBinds, isFile });
  assert.equal(r.ok, true, r.violations.join('\n'));
  assert.deepEqual(r.redundant, [], 'a duplicate of a root is not "covered by" itself');
});

// ── argv assembly (AC12 pure half; AC95) ─────────────────────────────────────

const argvOpts = {
  worktree: '/srv/wt', writableRoots: ['/srv/mirror.git'], readOnlyPaths: ['/usr', '/home/op/.local/bin/claude'],
  home: HOME, homeBinds, homeWritableFiles: [{ source: '/stage/claude.json', target: `${HOME}/.claude.json` }],
  homeScratchDirs: scratchDirs, isFile,
};
const pairs = (argv, flag) => argv.flatMap((a, i) => (a === flag ? [[argv[i + 1], argv[i + 2]]] : []));

test('the argv never binds the host root and binds each read-only entry as given', () => {
  const argv = buildBoundedModelPlaneArgv(argvOpts, ['claude', '-p', 'x']);
  assert.equal(argv[0], 'bwrap');
  assert.deepEqual(argv.slice(-4), ['--', 'claude', '-p', 'x']);
  const ro = pairs(argv, '--ro-bind');
  assert.ok(!ro.some(([s, d]) => s === '/' || d === '/'), 'NO --ro-bind / /');
  assert.ok(ro.some(([s, d]) => s === '/usr' && d === '/usr'));
  assert.ok(ro.some(([s, d]) => s === '/home/op/.local/bin/claude' && d === s), 'a FILE entry is bound as the file');
  assert.ok(!ro.some(([s]) => s === '/home/op/.local/bin'), 'never its parent directory');
  assert.ok(pairs(argv, '--bind').some(([s]) => s === '/srv/wt'), 'the worktree is a writable root');
  assert.ok(pairs(argv, '--bind').some(([s]) => s === '/srv/mirror.git'));
  assert.ok(argv.includes('--die-with-parent') && argv.includes('--proc') && argv.includes('--dev'));
});

test('a private tmpfs at /tmp with TMPDIR/TMP/TEMP inside it (AC95)', () => {
  const argv = buildBoundedModelPlaneArgv(argvOpts, ['true']);
  assert.ok(argv.join(' ').includes('--tmpfs /tmp --dir /tmp/fleet-tmp'));
  for (const v of ['TMPDIR', 'TMP', 'TEMP']) assert.ok(argv.join(' ').includes(`--setenv ${v} /tmp/fleet-tmp`), `${v} is set inside the tmpfs`);
  assert.throws(() => buildBoundedModelPlaneArgv({ ...argvOpts, tmpDir: '/var/tmp/x' }, ['true']), /TMPDIR .* is not under \/tmp/,
    'a TMPDIR outside the private tmpfs would land in a read-only bind or on the host');
});

test('--unshare-net appears only when requested; describe() reports the egress mode', () => {
  assert.ok(!buildBoundedModelPlaneArgv(argvOpts, ['true']).includes('--unshare-net'));
  assert.ok(buildBoundedModelPlaneArgv({ ...argvOpts, unshareNet: true }, ['true']).includes('--unshare-net'));
  const open = new BoundedModelSandbox({ backend: { name: 'bubblewrap' }, ...argvOpts });
  const closed = new BoundedModelSandbox({ backend: { name: 'bubblewrap' }, ...argvOpts, unshareNet: true });
  assert.equal(open.describe().egress, 'open');
  assert.equal(closed.describe().egress, 'allowlist');
  assert.equal(open.networkAllowed, true);
  assert.equal(closed.networkAllowed, false);
});

test('the HOME tmpfs precedes every HOME bind and scratch dir, and HOME is exported (order is the policy)', () => {
  const argv = buildBoundedModelPlaneArgv(argvOpts, ['true']);
  const at = (pred) => argv.findIndex(pred);
  const tmpfsHome = at((a, i) => a === '--tmpfs' && argv[i + 1] === HOME);
  assert.ok(tmpfsHome > 0, '--tmpfs <home> is present');
  assert.equal(argv[tmpfsHome - 2], '--perms', 'the tmpfs is 0700 (spec: "0700, the invoking uid")');
  assert.equal(argv[tmpfsHome - 1], '0700');
  for (const d of scratchDirs) assert.ok(at((a, i) => a === '--dir' && argv[i + 1] === d) > tmpfsHome, `${d} is created inside the tmpfs`);
  for (const b of homeBinds) {
    const i = at((a, j) => a === '--ro-bind' && argv[j + 1] === b.source && argv[j + 2] === b.target);
    assert.ok(i > tmpfsHome, `${b.target} is layered inside the tmpfs`);
  }
  const wr = at((a, i) => a === '--bind' && argv[i + 1] === '/stage/claude.json' && argv[i + 2] === `${HOME}/.claude.json`);
  assert.ok(wr > tmpfsHome, 'the writable HOME file is layered inside the tmpfs');
  // Binds of paths UNDER a tmpfs must follow it, or the tmpfs hides them: the
  // worktree and pinned tools commonly live under HOME or /tmp.
  const tmpfsTmp = at((a, i) => a === '--tmpfs' && argv[i + 1] === '/tmp');
  const firstBind = at((a) => a === '--ro-bind' || a === '--bind');
  assert.ok(firstBind > tmpfsHome && firstBind > tmpfsTmp, 'both tmpfs mounts precede every bind');
  assert.ok(argv.join(' ').includes(`--setenv HOME ${HOME}`));
});

test('a homeBinds target outside HOME throws at assembly time', () => {
  assert.throws(() => buildBoundedModelPlaneArgv({ ...argvOpts, homeBinds: [{ source: '/s', target: '/etc/x' }] }, ['true']), /not under/);
  assert.throws(() => buildBoundedModelPlaneArgv({ ...argvOpts, homeScratchDirs: ['/var/x'] }, ['true']), /scratch dir .* not under/);
});

test('BoundedModelSandbox refuses any backend but bubblewrap (fail closed)', () => {
  for (const backend of [{ name: 'seatbelt' }, null, undefined, { name: 'unshare' }]) {
    assert.throws(() => new BoundedModelSandbox({ backend, ...argvOpts }), /bounded model plane requires bubblewrap/);
  }
});

test('run() forwards the whole option bag and defaults cwd to the worktree; describe() echoes the policy', async () => {
  const calls = [];
  const sb = new BoundedModelSandbox({ backend: { name: 'bubblewrap' }, ...argvOpts, exec: (argv, opts) => { calls.push({ argv, opts }); return 'ran'; } });
  assert.equal(await sb.run(['claude'], { timeout: 5, input: 'prompt', env: { A: '1' } }), 'ran');
  assert.equal(calls[0].argv[0], 'bwrap');
  assert.deepEqual(calls[0].opts, { timeout: 5, input: 'prompt', env: { A: '1' }, cwd: '/srv/wt' });
  assert.deepEqual(sb.describe(), {
    readPolicy: 'bounded', privateTmp: true, readOnlyPaths: ['/usr', '/home/op/.local/bin/claude'],
    writableRoots: ['/srv/wt', '/srv/mirror.git'], homeBinds: homeBinds.map((b) => b.target), egress: 'open',
  });
  assert.equal(sb.canRead('/etc/passwd'), false);
  assert.equal(sb.canRead('/usr/bin/git'), true);
  assert.equal(sb.canWrite(`${HOME}/.claude/.credentials.json`), false, 'the read-only leaf is not writable');
  assert.equal(sb.canWrite(`${HOME}/.claude/projects/x`), true);
});

// ── REAL bwrap (AC12 / AC95 real half) ───────────────────────────────────────

function fixture() {
  const root = scratch('mp-read-');
  const worktree = join(root, 'wt');
  const home = join(root, 'home');
  const tools = join(root, 'tools');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, 'claude'), 'pinned');
  writeFileSync(join(tools, 'sibling'), 'sibling-secret');
  mkdirSync(join(root, 'outside'), { recursive: true });
  writeFileSync(join(root, 'outside', 'secret'), 'outside-secret');
  const sb = new BoundedModelSandbox({
    backend, worktree, home, readOnlyPaths: [...SYSTEM_ROOTS, join(tools, 'claude')], exec: spawnExec,
  });
  return { root, worktree, home, tools, sb };
}

test('inside the sandbox a pre-existing host /tmp file is absent and a /tmp write never reaches the host (AC95)', { skip: bwrapSkip }, async () => {
  const { root, sb } = fixture();
  const tag = randomBytes(6).toString('hex');
  const hostFile = join('/tmp', `fleet-host-${tag}`);
  const probe = join('/tmp', `fleet-probe-${tag}`);
  writeFileSync(hostFile, 'host');
  try {
    const res = await sb.run([SH, '-c', `if [ -e ${hostFile} ]; then echo present; else echo absent; fi; printf x > ${probe} && echo wrote`]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'absent\nwrote\n');
    assert.ok(!existsSync(probe), 'the write landed in the private tmpfs, not on the host');
  } finally { rmSync(hostFile, { force: true }); rmSync(probe, { force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('a single-file read-only entry exposes only that file — its sibling is ENOENT (AC12/AC95)', { skip: bwrapSkip }, async () => {
  const { root, tools, sb } = fixture();
  try {
    const ok = await sb.run([SH, '-c', `cat ${join(tools, 'claude')}`]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'pinned');
    const sib = await sb.run([SH, '-c', `cat ${join(tools, 'sibling')}`]);
    assert.notEqual(sib.status, 0);
    assert.match(sib.stderr, /No such file/);
    assert.equal(sib.stdout, '');
    // CONTROL: unwrapped, the sibling IS readable — otherwise the denial proves nothing.
    assert.equal(readFileSync(join(tools, 'sibling'), 'utf8'), 'sibling-secret');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a file outside the read set is unreadable, the worktree stays writable, TMPDIR is set inside', { skip: bwrapSkip }, async () => {
  const { root, worktree, sb } = fixture();
  try {
    const out = await sb.run([SH, '-c', `cat ${join(root, 'outside', 'secret')}`]);
    assert.notEqual(out.status, 0);
    assert.equal(out.stdout, '');
    const wt = await sb.run([SH, '-c', 'printf edit > src.txt && echo "$TMPDIR" && [ -d "$TMPDIR" ] && [ "$TMP" = "$TMPDIR" ] && [ "$TEMP" = "$TMPDIR" ]']);
    assert.equal(wt.status, 0, wt.stderr);
    assert.equal(wt.stdout, '/tmp/fleet-tmp\n');
    assert.equal(readFileSync(join(worktree, 'src.txt'), 'utf8'), 'edit', 'the worktree write landed on the host');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('inside the sandbox the HOST\'s processes are invisible: /proc is the sandbox\'s own (PID namespace), the orchestrator\'s pid does not exist there (AC95)', { skip: bwrapSkip }, async () => {
  const { root, sb } = fixture();
  try {
    const res = await sb.run([SH, '-c', `if [ -e /proc/${process.pid} ]; then echo visible; else echo hidden; fi; ls /proc | grep -c '^[0-9]' `]);
    assert.equal(res.status, 0, res.stderr);
    const [vis, count] = res.stdout.trim().split('\n');
    assert.equal(vis, 'hidden', "the orchestrator's pid is not in the sandbox's /proc");
    assert.ok(Number(count) <= 5, `only the sandbox's own handful of processes are listed (${count})`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
