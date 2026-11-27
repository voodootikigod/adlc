// gemini-guard.mjs — Antigravity (agy) / JetSki hook enforcement runtime
// implementing the 4-level decision lattice (deny > force_ask > ask > pass),
// rail/trust-root protection, build-gate, flail tracking, and Stop verification.

import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { canonicalizePath as canonPath, extractAllToolWorkdirs, extractToolWorkdir, findInnermostCheckoutRoot, globMatch, hasConflictingToolWorkdirs, isPathInside, preferInnermostCheckout, resolveRailPath } from '@adlc/core';
import { detectTicketStore } from '@adlc/tickets';
import { resolveActiveTicketId } from './pretool.mjs';
import { flailMessage, resolveTranscriptPath, parseTranscriptSteps, parseTranscriptRecords } from './flail-transcript.mjs';
import { TRUST_ROOT_RAILS, classifyTool, isShellTool, hasCommandLineArgs, hasCodeExecutionArgs, extractCommandString, isCaseInsensitiveFs, isSecretStatePath, isTrustRootOrSecretPath, isUnauthorizedWorkspaceEscape, isTrustRootSecretAccess, hasShellTrustRootSecretAccess, hasShellSymlinkOrSecretEscape, isReadonlyCommand, isVerificationCommand, resolveUserHome } from './command-verify.mjs';
import { checkBuildGate, checkFlail, createPersistentTracker, resolveSessionId, getOrCreateSessionSecret, getMasterKeyRaw, rotateMasterKey } from './session-tracker.mjs';
import { evaluateGeminiStop, sanitizeField, sanitizeGlobList } from './gemini-stop-verify.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOLCALL_KEYS = ['toolCall', 'tool_call', 'tool'];
const NAME_KEYS = ['name', 'toolName', 'tool_name'];
const ARGS_KEYS = ['args', 'arguments', 'params', 'parameters', 'input', 'tool_input'];
const WORKSPACE_KEYS = ['workspacePaths', 'workspace_paths', 'workspaceRoots', 'workspace_roots'];
const PATH_KEYS = new Set(['targetfile', 'absolutepath', 'filepath', 'path', 'file_path', 'target_file', 'dest_file', 'destfile', 'dest', 'destination', 'destpath', 'target', 'file', 'filename', 'targetpath', 'source', 'sourcefile', 'src', 'src_file', 'dst', 'dst_file', 'output', 'output_file', 'output_path', 'out_file', 'outfile', 'outpath', 'outputpath', 'targetcontentpath', 'targetdir']);
const IGNORED_SCAN_KEYS = new Set(['CommandLine', 'command', 'cmd', 'code', 'CodeContent', 'content', 'ReplacementContent', 'TargetContent', 'Instruction', 'Description', 'Prompt', 'Message', 'message']);

const pass = () => ({ decision: 'pass', allow_tool: true });
const deny = (r) => ({ decision: 'deny', reason: `ADLC rails-guard: ${r}`, allow_tool: false, deny_reason: `ADLC rails-guard: ${r}` });
const forceAsk = (r, env) => (env?.ADLC_HEADLESS === '1' ? deny(r) : { decision: 'force_ask', reason: `ADLC rails-guard: ${r}`, allow_tool: false });
const isToolPayload = (p) => Boolean(p) && typeof p === 'object' && !Array.isArray(p);
const realpathOr = (p) => { try { return existsSync(p) ? realpathSync(p) : p; } catch { return p; } };
const nonPluginCwd = () => { try { const c = process.cwd(); return isPathInside(c, PLUGIN_ROOT) ? null : c; } catch { return null; } };
const loadStoreReadOnly = (root, env) => detectTicketStore({ root, ticketStore: env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || undefined, allowRecovery: true, env }).load();
function storeExists(root, env) {
  const ov = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  if (ov && typeof ov === 'string' && ov.trim() && existsSync(isAbsolute(ov.trim()) ? ov.trim() : join(root, ov.trim()))) return true;
  return existsSync(join(root, '.adlc', 'tickets.json')) || existsSync(join(root, '.adlc', 'tickets', '.store.json'));
}

