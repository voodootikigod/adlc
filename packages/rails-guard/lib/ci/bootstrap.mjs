// The bootstrap-acknowledgement gate (#140).
//
// This step owns the questions that need GitHub Actions context and therefore never
// existed in scripts/rails-guard-ci.mjs: is the deployed workflow protected by
// CODEOWNERS, has the repo acknowledged the new-rail limitation on its BASE branch,
// and — in signed mode — is this actually running on the dedicated signed runner pool
// with an audited runner binary. It used to live only as an inline `node -e` block in
// docs/ci/rails-guard.yml, hand-mirrored and sha-pinned. It lives here now, and the
// template invokes it.
//
// Everything here fails CLOSED. A question this step cannot answer is never answered
// "fine" — an unverifiable bootstrap is exit 1, because the whole purpose is to refuse
// to be configured as a required check while its own preconditions are unproven.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fail } from './errors.mjs';
import { createGit, parseJson, resolveTrustedBase, trackedAt } from './git.mjs';
import { pathHasCodeowner } from './codeowners.mjs';
import { committedManifestAtHead } from './manifest.mjs';
import {
  assertArraySuperset,
  assertExistingSignersUnchanged,
  rejectNewSigners,
  validateNewSigners,
} from './json-contract.mjs';

// The workflow path this gate defends in a CONSUMING repo. It is the deployed copy that
// matters: GitHub runs the PR branch's workflow file for a same-repo pull_request, so an
// unowned deployed path means the gate cannot defend itself.
export const DEPLOYED_WORKFLOW_PATH = '.github/workflows/adlc-rails-guard.yml';

const VALID_SECURITY_MODES = ['signed', 'unsigned-fallback'];

// Subcommands an audited adlc-runner must expose. Probing them is a shape check on the
// binary at ADLC_RUNNER_PATH — it is NOT an authenticity check; the sha256 pin above it
// is. Both are defense in depth behind the runner-pool label.
const RUNNER_PROBE_SUBCOMMANDS = ['record', 'run', 'accept', 'upgrade'];

const RUNNER_PROBE_TIMEOUT_MS = 30_000;

/**
 * Verify the repo is bootstrapped and its trust preconditions hold.
 *
 * @param {object} options
 * @param {string} options.cwd repository root (the PR checkout)
 * @param {string} options.base base REF NAME, e.g. `origin/main`
 * @param {NodeJS.ProcessEnv} options.env
 * @returns {{messages: string[]}} informational lines for the caller to print
 * @throws {import('./errors.mjs').GateFail|import('./errors.mjs').GateDeny}
 */
