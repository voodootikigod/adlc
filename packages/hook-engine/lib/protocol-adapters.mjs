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

export const DECISION_LATTICE = Object.freeze({
  pass: 0,
  allow: 0,
  ask: 1,
  force_ask: 2,
  deny: 3,
  block: 3,
});

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
  if (e === 'sessionstart' || e === 'session.created' || e === 'session_start' || e === 'preinvocation') {
    return 'session-start';
  }
  return e || 'pretool';
}

function isPlainObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function parseToolArgsString(raw) {
  if (Buffer.byteLength(raw, 'utf8') > MAX_TOOL_ARGS_BYTES) {
    return { __unparseable: true };
  }
  try {
    const parsed = JSON.parse(raw);
    return isPlainObj(parsed) ? parsed : { __unparseable: true };
  } catch {
    return { __unparseable: true };
  }
}

function firstNonEmptyString(values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function extractWorkspacePaths(p) {
  const raw = [p.workspacePaths, p.workspace_paths, p.workspaceRoots, p.workspace_roots];
  const out = [];
  for (const entry of raw) {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === 'string' && item.trim() && !out.includes(item.trim())) {
          out.push(item.trim());
        }
      }
    } else if (typeof entry === 'string' && entry.trim() && !out.includes(entry.trim())) {
      out.push(entry.trim());
    }
  }
  return out;
}

export function normalizeHookInput(harness, rawPayload = {}) {
  const proto = resolveHarnessProtocol(harness);
  const p = isPlainObj(rawPayload) ? rawPayload : {};
  const tc = isPlainObj(p.toolCall) ? p.toolCall : (isPlainObj(p.tool_call) ? p.tool_call : null);

  const event = canonicalEventName(
    p.hook_event_name ?? p.hookEventName ?? p.event ?? p.type ?? 'pretool'
  );
  const toolName = String(
    p.tool_name ??
    p.toolName ??
    (typeof p.tool === 'string' ? p.tool : null) ??
    p.name ??
    tc?.name ??
    tc?.toolName ??
    tc?.tool_name ??
    ''
  );

  const objCandidates = [
    p.tool_input,
    p.toolInput,
    p.toolArgs,
    p.args,
    p.input,
    tc?.args,
    tc?.arguments,
    tc?.params,
    tc?.parameters,
    tc?.input,
    tc?.tool_input,
    tc?.toolInput,
  ];
  let toolInput = objCandidates.find(isPlainObj) ?? null;

  if (!toolInput) {
    const strArgs = typeof p.toolArgs === 'string'
      ? p.toolArgs
      : (typeof tc?.arguments === 'string' ? tc.arguments : null);
    if (strArgs !== null) toolInput = parseToolArgsString(strArgs);
  }
  if (!toolInput) toolInput = {};

  const toolResult = p.tool_response ?? p.toolResult ?? p.result ?? p.output ?? null;
  const cwd = firstNonEmptyString([p.cwd, p.directory, p.workingDirectory, p.working_directory]);
  const workspacePaths = extractWorkspacePaths(p);
  const outerRoot = firstNonEmptyString([workspacePaths[0], p.project_dir, p.projectRoot]);
  const conversationId = firstNonEmptyString([
    p.conversationId,
    p.conversation_id,
    p.conversationID,
    p.params?.conversationId,
    p.params?.conversation_id,
  ]);
  const sessionId = firstNonEmptyString([p.session_id, p.sessionId, p.sessionID, conversationId]);
  const transcriptPath = firstNonEmptyString([p.transcript_path, p.transcriptPath]);

  return {
    harness: proto,
    event,
    toolName,
    toolInput,
    toolResult,
    cwd,
    outerRoot,
    workspacePaths,
    conversationId,
    sessionId,
    transcriptPath,
  };
}

export function formatHookOutput(harness, event, result = {}) {
  const proto = resolveHarnessProtocol(harness);
  const ev = canonicalEventName(event);
  const dec = String(result.decision ?? '').toLowerCase();
  const denied = dec === 'deny' || dec === 'block';
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
    } else if ((ev === 'session-start' || ev === 'posttool') && context) {
      payload = {
        hookSpecificOutput: {
          hookEventName: ev === 'session-start' ? 'SessionStart' : 'PostToolUse',
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
      if (denied) {
        payload = { decision: 'deny', reason, allow_tool: false, deny_reason: reason };
      } else if (dec === 'force_ask') {
        payload = { decision: 'force_ask', reason, allow_tool: false };
      } else if (dec === 'ask') {
        payload = { decision: 'ask', reason };
      } else {
        payload = { decision: 'pass', allow_tool: true };
      }
    } else if (ev === 'stop') {
      payload = (denied || dec === 'continue')
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