export const canonicalizeExisting = (p) => (!p || typeof p !== 'string' ? p : canonPath(p));
export const extractCwdFromArgs = (args) => extractToolWorkdir(args);
const toolCallOf = (p) => (!p || typeof p !== 'object' ? undefined : (TOOLCALL_KEYS.map((k) => p[k]).find((v) => v && typeof v === 'object') ?? p));
export function extractToolName(payload) { const obj = toolCallOf(payload); return obj && typeof obj === 'object' ? (NAME_KEYS.map((k) => obj[k]).find((v) => typeof v === 'string' && v.trim()) ?? '') : ''; }
export function extractArgs(payload) { const tc = toolCallOf(payload); return tc && typeof tc === 'object' ? (ARGS_KEYS.map((k) => tc[k]).find((v) => v && typeof v === 'object') ?? {}) : {}; }
function decodeUri(s) {
  if (!s.startsWith('file://')) return s;
  try { return fileURLToPath(s); } catch { const st = s.replace(/^file:\/\/(?:localhost)?/i, ''); try { return decodeURIComponent(st); } catch { return st; } }
}
export function extractFilePaths(payload) {
  const out = new Set();
  const scan = (obj, pk = '', d = 0) => {
    if (!obj || typeof obj !== 'object' || d > 5) return;
    for (const [k, v] of Object.entries(obj)) {
      if (IGNORED_SCAN_KEYS.has(k)) continue;
      const kl = k.toLowerCase(); const isPath = PATH_KEYS.has(kl) || (pk && PATH_KEYS.has(pk.toLowerCase()));
      if (typeof v === 'string' && v.trim()) { const t = v.trim(); if (isPath || (kl === 'uri' && (t.startsWith('file://') || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)))) out.add(decodeUri(t)); }
      else if (Array.isArray(v)) { for (const e of v) { if (typeof e === 'string' && isPath && e.trim()) out.add(decodeUri(e.trim())); else if (e && typeof e === 'object') scan(e, k, d + 1); } }
      else if (v && typeof v === 'object') scan(v, k, d + 1);
    }
  };
  scan(extractArgs(payload)); return [...out];
}
function hasPathLikeArgs(args, d = 0) {
  if (!args || typeof args !== 'object' || d > 5) return false;
  for (const [k, v] of Object.entries(args)) {
    if (IGNORED_SCAN_KEYS.has(k)) continue;
    if (typeof v === 'string' && (v.includes('/') || v.includes('\\') || v.includes('.') || /(file|path|dest|target|dir|src|dst)/i.test(k))) return true;
    if (v && typeof v === 'object' && (/(file|path|dest|target|dir|src|dst)/i.test(k) || hasPathLikeArgs(v, d + 1))) return true;
  }
  return false;
}

export function findAdlcRoot(absPath, env = process.env) {
  if (!absPath || typeof absPath !== 'string' || !isAbsolute(absPath)) return null;
  const ov = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  const homeDir = resolveUserHome(env) || homedir();
  const baseOpts = { storeOverride: ov, homeDir, pluginDir: PLUGIN_ROOT, allowFileStart: true, preserveSpelling: true };
  if (ov && isAbsolute(ov) && existsSync(ov)) {
    const gitRoot = findInnermostCheckoutRoot(absPath, { ...baseOpts, storeOverride: null, requireStore: false });
    for (const er of [env?.AGY_WORKSPACE, env?.ANTIGRAVITY_WORKSPACE, env?.GEMINI_WORKSPACE, env?.PROJECT_ROOT, env?.WORKSPACE_ROOT].filter((r) => typeof r === 'string' && r.trim() && isAbsolute(r.trim()))) {
      if (isPathInside(absPath, er)) return preferInnermostCheckout(er, [absPath], baseOpts);
    }
    if (gitRoot) return gitRoot;
    let cur = absPath; try { if (!lstatSync(absPath).isDirectory()) cur = dirname(absPath); } catch { cur = dirname(absPath); }
    const { root: fsRoot } = parse(cur); const normHome = homeDir ? realpathOr(resolve(homeDir)) : null;
    while (true) { if (normHome && realpathOr(cur) === normHome) break; if (existsSync(join(cur, '.adlc'))) return cur; if (cur === fsRoot) break; cur = dirname(cur); }
    return null;
  }
  return findInnermostCheckoutRoot(absPath, baseOpts);
}

function declaredOuterWorkspace(payload, targetHint = null) {
  const base = nonPluginCwd() ?? process.cwd();
  const all = WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : [payload?.[k]])).filter((s) => typeof s === 'string' && s.trim()).map((s) => (isAbsolute(s.trim()) ? s.trim() : resolve(base, s.trim())));
  if (!all.length) return null;
  return (typeof targetHint === 'string' && targetHint.trim() && isAbsolute(targetHint.trim())) ? (all.find((w) => isPathInside(targetHint.trim(), w)) ?? all[0]) : all[0];
}

