// Concern: AC6 — the cross-model-gate.yml workflow's #355 truncation-anchor wiring is
// structurally sound. Static assertions over the checked-in YAML text (not a live Actions
// run) so a future edit that silently drops one of these properties fails the build,
// rather than only being caught by re-reading the file by hand.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_PATH = join(new URL('../../../', import.meta.url).pathname, '.github/workflows/cross-model-gate.yml');
const text = readFileSync(WORKFLOW_PATH, 'utf8');

describe('cross-model-gate.yml — #355 truncation anchor structural properties (AC6)', () => {
  it('the mirror step runs and pushes BEFORE the gate step', () => {
    const mirrorIdx = text.indexOf('mirror-attestations');
    const pushIdx = text.indexOf('Push the updated attestation store');
    const gateIdx = text.indexOf('tier-check');
    assert.ok(mirrorIdx > -1 && pushIdx > -1 && gateIdx > -1, 'all three steps must be present');
    assert.ok(mirrorIdx < pushIdx, 'mirror must run before push');
    assert.ok(pushIdx < gateIdx, 'push must run before the gate step');
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
});
