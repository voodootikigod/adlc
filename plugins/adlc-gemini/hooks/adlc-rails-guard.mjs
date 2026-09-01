#!/usr/bin/env node
// adlc-rails-guard.mjs — the agy PreToolUse hook adapter (ESM core).
// Invoked via the .cjs shim (adlc-rails-guard.cjs) which registers process error
// handlers first. Maps agy's stdin { toolCall: { name, args } } onto the
// editor-agnostic checkRail() and emits agy's { allow_tool, deny_reason } verdict.
// Deny path imports ONLY node: builtins + the sibling checker (→ @adlc/core).
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

function canonicalizeExisting(p) {
  if (!p || typeof p !== 'string') return p;
  try {
    if (existsSync(p)) return realpathSync(p);
    let cur = dirname(p);
    const suffix = [parse(p).base];
    const { root: fsRoot } = parse(cur);
    while (cur && cur !== fsRoot) {
      if (existsSync(cur)) {
        return join(realpathSync(cur), ...suffix);
      }
      suffix.unshift(parse(cur).base);
      cur = dirname(cur);
    }
  } catch {}
  return p;
}

function realpathOr(p) {
  try {
    return existsSync(p) ? realpathSync(p) : p;
  } catch {
    return p;
  }
}
import { checkRail, classifyTool, isShellTool, hasCommandLineArgs, resolveActiveTicketId, railPreconditions, TRUST_ROOT_RAILS } from '../rails-checker.mjs';
import { loadTicketStoreReadOnly } from '../generated-ticket-reader.mjs';
import { checkBuildGate, checkFlail, createPersistentTracker, resolveSessionId, computePrefixHash, readTranscriptPrefixBounded, readTextFileBounded } from '../build-gate-inline.mjs';
import { flailMessage, resolveTranscriptPath, parseTranscriptSteps, parseTranscriptRecords, analyzeFlail } from '../flail-inline.mjs';

// agy nests the call under toolCall; args is the parameter bag. Read defensively.
const TOOLCALL_KEYS = ['toolCall', 'tool_call', 'tool'];
const NAME_KEYS = ['name', 'toolName', 'tool_name'];
const ARGS_KEYS = ['args', 'arguments', 'params', 'parameters', 'input', 'tool_input'];
// agy file-path arg keys are PascalCase (V7): write_to_file→TargetFile,
// view_file→AbsolutePath. Include common fallbacks. CommandLine/CodeContent are
// deliberately EXCLUDED — they are a shell string / file body, not a path.
const PATH_KEYS = [
  'TargetFile', 'AbsolutePath', 'FilePath', 'Path', 'path', 'file_path', 'filePath', 'target_file', 'targetFile',
  'dest_file', 'destFile', 'dest', 'destination', 'destPath', 'target', 'file', 'filename', 'filepath',
  'targetPath', 'source', 'sourceFile', 'src', 'src_file', 'dst', 'dst_file', 'output', 'output_file',
  'output_path', 'out_file', 'outFile', 'outPath', 'outputPath', 'TargetContentPath', 'TargetDir',
];

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

  function scan(obj, parentKey = '', depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return;
    for (const [key, v] of Object.entries(obj)) {
      if (key === 'CommandLine' || key === 'command' || key === 'cmd' || key === 'code' || key === 'CodeContent' || key === 'content' || key === 'ReplacementContent' || key === 'TargetContent' || key === 'Instruction' || key === 'Description' || key === 'Prompt' || key === 'Message' || key === 'message') {
        continue;
      }
      const isPathKey = PATH_KEYS.some((pk) => pk.toLowerCase() === key.toLowerCase()) || (parentKey && PATH_KEYS.some((pk) => pk.toLowerCase() === parentKey.toLowerCase()));
      if (typeof v === 'string') {
        if (isPathKey && v.trim()) out.add(v.trim());
      } else if (Array.isArray(v)) {
        for (const e of v) {
          if (typeof e === 'string' && isPathKey && e.trim()) out.add(e.trim());
          else if (e && typeof e === 'object') scan(e, key, depth + 1);
        }
      } else if (v && typeof v === 'object') {
        scan(v, key, depth + 1);
      }
    }
  }

  scan(args);
  return [...out];
}

function hasPathLikeArgs(args, depth = 0) {
  if (!args || typeof args !== 'object' || depth > 5) return false;
  for (const [key, val] of Object.entries(args)) {
    if (key === 'CommandLine' || key === 'command' || key === 'cmd' || key === 'code' || key === 'CodeContent' || key === 'content' || key === 'ReplacementContent' || key === 'TargetContent' || key === 'Instruction' || key === 'Description' || key === 'Prompt' || key === 'Message' || key === 'message') {
      continue;
    }
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('.') || /(file|path|dest|target|dir|src|dst)/i.test(key)) {
        return true;
      }
    } else if (val && typeof val === 'object') {
      if (/(file|path|dest|target|dir|src|dst)/i.test(key) || hasPathLikeArgs(val, depth + 1)) {
        return true;
      }
    }
  }
  return false;
}

const WORKSPACE_KEYS = ['workspacePaths', 'workspace_paths', 'workspaceRoots', 'workspace_roots'];

/** Nearest ancestor dir of absPath containing a supported ADLC ticket store, or null.
 * Bounded walk to the filesystem root — never uses process.cwd() (the plugin dir). */
export function findAdlcRoot(absPath, env = process.env) {
  if (!absPath || typeof absPath !== 'string' || !isAbsolute(absPath)) return null;
  const storeOverride = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;

  let cur = absPath;
  try {
    const stat = lstatSync(absPath);
    if (!stat.isDirectory()) cur = dirname(absPath);
  } catch {
    cur = dirname(absPath);
  }

  // Check explicit workspace roots from env if storeOverride is an absolute path
  if (storeOverride && isAbsolute(storeOverride) && existsSync(storeOverride)) {
    const explicitRoots = [env?.AGY_WORKSPACE, env?.ANTIGRAVITY_WORKSPACE, env?.PROJECT_ROOT, env?.WORKSPACE_ROOT]
      .filter((r) => typeof r === 'string' && r.trim() && isAbsolute(r.trim()));
    for (const er of explicitRoots) {
      const rel = relative(er, absPath);
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        return er;
      }
    }
  }

  const { root: fsRoot } = parse(cur);
  let topGitRoot = null;
  let topAdlcRoot = null;

  while (true) {
    if (storeOverride) {
      if (!isAbsolute(storeOverride)) {
        if (existsSync(join(cur, storeOverride))) return cur;
      }
    }
    if (existsSync(join(cur, '.adlc', 'tickets.json')) || existsSync(join(cur, '.adlc', 'tickets', '.store.json'))) {
      return cur;
    }
    if (existsSync(join(cur, '.adlc'))) {
      topAdlcRoot = cur;
    }
    if (existsSync(join(cur, '.git'))) {
      topGitRoot = cur;
    }
    if (cur === fsRoot) break;
    cur = dirname(cur);
  }

  if (storeOverride && isAbsolute(storeOverride) && existsSync(storeOverride)) {
    if (topAdlcRoot) return topAdlcRoot;
    if (topGitRoot) return topGitRoot;
  }
  return null;
}