export function anchorPath(rawPath, payload, env = null) {
  if (!rawPath) return { abs: null, anchored: false };
  const norm = typeof rawPath === 'string' ? rawPath.replace(/\\/g, '/') : rawPath;
  if (isAbsolute(norm)) return { abs: norm, anchored: true };
  const wd = isToolPayload(payload) ? extractCwdFromArgs(extractArgs(payload)) : null;
  const ws = WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : [])).find((s) => typeof s === 'string' && s.trim())
    ?? [payload?.cwd, payload?.workingDirectory, payload?.working_directory, payload?.workspaceRoot, env?.AGY_WORKSPACE, env?.ANTIGRAVITY_WORKSPACE, env?.GEMINI_WORKSPACE, env?.PROJECT_ROOT, env?.WORKSPACE_ROOT].find((s) => typeof s === 'string' && s.trim());
  if (ws) {
    const absWs = isAbsolute(ws) ? ws : resolve(nonPluginCwd() ?? process.cwd(), ws);
    if (typeof wd === 'string' && wd.trim() && norm !== wd.trim().replace(/\\/g, '/')) return { abs: join(isAbsolute(wd.trim()) ? wd.trim() : resolve(absWs, wd.trim()), norm), anchored: true };
    return { abs: join(absWs, norm), anchored: true };
  }
  if (typeof wd === 'string' && wd.trim() && isAbsolute(wd.trim())) return { abs: norm === wd.trim().replace(/\\/g, '/') ? wd.trim() : join(wd.trim(), norm), anchored: true };
  return { abs: null, anchored: false };
}

export function railPreconditions({ root = process.cwd(), env = process.env } = {}) {
  if (env.ADLC_P4_ENFORCEMENT !== '1') return { state: 'inactive', reason: 'enforcement inactive' };
  if (!storeExists(root, env)) return { state: 'inactive', reason: 'repo not ADLC-initialized' };
  const active = resolveActiveTicketId(root, env);
  if (active.conflict) return { state: 'deny', reason: active.message ?? 'conflicting active-ticket signal' };
  if (!active.id) return { state: 'inactive', reason: 'no active ticket resolved' };
  let snap; try { snap = loadStoreReadOnly(root, env); } catch (err) { return { state: 'deny', reason: `ticket store failed to load (${err.message}) — failing closed` }; }
  const ticket = snap?.get(active.id);
  if (!ticket) return { state: 'deny', reason: `active ticket ${active.id} not found in ticket store — failing closed` };
  if (active.ticketHash) { const sh = snap.ticketHashes?.[active.id] ?? snap.ticketHashes?.get?.(active.id); if (sh && sh !== active.ticketHash) return { state: 'deny', reason: `active ticket ${active.id} hash mismatch — failing closed` }; }
  const declared = ticket.rails ?? [];
  if (declared.some((r) => typeof r !== 'string' || !r.length)) return { state: 'deny', reason: `active ticket ${active.id} has a malformed rail entry — failing closed` };
  const custom = []; const ov = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  if (ov && typeof ov === 'string' && ov.trim()) {
    const raw = ov.trim(); custom.push(raw, `${raw}/**`, `${raw}/*`);
    if (isAbsolute(raw)) { const rel = relative(root, raw); if (!rel.startsWith('..')) custom.push(rel, `${rel}/**`); }
    else custom.push(join(root, raw), `${join(root, raw)}/**`);
  }
  return { state: 'active', rails: [...declared, ...TRUST_ROOT_RAILS, ...custom], activeId: active.id };
}

export function checkRail({ filePath, tool, toolArgs = null, root = process.cwd(), env = process.env, isCaseInsensitiveFsFn = isCaseInsensitiveFs }) {
  if (classifyTool(tool, toolArgs) === 'readonly') return { decision: 'allow', reason: `tool "${tool}" is read-only` };
  const pre = railPreconditions({ root, env });
  if (pre.state !== 'active') return { decision: pre.state === 'deny' ? 'deny' : 'allow', reason: pre.reason };
  const abs = isAbsolute(filePath) ? filePath : join(root, filePath);
  const cands = new Set([relative(root, abs).replace(/\\/g, '/'), resolveRailPath(filePath, root), abs.replace(/\\/g, '/'), realpathOr(filePath).replace(/\\/g, '/')]);
  const insens = isCaseInsensitiveFsFn(root);
  for (const p of cands) {
    const np = String(p ?? '').replace(/\\/g, '/');
    let hit = pre.rails.find((r) => r.replace(/\\/g, '/') === np || globMatch(r.replace(/\\/g, '/'), np));
    if (!hit && insens) { const lp = np.toLowerCase(); hit = pre.rails.find((r) => r.toLowerCase() === lp || globMatch(r.toLowerCase(), lp)); }
    if (hit) return { decision: 'deny', reason: `frozen rail "${hit}" (active ticket ${pre.activeId})` };
  }
  return { decision: 'allow', reason: 'path is not a frozen rail' };
}

