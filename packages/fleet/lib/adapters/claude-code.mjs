// The v1 WorkerAdapter: headless Claude Code (spec §4, §7.2; K2 model plane).
//
// The adapter is a pure I/O shim — no retry, gate, or git logic (that is all
// scheduler policy, so future codex/agy/opencode adapters inherit it). It:
//   - provision(): writes the worktree's .claude/settings.local.json allowlist,
//     translating config command strings into Claude Code permission-rule form
//     (the load-bearing syntax step — premortem F1);
//   - dispatch(): runs `claude -p … --permission-mode acceptEdits` in the
//     worktree on the MODEL plane (provider egress + its own auth), explicitly
//     NOT wrapped in the no-network repo-command sandbox (K2), or it could never
//     authenticate.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnAsync } from '../spawn-async.mjs';
import { modelArgs, TRUNCATED_NOTE } from './_shared.mjs';
import { UNREPORTED, normalizeUsage, reported } from './usage.mjs';

export const name = 'claude-code';
export const pool = 'default';

/**
 * 7.3 model-plane filesystem policy (issue #395): where THIS harness writes its
 * own session state, and nowhere else.
 *
 * `.claude/` itself is deliberately ABSENT. It holds `settings.json`,
 * `settings.local.json`, `hooks/`, `agents/`, `skills/` and `plugins/` -- executable
 * configuration that decides what runs in the operator's NEXT session. Granting the
 * parent and carving those back out would make the boundary depend on which of them
 * happen to exist on this host today; granting only the scratch subdirectories does
 * not.
 *
 * The stored credential is writable because the CLI refreshes its OAuth token in
 * place -- a read-only credential file turns an expiring session into a mid-run
 * failure.
 */
export const homeState = Object.freeze({
  dirs: Object.freeze([
    '.claude/projects', '.claude/todos', '.claude/statsig', '.claude/shell-snapshots',
    '.claude/file-history', '.claude/logs', '.claude/downloads', '.cache/claude-cli-nodejs',
  ]),
  files: Object.freeze(['.claude/.credentials.json', '.claude.json', '.claude.json.backup']),
});

/**
 * Run-time aliases this harness resolves for itself (operating-stack §4b rule 6).
 *
 * `claude --help` documents `--model` as taking "an alias for the latest model
 * (e.g. 'fable', 'opus', or 'sonnet') or a model's full name" — the alias set is
 * open-ended by construction, since each alias tracks whatever "latest" means
 * today. The list is therefore deliberately OVER-inclusive: a name listed here
 * that turns out to be concrete only costs a reviewer seat an explicit model ID,
 * while a mutable alias missing from the list would let reviewer identity drift
 * under the attestation — the failure this rule exists to prevent.
 */
export const aliases = Object.freeze(['default', 'fable', 'opus', 'sonnet', 'haiku', 'opusplan']);

/** `--model` accepts an alias or a full model name, so this adapter can serve a registry seat (§4c). */
export const forcesModel = true;

/**
 * §4c ATTEST half: whether this adapter reports the concrete model its harness
 * actually ran (`resolvedModel`). NONE do yet — that is spec §9.3 — so an
 * alias-based channel cannot be bound to any adapter today, which is exactly
 * what §4c round-11 requires: without attestation, an alias is an unverifiable
 * claim about what executed.
 */
export const attestsResolvedModel = false;

/**
 * §4b transport classes this harness can serve (issue #396).
 *
 * `subscription` — the harness's own OAuth/keychain session, read from HOME.
 * `api` — the CLI documents a mode in which "Anthropic auth is strictly
 * ANTHROPIC_API_KEY ... OAuth and keychain are never read", so a metered path
 * exists and is nameable.
 *
 * THE GUARANTEE IS ASYMMETRIC. Withholding the key is provable: a subscription
 * seat that never receives ANTHROPIC_API_KEY cannot have been metered. Supplying
 * it is not: a harness handed a key may still prefer a stored session. That is
 * why a recorded transport is `selected`, never `attested` — proving what
 * actually served a call is the deferred half (§9.3's twin for transport).
 */
export const transports = Object.freeze({
  subscription: Object.freeze({}),
  api: Object.freeze({ env: 'ANTHROPIC_API_KEY' }),
});

/**
 * Model-plane egress allowlist (issue-autopilot spec §6.4 "EGRESS", §14 item 13):
 * the model API plus the OAuth refresh hosts the CLI is known to contact. Under
 * `--model-plane-egress allowlist` these exact `host:port` pairs are the ONLY
 * CONNECT targets the host-side proxy will open for this harness.
 */
export const egressHosts = Object.freeze(['api.anthropic.com:443', 'console.anthropic.com:443', 'platform.claude.com:443']);

/**
 * Translate a config command string into a Claude Code permission rule. A raw
 * string allowlists NOTHING (premortem F1), so each becomes `Bash(<cmd>)`; a
 * command already carrying a `:*` wildcard is preserved.
 */
export function toPermissionRule(command) {
  return `Bash(${command})`;
}

