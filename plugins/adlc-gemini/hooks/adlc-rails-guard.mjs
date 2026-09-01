#!/usr/bin/env node
// adlc-rails-guard.mjs — the agy PreToolUse hook adapter (ESM core).
// Invoked via the .cjs shim (adlc-rails-guard.cjs) which registers process error
// handlers first. Maps agy's stdin { toolCall: { name, args } } onto the
// editor-agnostic checkRail() and emits agy's { allow_tool, deny_reason } verdict.
// Deny path imports ONLY node: builtins + the sibling checker (→ @adlc/core).
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

function realpathOr(p) {
  try {
    return existsSync(p) ? realpathSync(p) : p;
  } catch {
    return p;
  }
}
import { checkRail, classifyTool, isShellTool, resolveActiveTicketId, railPreconditions, TRUST_ROOT_RAILS } from '../rails-checker.mjs';
import { loadTicketStoreReadOnly } from '../generated-ticket-reader.mjs';
import { checkBuildGate, checkFlail, createPersistentTracker, resolveSessionId } from '../build-gate-inline.mjs';
import { flailMessage, resolveTranscriptPath, parseTranscriptSteps, parseTranscriptRecords, analyzeFlail } from '../flail-inline.mjs';

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

/** Nearest ancestor dir of absPath containing a supported ADLC ticket store, or null.
 * Bounded walk to the filesystem root — never uses process.cwd() (the plugin dir). */