export function unwrapCall(c) {
  let cur = c; const keys = ['toolCall', 'tool_call', 'call', 'tool', 'payload', 'functionCall', 'function_call', 'invocation', 'action', 'toolUse', 'tool_use'];
  while (cur && typeof cur === 'object') {
    if (typeof cur.name === 'string' || typeof cur.toolName === 'string' || typeof cur.tool_name === 'string' || typeof cur.functionName === 'string') return cur;
    const nk = keys.find((k) => cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k])); if (!nk) break; cur = cur[nk];
  }
  return null;
}
export function extractToolCalls(r) {
  if (!r || typeof r !== 'object') return [];
  const arrK = ['toolCalls', 'tool_calls', 'calls', 'actions', 'functionCalls', 'function_calls', 'invocations', 'toolUses', 'tool_uses', 'parts', 'steps'].find((k) => Array.isArray(r[k]));
  if (arrK) return r[arrK].map(unwrapCall).filter(Boolean);
  const objK = ['toolCall', 'tool_call', 'call', 'tool', 'payload', 'action', 'functionCall', 'function_call', 'invocation', 'toolUse', 'tool_use'].find((k) => r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]));
  if (objK) return [r[objK]].map(unwrapCall).filter(Boolean);
  const u = unwrapCall(r); return u ? [u] : [];
}
export function discoverRootFromTranscriptRecords(records, env = process.env, { anchorBase = null } = {}) {
  if (!Array.isArray(records) || !records.length) return null;
  const found = [];
  for (const r of records) for (const c of extractToolCalls(r)) for (const p of [...extractAllToolWorkdirs(extractArgs({ toolCall: c })), ...extractFilePaths({ toolCall: c })]) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const rp = isAbsolute(p) ? p : (anchorBase ? resolve(anchorBase, p) : null); if (!rp) continue;
    const cand = findAdlcRoot(canonicalizeExisting(rp), env) ?? findAdlcRoot(rp, env); if (cand) found.push(cand);
  }
  if (!found.length) return null;
  const opts = { storeOverride: env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null, homeDir: resolveUserHome(env) || homedir(), pluginDir: PLUGIN_ROOT, preserveSpelling: true };
  return found.reduce((best, next) => preferInnermostCheckout(best, [next], opts) ?? best);
}
export function hasUnambiguousWorkspaceCwd(payload, env = process.env, expectedRoot = null) {
  const baseCwd = nonPluginCwd() ?? process.cwd();
  const toCan = (s) => canonPath(isAbsolute(s.trim()) ? resolve(s.trim()) : resolve(baseCwd, s.trim()));
  const uniq = [...new Set(WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : [payload?.[k]])).filter((s) => typeof s === 'string' && s.trim()).map(toCan))];
  const expDir = [payload?.cwd, payload?.workingDirectory, payload?.working_directory, payload?.workspaceRoot].find((s) => typeof s === 'string' && s.trim());
  const expEnv = [env?.AGY_WORKSPACE, env?.ANTIGRAVITY_WORKSPACE, env?.GEMINI_WORKSPACE, env?.PROJECT_ROOT, env?.WORKSPACE_ROOT].find((s) => typeof s === 'string' && s.trim());
  if (uniq.length > 1 && !expDir && !expEnv) return false;
  if (typeof expectedRoot === 'string' && expectedRoot.trim()) {
    const imp = expDir ?? (uniq.length === 1 ? uniq[0] : null) ?? expEnv ?? (env === process.env ? nonPluginCwd() : null) ?? env?.PWD ?? env?.INIT_CWD ?? null;
    return Boolean(imp && toCan(imp) === canonPath(resolve(expectedRoot.trim())));
  }
  return true;
}
export function resolveWorkspaceRoot(payload, env = process.env) {
  const storeOverride = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  const homeDir = resolveUserHome(env) || homedir(); const baseCwd = nonPluginCwd() ?? process.cwd();
  const outer = declaredOuterWorkspace(payload); const wds = extractAllToolWorkdirs(extractArgs(payload));
  const fps = isToolPayload(payload) ? extractFilePaths(payload) : [];
  const dyn = [payload?.cwd, payload?.workingDirectory, payload?.working_directory, payload?.workspaceRoot, ...[...wds, ...fps].filter((s) => typeof s === 'string' && s.trim()).map((s) => (isAbsolute(s.trim()) ? s.trim() : resolve(outer ?? baseCwd, s.trim()))), env === process.env ? nonPluginCwd() : null].filter((s) => typeof s === 'string' && s.trim());
  const upg = (c) => preferInnermostCheckout(c, dyn, { storeOverride, homeDir, pluginDir: PLUGIN_ROOT, allowFileStart: true, preserveSpelling: true }) ?? c;
  const cands = [payload?.cwd, payload?.workingDirectory, payload?.working_directory, payload?.workspaceRoot, ...WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : [payload?.[k]])), env?.AGY_WORKSPACE, env?.ANTIGRAVITY_WORKSPACE, env?.GEMINI_WORKSPACE, env?.PROJECT_ROOT, env?.WORKSPACE_ROOT, env === process.env ? nonPluginCwd() : null, env?.PWD, env?.INIT_CWD, ...wds.filter(isAbsolute)].filter((s) => typeof s === 'string' && s.trim());
  for (const c of cands) { const f = findAdlcRoot(isAbsolute(c.trim()) ? c.trim() : join(baseCwd, c.trim()), env); if (f) return upg(f); }
  return null;
}