export function runBootstrapCheck({ cwd, base, env }) {
  const git = createGit(cwd);
  const messages = [];

  const headConfigPath = join(cwd, '.adlc/config.json');
  if (!existsSync(headConfigPath)) {
    fail('missing .adlc/config.json; run /adlc-init before enabling this required check');
  }
  const head = parseJson(readFileSync(headConfigPath, 'utf8'), 'head .adlc/config.json');
  if (head.acknowledgedNewRailBypass !== true) {
    fail('missing acknowledgedNewRailBypass: true; acknowledge the new-rail limitation before using this as a required check');
  }
  if (!VALID_SECURITY_MODES.includes(head.securityMode)) fail('securityMode must be signed or unsigned-fallback');
  if (head.securityMode === 'unsigned-fallback' && head.signedEvidenceRequired === true) {
    fail('signedEvidenceRequired cannot be true in unsigned-fallback mode');
  }

  const trustedBase = resolveTrustedBase(git, base);
  const baseHasAdlc = trackedAt(git, trustedBase, '.adlc', 'git ls-tree base .adlc');
  const baseHasConfig = trackedAt(git, trustedBase, '.adlc/config.json', 'git ls-tree base config');

  // FIRST BOOTSTRAP: the base branch has no .adlc tree at all. This is the one PR that
  // is allowed to introduce the config, so it is judged on what it may NOT bring with it.
  if (!baseHasConfig && !baseHasAdlc) {
    // A DIFF question, not a filesystem one (#314): a gitignored untracked manifest in a
    // developer's tree is in zero commits and must not be read, or the local verdict
    // disagrees with CI's clean checkout.
    if (committedManifestAtHead(git).text.trim()) {
      fail('first bootstrap PR cannot introduce pre-populated .adlc/manifest.jsonl evidence');
    }
    if (head.securityMode === 'signed') {
      fail('bootstrap with securityMode signed requires the adlc-signed runner pool and ADLC_SIGNED_RUNNER_POOL=1 before enabling this as a required check; bootstrap in unsigned-fallback first, then upgrade through the protected-base runner ceremony');
    }
    if (head.signers !== undefined) validateNewSigners({}, head.signers);
    messages.push('bootstrap mode: base has no .adlc tree; merge this bootstrap commit before enabling the workflow as required, then configure CODEOWNERS protection before marking the check required.');
    return { messages };
  }

  // A base with a .adlc tree but no config is a half-bootstrapped repo — refuse rather
  // than guess which half is authoritative.
  if (!baseHasConfig) fail('base .adlc/config.json is absent; merge bootstrap config before enabling this required check');

  const showConfig = git(['show', `${trustedBase}:.adlc/config.json`], 'git show base config');
  if (showConfig.status !== 0) fail('git show failed for existing base config (operational) — failing closed');
  const trusted = parseJson(showConfig.stdout, 'base .adlc/config.json');

  // The attestation must ALREADY be on the base branch. A PR cannot assert that its own
  // repo is correctly protected — that is the claim under review.
  if (trusted.trustedCodeownersAttested !== true) {
    fail('base .adlc/config.json must set trustedCodeownersAttested: true after trusted-owner CODEOWNERS/ruleset review; this PR cannot self-attest workflow protection');
  }
  if (head.trustedCodeownersAttested !== true) fail('trustedCodeownersAttested cannot be removed in a PR');
  if (!pathHasCodeowner(git, trustedBase, DEPLOYED_WORKFLOW_PATH)) {
    fail(`missing CODEOWNERS entry protecting ${DEPLOYED_WORKFLOW_PATH}; configure trusted-owner review before enabling this required check`);
  }
  if (trusted.acknowledgedNewRailBypass !== true) {
    fail('acknowledgedNewRailBypass must already be set on the base branch; a PR cannot self-acknowledge this limitation');
  }
  if (!VALID_SECURITY_MODES.includes(trusted.securityMode)) {
    fail('base .adlc/config.json has an unrecognized securityMode; cannot verify downgrade safety');
  }
  if (trusted.securityMode === 'signed' && head.securityMode !== 'signed') {
    fail('cannot downgrade securityMode from signed to unsigned-fallback in a PR');
  }
  if (trusted.signedEvidenceRequired === true && head.signedEvidenceRequired !== true) {
    fail('cannot remove signedEvidenceRequired from a base config that requires it');
  }
  if (typeof trusted.runnerBinarySha256 === 'string' && head.runnerBinarySha256 !== trusted.runnerBinarySha256) {
    fail('runnerBinarySha256 cannot change in a PR; rotate it through the protected-base runner ceremony');
  }
  // Upgrading INTO signed mode grants the PR's code an execution surface on a privileged
  // runner. That is a protected-base ceremony, never a PR-side edit.
  if ((head.securityMode === 'signed' || head.signedEvidenceRequired === true)
    && trusted.securityMode !== 'signed' && trusted.signedEvidenceRequired !== true) {
    fail('signed mode upgrade requires a protected-base runner ceremony');
  }

  if (trusted.securityMode === 'signed' || trusted.signedEvidenceRequired === true) {
    verifySignedRunner({ trusted, env });
  }

  // .adlc/config.json is a rail trust root, so post-bootstrap signer changes require the
  // protected-base admin ceremony: existing identities are frozen, new ones are refused.
  if (trusted.signers !== undefined) assertExistingSignersUnchanged(trusted.signers, head.signers);
  if (head.signers !== undefined) rejectNewSigners(trusted.signers ?? {}, head.signers);
  assertArraySuperset('revokedKeys', trusted.revokedKeys, head.revokedKeys);
  assertArraySuperset('securitySensitivePatterns', trusted.securitySensitivePatterns, head.securitySensitivePatterns);
  if (typeof trusted.maxBundleAgeDays === 'number'
    && (typeof head.maxBundleAgeDays !== 'number' || head.maxBundleAgeDays > trusted.maxBundleAgeDays)) {
    fail('maxBundleAgeDays can only decrease or stay the same');
  }

  return { messages };
}

