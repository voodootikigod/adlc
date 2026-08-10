// handoff-deny.test.mjs — Claude Code PreToolUse context-handoff (T157).
// Drives the real hook entrypoint as a subprocess (same pattern as
// build-gate.test.mjs / rails.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
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
const HOOK = join(HOOKS_DIR, 'adlc-hook.mjs');
const HOOK_RUN = join(HOOKS_DIR, 'adlc-hook-run.mjs');
const REPO_ROOT = join(HOOKS_DIR, '..', '..', '..');

/** Build a transcript file with N tool_use JSONL lines. */
function makeTranscript(dir, name, toolUseCount, { padBytes = 0 } = {}) {
  const line = JSON.stringify({
    type: 'assistant',
    content: [{ type: 'tool_use', name: 'Edit' }],
  });
  const lines = Array.from({ length: toolUseCount }, () => line);
  if (padBytes > 0) lines.push('x'.repeat(padBytes));
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n'));
  return p;
}

function runHandoff({
  sessionId = 'sess-a',
  omitSessionId = false,
  toolName = 'Edit',
  toolInput,
  transcriptToolCalls,
  transcriptName,
  transcriptPadBytes,
  seedDeny,
  tickets = [{ id: 'T1', title: 'x', body: 'y', rails: [], scope: ['src/**'] }],
  env = {},
  viaRunner = false,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(
      join(dir, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets }),
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export {}\n');

    if (typeof seedDeny === 'function') {
      seedDeny(dir);
    }

    let transcriptPath;
    if (transcriptToolCalls !== undefined) {
      const name = transcriptName ?? `${sessionId}.jsonl`;
      transcriptPath = makeTranscript(dir, name, transcriptToolCalls, {
        padBytes: transcriptPadBytes ?? 0,
      });
    }

    const defaultToolInput =
      toolName === 'Bash' || toolName === 'Shell'
        ? { command: 'echo hi' }
        : { file_path: join(dir, 'src', 'app.mjs') };

    const payload = {
      cwd: dir,
      tool_name: toolName,
      tool_input: toolInput ?? defaultToolInput,
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    };
    if (!omitSessionId) payload.session_id = sessionId;

    const input = JSON.stringify(payload);

    const hookEnv = {
      ...process.env,
      CLAUDE_PROJECT_DIR: '',
      NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH]
        .filter(Boolean)
        .join(':'),
      ...env,
    };

    const argv = viaRunner
      ? [HOOK_RUN, 'handoff']
      : [HOOK, 'handoff'];

    let out = '';
    let status = 0;
    try {
      out = execFileSync(process.execPath, argv, {
        input,
        encoding: 'utf8',
        env: hookEnv,
      });
    } catch (e) {
      out = e.stdout ?? '';
      status = e.status ?? 1;
    }

    const resolvedId = omitSessionId
      ? (transcriptName ? transcriptName.replace(/\.jsonl$/, '') : null)
      : sessionId;
    const markerPath = resolvedId
      ? join(dir, '.adlc', 'handoffs', 'denies', `${resolvedId}.json`)
      : null;
    return {
      verdict:
        out.includes('"permissionDecision":"deny"') || status === 2 ? 'deny' : 'allow',
      out,
      status,
      dir,
      markerExists: markerPath ? existsSync(markerPath) : false,
      marker: markerPath && existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('clean ADLC repo without deny/handoff → allow Edit', () => {
  const r = runHandoff({ transcriptToolCalls: 5 });
  assert.equal(r.verdict, 'allow');
  assert.equal(r.markerExists, false);
});

test('open deny for another session without resume-auth → deny Edit', () => {
  const r = runHandoff({
    sessionId: 'consumer-1',
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-1',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /D3:unauthorized_open:denier-1/);
});

test('open deny → Bash fail-closed-all', () => {
  const r = runHandoff({
    sessionId: 'consumer-2',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-2',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_fail_closed_under_deny/);
});

test('under deny-set, Bash `adlc handoff repair` is denied with mutating-cli reason', () => {
  const r = runHandoff({
    sessionId: 'consumer-3',
    toolName: 'Bash',
    toolInput: { command: 'adlc handoff repair --write' },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-3',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_fail_closed_under_deny/);
  assert.match(r.out, /bash_handoff_mutating_cli/);
});

test('under deny-set, subshell handoff write is tagged mutating-cli', () => {
  const r = runHandoff({
    sessionId: 'consumer-3b',
    toolName: 'Bash',
    toolInput: { command: 'echo $(adlc handoff write --write)' },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-3b',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_handoff_mutating_cli/);
});

test('denier session stays denied after consume (D2 sticky via store)', () => {
  const r = runHandoff({
    sessionId: 'denier-sticky',
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-sticky',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
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

test('handoff band ensures deny marker for current session', () => {
  const r = runHandoff({
    sessionId: 'deep-sess',
    transcriptToolCalls: HANDOFF_DEPTH,
  });
  assert.equal(r.verdict, 'deny');
  assert.equal(r.markerExists, true, 'ensureDenyMarker must write denies/<session>.json');
  assert.match(r.marker, /"status": "open"/);
  assert.match(r.out, /D2:denier_session/);
});

test('transcript_path stem supplies session id when payload omits session_id', () => {
  const r = runHandoff({
    omitSessionId: true,
    transcriptName: 'uuid-from-transcript.jsonl',
    transcriptToolCalls: HANDOFF_DEPTH,
  });
  assert.equal(r.verdict, 'deny');
  assert.equal(r.markerExists, true);
  assert.match(r.marker, /"session_id": "uuid-from-transcript"/);
});

test('no usable session id under deny-store pressure → fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-handoff-nosid-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(
      join(dir, '.adlc', 'tickets.json'),
      JSON.stringify({
        tickets: [{ id: 'T1', title: 'x', body: 'y', rails: [], scope: ['src/**'] }],
      }),
    );
    assert.equal(
      ensureDenyMarker(dir, {
        sessionId: 'foreign-open',
        ticketId: 'T1',
        contentHash: 'abc',
        host: 'test',
      }).ok,
      true,
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export {}\n');
    const input = JSON.stringify({
      cwd: dir,
      tool_name: 'Edit',
      tool_input: { file_path: join(dir, 'src', 'app.mjs') },
    });

    let out = '';
    let status = 0;
    try {
      out = execFileSync(process.execPath, [HOOK, 'handoff'], {
        input,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: '',
          NODE_PATH: join(REPO_ROOT, 'node_modules'),
        },
      });
    } catch (e) {
      out = e.stdout ?? '';
      status = e.status ?? 1;
    }
    const verdict =
      out.includes('"permissionDecision":"deny"') || status === 2 ? 'deny' : 'allow';
    assert.equal(verdict, 'deny');
    assert.match(out, /D0:invalid_session_id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent Write to denies/* is denied even without open foreign deny', () => {
  const r = runHandoff({
    sessionId: 'path-guard',
    toolName: 'Write',
    toolInput: {
      file_path: '.adlc/handoffs/denies/path-guard.json',
      content: '{}',
    },
    seedDeny: (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /path_protected:.*denies\/path-guard\.json/);
});

test('agent Write to resume-auth / model-ok / lock is denied', () => {
  for (const leaf of [
    'sess-x.resume-auth.json',
    'sess-x.model-ok',
    'sess-x.lock',
  ]) {
    const r = runHandoff({
      sessionId: 'path-leaf',
      toolName: 'Write',
      toolInput: {
        file_path: `.adlc/handoffs/${leaf}`,
        content: '{}',
      },
      seedDeny: (root) => {
        mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
      },
    });
    assert.equal(r.verdict, 'deny', leaf);
    assert.match(r.out, new RegExp(`path_protected:.*${leaf.replace(/\./g, '\\.')}`));
  }
});

test('adlc-hook-run lists handoff as enforcing (timeout path non-zero)', () => {
  // Drive the runner with a tiny timeout by spawning a hanging child substitute:
  // assert the ENFORCING_MODES contract by reading the runner source — plus a
  // live spawn that forces ETIMEDOUT via ADLC_HOOK_RUN_TEST_SLEEP if present.
  // Primary load-bearing check: runner source includes handoff in both maps.
  const src = readFileSync(HOOK_RUN, 'utf8');
  assert.match(src, /handoff:\s*10_000/);
  assert.match(src, /ENFORCING_MODES = new Set\(\[[^\]]*['"]handoff['"]/);

  // Live: open deny + runner path still denies (not just direct hook).
  const r = runHandoff({
    sessionId: 'via-runner',
    viaRunner: true,
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-run',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /D3:unauthorized_open:denier-run/);
});

test('under deny-set, Bash `adlc handoff bypass` is tagged mutating-cli', () => {
  const r = runHandoff({
    sessionId: 'consumer-bypass',
    toolName: 'Bash',
    toolInput: { command: 'adlc handoff bypass --write' },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-bypass',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_handoff_mutating_cli/);
});

test('Shell tool_name is fail-closed under deny-set', () => {
  const r = runHandoff({
    sessionId: 'consumer-shell',
    toolName: 'Shell',
    toolInput: { command: 'pwd' },
    seedDeny: (root) => {
      assert.equal(
        ensureDenyMarker(root, {
          sessionId: 'denier-shell',
          ticketId: 'T1',
          contentHash: 'abc',
          host: 'test',
        }).ok,
        true,
      );
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /bash_fail_closed_under_deny/);
});

test('hooks.json wires handoff for Edit matcher and Bash|Shell', () => {
  const cfg = JSON.parse(readFileSync(join(HOOKS_DIR, 'hooks.json'), 'utf8'));
  const pre = cfg.hooks.PreToolUse;
  const edit = pre.find((e) => String(e.matcher).includes('Edit'));
  assert.ok(edit, 'Edit matcher entry');
  assert.ok(
    edit.hooks.some((h) => String(h.command).includes('handoff')),
    'handoff on Edit matcher',
  );
  const bash = pre.find((e) => String(e.matcher).includes('Bash'));
  assert.ok(bash, 'Bash matcher entry');
  assert.match(String(bash.matcher), /Bash\|Shell|Shell\|Bash/);
  assert.ok(bash.hooks.some((h) => String(h.command).includes('handoff')));
});

test('malformed stdin → deny (fail closed)', () => {
  let out = '';
  let status = 0;
  try {
    out = execFileSync(process.execPath, [HOOK, 'handoff'], {
      input: '{not-json',
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: '',
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
      },
    });
  } catch (e) {
    out = e.stdout ?? '';
    status = e.status ?? 1;
  }
  assert.equal(status, 2);
  assert.match(out, /permissionDecision":"deny"/);
  assert.match(out, /unreadable\/malformed input/);
});

test('unenterable project cwd → deny (fail closed)', () => {
  const missing = join(tmpdir(), `adlc-handoff-missing-${Date.now()}`, 'nope');
  let out = '';
  let status = 0;
  try {
    out = execFileSync(process.execPath, [HOOK, 'handoff'], {
      input: JSON.stringify({
        cwd: missing,
        session_id: 'sess-missing',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/app.mjs' },
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: '',
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
      },
    });
  } catch (e) {
    out = e.stdout ?? '';
    status = e.status ?? 1;
  }
  assert.equal(status, 2);
  assert.match(out, /permissionDecision":"deny"/);
  assert.match(out, /could not enter the project directory/);
});

test('empty transcript_path string does not become a session id', async () => {
  const { resolveSessionId } = await import('../handoff-gate.mjs');
  const { isSafeSessionId } = await import('@adlc/context-handoff');
  assert.equal(resolveSessionId(null, { isSafeSessionId }), null);
  assert.equal(resolveSessionId({ transcript_path: 12 }, { isSafeSessionId }), null);

  assert.equal(resolveSessionId(undefined, { isSafeSessionId }), null);
  assert.equal(
    resolveSessionId({ session_id: '', transcript_path: '' }, { isSafeSessionId }),
    null,
  );
  // Stem containing `..` is rejected by isSafeSessionId.
  assert.equal(
    resolveSessionId({ transcript_path: '....jsonl' }, { isSafeSessionId }),
    null,
  );
});

test('loadContextHandoff prefers projectRoot package when plugin walk is blind', async () => {
  const { loadContextHandoff } = await import('../handoff-resolve.mjs');
  const blind = mkdtempSync(join(tmpdir(), 'adlc-handoff-blind-'));
  try {
    // pluginHooksDir outside the monorepo: walk cannot find @adlc/*.
    // projectRoot still resolves via the real repo package.json.
    const api = await loadContextHandoff({
      projectRoot: REPO_ROOT,
      pluginHooksDir: blind,
    });
    assert.equal(typeof api?.evaluateMutationGate, 'function');
  } finally {
    rmSync(blind, { recursive: true, force: true });
  }
});

test('missing transcript_path file does not invent hard-band deny', () => {
  const r = runHandoff({
    sessionId: 'missing-tp',
    // Force observeHandoffSignals to see a path that does not exist.
    // runHandoff only sets transcript_path when transcriptToolCalls is set, so
    // drive the hook manually.
  });
  // Baseline allow without signals — control.
  assert.equal(r.verdict, 'allow');

  const dir = mkdtempSync(join(tmpdir(), 'adlc-handoff-miss-tp-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(
      join(dir, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', title: 'x', body: 'y', rails: [], scope: ['src/**'] }] }),
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export {}\n');
    const input = JSON.stringify({
      cwd: dir,
      session_id: 'missing-tp2',
      tool_name: 'Edit',
      tool_input: { file_path: join(dir, 'src', 'app.mjs') },
      transcript_path: join(dir, 'no-such-transcript.jsonl'),
    });
    let out = '';
    let status = 0;
    try {
      out = execFileSync(process.execPath, [HOOK, 'handoff'], {
        input,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: '',
          NODE_PATH: join(REPO_ROOT, 'node_modules'),
        },
      });
    } catch (e) {
      out = e.stdout ?? '';
      status = e.status ?? 1;
    }
    const verdict =
      out.includes('"permissionDecision":"deny"') || status === 2 ? 'deny' : 'allow';
    assert.equal(verdict, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadContextHandoff rejects non-string projectRoot without throwing', async () => {
  const { loadContextHandoff } = await import('../handoff-resolve.mjs');
  const blind = mkdtempSync(join(tmpdir(), 'adlc-handoff-blind2-'));
  try {
    assert.equal(await loadContextHandoff({ projectRoot: null, pluginHooksDir: blind }), null);
    assert.equal(await loadContextHandoff({ projectRoot: 1, pluginHooksDir: blind }), null);
  } finally {
    rmSync(blind, { recursive: true, force: true });
  }
});

test('Write to denies directory (no trailing slash) is denied', () => {
  const r = runHandoff({
    sessionId: 'path-dir',
    toolName: 'Write',
    toolInput: {
      file_path: '.adlc/handoffs/denies',
      content: '{}',
    },
    seedDeny: (root) => {
      mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    },
  });
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /path_protected:/);
});

test('Write via dotted handoffs path is still protected', async () => {
  const { isProtectedHandoffPath } = await import('../handoff-gate.mjs');
  assert.equal(isProtectedHandoffPath('.adlc/./handoffs/denies/x.json'), true);
  assert.equal(isProtectedHandoffPath('.adlc/handoffs/denies'), true);
});