export function decide(payload, { env = process.env, trackerCache } = {}) {
  let enforcing = false;
  try {
    enforcing = env?.ADLC_P4_ENFORCEMENT === '1';
    if (!isToolPayload(payload)) return enforcing ? deny('unparseable tool payload while enforcing — failing closed') : pass();
    const tool = extractToolName(payload);
    if (!tool) return enforcing ? deny('tool payload exposes no tool name while enforcing — failing closed') : pass();
    const wsRoot = resolveWorkspaceRoot(payload, env); const args = extractArgs(payload); const cls = classifyTool(tool, args);
    const ov = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
    const ovRe = ov && typeof ov === 'string' && ov.trim() ? new RegExp('(^|[\\s=;,"\'/$.()[\\]])(' + ov.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|ADLC_TICKET_STORE|ADLC_TICKETS)', 'i') : null;
    const paths = extractFilePaths(payload); const guard = cls === 'readonly' ? isSecretStatePath : isTrustRootOrSecretPath;
    for (const raw of paths) {
      const { abs } = anchorPath(raw, payload, env); const can = canonicalizeExisting(abs);
      if (guard(abs, env) || guard(can, env) || guard(raw, env)) return deny('frozen rail — modification of master key or trust-root session secrets is strictly prohibited');
      if (cls !== 'readonly' && /(^|[/\\])\.(adlc|booster)([/\\]|$)/i.test(String(can || abs || raw))) return deny('frozen rail — direct modification of .adlc/** or .booster/** is strictly prohibited');
    }
    const earlyWs = declaredOuterWorkspace(payload, wsRoot);
    if (hasConflictingToolWorkdirs(args, earlyWs ?? wsRoot ?? nonPluginCwd() ?? process.cwd())) return deny('conflicting working directories in tool arguments — failing closed');
    const isShell = isShellTool(tool, args); const swd = !isShell ? extractCwdFromArgs(args) : null;
    if (enforcing && typeof swd === 'string' && swd.trim()) {
      const b = declaredOuterWorkspace(payload, isAbsolute(swd.trim()) ? swd.trim() : wsRoot) ?? wsRoot;
      if (!b || !isPathInside(isAbsolute(swd.trim()) ? swd.trim() : resolve(b, swd.trim()), b)) return forceAsk('structured tool workdir targets path outside workspace', env);
    }
    if (cls === 'readonly') {
      if (enforcing) {
        for (const raw of paths) if (raw && !isAbsolute(raw.replace(/\\/g, '/'))) { const { abs, anchored } = anchorPath(raw, payload, env); const b = declaredOuterWorkspace(payload, abs) ?? wsRoot; if (!anchored || !b || !isPathInside(abs, b)) return forceAsk(`relative path "${raw}" escapes workspace`, env); }
      }
      return pass();
    }
    if (paths.length > 0) {
      const cache = trackerCache ?? new Map();
      const getT = (r) => (cache.has(r) ? cache.get(r) : (cache.set(r, createPersistentTracker(r, env)), cache.get(r)));
      for (const raw of paths) {
        const { abs, anchored } = anchorPath(raw, payload, env);
        if (!anchored) { if (enforcing) return forceAsk(`unanchorable relative path "${raw}"`, env); continue; }
        const can = canonicalizeExisting(abs); const b = declaredOuterWorkspace(payload, abs) ?? wsRoot;
        if (enforcing && ov && typeof ov === 'string' && ov.trim()) {
          const ovAbs = isAbsolute(ov.trim()) ? ov.trim() : resolve(wsRoot ?? b ?? process.cwd(), ov.trim());
          const ovCan = canonicalizeExisting(ovAbs);
          if (abs === ovAbs || can === ovCan || isPathInside(abs, ovAbs) || isPathInside(can, ovCan)) {
            return deny('frozen rail — direct modification of external ticket store is strictly prohibited');
          }
        }
        if (enforcing && b && !isPathInside(can, b)) return forceAsk(`target path "${raw}" mutates outside workspace`, env);
        const eff = findAdlcRoot(can, env) ?? findAdlcRoot(abs, env); if (!eff) continue;
        for (const fp of [can, abs]) { const v = checkRail({ filePath: fp, tool, toolArgs: args, root: eff, env }); if (v.decision === 'deny') return deny(`frozen rail — ${v.reason}`); }
        const tr = getT(eff); const sid = resolveSessionId({ payload, env });
        if (enforcing) {
          if (tr?.isInvalidated?.(sid)) return deny('session invalidated due to secret disclosure — failing closed');
          const g = checkBuildGate({ sessionID: sid, tracker: tr, root: eff, env }); if (g.decision === 'deny') return deny(`build-gate — ${g.reason}`);
        }
        if (cls === 'mutating' && tr?.recordEdit) {
          const tp = resolveTranscriptPath({ payload, conversationId: sid, env });
          const fl = tr.recordEdit(sid, abs, { transcriptSteps: tp ? parseTranscriptSteps(tp) : [] });
          if (fl?.verdict === 'flail' && (enforcing || env?.ADLC_FLAIL_ENFORCEMENT === '1') && env?.ADLC_FLAIL_BYPASS !== '1') return deny(`flail-detector — session is flailing: ${fl.summary}. ${flailMessage({ path: abs, count: 3 })}`);
        }
      }
    }
    if (isShell) {
      const cmd = extractCommandString(args); const cw = extractCwdFromArgs(args);
      const b = declaredOuterWorkspace(payload, cw && isAbsolute(cw) ? cw : wsRoot) ?? wsRoot;
      const ec = (cw ? (isAbsolute(cw) ? cw : (b ? resolve(b, cw) : null)) : null) ?? wsRoot ?? process.cwd();
      if (cmd) {
        if (isTrustRootSecretAccess(cmd, ovRe) && !isReadonlyCommand(cmd, { root: b ?? ec, cwd: ec, env })) return deny('shell modification of ticket store or trust-root rails is strictly prohibited');
        if (hasShellTrustRootSecretAccess(cmd, { root: b ?? ec, cwd: ec, env }) || hasShellSymlinkOrSecretEscape(cmd, { root: b ?? ec, cwd: ec, env })) return deny('shell access to master key, trust-root secrets, or escaping symlink is strictly prohibited');
        if (enforcing && isUnauthorizedWorkspaceEscape(cmd, { root: b, cwd: ec })) return forceAsk('shell command accesses filesystem paths outside workspace', env);
        if (enforcing) {
          const verRoot = (cw ? (findAdlcRoot(ec, env) ?? ec) : null) ?? wsRoot ?? b ?? ec;
          const ro = isReadonlyCommand(cmd, { root: b ?? ec, cwd: ec, env });
          const ver = isVerificationCommand(cmd, { root: verRoot, workdirAnchorBase: b, toolArgs: args, allowImplicitCwd: hasUnambiguousWorkspaceCwd(payload, env, verRoot) });
          if (!ro && !ver) return forceAsk(`ambiguous mutating shell command requires confirmation: ${cmd.slice(0, 120)}`, env);
        }
        return pass();
      }
      if (hasCommandLineArgs(args)) return enforcing ? forceAsk('recognized shell tool has unparseable command arguments', env) : pass();
    }
    if (!paths.length) {
      if (cls === 'other') return enforcing && (hasPathLikeArgs(args) || hasCommandLineArgs(args) || hasCodeExecutionArgs(args)) ? deny(`unclassified tool "${tool}" has uninspectable arguments — failing closed`) : pass();
      return enforcing ? deny(`mutating tool "${tool}" exposed no inspectable target path — failing closed`) : pass();
    }
    return pass();
  } catch (err) { return enforcing ? deny(`internal error while enforcing — ${err?.message ?? err}`) : pass(); }
}

