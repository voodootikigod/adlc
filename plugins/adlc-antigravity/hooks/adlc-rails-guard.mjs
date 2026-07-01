#!/usr/bin/env node
// adlc-rails-guard.mjs — the agy PreToolUse hook adapter (ESM core).
// Invoked via the .cjs shim (adlc-rails-guard.cjs) which registers process error
// handlers first. Maps agy's stdin { toolCall: { name, args } } onto the
// editor-agnostic checkRail() and emits agy's { allow_tool, deny_reason } verdict.
// Deny path imports ONLY node: builtins + the sibling checker (→ @adlc/core).
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { checkRail, classifyTool, isShellTool, railPreconditions } from '../rails-checker.mjs';

// agy nests the call under toolCall; args is the parameter bag. Read defensively.
const TOOLCALL_KEYS = ['toolCall', 'tool_call', 'tool'];
const NAME_KEYS = ['name', 'toolName', 'tool_name'];
const ARGS_KEYS = ['args', 'arguments', 'params', 'parameters', 'input', 'tool_input'];
// agy file-path arg keys are PascalCase (V7): write_to_file→TargetFile,
// view_file→AbsolutePath. Include common fallbacks. CommandLine/CodeContent are
// deliberately EXCLUDED — they are a shell string / file body, not a path.
const PATH_KEYS = ['TargetFile', 'AbsolutePath', 'FilePath', 'Path', 'path', 'file_path', 'filePath', 'target_file', 'targetFile'];

function toolCallOf(p) {
  if (!p || typeof p !== 'object') return undefined;
  for (const k of TOOLCALL_KEYS) if (p[k] && typeof p[k] === 'object') return p[k];
  return p; // some shapes may put name/args at top level
}
function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k];
  return undefined;
}

export function extractToolName(payload) {
  return firstString(toolCallOf(payload), NAME_KEYS) ?? '';
}
export function extractArgs(payload) {
  const tc = toolCallOf(payload);
  if (!tc || typeof tc !== 'object') return {};
  for (const k of ARGS_KEYS) if (tc[k] && typeof tc[k] === 'object') return tc[k];
  return {};
}
export function extractFilePaths(payload) {
  const args = extractArgs(payload);
  const out = new Set();
  for (const k of PATH_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) out.add(v);
    else if (Array.isArray(v)) for (const e of v) if (typeof e === 'string' && e.trim()) out.add(e);
  }
  return [...out];
}