/** Build the settings.local.json object for a worktree from config (§7.2). */
export function buildSettings(config = {}) {
  const gate = config.gate ?? {};
  const cmds = [
    ...(config.init ? [config.init] : []),
    ...(gate.build ? [gate.build] : []),
    ...(gate.test ? [gate.test] : []),
    ...(config.allowedCommands ?? []),
  ];
  const allow = [
    ...cmds.map(toPermissionRule),
    // read-only git the worker may need; NOT git commit (orchestrator commits).
    'Bash(git status)',
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
  ];
  return { permissions: { allow, deny: [] } };
}

/**
 * Write the allowlist settings into the worktree. Returns the object written.
 * `writeJson` is injectable so tests need no real filesystem.
 */
export function provision({ worktree, config, writeJson = defaultWriteJson }) {
  const settings = buildSettings(config);
  const path = join(worktree, '.claude', 'settings.local.json');
  writeJson(path, settings);
  return { settings, path };
}

function defaultWriteJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Dispatch one build attempt. Runs on the MODEL plane: the worker process keeps
 * provider egress + its own auth and is NOT sandboxed (K2). `env` is the
 * model-plane env the scheduler built (ADLC_P4_ENFORCEMENT=1 + ADLC_TICKET + the
 * worker's own model auth). Returns { exitCode, output, timedOut }.
 *
 * @param exec injectable spawn: (cmd, args, opts) => { status, stdout, stderr, signal }
 */
/**
 * Parse usage out of a `claude -p --output-format json` result document (T152,
 * §8a). Unlike opencode's JSONL event stream this mode emits ONE JSON object,
 * whose `usage` block is the Anthropic shape:
 *
 *   {"type":"result","subtype":"success","result":"ok",
 *    "usage":{"input_tokens":10,"output_tokens":54,
 *             "cache_read_input_tokens":17615,"cache_creation_input_tokens":21332}}
 *
 * The mapping is deliberately identical to @adlc/core's `usageFromAnthropic`:
 * cache READ and cache CREATION both count as cached, since both are input the
 * provider billed at a cache rate rather than fresh input.
 *
 * Returns `{usage, usageStatus, usageRaw}`, or UNREPORTED when stdout is not
 * that document (plain-text mode, a crash, a truncated pipe) or its counters
 * are not clean counts.
 */
export function parseUsage(output) {
  let doc;
  try { doc = JSON.parse(String(output ?? '').trim()); }
  catch { return UNREPORTED; }
  if (doc === null || typeof doc !== 'object') return UNREPORTED;

  const raw = doc.usage;
  if (raw === null || typeof raw !== 'object') return UNREPORTED;

  const usage = normalizeUsage({
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    cachedTokens: (raw.cache_read_input_tokens ?? 0) + (raw.cache_creation_input_tokens ?? 0),
  });
  if (usage === null) return UNREPORTED;

  return reported(usage, {
    input: raw.input_tokens,
    output: raw.output_tokens,
    cache: { read: raw.cache_read_input_tokens ?? 0, write: raw.cache_creation_input_tokens ?? 0 },
  });
}

/**
 * The assistant's text lives in `result` on the same document, so `output`
 * keeps meaning what it meant under `--output-format text`. Null when this is
 * not a result document, so the caller falls back to raw stdout instead of
 * reporting an empty transcript.
 */
export function parseText(output) {
  try {
    const doc = JSON.parse(String(output ?? '').trim());
    return typeof doc?.result === 'string' ? doc.result : null;
  } catch { return null; }
}

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, model, command = 'claude' }) {
  // §4c force half: the registry's model goes on the command line explicitly —
  // never the harness's ambient default.
  //
  // `json` rather than `text` so usage is observable at all; the assistant text
  // is recovered from the document's `result` below, so downstream consumers
  // (the flail transcript, the TICKET-BLOCKED probe) see what they saw before.
  const args = ['-p', prompt, '--permission-mode', 'acceptEdits', '--output-format', 'json', ...modelArgs('--model', model)];
  const res = await exec(command, args, { cwd: worktree, env, timeout: timeoutMs });
  const timedOut = res.signal === 'SIGTERM' || res.killed === true || res.timedOut === true;
  const stdout = `${res.stdout ?? ''}`;
  const text = parseText(stdout);
  const status = typeof res.status === 'number' ? res.status : (timedOut ? 124 : 1);
  return {
    // A truncated stream is never a success (codex r24 #4): its document may be the part cut off.
    exitCode: res.truncated === true && status === 0 ? 1 : status,
    output: `${res.truncated === true ? TRUNCATED_NOTE : ''}${text === null ? `${stdout}${res.stderr ?? ''}` : `${text}${res.stderr ?? ''}`}`,
    timedOut,
    ...(res.truncated === true ? { truncated: true } : {}),
    ...parseUsage(stdout),
  };
}

function defaultExec(cmd, args, opts) {
  return spawnAsync(cmd, args, { ...opts, encoding: 'utf8' });
}