export function runFromStdin(raw, envArg = process.env) {
  const env = (envArg && typeof envArg === 'object' && envArg.env) ? envArg.env : (envArg ?? process.env);
  const enf = env?.ADLC_P4_ENFORCEMENT === '1';
  if (!raw || !raw.trim()) return enf ? deny('unparseable tool payload while enforcing — failing closed') : pass();
  let payload; try { payload = JSON.parse(raw); } catch { return enf ? deny('unparseable tool payload while enforcing — failing closed') : pass(); }
  if (!isToolPayload(payload)) return enf ? deny('unparseable tool payload while enforcing — failing closed') : pass();
  const toolName = extractToolName(payload); const trackerCache = new Map();
  if (!toolName) return decide(payload, { env, trackerCache });
  const wsRoot = resolveWorkspaceRoot(payload, env);
  const args = extractArgs(payload); const cls = classifyTool(toolName, args); const sid = resolveSessionId({ payload, env });
  const cmdCwd = extractCwdFromArgs(args);
  const cmdCwdRoot = cmdCwd && isAbsolute(cmdCwd) ? findAdlcRoot(cmdCwd, env) : null;
  const pathRoots = new Set();
  for (const p of extractFilePaths(payload)) { const { abs } = anchorPath(p, payload, env); if (abs) { const r = findAdlcRoot(abs, env); if (r) pathRoots.add(r); } }
  const roots = new Set(cmdCwdRoot ? [cmdCwdRoot, ...pathRoots] : (pathRoots.size ? [...pathRoots] : [wsRoot].filter(Boolean)));
  const tp = resolveTranscriptPath({ payload, conversationId: sid, env });
  if (!roots.size && tp) {
    const trRoot = discoverRootFromTranscriptRecords(parseTranscriptRecords(tp), env, { anchorBase: declaredOuterWorkspace(payload) }) ?? findAdlcRoot(tp, env);
    if (trRoot) roots.add(trRoot);
  }
  const isShell = isShellTool(toolName, args); const cmd = extractCommandString(args);
  const verTarget = cmdCwdRoot ?? wsRoot ?? [...roots][0] ?? process.cwd();
  const isMut = isShell ? (!isReadonlyCommand(cmd, { root: verTarget, cwd: cmdCwd && isAbsolute(cmdCwd) ? cmdCwd : verTarget, env }) && !isVerificationCommand(cmd, { root: verTarget, workdirAnchorBase: declaredOuterWorkspace(payload, verTarget), toolArgs: args })) : cls !== 'readonly';
  for (const r of roots) {
    const tr = createPersistentTracker(r, env); trackerCache.set(r, tr);
    tr.recordToolCall(sid, { isMutating: isMut }); if (tp) tr.recordTranscript(sid, tp);
    const active = resolveActiveTicketId(r, env); if (active.id) try { tr.recordActiveTicket(sid, active.id, loadStoreReadOnly(r, env)?.hash); } catch {}
  }
  const v = decide(payload, { env, trackerCache });
  if (v.decision === 'deny') for (const r of roots) trackerCache.get(r)?.revertToolCall?.(sid, { isMutating: isMut });
  return v;
}