/** Make a raw target path absolute using workspacePaths[0]; report if we could. */
export function anchorPath(rawPath, payload) {
  if (!rawPath) return { abs: null, anchored: false };
  if (isAbsolute(rawPath)) return { abs: rawPath, anchored: true };
  const ws = WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : []))
    .find((s) => typeof s === 'string' && s.trim());
  if (ws) {
    const absWs = isAbsolute(ws) ? ws : resolve(process.cwd(), ws);
    return { abs: join(absWs, rawPath), anchored: true };
  }
  return { abs: null, anchored: false };
}

const allow = () => ({ decision: 'allow', allow_tool: true });
const deny = (reason) => ({
  decision: 'deny',
  reason: `ADLC rails-guard: ${reason}`,
  allow_tool: false,
  deny_reason: `ADLC rails-guard: ${reason}`,
});

/**
 * A parsed payload the decision tree can reason about: a plain (non-array)
 * object. Anything else — null, a scalar, an array — has no tool name to
 * classify and used to fall through as an unclassified tool (#823). ONE
 * definition, shared by decide() and runFromStdin(): the two call sites must
 * never disagree about what a payload is.
 */
function isToolPayload(p) {
  return Boolean(p) && typeof p === 'object' && !Array.isArray(p);
}

/**
 * Pure decision over a parsed agy PreToolUse payload → agy verdict.
 * Never throws (the caller also wraps it). Implements the §5 decision tree.
 */