/**
 * Signed mode: prove we are on the dedicated runner pool and that the runner binary at
 * ADLC_RUNNER_PATH is the audited one.
 *
 * The runner-pool env check is a DEFENSE-IN-DEPTH SIGNAL ONLY — a self-hosted runner
 * controls its own environment, so the authoritative boundary is the `adlc-signed`
 * runner-pool label plus branch and workflow protection. What this adds that the label
 * cannot: content-addressed proof that the binary about to be executed is byte-identical
 * to the one the base config pinned.
 */
function verifySignedRunner({ trusted, env }) {
  if (env.RUNNER_ENVIRONMENT !== 'self-hosted' || env.ADLC_SIGNED_RUNNER_POOL !== '1') {
    fail('signed mode requires the dedicated adlc-signed self-hosted runner pool with ADLC_SIGNED_RUNNER_POOL=1');
  }
  const runnerPath = env.ADLC_RUNNER_PATH;
  if (!runnerPath) fail('signed mode requires ADLC_RUNNER_PATH to point to an audited adlc-runner binary');
  if (!isAbsolute(runnerPath)) fail('ADLC_RUNNER_PATH must be an absolute path');
  if (typeof trusted.runnerBinarySha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(trusted.runnerBinarySha256)) {
    fail('signed mode requires runnerBinarySha256 in base .adlc/config.json');
  }

  let runnerBytes;
  try {
    runnerBytes = readFileSync(runnerPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fail(`ADLC_RUNNER_PATH ${runnerPath} does not exist; is this job running on the dedicated signed-mode runner pool?`);
    }
    fail(`cannot read ADLC_RUNNER_PATH ${runnerPath}: ${error.message}`);
  }
  // Hash BEFORE executing anything, and execute a private COPY of the exact bytes that
  // hashed — not the original path, which a co-tenant could swap between the check and
  // the run.
  const digest = createHash('sha256').update(runnerBytes).digest('hex');
  if (digest.toLowerCase() !== trusted.runnerBinarySha256.toLowerCase()) {
    fail('ADLC_RUNNER_PATH sha256 does not match runnerBinarySha256');
  }

  let runnerTmpDir = '';
  try {
    runnerTmpDir = mkdtempSync(join(tmpdir(), 'adlc-runner-'));
    const runnerCopy = join(runnerTmpDir, 'adlc-runner');
    writeFileSync(runnerCopy, runnerBytes, { mode: 0o500 });
    chmodSync(runnerCopy, 0o500); // writeFileSync's mode is subject to umask; this is not

    // Keep the probe's environment and cwd narrow, while preserving the OS variables a
    // legitimate binary needs for homedir and temp resolution. Secrets and
    // repo-controlled files stay out of the probe context.
    const runnerEnv = {
      PATH: env.PATH || '',
      HOME: env.HOME || '',
      TMPDIR: env.TMPDIR || tmpdir(),
      USER: env.USER || '',
    };
    const probe = (args, label) => {
      const result = spawnSync(runnerCopy, args, {
        encoding: 'utf8',
        timeout: RUNNER_PROBE_TIMEOUT_MS,
        env: runnerEnv,
        cwd: runnerTmpDir,
      });
      if (result.error) fail(`${label}: ${result.error.message}`);
      if (result.signal) fail(`${label} timed out or was killed by ${result.signal}`);
      return result;
    };

    const version = probe(['--version'], 'signed mode requires ADLC_RUNNER_PATH to execute');
    if (version.status !== 0) fail('signed mode requires ADLC_RUNNER_PATH --version to exit 0');
    for (const subcommand of RUNNER_PROBE_SUBCOMMANDS) {
      const result = probe([subcommand, '--help'], `adlc-runner ${subcommand} probe failed`);
      if (result.status !== 0) fail(`signed mode requires adlc-runner ${subcommand} --help to exit 0`);
    }
  } finally {
    // Runs even when a probe fails closed above, so a failed run never leaves an
    // executable copy behind on a shared runner.
    if (runnerTmpDir) {
      try {
        rmSync(runnerTmpDir, { recursive: true, force: true });
      } catch {
        /* best effort — the verdict is already decided and must not change here */
      }
    }
  }
}