export function preInvocation(payload, { env = process.env } = {}) {
  try {
    let root = resolveWorkspaceRoot(payload, env);
    const sid = resolveSessionId({ payload, env });
    const tp = resolveTranscriptPath({ payload, conversationId: sid, env });
    if (tp) {
      const trRoot = discoverRootFromTranscriptRecords(parseTranscriptRecords(tp, { readFull: true }), env, { anchorBase: declaredOuterWorkspace(payload, root) }) ?? findAdlcRoot(tp, env);
      const multi = WORKSPACE_KEYS.flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : [])).filter((s) => typeof s === 'string' && s.trim());
      if (!root || (trRoot && multi.length > 1 && multi.some((w) => canonPath(w) === canonPath(trRoot)))) root = trRoot;
      else if (trRoot) root = preferInnermostCheckout(root, [trRoot], { storeOverride: env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null, homeDir: resolveUserHome(env) || homedir(), pluginDir: PLUGIN_ROOT, preserveSpelling: true }) ?? root;
    }
    if (!root) return { injectSteps: [] };
    const active = resolveActiveTicketId(root, env);
    const cleanId = sanitizeField(active.id, 64);
    if (!cleanId || cleanId !== active.id || active.conflict || !/^[a-zA-Z0-9_-]+$/.test(cleanId)) return { injectSteps: [] };
    const snap = loadStoreReadOnly(root, env); const ticket = snap.get(cleanId); if (!ticket) return { injectSteps: [] };
    const tr = createPersistentTracker(root, env);
    tr.recordActiveTicket(sid, cleanId, snap.hash);
    if (tp) tr.recordTranscript(sid, tp);
    const rails = [...new Set([...sanitizeGlobList(ticket.rails), ...TRUST_ROOT_RAILS])].join(', ');
    const cleanScope = sanitizeGlobList(ticket.scope);
    const scope = cleanScope.length ? cleanScope.join(', ') : 'unrestricted';
    return { injectSteps: [{ ephemeralMessage: `[ADLC Context] Active Ticket: ${cleanId} | Enforcement: ${env.ADLC_P4_ENFORCEMENT === '1' ? 'ACTIVE' : 'INACTIVE (advisory)'} | Scope: ${scope} | Frozen Rails: ${rails}` }] };
  } catch { return { injectSteps: [] }; }
}

