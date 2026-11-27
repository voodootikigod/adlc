// Concern: AC6 — the cross-model-gate.yml workflow's #355 truncation-anchor wiring is
// structurally sound. Static assertions over the checked-in YAML text (not a live Actions
// run) so a future edit that silently drops one of these properties fails the build,
// rather than only being caught by re-reading the file by hand.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_PATH = join(new URL('../../../', import.meta.url).pathname, '.github/workflows/cross-model-gate.yml');
const BIN_PATH = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
const text = readFileSync(WORKFLOW_PATH, 'utf8');

describe('cross-model-gate.yml — #355 truncation anchor structural properties (AC6)', () => {
  it('the mirror+push step runs BEFORE the gate step', () => {
    const mirrorIdx = text.indexOf('mirror-attestations');
    const pushIdx = text.indexOf('git -C ./_attestations push origin');
    const gateIdx = text.lastIndexOf('tier-check');
    assert.ok(mirrorIdx > -1 && pushIdx > -1 && gateIdx > -1, 'all three steps must be present');
    assert.ok(mirrorIdx < pushIdx, 'mirror must run before push');
    assert.ok(pushIdx < gateIdx, 'push must run before the gate step');
  });

  it('bootstrap (no file ever created) is not a git-add error (round-1 codex finding)', () => {
    assert.match(text, /if \[ -f \.\/_attestations\/attestations\.jsonl \]; then/);
  });

  it('a push rejected by a concurrent PR is retried against the fresh tip, not treated as fatal (round-1 codex finding)', () => {
    assert.match(text, /for attempt in 1 2 3 4 5; do/);
    assert.match(text, /git -C \.\/_attestations fetch origin adlc-attestations/);
    assert.match(text, /git -C \.\/_attestations reset --hard origin\/adlc-attestations/);
  });

  it('grants contents: write (needed only for the mirror-push step)', () => {
    assert.match(text, /permissions:\s*\n\s*contents:\s*write/);
  });

  it('has a concurrency block keyed by PR number, with cancel-in-progress: false, and never keys on github.ref', () => {
    assert.match(text, /concurrency:\s*\n\s*group:.*github\.event\.pull_request\.number/);
    assert.match(text, /cancel-in-progress:\s*false/);
    assert.doesNotMatch(text, /group:.*\$\{\{\s*github\.ref\s*\}\}/, 'the concurrency group must not alias to the base ref under pull_request_target');
  });

  it('the mirror-push step never masks a genuine push failure', () => {
    assert.doesNotMatch(text, /continue-on-error:\s*true/);
    assert.doesNotMatch(text, /git push[^\n]*\|\|\s*true/);
  });

  it('the attestation store lives OUTSIDE ./_pr (never nested inside the materialized PR tree)', () => {
    assert.doesNotMatch(text, /_pr\/_attestations/);
    assert.match(text, /GITHUB_WORKSPACE\/_attestations\/attestations\.jsonl/);
  });

  it('the gate step passes --attestation-store pointing at the mirrored store', () => {
    const gateInvocation = text.slice(text.lastIndexOf('tier-check \\'));
    assert.match(gateInvocation.slice(0, 300), /--attestation-store "\$GITHUB_WORKSPACE\/_attestations\/attestations\.jsonl"/);
  });

  it('no longer names #355 as an open follow-up', () => {
    assert.doesNotMatch(text, /truncation is tracked follow-up/i);
  });

  it('does not persist a write-capable credential before npm ci runs (round-3 codex finding)', () => {
    const checkoutIdx = text.indexOf('actions/checkout');
    const npmCiIdx = text.indexOf('run: npm ci'); // the actual invocation, not an incidental mention
    const persistIdx = text.indexOf('persist-credentials: false');
    const credentialSetupIdx = text.indexOf('AUTHORIZATION: basic');
    assert.ok(checkoutIdx > -1 && npmCiIdx > -1 && persistIdx > -1 && credentialSetupIdx > -1);
    assert.ok(checkoutIdx < persistIdx && persistIdx < npmCiIdx, 'persist-credentials: false must apply to the checkout BEFORE npm ci runs');
    assert.ok(npmCiIdx < credentialSetupIdx, 'the write-capable credential must not be configured until after npm ci has already run');
  });

  it('mirror-attestations only runs after a scoped credential is configured, not before', () => {
    const credentialSetupIdx = text.indexOf('AUTHORIZATION: basic');
    const mirrorRunIdx = text.indexOf('mirror-attestations');
    assert.ok(credentialSetupIdx > -1 && mirrorRunIdx > -1 && credentialSetupIdx < mirrorRunIdx);
  });

  it('passes --trusted-dir "$GITHUB_WORKSPACE/.adlc" to both mirror-attestations and tier-check', () => {
    const mirrorInvocation = text.slice(text.indexOf('mirror-attestations \\'));
    assert.match(mirrorInvocation.slice(0, 300), /--trusted-dir "\$GITHUB_WORKSPACE\/\.adlc"/);
    const gateInvocation = text.slice(text.lastIndexOf('tier-check \\'));
    assert.match(gateInvocation.slice(0, 300), /--trusted-dir "\$GITHUB_WORKSPACE\/\.adlc"/);
  });

  it('never references secrets.ADLC_MANIFEST_PRIVATE_KEY or passes ADLC_MANIFEST_PRIVATE_KEY to CI verification', () => {
    assert.doesNotMatch(text, /secrets\.ADLC_MANIFEST_PRIVATE_KEY/);
    assert.doesNotMatch(text, /\bADLC_MANIFEST_PRIVATE_KEY\b/);
  });

  it('maintains CLI flag parity between cross-model-gate.yml and adlc-prosecute --help / parseArgs', () => {
    const binSource = readFileSync(BIN_PATH, 'utf8');
    const helpOut = execFileSync(process.execPath, [BIN_PATH, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, ADLC_MANIFEST_KEY: '', ADLC_MANIFEST_PRIVATE_KEY: '' },
    });
    for (const flag of ['trusted-dir', 'attestation-store', 'base', 'author-provider', 'dir']) {
      assert.match(binSource, new RegExp(`['"]?${flag}['"]?\\s*:`));
      assert.match(helpOut, new RegExp(`--${flag}\\b`));
    }
  });
});
