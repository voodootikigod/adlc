// AC 13 / 71 / 136 (unit half) — the generated systemd unit: parses as a unit,
// line-anchored absolute paths, EnvironmentFile, Restart=on-failure,
// KillMode=control-group, no %h, no inline key, exactly one SSH auth mode.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { renderUnit, assertWorkingDirectory, execStartArgv, installInstructions, ServiceError, UNIT_NAME } from '../lib/service.mjs';

const exists = (p) => /\.git$|config\.json$/.test(p);
const base = { repoRoot: '/srv/adlc', nodePath: '/opt/node/bin/node', binPath: '/srv/adlc/packages/autopilot/bin/adlc-autopilot.mjs', repo: 'voodootikigod/adlc', exists };

export function ac13_unitShape() {
  const unit = renderUnit({ ...base, sshAuthSock: '/run/user/1000/ssh-agent.sock' });
  assert.match(unit, /^\[Unit\]\n/); assert.match(unit, /\n\[Service\]\n/); assert.match(unit, /\n\[Install\]\n/);
  assert.match(unit, /^EnvironmentFile=\/srv\/adlc\/\.env\.local$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.ok(!/ADLC_MANIFEST_KEY/.test(unit), 'no inline key — the key comes from EnvironmentFile');
  assert.ok(!/%h/.test(unit), 'no %h expansion');
}
test('AC13: init --service output parses as a unit with EnvironmentFile=, Restart=on-failure and no inline key (line-anchored)', ac13_unitShape);

export function ac71_absolutePathsAndModes() {
  const agent = renderUnit({ ...base, sshAuthSock: '/run/user/1000/ssh-agent.sock' });
  assert.match(agent, /^WorkingDirectory=\/srv\/adlc$/m);
  assert.match(agent, /^ExecStart=\/opt\/node\/bin\/node \/srv\/adlc\/packages\/autopilot\/bin\/adlc-autopilot\.mjs loop --rest 10m$/m);
  assert.match(agent, /^Environment=SSH_AUTH_SOCK=\/run\/user\/1000\/ssh-agent\.sock$/m);
  assert.match(agent, /^Environment=ADLC_AUTOPILOT_REPO=voodootikigod\/adlc$/m);
  assert.match(agent, /^KillMode=control-group$/m); assert.match(agent, /^TimeoutStopSec=120$/m); assert.match(agent, /^RestartSec=60$/m);
  assert.ok(!/--ssh-identity/.test(agent), 'agent mode carries no --ssh-identity');
  const explicit = renderUnit({ ...base, sshIdentity: '/home/op/.ssh/id_ed25519' });
  assert.match(explicit, /^ExecStart=.* loop --rest 10m --ssh-identity \/home\/op\/\.ssh\/id_ed25519$/m);
  assert.ok(!/SSH_AUTH_SOCK/.test(explicit), 'explicit mode carries no SSH_AUTH_SOCK line');
  assert.deepEqual(execStartArgv(explicit).slice(2), ['loop', '--rest', '10m', '--ssh-identity', '/home/op/.ssh/id_ed25519']);
  assert.throws(() => renderUnit({ ...base }), (e) => e instanceof ServiceError && e.code === 'ssh-auth-missing');
  assert.throws(() => renderUnit({ ...base, sshIdentity: '/k', sshAuthSock: '/s' }), (e) => e.code === 'ssh-mode-ambiguous');
  assert.throws(() => renderUnit({ ...base, exists: (p) => /\.git$/.test(p), sshAuthSock: '/s' }), (e) => e.code === 'bad-working-directory');
  assert.throws(() => assertWorkingDirectory('relative/path'), (e) => e.code === 'bad-working-directory');
  assert.throws(() => renderUnit({ ...base, nodePath: 'node', sshAuthSock: '/s' }), (e) => e.code === 'bad-unit-path');
  assert.match(installInstructions({ unitPath: '/x' }), new RegExp(`enable --now ${UNIT_NAME}`));
}
test('AC71: WorkingDirectory/ExecStart/EnvironmentFile are absolute and literal; explicit vs agent mode is exclusive; a missing .adlc/config.json is bad-working-directory', ac71_absolutePathsAndModes);
