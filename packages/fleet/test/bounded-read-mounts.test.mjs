import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSandboxBinary } from '@adlc/core';
import { SafeSandbox, resolveFleetSandboxLauncher } from '../lib/safe-sandbox.mjs';
import { SANDBOX_MODES, NETWORK, READ_POLICY } from '../lib/sandbox.mjs';
import { defaultBoundedReadOnlyPaths, defaultIo } from '../lib/live-deps.mjs';

test('SafeSandbox.wrap mounts /dev, /proc, /tmp and readOnlyPaths on Linux bubblewrap BOUNDED policy', () => {
  const sb = new SafeSandbox({
    mode: SANDBOX_MODES.SANDBOX,
    backend: { name: 'bubblewrap' },
    worktree: '/w/t',
    syntheticHome: '/w/t/.home',
    readOnlyPaths: ['/usr', '/etc'],
    network: NETWORK.DENY,
    readPolicy: READ_POLICY.BOUNDED,
  });
  const argv = sb.wrap(['echo', 'hi']);
  const s = argv.join(' ');
  assert.equal(argv[0], 'bwrap');
  assert.ok(argv.includes('--unshare-net'));
  assert.ok(argv.includes('--unshare-pid'));
  assert.ok(argv.includes('--unshare-ipc'));
  assert.ok(argv.includes('--unshare-uts'));
  assert.ok(s.includes('--dev /dev --proc /proc --tmpfs /tmp'));
  assert.ok(s.includes('--bind /w/t /w/t'));
  assert.ok(s.includes('--bind /w/t/.home /w/t/.home'));
  assert.ok(s.includes('--ro-bind /usr /usr'));
  assert.ok(s.includes('--ro-bind /etc /etc'));
  assert.ok(s.includes('--setenv HOME /w/t/.home'));
  assert.deepEqual(argv.slice(-3), ['--', 'echo', 'hi'].slice(0, 3));
  const bad = new SafeSandbox({
    mode: SANDBOX_MODES.SANDBOX, backend: { name: 'bubblewrap' }, worktree: '/w/t',
    readOnlyPaths: ['relative'], readPolicy: READ_POLICY.BOUNDED,
  });
  assert.throws(() => bad.wrap(['echo']), TypeError);

  const hostPolicy = new SafeSandbox({
    mode: SANDBOX_MODES.SANDBOX, backend: { name: 'bubblewrap' }, worktree: '/w/t',
    readOnlyPaths: ['/usr'], readPolicy: READ_POLICY.HOST,
  });
  assert.ok(hostPolicy.wrap(['echo']).join(' ').includes('--ro-bind / /'));

  const nonBwrapBounded = new SafeSandbox({
    mode: SANDBOX_MODES.SANDBOX, backend: { name: 'other' }, worktree: '/w/t',
    readOnlyPaths: ['/usr'], readPolicy: READ_POLICY.BOUNDED,
  });
  assert.throws(() => nonBwrapBounded.wrap(['echo']));
});

test('defaultBoundedReadOnlyPaths populates existing runtime roots outside HOME and rejects HOME or root prefixes', () => {
  const present = new Set(['/usr', '/etc', '/opt/x', '/n/bin/node-root']);
  const out = defaultBoundedReadOnlyPaths({
    exists: (p) => present.has(p),
    execPath: '/n/bin/node-root/bin/node',
    homeDir: '/home/alice',
    extra: ['/opt/x', '/usr', '/missing'],
  });
  assert.deepEqual(out, ['/usr', '/etc', '/n/bin/node-root', '/opt/x']);

  // $HOME/bin/node and $HOME/.local/bin/node must never mount $HOME or $HOME/.local
  const allExist = () => true;
  const homeBin = defaultBoundedReadOnlyPaths({
    exists: allExist,
    realpath: (p) => p,
    execPath: '/home/alice/bin/node',
    homeDir: '/home/alice',
  });
  assert.ok(!homeBin.includes('/home/alice'), '$HOME must never be mounted');
  assert.ok(!homeBin.some((p) => p.startsWith('/home/alice')));

  const localBin = defaultBoundedReadOnlyPaths({
    exists: allExist,
    realpath: (p) => p,
    execPath: '/home/alice/.local/bin/node',
    homeDir: '/home/alice',
  });
  assert.ok(!localBin.includes('/home/alice/.local'), '$HOME/.local must never be mounted');
  assert.ok(!localBin.some((p) => p.startsWith('/home/alice')));

  // Symlinked /opt/bin/node -> /home/alice/.local/bin/node is resolved and rejected too
  const symlinkedHome = defaultBoundedReadOnlyPaths({
    exists: allExist,
    realpath: (p) => (p === '/opt/bin/node' ? '/home/alice/.local/bin/node' : p),
    execPath: '/opt/bin/node',
    homeDir: '/home/alice',
  });
  assert.ok(!symlinkedHome.some((p) => p.startsWith('/home/alice')));

  // /bin/node derives '/' which must never be mounted as a whole-filesystem bind
  const rootBin = defaultBoundedReadOnlyPaths({
    exists: allExist,
    realpath: (p) => p,
    execPath: '/bin/node',
    homeDir: '/home/alice',
  });
  assert.ok(!rootBin.includes('/'));

  // Empty execPath or empty homeDir handled cleanly
  const emptyExec = defaultBoundedReadOnlyPaths({ exists: (p) => p === '/usr', execPath: '', homeDir: '/home/alice' });
  assert.deepEqual(emptyExec, ['/usr']);
  const emptyHome = defaultBoundedReadOnlyPaths({
    exists: (p) => p === '/usr' || p === '/opt/node',
    realpath: (p) => p,
    execPath: '/opt/node/bin/node',
    homeDir: '',
  });
  assert.deepEqual(emptyHome, ['/usr', '/opt/node']);
});

