#!/usr/bin/env node
// adlc-rails-guard.mjs — the agy PreToolUse hook adapter (ESM core).
// Invoked via the .cjs shim (adlc-rails-guard.cjs) which registers process error
// handlers first. Maps agy's stdin { toolCall: { name, args } } onto the
// editor-agnostic checkRail() and emits agy's { allow_tool, deny_reason } verdict.
// Deny path imports ONLY node: builtins + the sibling checker (→ @adlc/core).
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { checkRail, classifyTool, isShellTool } from '../rails-checker.mjs';

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

const WORKSPACE_KEYS = ['workspacePaths', 'workspace_paths', 'workspaceRoots', 'workspace_roots'];

/** Nearest ancestor dir of absPath containing .adlc/tickets.json, or null. */
export function findAdlcRoot(absPath) {
  let cur = dirname(absPath);
  const { root: fsRoot } = parse(cur);
  // Bounded walk to the filesystem root — never uses process.cwd() (the plugin dir).
  while (true) {
    if (existsSync(join(cur, '.adlc', 'tickets.json'))) return cur;
    if (cur === fsRoot) return null;
    cur = dirname(cur);
  }
}

/** Make a raw target path absolute using workspacePaths[0]; report if we could. */
export function anchorPath(rawPath, payload) {
  if (!rawPath) return { abs: null, anchored: false };
  if (isAbsolute(rawPath)) return { abs: rawPath, anchored: true };
  const ws = WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : []))
    .find((s) => typeof s === 'string' && s.trim());
  if (ws) return { abs: join(ws, rawPath), anchored: true };
  return { abs: null, anchored: false };
}

const allow = () => ({ allow_tool: true });
const deny = (reason) => ({ allow_tool: false, deny_reason: `ADLC rails-guard: ${reason}` });

/**
 * Pure decision over a parsed agy PreToolUse payload → agy verdict.
 * Never throws (the caller also wraps it). Implements the §5 decision tree.
 */
export function decide(payload, { env = process.env } = {}) {
  let enforcing = false;
  try {
    enforcing = env?.ADLC_P4_ENFORCEMENT === '1';
    const tool = extractToolName(payload);
    const cls = classifyTool(tool);

    // Step 2 — classify first. Reads and shell tools are never rail-gated in-session.
    if (cls === 'readonly') return allow();
    if (isShellTool(tool)) return allow(); // run_command → CI diff gate

    const paths = extractFilePaths(payload);

    // Step 2 (cont.) — an 'other' tool with NO path and no mutating hint is not a file
    // op (e.g. generate_image, a mutator with no inspectable path) → allow. A
    // 'mutating' name with no path is opaque (H2).
    if (!paths.length) {
      if (cls === 'other') return allow();
      return enforcing
        ? deny(`mutating tool "${tool}" exposed no inspectable target path — failing closed`)
        : allow();
    }

    // Steps 3–4 — resolve each target; fail closed on anything unanchorable (H1/H2/H3),
    // no-op allow only for an absolute path in a genuinely non-ADLC location (G2).
    for (const raw of paths) {
      const { abs, anchored } = anchorPath(raw, payload);
      if (!anchored) {
        if (enforcing) return deny(`unanchorable path "${raw}" (relative, no workspace root) — failing closed`);
        continue;
      }
      const root = findAdlcRoot(abs);
      if (root === null) continue; // absolute path, not an ADLC repo → no-op allow (G2)
      const verdict = checkRail({ filePath: abs, tool, root, env });
      if (verdict.decision === 'deny') return deny(`frozen rail — ${verdict.reason}`);
    }
    return allow();
  } catch (err) {
    // Categorical fail-safe: under enforcement an unexpected error is more likely
    // tamper/corruption than a benign bug → fail CLOSED; off → no-op allow.
    return enforcing ? deny(`internal error while enforcing — ${err?.message ?? err}`) : allow();
  }
}

/** Parse a raw stdin string and return the agy verdict. Enforcement-aware on bad JSON. */
export function runFromStdin(raw, env = process.env) {
  const enforcing = env?.ADLC_P4_ENFORCEMENT === '1';
  let payload = {};
  if (raw && raw.trim()) {
    try { payload = JSON.parse(raw); }
    catch { return enforcing ? deny('unparseable tool payload while enforcing — failing closed') : allow(); }
  }
  return decide(payload, { env });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main() {
  const raw = await readStdin();
  process.stdout.write(JSON.stringify(runFromStdin(raw, process.env)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
