import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTrustRootTier } from '../lib/tier.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('T-P06: expanded trust-root tier surfaces', () => {
  it('classifies all 7 harness plugin enforcement cores, rails-checkers, hooks.json, and hook-engine as trust-root', () => {
    const surfaces = [
      'plugins/adlc-pi/lib/rails-checker.mjs',
      'plugins/adlc-opencode/lib/plugin.mjs',
      'plugins/adlc-claude-code/hooks/adlc-hook.mjs',
      'plugins/adlc-codex/hooks/adlc-rails-guard.mjs',
      'plugins/adlc-copilot/hooks/adlc-rails-guard.mjs',
      'plugins/adlc-cursor/hooks/adlc-pretool.mjs',
      'plugins/adlc-gemini/hooks/adlc-rails-guard.bundle.mjs',
      'plugins/adlc-cursor/rails-checker.mjs',
      'plugins/adlc-opencode/rails-checker.mjs',
      'plugins/adlc-cursor/hooks.json',
      'plugins/adlc-gemini/hooks.json',
      'packages/hook-engine/lib/decide.mjs',
    ];
    for (const file of surfaces) {
      const r = classifyTrustRootTier({ changedFiles: [file] });
      assert.equal(r.isTrustRootTier, true, `${file} must classify as trust-root`);
      assert.ok(r.reasons.length > 0, `${file} must emit a trust-root reason`);
    }
  });

  it('classifies foundational enforcement dependencies packages/{core,tickets,hollow-test}/ as trust-root', () => {
    for (const file of [
      'packages/core/lib/shell.mjs',
      'packages/tickets/lib/service.mjs',
      'packages/hollow-test/lib/mutate.mjs',
    ]) {
      const r = classifyTrustRootTier({ changedFiles: [file] });
      assert.equal(r.isTrustRootTier, true, `${file} must classify as trust-root`);
    }
    // Test-only changes inside enforcement prefixes stay exempt
    for (const testFile of [
      'packages/core/test/shell.test.mjs',
      'packages/tickets/test/service.test.mjs',
      'packages/hollow-test/test/mutate.test.mjs',
      'plugins/adlc-codex/hooks/test/guard.test.mjs',
    ]) {
      const r = classifyTrustRootTier({ changedFiles: [testFile] });
      assert.equal(r.isTrustRootTier, false, `test-only ${testFile} should remain exempt`);
    }
  });

  it('classifies required CI gate scripts and declarations as trust-root', () => {
    const scripts = [
      'scripts/mutation-gate.mjs',
      'scripts/run-tests.mjs',
      'scripts/preflight-fast.mjs',
      'scripts/build-hooks.mjs',
      'scripts/scan-findings-ledger.mjs',
      'scripts/guard-findings-ledger-append-only.mjs',
      'packages/lesson-foundry/bin/ledger-guard.mjs',
      'packages/lesson-foundry/lib/ledger-guard.mjs',
      'scripts/gate-liveness.mjs',
      'docs/ci/required-gates.json',
    ];
    for (const file of scripts) {
      const r = classifyTrustRootTier({ changedFiles: [file] });
      assert.equal(r.isTrustRootTier, true, `${file} must classify as trust-root`);
      assert.ok(r.reasons.some((x) => x.includes(file)), `reason must cite ${file}`);
    }
  });

  it('classifies nested workspace package.json manifests and .adlc/{lessons,lenses}/ unconditionally', () => {
    for (const file of [
      'packages/parallax/package.json',
      'plugins/adlc-cursor/package.json',
      '.adlc/lessons/security.md',
      '.adlc/lenses/correctness.md',
      '.adlc/lessons/test/case.md',
    ]) {
      const r = classifyTrustRootTier({ changedFiles: [file] });
      assert.equal(r.isTrustRootTier, true, `${file} must classify as trust-root`);
    }
    // Ordinary non-trust-root files remain false
    for (const file of [
      'packages/parallax/lib/prompts.mjs',
      'plugins/adlc-cursor/README.md',
      '.adlc/specs/example.md',
    ]) {
      const r = classifyTrustRootTier({ changedFiles: [file] });
      assert.equal(r.isTrustRootTier, false, `${file} must NOT classify as trust-root`);
    }
  });

  it('ticket-store-platform.yml uses npm ci --ignore-scripts instead of bare npm install', () => {
    const wf = readFileSync(join(REPO_ROOT, '.github/workflows/ticket-store-platform.yml'), 'utf8');
    assert.match(wf, /run:\s*npm ci --ignore-scripts/);
    assert.doesNotMatch(wf, /run:\s*npm install\b/);
  });
});
