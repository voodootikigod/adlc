// The systemd --user unit (spec §0.9, §9.3a, §9.1b unit rules; AC 13, 71, 136).
//
// `adlc-autopilot init --service` prints the unit and the `systemctl --user
// enable --now` line; it never writes outside the repository unless `--write`
// is passed. Every path is ABSOLUTE and literal (no `%h`), so a test can
// assert the lines byte for byte. Exactly one SSH auth mode is baked in:
// `--ssh-identity <abs>` on ExecStart (explicit mode, no SSH_AUTH_SOCK line) or
// `Environment=SSH_AUTH_SOCK=<abs>` (agent mode, no --ssh-identity) — never
// both, never neither.

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { validateRepoSpec } from './input.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['service.omitEnvironmentFile']);

export const UNIT_NAME = 'adlc-autopilot.service';

export class ServiceError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.exitCode = 1; }
}

/**
 * Validate the working directory at generation (and the loop re-validates at
 * start): it must contain `.git` and `.adlc/config.json`.
 */
export function assertWorkingDirectory(repoRoot, { exists = existsSync } = {}) {
  if (!repoRoot || !isAbsolute(repoRoot)) throw new ServiceError('bad-working-directory', 'WorkingDirectory must be absolute');
  if (!exists(join(repoRoot, '.git'))) throw new ServiceError('bad-working-directory', `${repoRoot} has no .git`);
  if (!exists(join(repoRoot, '.adlc', 'config.json'))) throw new ServiceError('bad-working-directory', `${repoRoot} has no .adlc/config.json`);
  return repoRoot;
}

/**
 * Render the unit text.
 * @param opts.repoRoot     absolute primary checkout (WorkingDirectory)
 * @param opts.nodePath     absolute node
 * @param opts.binPath      absolute packages/autopilot/bin/adlc-autopilot.mjs
 * @param opts.repo         owner/name (Environment=ADLC_AUTOPILOT_REPO=…)
 * @param opts.rest         rest duration token (default 10m)
 * @param opts.sshIdentity  absolute private key → explicit mode
 * @param opts.sshAuthSock  absolute socket → agent mode
 */
export function renderUnit({ repoRoot, nodePath, binPath, repo, rest = '10m', sshIdentity = null, sshAuthSock = null, exists = existsSync }) {
  assertWorkingDirectory(repoRoot, { exists });
  for (const [name, p] of [['node', nodePath], ['bin', binPath]]) {
    if (!p || !isAbsolute(p)) throw new ServiceError('bad-unit-path', `${name} path must be absolute`);
  }
  validateRepoSpec(repo, 'repo');
  if (sshIdentity && sshAuthSock) throw new ServiceError('ssh-mode-ambiguous', 'both --ssh-identity and SSH_AUTH_SOCK given');
  if (!sshIdentity && !sshAuthSock) throw new ServiceError('ssh-auth-missing', 'init --service needs an SSH agent socket or --ssh-identity');
  if (sshIdentity && !isAbsolute(sshIdentity)) throw new ServiceError('bad-unit-path', '--ssh-identity must be absolute');
  if (sshAuthSock && !isAbsolute(sshAuthSock)) throw new ServiceError('bad-unit-path', 'SSH_AUTH_SOCK must be absolute');
  if (/[\s%]/.test(repoRoot + nodePath + binPath + (sshIdentity ?? '') + (sshAuthSock ?? ''))) {
    throw new ServiceError('bad-unit-path', 'unit paths may not contain whitespace or % (systemd would expand or split them)');
  }
  const exec = `${nodePath} ${binPath} loop --rest ${rest}${sshIdentity ? ` --ssh-identity ${sshIdentity}` : ''}`;
  const lines = [
    '[Unit]',
    'Description=ADLC issue autopilot (quota-gated local issue-to-PR loop)',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${repoRoot}`,
    `ExecStart=${exec}`,
    // Mutation seam: a unit without the key file could never sign a manifest entry.
    ...(active('service.omitEnvironmentFile') ? [] : [`EnvironmentFile=${join(repoRoot, '.env.local')}`]),
    `Environment=ADLC_AUTOPILOT_REPO=${repo}`,
    ...(sshAuthSock ? [`Environment=SSH_AUTH_SOCK=${sshAuthSock}`] : []),
    'Restart=on-failure',
    'RestartSec=60',
    'KillMode=control-group',
    'TimeoutStopSec=120',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

/** The install instructions printed beside the unit. */
export function installInstructions({ unitPath }) {
  return [
    `# write the unit to ${unitPath} (init --service --write does this), then:`,
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${UNIT_NAME}`,
    `systemctl --user status ${UNIT_NAME}`,
  ].join('\n');
}

export function defaultUnitPath(home) {
  return join(home, '.config', 'systemd', 'user', UNIT_NAME);
}

/** Parse the ExecStart argv back out (for tests that spawn the unit's command against fakes). */
export function execStartArgv(unitText) {
  const line = unitText.split('\n').find((l) => l.startsWith('ExecStart='));
  if (!line) return null;
  return line.slice('ExecStart='.length).split(' ');
}