export function postToolUse(payload, { env = process.env } = {}) {
  try {
    const sid = resolveSessionId({ payload, env });
    const rawOut = (typeof payload?.output === 'string' ? payload.output + '\n' : '') + JSON.stringify(payload ?? {});
    const mk = getMasterKeyRaw(env);
    if (mk && rawOut.includes(mk)) { rotateMasterKey(env); createPersistentTracker(resolveWorkspaceRoot(payload, env) ?? process.cwd(), env)?.invalidateSession?.(sid); }
    const tp = resolveTranscriptPath({ payload, conversationId: sid, env });
    let wsRoot = resolveWorkspaceRoot(payload, env);
    if (!wsRoot && tp) wsRoot = discoverRootFromTranscriptRecords(parseTranscriptRecords(tp), env, { anchorBase: declaredOuterWorkspace(payload) }) ?? findAdlcRoot(tp, env);
    if (wsRoot) {
      const tr = createPersistentTracker(wsRoot, env);
      const ec = payload?.exit_code ?? payload?.exitCode ?? payload?.result?.exitCode ?? payload?.toolResult?.exitCode;
      tr.recordToolResult(sid, { exitCode: typeof ec === 'number' ? ec : null, transcriptPath: tp });
      const sec = getOrCreateSessionSecret(wsRoot, env); if (sec && rawOut.includes(sec)) tr.invalidateSession?.(sid);
    }
  } catch {}
  return pass();
}

export function onStop(payload, { env = process.env } = {}) {
  return evaluateGeminiStop(payload, {
    env,
    helpers: {
      PLUGIN_ROOT,
      resolveWorkspaceRoot,
      declaredOuterWorkspace,
      discoverRootFromTranscriptRecords,
      hasUnambiguousWorkspaceCwd,
      extractToolCalls,
      extractToolName,
      extractArgs,
      extractFilePaths,
      findAdlcRoot,
      canonicalizeExisting,
    },
  });
}

export function printStatus(root = process.cwd(), env = process.env, payload = {}) {
  const r = findAdlcRoot(isAbsolute(root) ? root : join(process.cwd(), root), env) ?? root;
  const a = resolveActiveTicketId(r, env); const tr = createPersistentTracker(r, env); const sid = resolveSessionId({ payload, env }); const fl = checkFlail({ sessionID: sid, tracker: tr, env });
  console.log(`--- ADLC Gemini Status ---\nRoot: ${r}\nActive Ticket: ${a.id ?? (a.conflict ? 'CONFLICT' : 'NONE')}\nEnforcement (ADLC_P4_ENFORCEMENT): ${env.ADLC_P4_ENFORCEMENT === '1' ? 'ACTIVE' : 'INACTIVE'}\nResolved Session ID: ${sid}\nContext Depth (Tool Calls): ${tr.depth(sid)}\nSession Compacted: ${tr.isCompacted(sid)}\nFlail Status: ${fl.verdict.toUpperCase()}${fl.summary ? ` (${fl.summary})` : ''}`);
}
export function printDoctor(root = process.cwd(), env = process.env) {
  const r = findAdlcRoot(isAbsolute(root) ? root : join(process.cwd(), root), env) ?? root;
  console.log(`--- ADLC Gemini Doctor ---\nNode Version: ${process.version}\nRoot Directory: ${r}\nADLC Ticket Store Present: ${storeExists(r, env)}\nActive Ticket: ${resolveActiveTicketId(r, env).id ?? 'NONE'}\nCI Rail Guard Workflow: ${existsSync(join(r, '.github/workflows/adlc-rails-guard.yml')) ? 'PRESENT' : 'MISSING'}`);
}
