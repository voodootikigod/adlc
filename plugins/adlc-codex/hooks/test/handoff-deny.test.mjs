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
  copyFileSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  ensureDenyMarker,
  writeDenyRecord,
  writeResumeAuth,
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
  env: extraEnv = {},
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
          ...extraEnv,
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

test('the hook never hands the manifest key to project-resolved code', () => {
  // handoff-resolve.mjs deliberately resolves @adlc/context-handoff from the
  // PROJECT's node_modules, so the imported module is project-controlled. If
  // the hook passed ADLC_MANIFEST_KEY into it, any repository shipping a
  // package by that name could exfiltrate the manifest trust anchor. The
  // observable contract: even WITH a key in the environment and a validly
  // signed resume-auth on disk, this hook cannot verify it — and says so.
  const key = 'a'.repeat(64);
  const seed = (root) => {
    seedForeignDeny('denier-resume')(root);
    assert.equal(
      writeResumeAuth(
        root,
        'consumer-resume',
        { ticketId: 'T1', contentHash: 'abc', denySessionId: 'denier-resume' },
        { key },
      ).ok,
      true,
    );
  };

  for (const envKey of ['', key]) {
    const r = runHandoff({
      sessionId: 'consumer-resume',
      seedDeny: seed,
      env: { ADLC_MANIFEST_KEY: envKey },
    });
    assert.equal(r.verdict, 'deny', `key=${envKey ? 'set' : 'unset'} must still deny`);
    assert.match(r.out, /resume_auth_unverifiable:no_manifest_key/);
  }

  const source = readFileSync(HOOK, 'utf8');
  assert.doesNotMatch(
    source,
    /manifestKey:\s*process\.env/,
    'the key must not be threaded into the dynamically resolved module',
  );
});

test('the direct-execution guard survives a path containing a space', () => {
  // `file://${argv[1]}` does not match import.meta.url for a percent-encoded
  // path, so main() would never run and the hook would exit 0 — read as ALLOW.
  // realpathSync: macOS tmpdir() is itself a symlink, and import.meta.url is
  // always the RESOLVED path — without this the two would differ for a reason
  // that has nothing to do with the space this test is about.
  const spaced = realpathSync(mkdtempSync(join(tmpdir(), 'adlc codex hook ')));
  try {
    const copyDir = join(spaced, 'hooks');
    mkdirSync(copyDir, { recursive: true });
    for (const f of [
      'adlc-handoff-gate.mjs',
      'handoff-resolve.mjs',
      'adlc-build-gate.mjs',
      'generated-active-ticket.mjs',
      'generated-ticket-reader.mjs',
      'generated-glob-match.mjs',
    ]) {
      copyFileSync(join(HOOKS_DIR, f), join(copyDir, f));
    }
    // Let the resolver find the package by walking up from the spaced hooks
    // dir, so this asserts the real deny rather than the fail-closed path.
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(spaced, 'node_modules'), 'dir');
    const repo = mkdtempSync(join(tmpdir(), 'adlc-codex-spaced-'));
    try {
      mkdirSync(join(repo, '.adlc'), { recursive: true });
      seedForeignDeny('denier-spaced')(repo);
      let status = 0;
      let out = '';
      try {
        execFileSync(process.execPath, [join(copyDir, 'adlc-handoff-gate.mjs')], {
          input: JSON.stringify({
            session_id: 'consumer-spaced',
            tool_name: 'apply_patch',
            file_path: 'src/app.mjs',
          }),
          encoding: 'utf8',
          cwd: repo,
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
      assert.equal(status, 2, `the hook must still enforce from a spaced path: ${out}`);
      assert.match(out, /D3:unauthorized_open:denier-spaced/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  } finally {
    rmSync(spaced, { recursive: true, force: true });
  }
});

test('a supplied but missing transcript fails closed; an absent one does not', () => {
  // Absent field → no signal → a harness without telemetry stays usable.
  const absent = runHandoff({ sessionId: 'sess-absent' });
  assert.equal(absent.verdict, 'allow', absent.out);

  // Supplied but unreachable → a FAILED read of a real signal, not the absence
  // of one. A rotated or deleted transcript must not read as "no pressure".
  const missing = runHandoff({
    sessionId: 'sess-missing',
    payloadExtra: { file_path: 'src/app.mjs', transcript_path: '/nonexistent/rotated.jsonl' },
  });
  assert.equal(missing.verdict, 'deny', missing.out);
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

test('a nested shell call inside a parallel envelope is scanned for protected paths', () => {
  // multi_tool_use.parallel is in this hook's PreToolUse matcher, but the outer
  // envelope is not itself a shell tool. Reading only the outer name left the
  // nested command unscanned, so this deletion was allowed on a cold deny-set
  // while the same command sent directly was denied.
  const r = runHandoff({
    sessionId: 'parallel-1',
    toolName: 'multi_tool_use.parallel',
    transcriptToolCalls: 5,
    payloadExtra: {
      tool_uses: [
        {
          recipient_name: 'functions.exec_command',
          parameters: { command: 'rm -rf .adlc/handoffs .adlc/.deny-store' },
        },
      ],
    },
  });
  assert.equal(r.verdict, 'deny', r.out);
  assert.match(r.out, /path_protected_shell/);
});

test('a parallel envelope carrying only ordinary work is still allowed', () => {
  const r = runHandoff({
    sessionId: 'parallel-2',
    toolName: 'multi_tool_use.parallel',
    transcriptToolCalls: 5,
    payloadExtra: {
      tool_uses: [
        { recipient_name: 'functions.exec_command', parameters: { command: 'cat ./src/app.mjs' } },
        { recipient_name: 'functions.apply_patch', parameters: { path: 'src/app.mjs' } },
      ],
    },
  });
  assert.equal(r.verdict, 'allow', r.out);
});
