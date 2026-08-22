// handoff-resolve-drift.test.mjs — pin the Codex copy of handoff-resolve.mjs
// to the Claude Code original (slice 5).
//
// A PreToolUse hook runs from the plugin's INSTALLED location, which has no
// node_modules, so it cannot bare-import @adlc/context-handoff; the resolver
// walks up to the project's node_modules instead. Both enforcing hook-style
// harnesses need that walk, and neither can import it from the other's plugin
// directory — so the file is copied, and copies drift. Same KEEP-IN-SYNC
// pattern as packages/core/test/shell.test.mjs pinning the Codex hook's inline
// shell classifier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARD_DEPTH } from '@adlc/context-handoff';
import {
  buildCodexRollout,
  functionCall,
  functionCallOutput,
  customToolCall,
  customToolCallOutput,
  patchApplyEnd,
} from '../../../../packages/build-gate/test/fixtures/codex-rollout.mjs';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(HOOKS_DIR, '..', '..', '..');

const CODEX_COPY = join(HOOKS_DIR, 'handoff-resolve.mjs');
const CC_ORIGINAL = join(
  REPO_ROOT,
  'plugins',
  'adlc-claude-code',
  'hooks',
  'handoff-resolve.mjs',
);

test('the Codex resolver is byte-identical to the Claude Code original', () => {
  const copy = readFileSync(CODEX_COPY, 'utf8');
  const original = readFileSync(CC_ORIGINAL, 'utf8');
  assert.equal(
    copy,
    original,
    'plugins/adlc-codex/hooks/handoff-resolve.mjs has drifted from the Claude Code ' +
      'original — re-copy it rather than patching one side',
  );
});

test('the copy still exports the resolver contract the hook depends on', () => {
  const source = readFileSync(CODEX_COPY, 'utf8');
  for (const name of ['resolveContextHandoffEntry', 'loadContextHandoff']) {
    assert.match(source, new RegExp(`export (async )?function ${name}\\b`), `missing ${name}`);
  }
});

test('the handoff hook counts tool calls with the canonical counter', async () => {
  // Two regexes over one transcript is one too many: the handoff hook shipped
  // its own, which missed the `Writing|Editing|Created` prose tool-log form the
  // build gate recognizes — so the same session read as deep to one gate and
  // empty to the other. The hook must import, not re-derive.
  const source = readFileSync(join(HOOKS_DIR, 'adlc-handoff-gate.mjs'), 'utf8');
  assert.match(
    source,
    /import \{ countToolCalls \} from '\.\/adlc-build-gate\.mjs'/,
    'the handoff hook must import the canonical counter',
  );
  assert.doesNotMatch(
    source,
    /function countToolCalls\b/,
    'and must not declare a second one',
  );

  const { countToolCalls } = await import(join(HOOKS_DIR, 'adlc-build-gate.mjs'));
  const prose = 'Writing src/a.mjs\nEditing src/b.mjs\nCreated src/c.mjs\n';
  assert.equal(countToolCalls(prose), 3, 'the prose tool-log form must count');
  const blocks = JSON.stringify({ content: [{ type: 'tool_use' }] });
  assert.equal(countToolCalls(`${blocks}\n${prose}`), 4);
});

test('the handoff hook counts the Codex rollout shape it actually runs against', async () => {
  // This hook only ever sees Codex transcripts, and every fixture above is
  // Anthropic-shaped — so the counter could read 0 on every real session while
  // this file stayed green. That is exactly what shipped
  // (T-01M05BWTEYKHEK3JJX71NXXJ4H). Structure adjudicated against real
  // ~/.codex/sessions rollouts; see the fixture module for what is excluded.
  const { countToolCalls } = await import(join(HOOKS_DIR, 'adlc-build-gate.mjs'));
  const { text, expectedToolCalls } = buildCodexRollout({
    functionCalls: 31,
    customToolCalls: 12,
    messages: 7,
  });
  assert.equal(expectedToolCalls, 43);
  assert.equal(countToolCalls(text), 43, 'a 43-call Codex rollout must not read as depth 0');
  assert.ok(countToolCalls(text) >= HARD_DEPTH, 'and must reach the hard depth band');

  // The call/output pair counts once; the event_msg mirror adds nothing.
  assert.equal(countToolCalls(`${functionCall(1)}\n${functionCallOutput(1)}`), 1);
  assert.equal(
    countToolCalls(`${customToolCall(2)}\n${patchApplyEnd(2)}\n${customToolCallOutput(2)}`),
    1,
  );
});

test('the resolver loads the package from a project root', async () => {
  const { loadContextHandoff } = await import(CODEX_COPY);
  const api = await loadContextHandoff({ projectRoot: REPO_ROOT });
  assert.ok(api, 'the resolver must find @adlc/context-handoff from the repo root');
  assert.equal(typeof api.evaluateHandoffPreToolUse, 'function');
});