test('SafeSandbox.run and defaultIo().spawnWorker reject PATH-shadowing fake bwrap and execute root-owned launcher by absolute path', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fleet-bwrap-shadow-'));
  try {
    const fakeBin = join(scratch, 'bin');
    const marker = join(scratch, 'pwned');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'bwrap'), `#!/bin/sh\necho pwned > "${marker}"\nexit 0\n`, { mode: 0o755 });

    assert.equal(resolveFleetSandboxLauncher({ name: 'bubblewrap' }, { pathEnv: fakeBin }), null);
    assert.equal(resolveFleetSandboxLauncher({ name: 'other' }, { pathEnv: '/usr/bin' }), null);
    assert.equal(resolveFleetSandboxLauncher({ name: 'bubblewrap', launcherPath: '/usr/bin/bwrap' }), '/usr/bin/bwrap');

    const rootFsOps = {
      lstatSync: (p) => p.startsWith(fakeBin) ? { uid: 1000, mode: 0o100755 } : { uid: 0, mode: 0o100755 },
      realpathSync: (p) => p,
      statSync: (p) => p.startsWith(fakeBin)
        ? { uid: 1000, mode: 0o100755, isFile: () => p.endsWith('bwrap') || p.endsWith('sandbox-exec') }
        : { uid: 0, mode: (p.endsWith('bwrap') || p.endsWith('sandbox-exec')) ? 0o100755 : 0o40755, isFile: () => p.endsWith('bwrap') || p.endsWith('sandbox-exec') },
    };
    assert.equal(resolveFleetSandboxLauncher({ name: 'seatbelt' }, { pathEnv: `${fakeBin}:/trusted/bin`, fsOps: rootFsOps }), '/trusted/bin/sandbox-exec');

    let capturedArgv = null;
    const sb = new SafeSandbox({
      mode: SANDBOX_MODES.SANDBOX,
      backend: { name: 'bubblewrap' },
      launcherPath: resolveFleetSandboxLauncher({ name: 'bubblewrap' }, { pathEnv: `${fakeBin}:/trusted/bin`, fsOps: rootFsOps }),
      worktree: scratch,
      syntheticHome: scratch,
      readOnlyPaths: ['/usr'],
      readPolicy: READ_POLICY.BOUNDED,
      exec: async (argv) => { capturedArgv = argv; return 'ok'; },
    });
    await sb.run(['echo', 'hi']);
    assert.equal(capturedArgv[0], '/trusted/bin/bwrap');

    const hostSb = new SafeSandbox({
      mode: SANDBOX_MODES.SANDBOX,
      backend: { name: 'bubblewrap', launcherPath: '/trusted/bin/bwrap' },
      worktree: scratch,
      readPolicy: READ_POLICY.HOST,
    });
    const hostWrapped = hostSb.wrap(['echo']);
    assert.equal(hostWrapped[0], '/trusted/bin/bwrap');
    assert.equal(hostWrapped[1], '--unshare-net');
    const sbExecPinned = new SafeSandbox({
      mode: SANDBOX_MODES.SANDBOX,
      backend: { name: 'seatbelt', launcherPath: '/trusted/bin/sandbox-exec' },
      worktree: scratch,
    });
    assert.equal(sbExecPinned.wrap(['echo'])[0], '/trusted/bin/sandbox-exec');

    const unresolvable = new SafeSandbox({
      mode: SANDBOX_MODES.SANDBOX,
      backend: { name: 'bubblewrap' },
      worktree: scratch,
      pathEnv: fakeBin,
    });
    await assert.rejects(() => unresolvable.run(['echo', 'hi']), /No trusted root-owned sandbox binary found/);

    const io = defaultIo();
    const shadowRes = await io.spawnWorker('bwrap', ['--version'], { env: { PATH: fakeBin } });
    assert.ok(shadowRes.error, 'defaultIo().spawnWorker must refuse untrusted PATH bwrap');
    assert.equal(shadowRes.timedOut, false);
    assert.equal(existsSync(marker), false, 'fake bwrap must never be executed');

    const plainRes = await io.spawnWorker(process.execPath, ['-e', 'process.stdout.write("plain-ok")']);
    assert.equal(plainRes.status, 0);
    assert.equal(plainRes.stdout, 'plain-ok');

    if (resolveSandboxBinary('bwrap')) {
      const okBwrap = await io.spawnWorker('bwrap', ['--ro-bind', '/', '/', '--', 'true'], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      });
      assert.equal(okBwrap.status, 0);
      assert.equal(existsSync(marker), false);

      const realBounded = new SafeSandbox({
        mode: SANDBOX_MODES.SANDBOX,
        backend: { name: 'bubblewrap' },
        worktree: scratch,
        syntheticHome: scratch,
        readOnlyPaths: defaultBoundedReadOnlyPaths(),
        network: NETWORK.DENY,
        readPolicy: READ_POLICY.BOUNDED,
      });
      const pidOut = await realBounded.run([
        '/bin/sh',
        '-c',
        `if [ -e "/proc/${process.pid}/environ" ]; then printf visible; else printf hidden; fi`,
      ]);
      assert.equal(String(pidOut).trim(), 'hidden', 'host PID environ must not be visible inside BOUNDED PID namespace');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
