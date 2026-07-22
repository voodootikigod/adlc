// prosecutor-lens-dedup.test.mjs — issue #276: the 5 lens agent files must
// carry only their differentiator (lens focus), not the ~85% shared
// boilerplate (refute charter, output schema, tool constraints) that now
// lives once in commands/adlc-prosecute.md step 1. And the trust-root tier
// explanation must exist in exactly one canonical file, not triplicated
// across SKILL.md / prosecutor.md / adlc-prosecute.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..', '..');

const LENS_FILES = [
  'prosecutor-correctness.md',
  'prosecutor-security.md',
  'prosecutor-contract.md',
  'prosecutor-diff.md',
  'prosecutor-tests.md',
].map((f) => join(PLUGIN_ROOT, 'agents', f));

function read(path) {
  return readFileSync(path, 'utf8');
}

/**
 * Every substring of `len` characters that appears in `text`. Used to find
 * the longest common substring between two files without pulling in a diff
 * library — a sliding window plus a Set is enough at this file size.
 */
function hasCommonSubstring(a, b, len) {
  const windows = new Set();
  for (let i = 0; i + len <= a.length; i++) windows.add(a.slice(i, i + len));
  for (let i = 0; i + len <= b.length; i++) {
    if (windows.has(b.slice(i, i + len))) return true;
  }
  return false;
}

test('no two lens agent files share a 200+ character block (the shared contract lives in adlc-prosecute.md, not duplicated per-lens)', () => {
  const bodies = LENS_FILES.map((f) => [f, read(f)]);
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const [fileA, textA] = bodies[i];
      const [fileB, textB] = bodies[j];
      assert.equal(
        hasCommonSubstring(textA, textB, 200),
        false,
        `${fileA} and ${fileB} share a 200+ char block — the shared prosecution contract must live in commands/adlc-prosecute.md, not be duplicated per-lens`
      );
    }
  }
});

test('every lens file points to /adlc:adlc-prosecute for the shared contract instead of restating it', () => {
  for (const f of LENS_FILES) {
    const text = read(f);
    assert.match(text, /\/adlc:adlc-prosecute/, `${f} must reference the command that supplies the shared contract`);
    // The old duplicated schema line must be gone from every lens file.
    assert.doesNotMatch(text, /quoted verbatim from the diff/, `${f} must not restate the old verbatim-evidence instruction`);
  }
});

test('the shared prosecution contract (schema + tool constraints) is defined in commands/adlc-prosecute.md', () => {
  const command = read(join(PLUGIN_ROOT, 'commands', 'adlc-prosecute.md'));
  assert.match(command, /severity[\s\S]*critical\|high\|medium\|low/);
  assert.match(command, /You have no Edit\/Write\/Bash tools by design/);
});

// ── trust-root tier: de-duplicated where it's actually possible (issue #276) ──
//
// SKILL.md is a GENERATED file — six harness router files (claude-code,
// antigravity, codex, pi, opencode, cursor) are rendered from one shared
// template in scripts/router/router-model.mjs (see router-drift.test.mjs).
// Its trust-root paragraph is intentionally shared cross-harness content,
// not an accidental duplicate within this one plugin — pointing it at a
// claude-code-only references/ file would break the other five harnesses,
// which have no such file. So SKILL.md keeps its full copy; prosecutor.md
// (which is NOT generated, genuinely claude-code-specific) is the one that
// gets de-duplicated down to a pointer. The review's claimed third site
// (commands/adlc-prosecute.md) never existed in the current codebase.

const TRUST_ROOT_MARKER = 'cross-model-review';

test('the trust-root tier reference doc carries the actionable mechanics (record-cross-model)', () => {
  const referencePath = join(PLUGIN_ROOT, 'skills', 'adlc', 'references', 'trust-root.md');
  const reference = read(referencePath);
  assert.match(reference, new RegExp(TRUST_ROOT_MARKER));
  assert.match(reference, /record-cross-model/);
});

test('prosecutor.md (non-generated) points to the trust-root reference doc instead of restating it', () => {
  const prosecutor = read(join(PLUGIN_ROOT, 'agents', 'prosecutor.md'));
  assert.match(prosecutor, /references\/trust-root\.md/);
  assert.doesNotMatch(prosecutor, /record-cross-model --ticket/, 'prosecutor.md must not restate the record-cross-model invocation — it should point to references/trust-root.md instead');
});

test('commands/adlc-prosecute.md does not carry its own copy of the trust-root explanation (it never did — review claim was stale)', () => {
  const command = read(join(PLUGIN_ROOT, 'commands', 'adlc-prosecute.md'));
  assert.doesNotMatch(command, new RegExp(TRUST_ROOT_MARKER));
});

// ── prosecutor.md meta-commentary removed (issue #276 item 4) ─────────────

test('prosecutor.md no longer narrates the OpenCode integration provenance history', () => {
  const prosecutor = read(join(PLUGIN_ROOT, 'agents', 'prosecutor.md'));
  assert.doesNotMatch(prosecutor, /OpenCode integration/);
});
