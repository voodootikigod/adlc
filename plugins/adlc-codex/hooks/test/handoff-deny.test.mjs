// handoff-deny.test.mjs — Codex PreToolUse context-handoff (slice 5).
// Drives the real hook script as a subprocess (same pattern as
// build-gate.test.mjs), never a re-implementation of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  ensureDenyMarker,
  writeDenyRecord,
  HANDOFF_DEPTH,
} from '@adlc/context-handoff';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(HOOKS_DIR, 'adlc-handoff-gate.mjs');
const REPO_ROOT = join(HOOKS_DIR, '..', '..', '..');

/** Build a transcript file with N tool_use JSONL lines. */
function makeTranscript(dir, name, toolUseCount) {
  const line = JSON.stringify({
    type: 'assistant',
    content: [{ type: 'tool_use', name: 'apply_patch' }],
  });
  const p = join(dir, name);
  writeFileSync(p, Array.from({ length: toolUseCount }, () => line).join('\n'));
  return p;
}

function runHandoff({
  sessionId = 'sess-a',
  omitSessionId = false,
  toolName = 'apply_patch',
  payloadExtra,
  transcriptToolCalls,
  transcriptName,
  seedDeny,
  rawInput,
  makeAdlcDir = true,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-codex-handoff-'));
  try {
    if (makeAdlcDir) mkdirSync(join(dir, '.adlc'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export {}\n');

    if (typeof seedDeny === 'function') seedDeny(dir);

    let transcriptPath;
    if (transcriptToolCalls !== undefined) {
      transcriptPath = makeTranscript(
        dir,
        transcriptName ?? `${sessionId}.jsonl`,
        transcriptToolCalls,
      );
    }

    const payload = {
      tool_name: toolName,
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
      ...(payloadExtra ?? { file_path: join(dir, 'src', 'app.mjs') }),
    };
    if (!omitSessionId) payload.session_id = sessionId;

    const input = rawInput ?? JSON.stringify(payload);

    let out = '';
    let status = 0;
    try {
      execFileSync(process.execPath, [HOOK], {
        input,
        encoding: 'utf8',
        cwd: dir,
        env: {
          ...process.env,
          NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH]
            .filter(Boolean)
            .join(':'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      out = e.stderr ?? '';
      status = e.status ?? 1;
    }

    const resolvedId = omitSessionId
      ? transcriptName
        ? transcriptName.replace(/\.jsonl$/, '')
        : null
      : sessionId;
    const markerPath = resolvedId
      ? join(dir, '.adlc', 'handoffs', 'denies', `${resolvedId}.json`)
      : null;

    return {
      verdict: status === 2 ? 'deny' : status === 0 ? 'allow' : 'error',
      status,
      out,
      markerExists: markerPath ? existsSync(markerPath) : false,
      marker: markerPath && existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Seed an open deny record owned by another session. */
function seedForeignDeny(name) {
  return (root) => {
    assert.equal(
      ensureDenyMarker(root, {
        sessionId: name,
        ticketId: 'T1',
        contentHash: 'abc',
        host: 'test',
      }).ok,
      true,
    );
  };
}

test('clean ADLC repo without deny/handoff → allow apply_patch', () => {
  const r = runHandoff({ transcriptToolCalls: 5 });
  assert.equal(r.verdict, 'allow', r.out);
  assert.equal(r.markerExists, false);
});

test('a directory that is not an ADLC repo is left alone', () => {
  const r = runHandoff({ makeAdlcDir: false, transcriptToolCalls: 5 });
  assert.equal(r.verdict, 'allow', r.out);
});

test('open deny for another session without resume-auth → deny apply_patch', () => {
  const r = runHandoff({
    sessionId: 'consumer-1',
    seedDeny: seedForeignDeny('denier-1'),
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /D3:unauthorized_open:denier-1/);
});

test('apply_patch envelope paths are seen (not just file_path)', () => {
  const r = runHandoff({
    sessionId: 'consumer-1b',
    payloadExtra: {
      input: '*** Update File: src/app.mjs\n@@\n-export {}\n+export const x = 1\n',
    },
    seedDeny: seedForeignDeny('denier-1b'),
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /D3:unauthorized_open:denier-1b/);
});

test('shell is fail-closed-all under the deny-set', () => {
  const r = runHandoff({
    sessionId: 'consumer-2',
    toolName: 'exec_command',
    payloadExtra: { command: 'ls' },
    seedDeny: seedForeignDeny('denier-2'),
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_fail_closed_under_deny/);
});

test('under deny-set, shell `adlc handoff repair` is tagged mutating-cli', () => {
  const r = runHandoff({
    sessionId: 'consumer-3',
    toolName: 'exec_command',
    payloadExtra: { command: 'adlc handoff repair --write' },
    seedDeny: seedForeignDeny('denier-3'),
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_fail_closed_under_deny/);
  assert.match(r.out, /bash_handoff_mutating_cli/);
});

test('under deny-set, a subshell handoff write is tagged mutating-cli', () => {
  const r = runHandoff({
    sessionId: 'consumer-3b',
    toolName: 'bash',
    payloadExtra: { command: 'echo $(adlc handoff write --write)' },
    seedDeny: seedForeignDeny('denier-3b'),
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_handoff_mutating_cli/);
});

test('shell is allowed when no deny-set is active', () => {
  const r = runHandoff({
    sessionId: 'sess-shell',
    toolName: 'exec_command',
    payloadExtra: { command: 'adlc handoff repair --write' },
    transcriptToolCalls: 2,
  });
  assert.equal(r.verdict, 'allow', r.out);
});

test('denier session stays denied after consume (D2 sticky)', () => {
  const r = runHandoff({
    sessionId: 'denier-sticky',
    seedDeny: (root) => {
      seedForeignDeny('denier-sticky')(root);
      writeDenyRecord(root, {
        session_id: 'denier-sticky',
        ticket_id: 'T1',
        content_hash: 'abc',
        status: 'consumed',
        since: new Date().toISOString(),
        host: 'test',
        schema: 1,
      });
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /D2:denier_session/);
});

test('handoff band ensures a deny marker for the current session', () => {
  const r = runHandoff({
    sessionId: 'deep-sess',
    transcriptToolCalls: HANDOFF_DEPTH,
  });
  assert.equal(r.verdict, 'deny');
  assert.equal(r.markerExists, true, 'ensureDenyMarker must write denies/<session>.json');
  assert.match(r.marker, /"status": "open"/);
  assert.match(r.marker, /"host": "codex"/);
});

test('transcript_path stem supplies the session id when the payload omits one', () => {
  const r = runHandoff({
    omitSessionId: true,
    transcriptName: 'stem-sess.jsonl',
    transcriptToolCalls: HANDOFF_DEPTH,
  });
  assert.equal(r.verdict, 'deny');
  assert.equal(r.markerExists, true, 'the stem must become the marker filename');
});

test('no usable session id under deny-store pressure → fail closed', () => {
  const r = runHandoff({
    omitSessionId: true,
    seedDeny: seedForeignDeny('denier-4'),
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /D0:invalid_session_id/);
});

test('no usable session id on a clean repo still allows', () => {
  const r = runHandoff({ omitSessionId: true, transcriptToolCalls: 3 });
  assert.equal(r.verdict, 'allow', r.out);
});

test('writing a handoff trust-root path is denied even with a cold store', () => {
  const r = runHandoff({
    sessionId: 'sneaky',
    payloadExtra: { file_path: '.adlc/handoffs/denies/sneaky.json' },
    transcriptToolCalls: 2,
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /path_protected/);
});

test('resume-auth / model-ok / lock artifacts are protected too', () => {
  for (const rel of [
    '.adlc/handoffs/sess-a.resume-auth.json',
    '.adlc/handoffs/sess-a.model-ok',
    '.adlc/handoffs/sess-a.lock',
    '.adlc/.deny-store',
  ]) {
    const r = runHandoff({
      sessionId: 'sneaky',
      payloadExtra: { file_path: rel },
      transcriptToolCalls: 2,
    });
    assert.equal(r.verdict, 'deny', `${rel} must be protected`);
    assert.match(r.out, /path_protected/);
  }
});

test('malformed stdin fails closed', () => {
  const r = runHandoff({ rawInput: '{not json' });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /malformed hook payload JSON/);
});

test('hooks.json wires the handoff hook on the PreToolUse mutation matcher', () => {
  const wiring = JSON.parse(readFileSync(join(HOOKS_DIR, 'hooks.json'), 'utf8'));
  const pre = wiring.hooks.PreToolUse;
  assert.ok(Array.isArray(pre) && pre.length > 0);
  const entry = pre.find((group) =>
    group.hooks.some((h) => h.command.includes('adlc-handoff-gate.mjs')),
  );
  assert.ok(entry, 'PreToolUse must run adlc-handoff-gate.mjs');
  // The matcher must cover both structured edits and the shell, or the
  // fail-closed-all rule has a hole the deny-set cannot see.
  for (const tool of ['apply_patch', 'write', 'Edit', 'Bash', 'exec_command', 'write_stdin']) {
    assert.match(tool, new RegExp(entry.matcher), `matcher must cover ${tool}`);
  }
});

test('the plugin ships the new hook and its resolver', () => {
  const pkg = JSON.parse(readFileSync(join(HOOKS_DIR, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('hooks/*.mjs'), 'files must ship hooks/*.mjs');
  assert.ok(existsSync(join(HOOKS_DIR, 'handoff-resolve.mjs')));
  // Track the workspace version rather than pinning a literal: a release bump
  // must not turn into a rebase conflict in an enforcement contract test.
  const corePkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages', 'context-handoff', 'package.json'), 'utf8'),
  );
  assert.equal(pkg.dependencies['@adlc/context-handoff'], corePkg.version);
});