export function findAdlcRoot(absPath) {
  if (!absPath || typeof absPath !== 'string' || !isAbsolute(absPath)) return null;
  let cur = absPath;
  const { root: fsRoot } = parse(cur);
  while (true) {
    if (existsSync(join(cur, '.adlc', 'tickets.json')) || existsSync(join(cur, '.adlc', 'tickets', '.store.json'))) return cur;
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

    const localCache = trackerCache ?? new Map();
    const getTracker = (r) => {
      if (!localCache.has(r)) localCache.set(r, createPersistentTracker(r, env));
      return localCache.get(r);
    };

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

      const pathTracker = getTracker(root);
      const sessionID = resolveSessionId({ payload, env });

      // Check build-gate backstop for structured mutators and unknown ('other') tools
      if (cls !== 'readonly' && enforcing) {
        if (sessionID === 'default_session') {
          console.error('[adlc-rails-guard] Advisory: session ID unresolvable (default_session); depth counter shared across unresolvable sessions.');
        }
        const gate = checkBuildGate({ sessionID, tracker: pathTracker, root, env });
        if (gate.decision === 'deny') return deny(`build-gate — ${gate.reason}`);
      }

      // Record edit for flail tracking & inspect session transcript for repeated errors / edit churn
      if (cls === 'mutating' && pathTracker?.recordEdit) {
        const transcriptPath = resolveTranscriptPath({ payload, conversationId: sessionID, env });
        const transcriptSteps = transcriptPath ? parseTranscriptSteps(transcriptPath) : [];
        const flailRes = pathTracker.recordEdit(sessionID, abs, { transcriptSteps });

        const flailEnforcing = env?.ADLC_FLAIL_ENFORCEMENT === '1';
        const flailBypass = env?.ADLC_FLAIL_BYPASS === '1';

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

  // For readonly tools, skip session lock persistence entirely
  if (cls === 'readonly') {
    return decide(payload, { env, trackerCache });
  }

  const paths = extractFilePaths(payload);
  const getTracker = (r) => {
    if (!trackerCache.has(r)) trackerCache.set(r, createPersistentTracker(r, env));
    return trackerCache.get(r);
  };

  const distinctRoots = new Set();
  if (paths.length > 0) {
    for (const p of paths) {
      const { abs } = anchorPath(p, payload);
      if (abs) {
        const root = findAdlcRoot(abs);
        if (root) distinctRoots.add(root);
      }
    }
  } else {
    const ws = WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : []))
      .find((s) => typeof s === 'string' && s.trim());
    const fallbackRoot = findAdlcRoot(ws ? (isAbsolute(ws) ? ws : join(process.cwd(), ws)) : process.cwd());
    if (fallbackRoot) distinctRoots.add(fallbackRoot);
  }

  for (const root of distinctRoots) {
    getTracker(root).recordToolCall(sessionID);
  }

  return decide(payload, { env, trackerCache });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function printStatus(root = process.cwd(), env = process.env, payload = {}) {
  const absRoot = isAbsolute(root) ? root : join(process.cwd(), root);
  const resolvedRoot = findAdlcRoot(absRoot) ?? absRoot;
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
  const direct = WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : [payload?.[k]]))
    .find((s) => typeof s === 'string' && s.trim());
  if (direct) {
    const candidate = isAbsolute(direct) ? direct : join(process.cwd(), direct);
    const found = findAdlcRoot(candidate);
    if (found) return found;
  }

  const pathKeys = ['transcriptPath', 'transcript_path', 'artifactPath', 'artifact_path', 'logPath', 'log_path'];
  for (const pk of pathKeys) {
    const p = payload?.[pk];
    if (typeof p === 'string' && p.trim()) {
      const found = findAdlcRoot(dirname(p));
      if (found) return found;
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
    const found = findAdlcRoot(c);
    if (found) return found;
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

export function preInvocation(payload, { env = process.env } = {}) {
  try {
    const root = resolveWorkspaceRoot(payload, env);
    if (!root) return { injectSteps: [] };

    const active = resolveActiveTicketId(root, env);
    if (!active.id || active.conflict) return { injectSteps: [] };

    const cleanId = sanitizeField(active.id, 64);
    if (!cleanId || cleanId !== active.id || !/^[a-zA-Z0-9_-]+$/.test(cleanId)) return { injectSteps: [] };

    try {
      const snapshot = loadTicketStoreReadOnly({ root, env });
      const ticket = snapshot.get(cleanId);
      if (ticket) {
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
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    tokens.push(raw.replace(/\\(["'\s\\])/g, '$1'));
  }
  return tokens;
}

export function isVerificationCommand(cmd, { root, toolArgs, packageManifestMutated = false, shellMutated = false } = {}) {
  if (typeof cmd !== 'string' || !cmd) return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  // Reject newlines, shell chaining, pipes, redirects, substitutions, or operators that can mask test failures
  if (/[\r\n;&|<>\$`]/.test(trimmed)) return false;

  // Reject directory-redirecting flags, test-filtering/skipping flags, shard flags, and module preload/loader options
  if (/(^|\s)(--prefix|--cwd|-C|--if-present|--test-name-pattern|--test-only|--passWithNoTests|--test-shard|--grep|-g|--require|--import|--loader|--experimental-loader|-r)\b/i.test(trimmed)) return false;
  if (/(--require=|--import=|--loader=|--experimental-loader=|--test-shard=)/i.test(trimmed)) return false;

  // Reject device paths like /dev/null, /dev/zero
  if (/(^|\s)\/dev\//i.test(trimmed)) return false;

  const realRoot = root ? realpathOr(resolve(root)) : null;

  // If tool args specify a working directory, it must resolve via realpath to inside or equal to the root
  if (realRoot && toolArgs) {
    const cwd = toolArgs.Cwd ?? toolArgs.cwd;
    if (typeof cwd === 'string' && cwd) {
      const absCwd = isAbsolute(cwd) ? cwd : resolve(root, cwd);
      const realCwd = realpathOr(absCwd);
      const rel = relative(realRoot, realCwd);
      if (rel.startsWith('..') || isAbsolute(rel)) return false;
    }
  }

  // If command includes arguments/paths, validate that all positional paths resolve inside root
  if (realRoot) {
    const tokens = tokenizeCommand(trimmed);
    for (const rawToken of tokens) {
      const token = rawToken.includes('=') ? rawToken.slice(rawToken.indexOf('=') + 1) : rawToken;
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

  // If package.json or shell mutations occurred, mutable npm script aliases cannot be trusted as verification
  if (!packageManifestMutated && !shellMutated && /^(npm\s+(test|run\s+(test|preflight|check)))(\s+|$)/i.test(trimmed)) return true;

  // Strict immutable verification runners (npx requires --no-install)
  if (/^(node\s+(--test|scripts\/test\/))/i.test(trimmed)) return true;
  if (/^(adlc|npx\s+--no-install\s+adlc)\s+(hollow-test|rails-guard|preflight)(\s+|$)/i.test(trimmed)) return true;
  if (/^npx\s+--no-install\s+(mocha|jest|vitest)(\s+|$)/i.test(trimmed)) return true;

  return false;
}

export function isReadonlyCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd) return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  // Any shell redirection, chaining, or piping could mutate state
  if (/[\r\n;&|<>]/.test(trimmed)) return false;
  // Reject output redirection flags (e.g. git diff --output=file)
  if (/(^|\s)(--output|-o|--output-directory)\b/i.test(trimmed) || /--output=/i.test(trimmed)) return false;
  return /^(git\s+(status|diff|log|branch|rev-parse|show)|ls|pwd|cat|head|tail|which|uname|whoami|date)(\s+|$)/i.test(trimmed);
}

export function onStop(payload, { env = process.env } = {}) {
  try {
    const enforcing = env?.ADLC_P4_ENFORCEMENT === '1';
    if (!enforcing) return { decision: 'stop' };

    const sessionID = resolveSessionId({ payload, env });
    const transcriptPath = resolveTranscriptPath({ payload, conversationId: sessionID, env });
    const records = transcriptPath ? parseTranscriptRecords(transcriptPath, { readFull: true }) : [];

    let root = resolveWorkspaceRoot(payload, env);

    // Fallback: discover repo root from absolute paths in transcript tool calls for headless sessions
    if (!root && records.length > 0) {
      for (const r of records) {
        if (!r || typeof r !== 'object') continue;
        const calls = Array.isArray(r.toolCalls) ? r.toolCalls
          : (Array.isArray(r.tool_calls) ? r.tool_calls
          : (r.toolCall ? [r.toolCall]
          : (r.name ? [r] : [])));
        for (const c of calls) {
          const args = c?.args ?? c?.arguments ?? {};
          const candidatePath = args.TargetFile ?? args.AbsolutePath ?? args.SearchDirectory ?? args.Cwd ?? args.cwd;
          if (typeof candidatePath === 'string' && isAbsolute(candidatePath)) {
            const found = findAdlcRoot(dirname(candidatePath)) ?? findAdlcRoot(candidatePath);
            if (found) {
              root = found;
              break;
            }
          }
        }
        if (root) break;
      }
    }

    if (!root) {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Repository workspace root cannot be resolved under enforcement during Stop verification.',
      };
    }

    const active = resolveActiveTicketId(root, env);
    if (active.conflict) {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Active ticket state conflict detected during Stop verification.',
      };
    }
    if (!active.id) return { decision: 'stop' };

    // Validate that the active ticket is present in the validated ticket store
    try {
      const snapshot = loadTicketStoreReadOnly({ root, env });
      if (!snapshot.get(active.id)) {
        return {
          decision: 'continue',
          reason: `ADLC Rails-Guard: Active ticket ${active.id} not found in validated ticket store.`,
        };
      }
    } catch {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Corrupt or unreadable ticket store during Stop verification.',
      };
    }

    // Under enforcement with an active ticket, transcript evidence is required
    if (!transcriptPath || records.length === 0) {
      return {
        decision: 'continue',
        reason: 'ADLC Rails-Guard: Session transcript is missing or unreadable under enforcement during Stop verification.',
      };
    }

    let callSeq = 0;
    let lastMutationCallIdx = -1;
    let lastSuccessTestCallIdx = -1;
    let packageManifestMutated = false;
    let shellMutated = false;

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r || typeof r !== 'object') continue;

      if (r.__unparseable) {
        return {
          decision: 'continue',
          reason: 'ADLC Rails-Guard: Corrupted or unparseable transcript records detected under enforcement during Stop verification.',
        };
      }

      const calls = Array.isArray(r.toolCalls) ? r.toolCalls
        : (Array.isArray(r.tool_calls) ? r.tool_calls
        : (r.toolCall ? [r.toolCall]
        : (r.name ? [r] : [])));

      for (const c of calls) {
        callSeq++;
        const currentCallIdx = callSeq;
        const name = c?.name ?? c?.toolName ?? '';
        const args = extractArgs({ toolCall: c });
        const filePaths = extractFilePaths({ toolCall: c });
        const isMutating = classifyTool(name) === 'mutating'
          || (classifyTool(name) !== 'readonly' && filePaths.length > 0);

        if (isMutating) {
          lastMutationCallIdx = currentCallIdx;
          if (filePaths.some((p) => /(^|[/\\])(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(p))) {
            packageManifestMutated = true;
          }
        }

        if (name === 'run_command' || name === 'execute') {
          const cmd = (args?.CommandLine ?? args?.command ?? args?.cmd ?? '').trim();
          if (isVerificationCommand(cmd, { root, toolArgs: args, packageManifestMutated, shellMutated })) {
            const exitCode = r?.exit_code ?? r?.exitCode ?? c?.exitCode;
            const status = r?.status ?? c?.status;
            const isExplicitSuccess = exitCode === 0 || status === 'DONE' || status === 'done' || status === 'success' || r?.success === true;
            const isExplicitFailure = (typeof exitCode === 'number' && exitCode !== 0) || status === 'ERROR' || status === 'error' || r?.success === false;

            if (isExplicitSuccess && !isExplicitFailure) {
              lastSuccessTestCallIdx = currentCallIdx;
            }
          } else if (!isReadonlyCommand(cmd)) {
            lastMutationCallIdx = currentCallIdx;
            shellMutated = true;
          }
        }
      }
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
  const resolvedRoot = findAdlcRoot(absRoot) ?? absRoot;
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
