// protocol-adapters.mjs — wire-protocol normalization and formatting across all
// 7 shipped ADLC harnesses: claude-code, codex, copilot, cursor, gemini
// (Antigravity agy / JetSki jetski), opencode, and pi.

export const HARNESS_PROTOCOLS = Object.freeze([
  'claude-code',
  'codex',
  'copilot',
  'cursor',
  'gemini',
  'opencode',
  'pi',
]);

const MAX_TOOL_ARGS_BYTES = 256 * 1024;

const HARNESS_ALIASES = new Map([
  ['claude', 'claude-code'],
  ['claude-code', 'claude-code'],
  ['codex', 'codex'],
  ['copilot', 'copilot'],
  ['cursor', 'cursor'],
  ['gemini', 'gemini'],
  ['antigravity', 'gemini'],
  ['agy', 'gemini'],
  ['jetski', 'gemini'],
  ['opencode', 'opencode'],
  ['pi', 'pi'],
]);

/**
 * Canonicalize a harness identifier (supporting aliases like `agy`/`jetski` -> `gemini`).
 * @param {string} harness
 * @returns {string}
 */
export function resolveHarnessProtocol(harness) {
  const key = String(harness ?? '').trim().toLowerCase();
  const resolved = HARNESS_ALIASES.get(key);
  if (!resolved) {
    throw new Error(`Unsupported harness protocol: ${String(harness)}`);
  }
  return resolved;
}

function canonicalEventName(rawEvent) {
  const e = String(rawEvent ?? '').trim().toLowerCase();
  if (e === 'pretooluse' || e === 'beforetool' || e === 'tool.execute.before' || e === 'tool_call') {
    return 'pretool';
  }
  if (e === 'posttooluse' || e === 'aftertool' || e === 'tool.execute.after' || e === 'tool_result') {
    return 'posttool';
  }
  if (e === 'stop' || e === 'afteragent' || e === 'session.idle' || e === 'agent_end') {
    return 'stop';
  }
  if (e === 'sessionstart' || e === 'session.created' || e === 'session_start') {
    return 'session-start';
  }
  return e || 'pretool';
}

function parseToolArgsString(raw) {
  if (Buffer.byteLength(raw, 'utf8') > MAX_TOOL_ARGS_BYTES) {
    return { __unparseable: true };
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { __unparseable: true };
  } catch {
    return { __unparseable: true };
  }
}

/**
 * Normalize a harness-native hook payload into a canonical hook-engine input.
 * Supports Copilot's JSON-stringified `toolArgs` field as well as structured
 * `tool_input`, `toolInput`, `args`, and `input` objects.
 *
 * @param {string} harness
 * @param {object} [rawPayload]
 * @returns {{ harness: string, event: string, toolName: string, toolInput: object, toolResult: unknown, cwd: string | null, outerRoot: string | null, sessionId: string | null }}
 */
export function normalizeHookInput(harness, rawPayload = {}) {
  const proto = resolveHarnessProtocol(harness);
  const p = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};

  const event = canonicalEventName(
    p.hook_event_name ?? p.hookEventName ?? p.event ?? p.type ?? 'pretool'
  );
  const toolName = String(
    p.tool_name ?? p.toolName ?? p.tool ?? p.name ?? ''
  );

  let toolInput =
    (p.tool_input && typeof p.tool_input === 'object' && !Array.isArray(p.tool_input) ? p.tool_input : null) ??
    (p.toolInput && typeof p.toolInput === 'object' && !Array.isArray(p.toolInput) ? p.toolInput : null) ??
    (p.toolArgs && typeof p.toolArgs === 'object' && !Array.isArray(p.toolArgs) ? p.toolArgs : null) ??
    (p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? p.args : null) ??
    (p.input && typeof p.input === 'object' && !Array.isArray(p.input) ? p.input : null);

  if (!toolInput && typeof p.toolArgs === 'string') {
    toolInput = parseToolArgsString(p.toolArgs);
  }
  if (!toolInput) {
    toolInput = {};
  }

  const toolResult = p.tool_response ?? p.toolResult ?? p.result ?? p.output ?? null;
  const cwd =
    (typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : null) ??
    (typeof p.directory === 'string' && p.directory.trim() ? p.directory.trim() : null) ??
    (typeof p.workingDirectory === 'string' && p.workingDirectory.trim() ? p.workingDirectory.trim() : null) ??
    null;
  const outerRoot =
    (Array.isArray(p.workspace_roots) && typeof p.workspace_roots[0] === 'string' ? p.workspace_roots[0] : null) ??
    (typeof p.project_dir === 'string' ? p.project_dir : null) ??
    (typeof p.projectRoot === 'string' ? p.projectRoot : null) ??
    null;
  const sessionId =
    (typeof p.session_id === 'string' ? p.session_id : null) ??
    (typeof p.sessionId === 'string' ? p.sessionId : null) ??
    null;

  return { harness: proto, event, toolName, toolInput, toolResult, cwd, outerRoot, sessionId };
}