export function decide(payload, { env = process.env, trackerCache } = {}) {
  let enforcing = false;
  try {
    enforcing = env?.ADLC_P4_ENFORCEMENT === '1';
    if (!isToolPayload(payload)) {
      return enforcing ? deny('unparseable tool payload while enforcing — failing closed') : allow();
    }
    const tool = extractToolName(payload);
    // A payload with no tool name is a malformed hook envelope, not an unknown
    // tool: agy names every PreToolUse call. Without this, {} or {toolCall:{}}
    // classifies 'other', exposes no path and reaches the allow branch — the
    // same fall-through #823 closes for scalars, one step later.
    if (!tool) {
      return enforcing ? deny('tool payload exposes no tool name while enforcing — failing closed') : allow();
    }
    const cls = classifyTool(tool);

    // Step 2 — classify first. Reads and shell tools are never rail-gated in-session.
    if (cls === 'readonly') return allow();
    const args = extractArgs(payload);
    const storeOverride = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
    let overrideEscaped = null;
    if (storeOverride && typeof storeOverride === 'string' && storeOverride.trim()) {
      const trimmed = storeOverride.trim();
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      overrideEscaped = new RegExp('(^|[\\s=;,"\'/$.()[\\]])(' + escaped + '|ADLC_TICKET_STORE|ADLC_TICKETS)', 'i');
    }

    const paths = extractFilePaths(payload);

    if (paths.length > 0) {
      const localCache = trackerCache ?? new Map();
      const getTracker = (r) => {
        if (!localCache.has(r)) localCache.set(r, createPersistentTracker(r, env));
        return localCache.get(r);
      };

      let canonicalStoreOverride = null;
      if (storeOverride && typeof storeOverride === 'string' && storeOverride.trim()) {
        const trimmed = storeOverride.trim();
        canonicalStoreOverride = canonicalizeExisting(isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed));
      }

      // Steps 3–4 — resolve each target; fail closed on anything unanchorable (H1/H2/H3),
      // no-op allow only for an absolute path in a genuinely non-ADLC location (G2).
      for (const raw of paths) {
        const { abs, anchored } = anchorPath(raw, payload);
        if (!anchored) {
          if (enforcing) return deny(`unanchorable path "${raw}" (relative, no workspace root) — failing closed`);
          continue;
        }
        const canonicalAbs = canonicalizeExisting(abs);

        // Check if target is a configured ticket store override (external or custom in-repo)
        if (canonicalStoreOverride && (canonicalAbs === canonicalStoreOverride || canonicalAbs.startsWith(canonicalStoreOverride + '/'))) {
          return deny(`frozen rail — custom ticket store override "${storeOverride}" is a protected trust root`);
        }

        let effectiveRoot = findAdlcRoot(canonicalAbs, env) ?? findAdlcRoot(abs, env);
        if (effectiveRoot === null) {
          if (canonicalStoreOverride && existsSync(canonicalStoreOverride)) {
            const wsCandidate = WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : []))
              .filter((s) => typeof s === 'string' && s.trim())
              .find((ws) => {
                const absWs = canonicalizeExisting(isAbsolute(ws) ? ws : resolve(process.cwd(), ws));
                const rel = relative(absWs, canonicalAbs);
                return !rel.startsWith('..') && !isAbsolute(rel);
              }) ?? WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : []))
              .find((s) => typeof s === 'string' && s.trim());
            if (wsCandidate) {
              effectiveRoot = canonicalizeExisting(isAbsolute(wsCandidate) ? wsCandidate : resolve(process.cwd(), wsCandidate));
            } else if (enforcing) {
              return deny(`external ticket store override is active but workspace root could not be established for path "${raw}" — failing closed`);
            }
          }
        }
        if (effectiveRoot === null) continue; // absolute path, not an ADLC repo → no-op allow (G2)

        const verdictCanonical = checkRail({ filePath: canonicalAbs, tool, root: effectiveRoot, env });
        if (verdictCanonical.decision === 'deny') return deny(`frozen rail — ${verdictCanonical.reason}`);

        const verdict = checkRail({ filePath: abs, tool, root: effectiveRoot, env });
        if (verdict.decision === 'deny') return deny(`frozen rail — ${verdict.reason}`);

        const pathTracker = getTracker(effectiveRoot);
        const sessionID = resolveSessionId({ payload, env });

        // Check build-gate backstop for structured mutators and unknown ('other') tools
        if (cls !== 'readonly' && enforcing) {
          if (sessionID === 'default_session') {
            console.error('[adlc-rails-guard] Advisory: session ID unresolvable (default_session); depth counter shared across unresolvable sessions.');
          }
          const gate = checkBuildGate({ sessionID, tracker: pathTracker, root: effectiveRoot, env });
          if (gate.decision === 'deny') return deny(`build-gate — ${gate.reason}`);
        }

        // Record edit for flail tracking & inspect session transcript for repeated errors / edit churn
        if (cls === 'mutating' && pathTracker?.recordEdit) {
          const transcriptPath = resolveTranscriptPath({ payload, conversationId: sessionID, env });
          const transcriptSteps = transcriptPath ? parseTranscriptSteps(transcriptPath) : [];
          const flailRes = pathTracker.recordEdit(sessionID, abs, { transcriptSteps });

          const flailEnforcing = enforcing || env?.ADLC_FLAIL_ENFORCEMENT === '1';
          const flailBypass = env?.ADLC_FLAIL_BYPASS === '1';

          if (flailRes?.verdict === 'loop_blocked') {
            return deny(`flail-guard — ${flailMessage(flailRes)}`);
          }
          if (flailRes?.verdict === 'flail') {
            if (flailEnforcing && !flailBypass) {
              return deny(`flail-detector — session is flailing: ${flailRes.summary}. Step back or start a fresh session before retrying.`);
            }
            if (flailRes.isNewSignal) {
              console.error(`[adlc-anti-flail] Advisory: ${flailRes.recommendation}`);
            }
          }
        }
      }
    }

    const isShell = isShellTool(tool, args);

    if (isShell) {
      if (enforcing) {
        const cmd = (args?.CommandLine ?? args?.command ?? args?.cmd ?? args?.code ?? args?.script ?? '').trim();
        if (((overrideEscaped && overrideEscaped.test(cmd)) || /(^|[\s=;,"'\/$.()[\]])(\.adlc|\.session-secret|\.store\.json)/i.test(cmd)) && !isReadonlyCommand(cmd)) {
          return deny('shell modification of ticket store or trust-root rails is strictly prohibited');
        }
      }
      return allow(); // pure command runner with no rail paths
    }

    // Step 2 (cont.) — an 'other' tool with NO path and no mutating hint is not a file
    // op (e.g. generate_image, a mutator with no inspectable path) → allow. A
    // 'mutating' name with no path is opaque (H2).
    if (!paths.length) {
      if (cls === 'other') {
        if (enforcing && (hasPathLikeArgs(args) || hasCommandLineArgs(args))) {
          return deny(`unclassified tool "${tool}" has uninspectable arguments — failing closed`);
        }
        return allow();
      }
      return enforcing
        ? deny(`mutating tool "${tool}" exposed no inspectable target path — failing closed`)
        : allow();
    }

    return allow();
  } catch (err) {
    // Categorical fail-safe: under enforcement an unexpected error is more likely
    // tamper/corruption than a benign bug → fail CLOSED; off → no-op allow.
    return enforcing ? deny(`internal error while enforcing — ${err?.message ?? err}`) : allow();
  }
}

/** Parse a raw stdin string and return the agy verdict. Enforcement-aware on bad JSON. */
export function runFromStdin(raw, envArg = process.env) {
  const env = (envArg && typeof envArg === 'object' && envArg.env) ? envArg.env : (envArg ?? process.env);
  const enforcing = env?.ADLC_P4_ENFORCEMENT === '1';
  if (!raw || !raw.trim()) {
    return enforcing ? deny('unparseable tool payload while enforcing — failing closed') : allow();
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return enforcing ? deny('unparseable tool payload while enforcing — failing closed') : allow();
  }
  if (!isToolPayload(payload)) {
    return enforcing ? deny('unparseable tool payload while enforcing — failing closed') : allow();
  }
  const toolName = extractToolName(payload);
  const trackerCache = new Map();
  // A nameless envelope is decided (denied under enforcement) by decide(); it
  // must not first count as a tool call against the session — repeated
  // malformed envelopes would poison persistent depth and deny later edits.
  if (!toolName) return decide(payload, { env, trackerCache });
  const cls = classifyTool(toolName);

  const sessionID = resolveSessionId({ payload, env });
  const args = extractArgs(payload);

  const paths = extractFilePaths(payload);
  const cwdCandidates = [args?.Cwd, args?.cwd, args?.workdir, args?.workingDirectory, payload?.cwd, payload?.workspaceRoot];
  for (const c of cwdCandidates) {
    if (typeof c === 'string' && c.trim()) {
      paths.push(c.trim());
    }
  }

  const getTracker = (r) => {
    if (!trackerCache.has(r)) trackerCache.set(r, createPersistentTracker(r, env));
    return trackerCache.get(r);
  };

  const distinctRoots = new Set();
  const wsRoot = resolveWorkspaceRoot(payload, env);
  if (wsRoot) distinctRoots.add(wsRoot);

  if (paths.length > 0) {
    for (const p of paths) {
      const { abs } = anchorPath(p, payload);
      if (abs) {
        const root = findAdlcRoot(abs, env);
        if (root) distinctRoots.add(root);
      }
    }
  }
  const transcriptPath = resolveTranscriptPath({ payload, conversationId: sessionID, env });
  if (distinctRoots.size === 0 && transcriptPath) {
    const transcriptRoot = findAdlcRoot(transcriptPath, env);
    if (transcriptRoot) distinctRoots.add(transcriptRoot);
  }

  const isShell = isShellTool(toolName, args);
  const cmd = (args?.CommandLine ?? args?.command ?? args?.cmd ?? args?.code ?? args?.script ?? '').trim();
  const shellCwd = args?.Cwd ?? args?.cwd;
  if (shellCwd && typeof shellCwd === 'string') {
    const shellRoot = findAdlcRoot(isAbsolute(shellCwd) ? shellCwd : join(wsRoot ?? process.cwd(), shellCwd), env);
    if (shellRoot) distinctRoots.add(shellRoot);
  }
  const cmdRoot = (shellCwd && typeof shellCwd === 'string' ? findAdlcRoot(isAbsolute(shellCwd) ? shellCwd : join(wsRoot ?? process.cwd(), shellCwd), env) : null) ?? wsRoot ?? Array.from(distinctRoots)[0] ?? process.cwd();
  const isMut = isShell ? (!isReadonlyCommand(cmd) && !isVerificationCommand(cmd, { root: cmdRoot, toolArgs: args })) : cls !== 'readonly';

  for (const root of distinctRoots) {
    const tracker = getTracker(root);
    tracker.recordToolCall(sessionID, { isMutating: isMut });
    if (transcriptPath) tracker.recordTranscript(sessionID, transcriptPath);
    const active = resolveActiveTicketId(root, env);
    if (active.id) {
      try {
        const snap = loadTicketStoreReadOnly({ root, env });
        tracker.recordActiveTicket(sessionID, active.id, snap?.hash);
      } catch {}
    }
  }

  const verdict = decide(payload, { env, trackerCache });
  if (verdict.allow_tool === false) {
    for (const root of distinctRoots) {
      const tracker = getTracker(root);
      tracker.revertToolCall?.(sessionID, { isMutating: isMut });
    }
    return verdict;
  }

  return verdict;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function printStatus(root = process.cwd(), env = process.env, payload = {}) {
  const absRoot = isAbsolute(root) ? root : join(process.cwd(), root);
  const resolvedRoot = findAdlcRoot(absRoot, env) ?? absRoot;
  const active = resolveActiveTicketId(resolvedRoot, env);
  const tracker = createPersistentTracker(resolvedRoot, env);
  const sessionID = resolveSessionId({ payload, env });
  const flail = checkFlail({ sessionID, tracker, root: resolvedRoot, env });

  console.log(`--- ADLC Gemini Status ---`);
  console.log(`Root: ${resolvedRoot}`);
  console.log(`Active Ticket: ${active.id ?? (active.conflict ? 'CONFLICT' : 'NONE')}`);
  console.log(`Enforcement (ADLC_P4_ENFORCEMENT): ${env.ADLC_P4_ENFORCEMENT === '1' ? 'ACTIVE' : 'INACTIVE'}`);
  console.log(`Resolved Session ID: ${sessionID}`);
  console.log(`Context Depth (Tool Calls): ${tracker.depth(sessionID)}`);
  console.log(`Session Compacted: ${tracker.isCompacted(sessionID)}`);
  console.log(`Flail Status: ${flail.verdict.toUpperCase()}${flail.summary ? ` (${flail.summary})` : ''}`);
}

export function resolveWorkspaceRoot(payload, env = process.env) {
  const storeOverride = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  const hasStoreOverride = storeOverride && existsSync(isAbsolute(storeOverride) ? storeOverride : join(process.cwd(), storeOverride));

  const pathKeys = ['transcriptPath', 'transcript_path', 'artifactPath', 'artifact_path', 'logPath', 'log_path'];
  for (const pk of pathKeys) {
    const p = payload?.[pk];
    if (typeof p === 'string' && p.trim()) {
      const found = findAdlcRoot(dirname(p), env);
      if (found) return found;
    }
  }

  const allWorkspaces = WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : [payload?.[k]]))
    .filter((s) => typeof s === 'string' && s.trim());
  for (const ws of allWorkspaces) {
    const candidate = isAbsolute(ws) ? ws : join(process.cwd(), ws);
    const found = findAdlcRoot(candidate, env);
    if (found) return found;
    if (hasStoreOverride && existsSync(candidate) && lstatSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  const envCandidates = [
    env?.AGY_WORKSPACE,
    env?.ANTIGRAVITY_WORKSPACE,
    env?.GEMINI_WORKSPACE,
    env?.PROJECT_ROOT,
    env?.INIT_CWD,
    env?.PWD,
    env === process.env ? process.cwd() : null,
  ].filter((s) => typeof s === 'string' && s.trim());

  for (const c of envCandidates) {
    const found = findAdlcRoot(c, env);
    if (found) return found;
    if (hasStoreOverride && existsSync(c) && lstatSync(c).isDirectory()) {
      return c;
    }
  }
  return null;
}

function sanitizeField(val, maxLen = 120) {
  if (typeof val !== 'string') return '';
  const stripped = val.replace(/[\r\n\x00-\x1f`]/g, ' ').trim().slice(0, maxLen);
  return stripped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeGlobPattern(p) {
  if (typeof p !== 'string') return '';
  const trimmed = p.trim();
  if (!/^[a-zA-Z0-9_.*\-/@]+$/.test(trimmed)) return '';
  return trimmed;
}

function sanitizeGlobList(list, maxItems = 20) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, maxItems).map(sanitizeGlobPattern).filter(Boolean);
}

export function unwrapCall(c) {
  let cur = c;
  while (cur && typeof cur === 'object') {
    if (typeof cur.name === 'string' || typeof cur.toolName === 'string' || typeof cur.tool_name === 'string') {
      return cur;
    }
    let unwrapped = false;
    for (const k of ['toolCall', 'tool_call', 'call', 'tool', 'payload']) {
      if (cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k])) {
        cur = cur[k];
        unwrapped = true;
        break;
      }
    }
    if (!unwrapped) break;
  }
  return cur;
}

export function extractToolCalls(record) {
  if (!record || typeof record !== 'object') return [];
  let rawCalls = [];
  for (const k of ['toolCalls', 'tool_calls', 'calls']) {
    if (Array.isArray(record[k])) {
      rawCalls = record[k];
      break;
    }
  }
  if (rawCalls.length === 0) {
    for (const k of ['toolCall', 'tool_call', 'call', 'tool', 'payload']) {
      if (record[k] && typeof record[k] === 'object' && !Array.isArray(record[k])) {
        rawCalls = [record[k]];
        break;
      }
    }
  }
  if (rawCalls.length === 0 && (typeof record.name === 'string' || typeof record.toolName === 'string' || typeof record.tool_name === 'string')) {
    rawCalls = [record];
  }
  return rawCalls.map(unwrapCall).filter(Boolean);
}

export function discoverRootFromTranscriptRecords(records, env = process.env) {
  if (!Array.isArray(records) || records.length === 0) return null;
  for (const r of records) {
    const calls = extractToolCalls(r);
    for (const c of calls) {
      const paths = extractFilePaths({ toolCall: c });
      const args = extractArgs({ toolCall: c });
      const cwdCandidates = [args?.Cwd, args?.cwd, args?.workdir, args?.workingDirectory];
      for (const cwd of cwdCandidates) {
        if (typeof cwd === 'string' && cwd.trim()) {
          paths.push(cwd.trim());
        }
      }
      for (const p of paths) {
        if (typeof p === 'string' && isAbsolute(p)) {
          const canonical = canonicalizeExisting(p);
          const candidate = findAdlcRoot(canonical, env) ?? findAdlcRoot(p, env);
          if (candidate) return candidate;
        }
      }
    }
  }
  return null;
}

export function preInvocation(payload, { env = process.env } = {}) {
  try {
    let root = resolveWorkspaceRoot(payload, env);
    if (!root) {
      const transcriptPath = resolveTranscriptPath({ payload, env });
      if (transcriptPath) {
        const records = parseTranscriptRecords(transcriptPath, { readFull: true });
        root = discoverRootFromTranscriptRecords(records, env);
      }
    }
    if (!root) return { injectSteps: [] };

    const active = resolveActiveTicketId(root, env);
    if (!active.id || active.conflict) return { injectSteps: [] };

    const cleanId = sanitizeField(active.id, 64);
    if (!cleanId || cleanId !== active.id || !/^[a-zA-Z0-9_-]+$/.test(cleanId)) return { injectSteps: [] };

    try {
      const snapshot = loadTicketStoreReadOnly({ root, env });
      const ticket = snapshot.get(cleanId);
      if (ticket) {
        const tracker = createPersistentTracker(root, env);
        const sessionID = resolveSessionId({ payload, env });
        tracker.recordActiveTicket(sessionID, cleanId, snapshot.hash);
        const transcriptPath = resolveTranscriptPath({ payload, conversationId: sessionID, env });
        if (transcriptPath) tracker.recordTranscript(sessionID, transcriptPath);

        const cleanRails = sanitizeGlobList(ticket.rails);
        const allRails = Array.from(new Set([...cleanRails, ...TRUST_ROOT_RAILS]));
        const cleanScope = sanitizeGlobList(ticket.scope);
        const declaredRails = allRails.join(', ');
        const declaredScope = cleanScope.length ? cleanScope.join(', ') : 'unrestricted';
        const enf = env.ADLC_P4_ENFORCEMENT === '1' ? 'ACTIVE' : 'INACTIVE (advisory)';
        return {
          injectSteps: [
            {
              ephemeralMessage: `[ADLC Context] Active Ticket: ${cleanId} | Enforcement: ${enf} | Scope: ${declaredScope} | Frozen Rails: ${declaredRails}`,
            },
          ],
        };
      }
    } catch {
      return { injectSteps: [] };
    }

    return { injectSteps: [] };
  } catch {
    return { injectSteps: [] };
  }
}

export function tokenizeCommand(cmd) {
  if (typeof cmd !== 'string') return [];
  const tokens = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let m;
  while ((m = regex.exec(cmd)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

export function isVerificationCommand(cmd, { root, toolArgs, packageManifestMutated = false, shellMutated = false } = {}) {
  if (typeof cmd !== 'string' || !cmd) return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  // Reject newlines, shell chaining, pipes, redirects, substitutions, tilde expansion, or operators that can mask test failures
  if (/[\r\n;&|<>\$`~]/.test(trimmed)) return false;

  // Reject directory-redirecting flags, test-filtering/skipping flags, shard flags, destination/reporter flags, module preload/loader options, setup/teardown code, watch mode, snapshot updates, workspace narrowing, and coverage options
  if (/(^|\s)(--prefix|--cwd|-C|--if-present|--test-name-pattern|--test-skip-pattern|--test-only|--passWithNoTests|--test-shard|--test-reporter-destination|--output|--output-dir|--output-directory|--destination|-o|--grep|-g|--require|--import|--loader|--experimental-loader|-r|--test-global-setup|--test-global-teardown|--test-update-snapshots|--test-coverage|--experimental-test-coverage|--watch|--watch-mode|--run|-w|--workspace|--workspaces|--include-workspace-root)\b/i.test(trimmed)) return false;
  if (/(--require=|--import=|--loader=|--experimental-loader=|--test-shard=|--test-name-pattern=|--test-skip-pattern=|--test-reporter-destination=|--output=|--destination=|--test-global-setup=|--test-global-teardown=|--test-coverage=|--experimental-test-coverage=|--workspace=)/i.test(trimmed)) return false;

  // Reject device paths like /dev/null, /dev/zero
  if (/(^|\s)\/dev\//i.test(trimmed)) return false;

  // Reject forwarded arguments (-- -t, etc.) that can filter tests
  if (/(^|\s)--(\s+|$)/.test(trimmed)) return false;

  const realRoot = root ? realpathOr(resolve(root)) : null;

  // All verification commands must execute with an explicit Cwd bound to the repository root
  const cwd = toolArgs?.Cwd ?? toolArgs?.cwd;
  if (typeof cwd !== 'string' || !cwd) return false;
  const absCwd = isAbsolute(cwd) ? cwd : resolve(root, cwd);
  const realCwd = realpathOr(absCwd);
  if (!realRoot || relative(realRoot, realCwd) !== '') return false;

  // If command includes arguments/paths, validate that all positional paths resolve inside root
  if (realRoot) {
    const tokens = tokenizeCommand(trimmed);
    for (const rawToken of tokens) {
      const token = rawToken.includes('=') ? rawToken.slice(rawToken.indexOf('=') + 1) : rawToken;
      if (token.startsWith('~')) return false;
      if (token.startsWith('/') || token.startsWith('\\')) {
        const realToken = realpathOr(token);
        const rel = relative(realRoot, realToken);
        if (rel.startsWith('..') || isAbsolute(rel)) return false;
      } else if (token.includes('/') || token.includes('\\') || token.includes('..')) {
        const absToken = resolve(root, token);
        const realToken = realpathOr(absToken);
        const rel = relative(realRoot, realToken);
        if (rel.startsWith('..') || isAbsolute(rel)) return false;
      }
    }
  }

  // Reject help, version, list queries
  if (/\s+(--help|--version|-v|-h)(\s+|$)/i.test(trimmed)) return false;
  if (/^(adlc|npx\s+(--no-install\s+)?adlc)\s+(ticket|doctor|status|help|version|list)/i.test(trimmed)) return false;

  // If shell mutations occurred, no textual test execution can be trusted as clean verification
  if (shellMutated) return false;

  // If package.json mutations occurred, mutable npm script aliases and local npx runners cannot be trusted as verification
  if (!packageManifestMutated) {
    if (/^(npm\s+(test|run\s+(test|preflight|check)))\s*$/i.test(trimmed)) return true;
    if (/^(adlc|npx\s+--no-install\s+adlc)\s+(hollow-test|rails-guard|preflight)\s*$/i.test(trimmed)) return true;
    if (/^npx\s+--no-install\s+(mocha|jest|vitest)\s*$/i.test(trimmed)) return true;
  }

  // Strict immutable verification runners: require full-suite execution from repository root with explicit CWD
  if (/^node\s+--test(\s+(test|tests|spec)\/?)?\s*$/i.test(trimmed)) {
    return true;
  }

  return false;
}

export function isReadonlyCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd) return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  // Any shell redirection, chaining, piping, substitution, assignment, grouping, or operator could mutate state
  if (/[\r\n;&|<>\$`()={}\\~]/.test(trimmed)) return false;
  // Reject output redirection flags (e.g. git diff --output=file)
  if (/(^|\s)(--output|-o|--output-directory)\b/i.test(trimmed) || /--output=/i.test(trimmed)) return false;

  // Treat git branch as mutating unless only read-only listing flags are supplied with no new branch name
  if (/^git\s+branch\b/i.test(trimmed)) {
    if (/(^|\s)(-[dDmMcfuU]|--delete|--move|--copy|--force|--set-upstream-to|--unset-upstream|-u)\b/i.test(trimmed)) return false;
    const tokens = tokenizeCommand(trimmed).slice(2);
    for (const t of tokens) {
      if (!t.startsWith('-')) return false; // positional branch argument (creating/modifying branch)
    }
    return true;
  }

  return /^(git\s+(status|diff|log|rev-parse|show)|ls|pwd|cat|head|tail|which|uname|whoami|date|echo|printf)(\s+|$)/i.test(trimmed);
}

export function onStop(payload, { env = process.env } = {}) {
  try {
    const enforcing = env?.ADLC_P4_ENFORCEMENT === '1';
    if (!enforcing) return { decision: 'stop' };

    const sessionID = resolveSessionId({ payload, env });
    let root = resolveWorkspaceRoot(payload, env);
    const transcriptPath = resolveTranscriptPath({ payload, conversationId: sessionID, env });
    let records = [];
    if (transcriptPath) {
      try {
        const statBefore = lstatSync(transcriptPath);
        records = parseTranscriptRecords(transcriptPath, { readFull: true });
        const statAfter = lstatSync(transcriptPath);
        if (statAfter.size !== statBefore.size || statAfter.mtimeMs !== statBefore.mtimeMs) {
          records = parseTranscriptRecords(transcriptPath, { readFull: true });
        }
      } catch {
        records = [];
      }
    }

    // Fallback: If root cannot be determined from payload or env (e.g. agy headless mode),
    // discover root from absolute file paths in the transcript
    if (!root && records.length > 0) {
      root = discoverRootFromTranscriptRecords(records, env);
    }

    if (!root) {
      if (env?.ADLC_P4_ENFORCEMENT === '1') {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Repository workspace root cannot be resolved under enforcement during Stop verification.',
        };
      }
      return { decision: 'stop' };
    }

    const initialActive = resolveActiveTicketId(root, env);
    let initialStoreHash = null;
    try {
      const initialSnapshot = loadTicketStoreReadOnly({ root, env });
      initialStoreHash = initialSnapshot?.hash ?? null;
    } catch {}

    const tracker = createPersistentTracker(root, env);
    const trackedInitialTicket = tracker.initialTicket(sessionID);
    const trackedInitialHash = tracker.initialStoreHash(sessionID);
    const initialActiveId = trackedInitialTicket ?? initialActive.id;
    const initialHash = trackedInitialHash ?? initialStoreHash;

    const trackerInfo = tracker.lastTranscript ? tracker.lastTranscript(sessionID) : { initial: tracker.initialTranscript(sessionID) };
    const initialTranscript = trackerInfo?.initial;
    let curStat = null;
    if (initialTranscript && transcriptPath) {
      if (initialTranscript.path && transcriptPath !== initialTranscript.path) {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Session transcript path changed during session.',
        };
      }
      try {
        curStat = lstatSync(transcriptPath);
        if (curStat.ino !== initialTranscript.ino || curStat.dev !== initialTranscript.dev) {
          return {
            decision: 'continue',
            reason: 'ADLC Rails-Guard: Session transcript file identity (inode/device) changed during session.',
          };
        }
        if (initialTranscript.size && curStat.size < initialTranscript.size) {
          return {
            decision: 'continue',
            reason: 'ADLC Rails-Guard: Session transcript file size shrank unexpectedly during session.',
          };
        }
        if (initialTranscript.hash && initialTranscript.size > 0) {
          const prefixHash = computePrefixHash(transcriptPath, initialTranscript.size);
          if (prefixHash !== initialTranscript.hash) {
            return {
              decision: 'continue',
              reason: 'ADLC Rails-Guard: Session transcript prefix content was modified during session.',
            };
          }
        }
        if (trackerInfo?.lastHash && trackerInfo?.lastSize && trackerInfo.lastSize > 0) {
          const lastHash = computePrefixHash(transcriptPath, trackerInfo.lastSize);
          if (lastHash !== trackerInfo.lastHash) {
            return {
              decision: 'continue',
              reason: 'ADLC Rails-Guard: Session transcript content was modified during session.',
            };
          }
        }
      } catch {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Session transcript became unreadable or missing during Stop verification.',
        };
      }
    }

    // Under enforcement, transcript evidence is parsed to evaluate all mutations first
    if (!transcriptPath || records.length === 0) {
      const active = initialActiveId ? { id: initialActiveId } : resolveActiveTicketId(root, env);
      if (active.id || active.conflict) {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Session transcript is missing or unreadable under enforcement during Stop verification.',
        };
      }
      return { decision: 'stop' };
    }
    const storeOverride = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
    let overrideEscaped = null;
    if (storeOverride && typeof storeOverride === 'string' && storeOverride.trim()) {
      const trimmed = storeOverride.trim();
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      overrideEscaped = new RegExp('(^|[\\s=;,"\'/$.()[\\]])(' + escaped + '|ADLC_TICKET_STORE|ADLC_TICKETS)', 'i');
    }

    let callSeq = 0;
    let mutatingCallSeq = 0;
    let lastMutationCallIdx = -1;
    let lastSuccessTestCallIdx = -1;
    let packageManifestMutated = false;
    let shellMutated = false;

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Invalid or schema-corrupted transcript records detected under enforcement during Stop verification.',
        };
      }

      if (r.__oversized) {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Session transcript exceeds maximum supported size under enforcement during Stop verification.',
        };
      }

      if (r.__unparseable) {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Corrupted or unparseable transcript records detected under enforcement during Stop verification.',
        };
      }

      const calls = extractToolCalls(r);

      for (const c of calls) {
        callSeq++;
        const currentCallIdx = callSeq;
        const name = extractToolName({ toolCall: c }) || (c?.name ?? c?.toolName ?? c?.tool_name ?? '');
        const args = extractArgs({ toolCall: c });
        const filePaths = extractFilePaths({ toolCall: c });

        if (filePaths.some((p) => /(^|[/\\])\.adlc([/\\]|$)/i.test(p)) || (overrideEscaped && filePaths.some((p) => overrideEscaped.test(p)))) {
          return {
            decision: 'continue',
            reason: 'ADLC Rails-Guard: Active ticket contract or trust-root store was modified during session.',
          };
        }
        if (filePaths.some((p) => /(^|[/\\]|\.system_generated[/\\]logs[/\\])transcript.*\.jsonl$/i.test(p))) {
          return {
            decision: 'continue',
            reason: 'ADLC Rails-Guard: Tampering with session transcript files is strictly prohibited.',
          };
        }

        const isShell = isShellTool(name, args);
        const isMutating = !isShell && classifyTool(name) !== 'readonly';
        if (isMutating) mutatingCallSeq++;

        if (isMutating) {
          lastMutationCallIdx = currentCallIdx;
          if (filePaths.length === 0) {
            packageManifestMutated = true;
            const argsStr = JSON.stringify(args ?? {});
            if (/(^|[=\s"';,/])(\.adlc|\.system_generated|transcript.*\.jsonl)/i.test(argsStr)) {
              return {
                decision: 'continue',
                reason: 'ADLC Rails-Guard: Active ticket contract or trust-root store was modified during session.',
              };
            }
          }
          if (filePaths.some((p) => /(^|[/\\])(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(p))) {
            packageManifestMutated = true;
          }
        }

        if (isShell) {
          const cmd = (args?.CommandLine ?? args?.command ?? args?.cmd ?? args?.code ?? '').trim();
          if ((/(^|[\s=;,"'\/$.()[\]])(\.adlc|\.system_generated|transcript.*\.jsonl)/i.test(cmd) || (overrideEscaped && overrideEscaped.test(cmd))) && !isReadonlyCommand(cmd)) {
            return {
              decision: 'continue',
              reason: 'ADLC Rails-Guard: Shell modification of trust-root store or transcript is strictly prohibited.',
            };
          }
          const cmdCwd = args?.Cwd ?? args?.cwd;
          const cmdRoot = (cmdCwd && typeof cmdCwd === 'string' ? findAdlcRoot(isAbsolute(cmdCwd) ? cmdCwd : join(root, cmdCwd), env) : null) ?? root;
          if (isVerificationCommand(cmd, { root: cmdRoot, toolArgs: args, packageManifestMutated, shellMutated })) {
            const exitCode = r?.exit_code ?? r?.exitCode ?? c?.exitCode;
            const status = r?.status ?? c?.status;
            const isExplicitSuccess = exitCode === 0 || status === 'DONE' || status === 'done' || status === 'success' || r?.success === true;
            const isExplicitFailure = (typeof exitCode === 'number' && exitCode !== 0) || status === 'ERROR' || status === 'error' || r?.success === false;

            if (isExplicitSuccess && !isExplicitFailure) {
              lastSuccessTestCallIdx = currentCallIdx;
            }
          } else if (!isReadonlyCommand(cmd) && !isVerificationCommand(cmd, { root: cmdRoot, toolArgs: args })) {
            mutatingCallSeq++;
            lastMutationCallIdx = currentCallIdx;
            shellMutated = true;
          }
        }
      }
    }

    const trackedDepth = tracker.mutatingCalls ? tracker.mutatingCalls(sessionID) : tracker.depth(sessionID);
    if (trackedDepth > 0 && mutatingCallSeq !== trackedDepth) {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Untracked or missing tool execution records detected in transcript during Stop verification.',
      };
    }
    const trackedTotal = tracker.totalCalls ? tracker.totalCalls(sessionID) : 0;
    if (trackedTotal > 0 && callSeq !== trackedTotal) {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Untracked or missing tool execution records detected in transcript during Stop verification.',
      };
    }
    if (trackedDepth === 0 && mutatingCallSeq > 0 && trackedInitialTicket) {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Untracked tool execution records detected in transcript during Stop verification.',
      };
    }

    const active = resolveActiveTicketId(root, env);
    if (initialActiveId && active.id !== initialActiveId) {
      return {
        decision: 'continue',
        reason: `ADLC Rails-Guard: Active ticket ID changed from ${initialActiveId} to ${active.id ?? 'none'} during session.`,
      };
    }
    if (!active.id) {
      if (active.conflict) {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Active ticket state conflict detected during Stop verification.',
        };
      }
      if (lastMutationCallIdx !== -1) {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Active ticket is missing while unverified edits exist in session.',
        };
      }
      return { decision: 'stop' };
    }
    // Check if initial pointer was removed
    const trackedInitialPointer = tracker.initialPointer ? tracker.initialPointer(sessionID) : null;
    const currentFile = join(root, '.adlc', 'current-ticket.json');
    if (trackedInitialPointer?.exists && !existsSync(currentFile)) {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Active ticket pointer (.adlc/current-ticket.json) was removed during session.',
      };
    }

    // Validate session tracking store integrity
    const sessionsFile = join(root, '.adlc', 'sessions.json');
    if ((trackedDepth > 0 || trackedTotal > 0 || mutatingCallSeq > 0 || trackedInitialTicket) && !existsSync(sessionsFile)) {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Session tracking store was missing or deleted during verification.',
      };
    }
    if (tracker.validateBaseline && !tracker.validateBaseline(sessionID)) {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Session baseline signature mismatch (tampering detected).',
      };
    }
    if (existsSync(sessionsFile)) {
      try {
        const sStat = lstatSync(sessionsFile);
        if (!sStat.isFile() || sStat.isSymbolicLink() || sStat.size > 1024 * 1024) {
          return {
            decision: 'continue',
            reason: 'ADLC Rails-Guard: Session tracking store was corrupted or unreadable during verification.',
          };
        }
        const sRaw = readTextFileBounded(sessionsFile, sStat.size);
        if (!sRaw) {
          return {
            decision: 'continue',
            reason: 'ADLC Rails-Guard: Session tracking store was corrupted or unreadable during verification.',
          };
        }
        const sData = JSON.parse(sRaw);
        if (!sData || typeof sData !== 'object' || Array.isArray(sData)) {
          return {
            decision: 'continue',
            reason: 'ADLC Rails-Guard: Session tracking store was corrupted or unreadable during verification.',
          };
        }
        if (trackedInitialTicket || trackedTotal > 0 || trackedDepth > 0) {
          if (!sData[sessionID] || typeof sData[sessionID] !== 'object' || Array.isArray(sData[sessionID]) || Object.keys(sData[sessionID]).length === 0) {
            return {
              decision: 'continue',
              reason: 'ADLC Rails-Guard: Session tracking entry was deleted, reset, or modified during session.',
            };
          }
        }
        if (sData[sessionID]) {
          const entry = sData[sessionID];
          if (typeof entry !== 'object' || Array.isArray(entry)) {
            return {
              decision: 'continue',
              reason: 'ADLC Rails-Guard: Session tracking entry was deleted, reset, or modified during session.',
            };
          }
          if (trackedInitialTicket && entry.initialActiveTicket !== trackedInitialTicket) {
            return {
              decision: 'continue',
              reason: 'ADLC Rails-Guard: Session tracking entry was deleted, reset, or modified during session.',
            };
          }
          if (active.id && entry.initialActiveTicket && entry.initialActiveTicket !== active.id) {
            return {
              decision: 'continue',
              reason: 'ADLC Rails-Guard: Session tracking entry was deleted, reset, or modified during session.',
            };
          }
          if (active.id && Object.keys(entry).length === 0) {
            return {
              decision: 'continue',
              reason: 'ADLC Rails-Guard: Session tracking entry was deleted, reset, or modified during session.',
            };
          }
          if (trackedDepth > 0 && typeof entry.mutatingCalls === 'number' && entry.mutatingCalls < trackedDepth) {
            return {
              decision: 'continue',
              reason: 'ADLC Rails-Guard: Session tracking entry was deleted, reset, or modified during session.',
            };
          }
          if (trackedTotal > 0 && typeof entry.totalCalls === 'number' && entry.totalCalls < trackedTotal) {
            return {
              decision: 'continue',
              reason: 'ADLC Rails-Guard: Session tracking entry was deleted, reset, or modified during session.',
            };
          }
        } else if (trackedInitialTicket) {
          return {
            decision: 'continue',
            reason: 'ADLC Rails-Guard: Session tracking entry was deleted, reset, or modified during session.',
          };
        }
      } catch {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Session tracking store was corrupted or unreadable during verification.',
        };
      }
    } else if (trackedInitialTicket || (active.id && records.length > 0 && shellMutated)) {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Session tracking store was missing or deleted under enforcement during Stop verification.',
      };
    }

    // Validate active ticket exists in ticket store
    try {
      const snapshot = loadTicketStoreReadOnly({ root, env });
      if (initialHash && snapshot.hash !== initialHash) {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Ticket store hash changed during session.',
        };
      }
      const ticket = snapshot.get(active.id);
      if (!ticket) {
        return {
          decision: 'continue',
          reason: `ADLC Rails-Guard: Active ticket ${active.id} not found in validated ticket store.`,
        };
      }
      const storeHash = snapshot.ticketHashes?.[active.id] ?? snapshot.ticketHashes?.get?.(active.id);
      const activeHash = active.ticketHash ?? active.hash;
      if (activeHash && storeHash && activeHash !== storeHash) {
        return {
          decision: 'continue',
          reason: `ADLC Rails-Guard: Active ticket hash mismatch detected during Stop verification.`,
        };
      }

      if (shellMutated) {
        try {
          const currentFile = join(root, '.adlc', 'current-ticket.json');
          if (existsSync(currentFile)) {
            const currentStat = lstatSync(currentFile);
            if (!currentStat.isFile() || currentStat.isSymbolicLink() || currentStat.size > 64 * 1024) {
              return {
                decision: 'continue',
                reason: 'ADLC Rails-Guard: Corrupt or unreadable current-ticket pointer after shell execution.',
              };
            }
            const currentRaw = readTextFileBounded(currentFile, currentStat.size);
            const currentObj = currentRaw ? JSON.parse(currentRaw) : null;
            if (!currentObj || typeof currentObj !== 'object') {
              return {
                decision: 'continue',
                reason: 'ADLC Rails-Guard: Corrupt or unreadable current-ticket pointer after shell execution.',
              };
            }
            if (currentObj.id && currentObj.id !== active.id) {
              return {
                decision: 'continue',
                reason: 'ADLC Rails-Guard: Active ticket pointer ID was altered during shell execution.',
              };
            }
          }
        } catch {
          return {
            decision: 'continue',
            reason: 'ADLC Rails-Guard: Trust-root files were corrupted or removed during shell execution.',
          };
        }
      }
    } catch {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Corrupt or unreadable ticket store during Stop verification.',
      };
    }

    // If mutations occurred under the active ticket, verification is required before stopping
    if (lastMutationCallIdx !== -1) {
      if (lastSuccessTestCallIdx === -1) {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Active ticket has unverified file edits. Verification/test commands must be run before completing.',
        };
      }

      if (lastMutationCallIdx > lastSuccessTestCallIdx) {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: File edits occurred after the last test run. Test suite must be re-run before completing.',
        };
      }
    }

    if (transcriptPath && existsSync(transcriptPath) && curStat) {
      try {
        const finalStat = lstatSync(transcriptPath);
        if (finalStat.size !== curStat.size || finalStat.ino !== curStat.ino) {
          return {
            decision: 'continue',
            reason: 'ADLC Rails-Guard: Session transcript was modified concurrently during Stop verification.',
          };
        }
      } catch {}
    }

    return { decision: 'stop' };
  } catch (err) {
    if (env?.ADLC_P4_ENFORCEMENT === '1') {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Internal error evaluating Stop hook under enforcement.',
      };
    }
    return { decision: 'stop' };
  }
}

export function printDoctor(root = process.cwd(), env = process.env) {
  const absRoot = isAbsolute(root) ? root : join(process.cwd(), root);
  const resolvedRoot = findAdlcRoot(absRoot, env) ?? absRoot;
  const active = resolveActiveTicketId(resolvedRoot, env);

  console.log(`--- ADLC Gemini Doctor ---`);
  console.log(`Node Version: ${process.version}`);
  console.log(`Root Directory: ${resolvedRoot}`);
  console.log(`ADLC Ticket Store Present: ${existsSync(join(resolvedRoot, '.adlc/tickets.json')) || existsSync(join(resolvedRoot, '.adlc/tickets/.store.json'))}`);
  console.log(`Active Ticket: ${active.id ?? 'NONE'}`);
  console.log(`CI Rail Guard Workflow: ${existsSync(join(resolvedRoot, '.github/workflows/adlc-rails-guard.yml')) ? 'PRESENT' : 'MISSING'}`);
}

export async function main() {
  const subcmd = process.argv[2];
  if (subcmd === 'status') {
    printStatus();
    return;
  }
  if (subcmd === 'doctor') {
    printDoctor();
    return;
  }

  const raw = await readStdin();
  process.stdout.write(JSON.stringify(runFromStdin(raw, process.env)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
