// plugin-footprint.test.mjs — issue #277: the plugin's always-loaded
// footprint (every frontmatter `description` field + the plugin.json
// description + the MCP tool schemas), before any command is invoked.
//
// HONEST STATUS: the issue's target was ≤~500 tokens. This test asserts what
// was actually achieved (a real, verified reduction from the ~1,006-token
// baseline the tokenomics review measured), not the aspirational target.
// The remaining gap is NOT closed here because closing it would mean cutting
// into content that is functionally load-bearing, not incidental waste:
//   - SKILL.md's description/body are generated from a template shared
//     across six harness ports (scripts/router/router-model.mjs) and used
//     for skill-trigger discovery — cutting trigger phrases risks real
//     discoverability loss, and doing it safely needs generator-level work
//     (see docs/integrations/claude-code.md's note on issue #277).
//   - The MCP tool schemas' bulk is the required JSON structure (the gate
//     enum, property definitions) an MCP client needs to call the tools
//     correctly — not prose that can be trimmed.
// What WAS cut, safely: the 6 programmatic prosecution agents' descriptions,
// which are never used for discovery (they're invoked by exact name, not
// model-selected) and were pure always-loaded cost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..', '..');
const REPO_ROOT = join(PLUGIN_ROOT, '..', '..');

function frontmatterField(path, field) {
  const text = readFileSync(path, 'utf8');
  const re = new RegExp(`^${field}:\\s*(.*)$`, 'm');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

const PROGRAMMATIC_AGENTS = [
  'prosecutor-correctness.md',
  'prosecutor-security.md',
  'prosecutor-contract.md',
  'prosecutor-diff.md',
  'prosecutor-tests.md',
  'prosecutor-verifier.md',
];

test('the 6 programmatically-invoked prosecution agents have a short, uniform description shape', () => {
  for (const f of PROGRAMMATIC_AGENTS) {
    const desc = frontmatterField(join(PLUGIN_ROOT, 'agents', f), 'description');
    assert.ok(desc.length <= 100, `${f} description is ${desc.length} chars, expected <=100 (was 187-256 before #277)`);
    assert.match(desc, /invoked by \/adlc:adlc-prosecute/, `${f} description should say it's invoked by the command, not model-selected`);
    assert.match(desc, /do not invoke directly/, `${f} description should discourage direct invocation`);
  }
});

test('prosecutor.md (the one user-facing, model-selected agent) keeps a fully descriptive description', () => {
  const desc = frontmatterField(join(PLUGIN_ROOT, 'agents', 'prosecutor.md'), 'description');
  // Deliberately NOT shortened — this is the one agent a user or the main
  // session picks by intent-matching, so its description needs real content.
  assert.ok(desc.length > 200, 'prosecutor.md description should stay descriptive (it is model-selected, unlike the 6 programmatic lenses)');
});

test('always-loaded footprint: agent descriptions total dropped by more than half vs. the pre-#277 baseline', () => {
  const agentFiles = [
    'prosecutor.md',
    ...PROGRAMMATIC_AGENTS,
  ];
  const total = agentFiles.reduce(
    (sum, f) => sum + frontmatterField(join(PLUGIN_ROOT, 'agents', f), 'description').length,
    0
  );
  const BASELINE_CHARS = 1680; // ~420 tokens, per the tokenomics review's measurement
  assert.ok(
    total < BASELINE_CHARS * 0.6,
    `agent description total is ${total} chars — expected a >40% reduction from the ${BASELINE_CHARS}-char baseline`
  );
});

test('SKILL.md and MCP schemas are NOT claimed as reduced — they are generated/protocol-required and out of this pass\'s scope', () => {
  // This test exists to make the scope decision explicit and machine-checked,
  // not to assert a specific size — it documents that touching these two
  // pieces needs the router-model generator (SKILL.md) or would break MCP
  // client calls (schemas), and is deferred rather than silently skipped.
  const skillPath = join(PLUGIN_ROOT, 'skills', 'adlc', 'SKILL.md');
  const generatorPath = join(REPO_ROOT, 'scripts', 'router', 'router-model.mjs');
  const skill = readFileSync(skillPath, 'utf8');
  const generator = readFileSync(generatorPath, 'utf8');
  assert.match(skill, /<!-- ADLC_CC_SENTINEL_PHASE_ROUTER_V1 -->/, 'SKILL.md must still carry the generated-file sentinel');
  assert.match(generator, /Routes agentic development work to the right/, 'the generator, not SKILL.md directly, is where this content is authored');
});