/**
 * Format a canonical hook-engine evaluation result into the native wire output
 * and exit code expected by `harness`:
 * - `claude-code`: `hookSpecificOutput.permissionDecision='deny'` (exit 0), Stop `{ decision:'block', reason }`
 * - `codex`: `{ decision:'block', reason }` (exit 2)
 * - `copilot`: top-level `{ reason }` (exit 0)
 * - `cursor`: `{ permission:'deny', user_message, agent_message }` (snake_case, exit 0), Stop `{ followup_message }`
 * - `gemini` (`agy`/`jetski`): PreTool `{ decision:'deny', reason, allow_tool:false, deny_reason }` (exit 0), Stop `{ decision:'continue', reason }`
 * - `opencode`: `{ blocked:true, reason }`
 * - `pi`: `{ block:true, reason }`
 *
 * @param {string} harness
 * @param {'pretool' | 'posttool' | 'stop' | 'session-start'} event
 * @param {object} result
 * @returns {{ exitCode: number, payload: object, stdout: string }}
 */
export function formatHookOutput(harness, event, result = {}) {
  const proto = resolveHarnessProtocol(harness);
  const ev = canonicalEventName(event);
  const denied = result.decision === 'deny' || result.decision === 'block';
  const reason = result.reason ?? '';
  const context = result.additionalContext ?? result.advisory ?? '';

  let payload = {};
  let exitCode = 0;

  if (proto === 'claude-code') {
    if (ev === 'pretool' && denied) {
      payload = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    } else if (ev === 'stop' && denied) {
      payload = { decision: 'block', reason };
    } else if (ev === 'session-start' && context) {
      payload = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      };
    } else if (ev === 'posttool' && context) {
      payload = {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: context,
        },
      };
    }
  } else if (proto === 'codex') {
    if ((ev === 'pretool' || ev === 'stop') && denied) {
      payload = { decision: 'block', reason };
      exitCode = 2;
    } else if (ev === 'session-start' && context) {
      payload = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      };
    } else if (context) {
      payload = { systemMessage: context };
    }
  } else if (proto === 'copilot') {
    if ((ev === 'pretool' || ev === 'stop') && denied) {
      payload = { reason: reason || 'ADLC hook denied tool execution' };
    } else if (context) {
      payload = { additionalContext: context };
    }
  } else if (proto === 'cursor') {
    if (ev === 'pretool' && denied) {
      payload = { permission: 'deny', user_message: reason, agent_message: reason };
    } else if (ev === 'stop' && denied) {
      payload = { followup_message: reason };
    } else if (context) {
      payload = { additional_context: context };
    }
  } else if (proto === 'gemini') {
    if (ev === 'pretool') {
      payload = denied
        ? { decision: 'deny', reason, allow_tool: false, deny_reason: reason }
        : { decision: 'allow', allow_tool: true };
    } else if (ev === 'stop') {
      payload = denied
        ? { decision: 'continue', reason }
        : { decision: 'stop' };
    } else if (context) {
      payload = { hookSpecificOutput: { additionalContext: context } };
    }
  } else if (proto === 'opencode') {
    if ((ev === 'pretool' || ev === 'stop') && denied) {
      payload = { blocked: true, reason };
    } else if (context) {
      payload = { advisory: context };
    }
  } else if (proto === 'pi') {
    if ((ev === 'pretool' || ev === 'stop') && denied) {
      payload = { block: true, reason };
    } else if (context) {
      payload = { advisory: context };
    }
  }

  return {
    exitCode,
    payload,
    stdout: Object.keys(payload).length > 0 ? `${JSON.stringify(payload)}\n` : '',
  };
}
