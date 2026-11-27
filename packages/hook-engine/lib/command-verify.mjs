// command-verify.mjs — tool classification, shell verification/readonly checks,
// trust-root & secret path guards, and filesystem case-sensitivity detection.

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalizePath as canonPath, extractToolWorkdir, hasConflictingToolWorkdirs, isPathInside } from '@adlc/core';

export const TRUST_ROOT_RAILS = [
  '.adlc', '.adlc/**', '.adlc/tickets', '.adlc/tickets.json', '.adlc/tickets/.store.json', '.adlc/tickets/**',
  '.adlc/current-ticket.json', '.adlc/sessions.json', '.adlc/sessions.lock', '.adlc/sessions.lock/**',
  '.adlc/session-ledger.jsonl', '.adlc/session-ledger.jsonl*', '.adlc/.session-secret', '.adlc/.session-secret*',
  '.booster', '.booster/**', '.env.local', '.env.local*',
];
export const MUTATING_TOOL_HINTS = ['write', 'edit', 'replace', 'patch', 'create', 'delete', 'remove', 'rename', 'move', 'apply', 'insert', 'append', 'modify'];
export const PURE_READS = new Set([
  'read', 'readfile', 'readlints', 'grep', 'grepsearch', 'glob', 'globsearch', 'codebasesearch', 'semanticsearch',
  'filesearch', 'list', 'listdir', 'ls', 'cat', 'view', 'viewfile', 'webfetch', 'websearch', 'fetch', 'fetchrules',
  'search', 'findbyname', 'searchweb', 'managetask', 'schedule', 'listpermissions', 'sendmessage', 'askquestion',
  'invokesubagent', 'askpermission', 'managesubagents', 'definesubagent', 'readurlcontent', 'listresources', 'readresource',
]);
const READONLY_MCP_INNER_TOOLS = new Set(['codegraphexplore', 'agbstatus', 'agbdoctor', 'agbpreflight', 'listresources', 'readresource']);
const SHELL_TOOL_NAMES = new Set([
  'bash', 'sh', 'zsh', 'fish', 'shell', 'terminal', 'cmd', 'powershell', 'pwsh', 'console', 'exec', 'run',
  'runcommand', 'runcmd', 'runterminalcmd', 'runterminalcommand', 'runinterminal', 'runinterminalcommand',
  'runshell', 'runshellcommand', 'shellexec', 'shellcommand', 'executecommand', 'execcommand',
  'executecommandline', 'execcommandline', 'executeshell', 'executeterminalcommand', 'terminalcmd', 'terminalcommand', 'customshell',
]);
const MUTATING_PAYLOAD_KEY_RE = /^(TargetFile|target_file|dest_file|destFile|dest|destination|destPath|CodeContent|codeContent|content|Replacement|replacement|ReplacementContent|replacementContent|ReplacementChunks|replacementChunks|patch|patchText|diff|edits|changes|operations)$/i;
const CMD_KEY_RE = /(command|cmd|exec|shell|terminal|script|code|eval|run)/i;
const CODE_KEY_RE = /^(code|script|eval|expression|program|snippet|inline|payload)$/i;
const EXTRACT_CMD_KEY_RE = /^(command|cmd|commandline|command_line|exec|shell|terminal|script|eval|run|query|action|operation|program|payload)$/i;
const SKIP_CMD_KEY_RE = /content|body|diff|patch|replacement|summary|description|message/i;
const SAFE_BINS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'rg', 'which', 'uname', 'whoami', 'date', 'echo', 'printf']);
const FILE_READER_BINS = new Set(['cat', 'head', 'tail', 'ls', 'grep', 'rg']);

export const normalizeToolName = (name) => String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');

export function resolveUserHome(env = process.env) {
  const fromEnv = process.platform === 'win32' ? env?.USERPROFILE : env?.HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  try { return homedir() || tmpdir(); } catch { return tmpdir(); }
}

export function getTrustRootSecretHomes(env = process.env) {
  const customHome = (resolveUserHome(env) || '').replace(/\\/g, '/');
  let realHome = '';
  try { realHome = (homedir() || tmpdir() || '').replace(/\\/g, '/'); } catch {
    try { realHome = (tmpdir() || '').replace(/\\/g, '/'); } catch { realHome = ''; }
  }
  return [...new Set([realHome, customHome].filter(Boolean))];
}

export function isSecretStatePath(p, env = process.env) {
  if (!p || typeof p !== 'string') return false;
  const norm = p.replace(/\\/g, '/');
  for (const h of getTrustRootSecretHomes(env)) {
    if (norm === `${h}/.adlc` || norm.startsWith(`${h}/.adlc/`) || norm === `${h}/.config/adlc` || norm.startsWith(`${h}/.config/adlc/`)) return true;
  }
  if (/(^|\/|\b)(\.master-key|\.auth-key|\.adlc-secrets|\.adlc-runtime-secrets|\.session-secret|\.store\.json|session-[a-f0-9]+\.secret|\.adlc\/sessions|\.adlc\/session-ledger|\.env\.local)/i.test(norm)) return true;
  return /^~\/\.adlc/.test(norm) || norm.startsWith('~/.config/adlc');
}

export function isTrustRootOrSecretPath(p, env = process.env) {
  if (!p || typeof p !== 'string') return false;
  const norm = p.replace(/\\/g, '/');
  if (process.execPath) {
    const nb = process.execPath.replace(/\\/g, '/');
    if (norm === nb || norm.startsWith(nb + '/')) return true;
    try { const rn = realpathSync(process.execPath).replace(/\\/g, '/'); if (norm === rn || norm.startsWith(rn + '/')) return true; } catch {}
  }
  if (/(^|\/)(node|node\.exe)$/i.test(norm) ||
      /(^|\/)node_modules\/\.bin\/(node|mocha|jest|vitest|npm|npx|adlc)(\.exe|\.cmd|\.ps1)?$/i.test(norm) ||
      /(^|\/)(\.mocharc(\.(js|cjs|mjs|json|yaml|yml))?|jest\.config\.(js|cjs|mjs|ts|json)|vitest\.config\.(js|cjs|mjs|ts))$/i.test(norm)) return true;
  return isSecretStatePath(p, env);
}

function hasKeyMatching(args, re, depth = 0) {
  if (!args || typeof args !== 'object' || depth > 5) return false;
  for (const [k, v] of Object.entries(args)) {
    if (re.test(k) && ((typeof v === 'string' && v.trim().length > 0) || (Array.isArray(v) && v.length > 0))) return true;
    if (v && typeof v === 'object' && hasKeyMatching(v, re, depth + 1)) return true;
  }
  return false;
}
export const hasCommandLineArgs = (args, depth = 0) => hasKeyMatching(args, CMD_KEY_RE, depth);
export const hasCodeExecutionArgs = (args, depth = 0) => hasKeyMatching(args, CODE_KEY_RE, depth);

export function extractCommandString(args, depth = 0) {
  if (!args || typeof args !== 'object' || depth > 5) return '';
  for (const [k, v] of Object.entries(args)) {
    if (SKIP_CMD_KEY_RE.test(k) || !EXTRACT_CMD_KEY_RE.test(k)) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length > 0) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ').trim();
  }
  for (const [k, v] of Object.entries(args)) {
    if (!SKIP_CMD_KEY_RE.test(k) && v && typeof v === 'object') { const n = extractCommandString(v, depth + 1); if (n) return n; }
  }
  return '';
}

export function isShellTool(name, args = null) {
  if (!SHELL_TOOL_NAMES.has(normalizeToolName(name))) return false;
  if (args && typeof args === 'object') {
    const hasTarget = Boolean(args.TargetFile || args.targetFile || args.FilePath || args.filePath || args.path || args.dest_file || args.destination || args.file);
    if (hasTarget && !hasCommandLineArgs(args)) return false;
  }
  return true;
}

export function hasMutatingPayloadDeep(args, depth = 0) {
  if (depth > 5) return true;
  if (!args || typeof args !== 'object') return false;
  if (Array.isArray(args)) return args.some((i) => i && typeof i === 'object' && hasMutatingPayloadDeep(i, depth + 1));
  for (const [k, v] of Object.entries(args)) {
    if (MUTATING_PAYLOAD_KEY_RE.test(k) && ((typeof v === 'string' && v.length > 0) || (Array.isArray(v) && v.length > 0) || (v && typeof v === 'object'))) return true;
    if (v && typeof v === 'object' && hasMutatingPayloadDeep(v, depth + 1)) return true;
  }
  return false;
}

export function classifyTool(name, args = null) {
  const n = normalizeToolName(name);
  if (!n) return 'other';
  if (n === 'callmcptool') {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return 'other';
    const inner = normalizeToolName(args.ToolName ?? args.toolName ?? args.tool_name ?? args.name ?? '');
    const qual = `${normalizeToolName(args.ServerName ?? args.serverName ?? args.server_name ?? args.server ?? '')}${inner}`;
    const ia = args.Arguments ?? args.arguments ?? args.parameters ?? args.tool_input ?? args.toolInput ?? args.input ?? args.params ?? null;
    if (!inner) return 'other';
    if (MUTATING_TOOL_HINTS.some((h) => inner.includes(h))) return 'mutating';
    const allowed = READONLY_MCP_INNER_TOOLS.has(inner) || READONLY_MCP_INNER_TOOLS.has(qual) || PURE_READS.has(inner);
    return (allowed && !hasMutatingPayloadDeep(args) && !hasMutatingPayloadDeep(ia) && !hasCommandLineArgs(args) && !hasCodeExecutionArgs(args) && !hasCommandLineArgs(ia) && !hasCodeExecutionArgs(ia)) ? 'readonly' : 'other';
  }
  if (MUTATING_TOOL_HINTS.some((h) => n.includes(h))) return 'mutating';
  if (PURE_READS.has(n)) return (args && typeof args === 'object' && (hasMutatingPayloadDeep(args) || hasCommandLineArgs(args) || hasCodeExecutionArgs(args))) ? 'other' : 'readonly';
  return 'other';
}

const caseSensitivityCache = new Map();
export function isCaseInsensitiveFs(root, fns) {
  const ex = fns?.existsSync ?? existsSync; const rp = fns?.realpathSync ?? realpathSync;
  if (!fns && caseSensitivityCache.has(root)) return caseSensitivityCache.get(root);
  let res = false;
  try {
    const target = ex(join(root, '.adlc')) ? join(root, '.adlc') : root;
    const leaf = basename(target);
    const flipped = [...leaf].map((c) => (c.toLowerCase() === c.toUpperCase() ? c : (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))).join('');
    if (flipped !== leaf) { const cand = join(dirname(target), flipped); res = ex(cand) && rp(cand) === rp(target); }
  } catch { res = false; }
  if (!fns) caseSensitivityCache.set(root, res);
  return res;
}

export function tokenizeCommand(cmd) {
  if (typeof cmd !== 'string') return [];
  const out = []; const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g; let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const realpathOr = (p) => { try { return existsSync(p) ? realpathSync(p) : p; } catch { return p; } };
const isAllowedSysExec = (p) => p === '/dev/null' || /^\/(bin|usr\/bin|usr\/local\/bin|opt\/homebrew\/bin)(\/|$)/.test(p);
const isTrustedNodeExec = (p) => {
  if (!p || !process.execPath) return false;
  if (p === process.execPath.replace(/\\/g, '/')) return true;
  try { return p === realpathSync(process.execPath).replace(/\\/g, '/'); } catch { return false; }
};
const unquote = (s) => (((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) && s.length >= 2) ? s.slice(1, -1) : s;

function collectShellCandidateTokens(cmd) {
  const items = []; let expectingCmd = true;
  for (const raw of tokenizeCommand(cmd)) {
    if (!raw || raw.length > 4096) continue;
    if (/^(;|&&|\|\||\|)$/.test(raw)) { expectingCmd = true; continue; }
    const outRedir = /^[0-9]*>+/.test(raw);
    if (!outRedir && expectingCmd && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) {
      const rhs = raw.slice(raw.indexOf('=') + 1).trim();
      if (rhs) items.push({ rawToken: rhs, isOutRedirect: false, isCommandToken: false });
      continue;
    }
    const hadFlag = /^--?[a-zA-Z0-9_-]+=/.test(raw);
    const cleaned = unquote(raw.replace(/^[0-9]*[><]+/, '').replace(/^--?[a-zA-Z0-9_-]+=/, '').trim());
    if (!cleaned || cleaned.startsWith('-')) continue;
    const isCommandToken = expectingCmd && !outRedir && !hadFlag;
    if (isCommandToken) expectingCmd = false;
    items.push({ rawToken: cleaned, isOutRedirect: outRedir, isCommandToken });
  }
  for (const rm of cmd.match(/[0-9]*[><]+\s*([^<>&|;\s]+)/g) ?? []) {
    const target = unquote(rm.replace(/^[0-9]*[><]+\s*/, '').trim());
    if (target) items.push({ rawToken: target, isOutRedirect: rm.includes('>'), isCommandToken: false });
  }
  return items;
}

export function isUnauthorizedWorkspaceEscape(cmd, { root = null, cwd = root } = {}) {
  if (!cmd || typeof cmd !== 'string') return false;
  const norm = cmd.replace(/\\/g, '/');
  if (/(^|[\s=;,"'(])~(?=$|[\s/;"')])|(\$HOME\b|\$\{HOME\})/.test(norm)) return true;
  if (/\bfind\b/i.test(norm) && /(-exec|-execdir|-ok|-delete)\b/i.test(norm)) return true;
  if (/(^|[\s=;,"'/\\$.()[\]])\.\.(?=$|[\s=;,"'/\\$.()[\]])/.test(norm)) return true;
  const hasRoot = typeof root === 'string' && root.trim().length > 0;
  const effCwd = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : root;
  if (hasRoot && effCwd && !isPathInside(effCwd, root)) return true;
  const checkAbs = (c, isCmd = false) => !(isAllowedSysExec(c) || (isCmd && isTrustedNodeExec(c))) && (hasRoot ? !isPathInside(c, root) : /^\/(home|Users|root|etc|proc|sys|dev|tmp|var|private|opt)(\/|$)/i.test(c));
  const allowedExec = new Set();
  for (const { rawToken: t, isCommandToken } of collectShellCandidateTokens(cmd)) {
    if (t.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(t)) {
      const nt = t.replace(/\\/g, '/');
      if (isCommandToken && isTrustedNodeExec(nt)) allowedExec.add(nt);
      if (checkAbs(nt, isCommandToken)) return true;
    } else if (hasRoot && effCwd && (t.includes('/') || t.includes('\\')) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t) && !isPathInside(resolve(effCwd, t), root)) return true;
  }
  const re = /(?:^|[\s=;,"'`$(><])(\/[A-Za-z0-9_./~-]*)/g; let m;
  while ((m = re.exec(norm)) !== null) if (m[1] && !(allowedExec.has(m[1]) && m.index === 0) && checkAbs(m[1])) return true;
  return false;
}

export function isTrustRootSecretAccess(cmd, overrideEscaped = null) {
  if (!cmd || typeof cmd !== 'string') return false;
  const norm = cmd.replace(/\\/g, '/');
  if (overrideEscaped && (overrideEscaped.test(cmd) || overrideEscaped.test(norm))) return true;
  if (/(master[\w*?.-]*key|auth[\w*?.-]*key|session[\w*?.-]*secret|tickets?[\w*?.-]*json|session[\w*?.-]*ledger)/i.test(norm)) return true;
  if (/(^|[\s=;,"'/\\$.()[\]])\.(adlc|booster|master|auth|session|adlc-secrets)[\w*?.-]*/i.test(norm)) return true;
  const deobf = norm.replace(/[[\]{}()\\*?`"'$]/g, '');
  if (/(master-?key|auth-?key|session-?secret|tickets?\.json|session-?ledger|current-?ticket)/i.test(deobf)) return true;
  const re = /(^|[\s=;,"'/\\$.()[\]])(\.adlc|\.booster|\.master-key|\.auth-key|\.adlc-secrets|\.adlc-runtime-secrets|\.session-secret|\.store\.json|session-[a-f0-9]+\.secret|\/dev\/shm\/\.adlc|\.env\.local)/i;
  return re.test(norm) || re.test(deobf);
}

export function hasShellTrustRootSecretAccess(cmd, { root = process.cwd(), cwd = root, env = process.env } = {}) {
  if (!cmd || typeof cmd !== 'string') return false;
  if (/\b(cat|head|tail|less|more|od|xxd|strings|source|\.)\s+.*[*?[\]{}]/i.test(cmd)) return true;
  const effCwd = cwd ?? root; const ro = isReadonlyCommand(cmd, { root, cwd: effCwd, env });
  const norm = cmd.replace(/\\/g, '/');
  if (!ro && /(^|[\s=;,"'/$.()[\]])(node_modules\/\.bin\/(node|mocha|jest|vitest|npm|npx|adlc)(\.exe|\.cmd|\.ps1)?|\.mocharc(\.(js|cjs|mjs|json|yaml|yml))?|jest\.config\.(js|cjs|mjs|ts|json)|vitest\.config\.(js|cjs|mjs|ts))(?=$|[\s=;,"'/$.()[\]])/i.test(norm)) {
    const items = collectShellCandidateTokens(cmd);
    if (!(items.length > 0 && !/[\r\n;&|<>$`()={}]/.test(cmd) && items.every((it) => it.isCommandToken || !/(node_modules\/\.bin\/|\.mocharc|jest\.config\.|vitest\.config\.)/i.test(it.rawToken.replace(/\\/g, '/'))))) return true;
  }
  for (const { rawToken: t, isOutRedirect, isCommandToken } of collectShellCandidateTokens(cmd)) {
    const abs = isAbsolute(t) ? t : resolve(effCwd, t); const lex = canonPath(abs); let real = lex;
    try { if (existsSync(abs) || lstatSync(abs).isSymbolicLink()) real = realpathSync(abs); } catch {}
    if (isSecretStatePath(abs, env) || isSecretStatePath(lex, env) || isSecretStatePath(real, env)) return true;
    if ((isOutRedirect || (!isCommandToken && !ro)) && (isTrustRootOrSecretPath(abs, env) || isTrustRootOrSecretPath(lex, env) || isTrustRootOrSecretPath(real, env))) return true;
    if (isCommandToken && (t.includes('/') || t.includes('\\')) && root && isPathInside(lex, root) && /(^|\/)(node|node\.exe)$/i.test(lex.replace(/\\/g, '/')) && !/\/node_modules\/\.bin\//i.test(lex.replace(/\\/g, '/'))) return true;
  }
  return false;
}

export function hasShellSymlinkOrSecretEscape(cmd, { root = process.cwd(), cwd = root, env = process.env } = {}) {
  if (!cmd || typeof cmd !== 'string') return false;
  const effCwd = cwd ?? root;
  const simpleRead = !/[\r\n;&|<>$`()={}\\~]/.test(cmd) && /^\s*(cat|head|tail|ls|stat|file|wc)\b/.test(cmd);
  for (const { rawToken: t, isOutRedirect, isCommandToken } of collectShellCandidateTokens(cmd)) {
    const abs = isAbsolute(t) ? t : resolve(effCwd, t);
    try {
      const isSym = lstatSync(abs).isSymbolicLink();
      if (isSym || existsSync(abs)) {
        const can = realpathSync(abs);
        if (isSecretStatePath(can, env)) return true;
        if ((isOutRedirect || (!isCommandToken && !simpleRead)) && isTrustRootOrSecretPath(can, env)) return true;
        if (isSym && !isAllowedSysExec(abs.replace(/\\/g, '/')) && root && !isPathInside(can, root)) return true;
      }
    } catch { try { if (lstatSync(abs).isSymbolicLink()) return true; } catch {} }
  }
  return false;
}

export function isReadonlyCommand(cmd, { root = process.cwd(), cwd = root, env = process.env } = {}) {
  if (typeof cmd !== 'string' || !cmd.trim()) return false;
  const trimmed = cmd.trim();
  if (/[\r\n;&|<>$`()={}\\~]/.test(trimmed) || isUnauthorizedWorkspaceEscape(trimmed, { root, cwd }) || isTrustRootSecretAccess(trimmed) || hasShellSymlinkOrSecretEscape(trimmed, { root, cwd, env })) return false;
  const tokens = tokenizeCommand(trimmed);
  if (!tokens.length) return false;
  const bin = tokens[0];
  if (bin === 'git') {
    if (tokens.length < 2) return false;
    let noPager = false; let sub = null; const args = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '--no-pager') { noPager = true; continue; }
      if (/^(-c|-C|--exec-path|--work-tree|--git-dir|--config-env)$/i.test(t) || /^--(exec-path|work-tree|git-dir|config-env)=/i.test(t) || /(diff\.external|diff\.textconv|core\.pager|pager\.|alias\.|!)/i.test(t)) return false;
      if (!sub && !t.startsWith('-')) sub = t; else args.push(t);
    }
    if (!sub || !['status', 'diff', 'log', 'rev-parse', 'show', 'branch'].includes(sub)) return false;
    if (args.some((t) => /^(-o|--output|--output-directory|--ext-diff|--textconv)$/i.test(t) || /^--(output|output-directory|ext-diff|textconv)=/i.test(t))) return false;
    if ((sub === 'diff' || sub === 'log' || sub === 'show') && (!args.includes('--no-ext-diff') || !noPager)) return false;
    return !(sub === 'branch' && args.some((t) => !t.startsWith('-') || /^(-[dDmMcfuU]|--delete|--move|--copy|--force|--set-upstream-to|--unset-upstream|-u)$/i.test(t)));
  }
  if (!SAFE_BINS.has(bin)) return false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^(-o|--output|--output-directory)$/i.test(t) || /^--output=/i.test(t) || isUnauthorizedWorkspaceEscape(t, { root }) || isTrustRootSecretAccess(t)) return false;
    if (!t.startsWith('-') && FILE_READER_BINS.has(bin)) {
      const res = isAbsolute(t) ? t : resolve(root, t); const rel = relative(root, res);
      if (rel.startsWith('..') || isAbsolute(rel) || isTrustRootSecretAccess(res)) return false;
      try {
        if (existsSync(res) || lstatSync(res).isSymbolicLink()) {
          const real = realpathSync(res); const rr = relative(root, real);
          if (rr.startsWith('..') || isAbsolute(rr) || isTrustRootSecretAccess(real)) return false;
        }
      } catch { try { if (lstatSync(res).isSymbolicLink()) return false; } catch {} }
    }
  }
  return true;
}

export function isVerificationCommand(cmd, { root, workdirAnchorBase = null, toolArgs, allowImplicitCwd = true, packageManifestMutated = false, shellMutated = false } = {}) {
  if (typeof cmd !== 'string' || !cmd.trim()) return false;
  const trimmed = cmd.trim();
  if (/[\r\n;&|<>$`~]/.test(trimmed) || /(^|\s)\/dev\//i.test(trimmed) || /(^|\s)--(\s+|$)/.test(trimmed)) return false;
  if (/(^|\s)(--prefix|--cwd|-C|--if-present|--test-name-pattern|--test-skip-pattern|--test-only|--passWithNoTests|--test-shard|--test-reporter-destination|--output|--output-dir|--output-directory|--destination|-o|--grep|-g|--require|--import|--loader|--experimental-loader|-r|--test-global-setup|--test-global-teardown|--test-update-snapshots|--test-coverage|--experimental-test-coverage|--watch|--watch-mode|--run|-w|--workspace|--workspaces|--include-workspace-root)\b/i.test(trimmed)) return false;
  if (/(--require=|--import=|--loader=|--experimental-loader=|--test-shard=|--test-name-pattern=|--test-skip-pattern=|--test-reporter-destination=|--output=|--destination=|--test-global-setup=|--test-global-teardown=|--test-coverage=|--experimental-test-coverage=|--workspace=)/i.test(trimmed)) return false;
  const realRoot = root ? realpathOr(resolve(root)) : null; const wdBase = workdirAnchorBase ?? root ?? process.cwd();
  if (hasConflictingToolWorkdirs(toolArgs, wdBase)) return false;
  const cwd = extractToolWorkdir(toolArgs);
  if (typeof cwd === 'string' && cwd) {
    if (!root || !realRoot || relative(realRoot, realpathOr(isAbsolute(cwd) ? cwd : resolve(wdBase, cwd))) !== '') return false;
  } else if (!allowImplicitCwd || !realRoot) return false;
  const tokens = tokenizeCommand(trimmed);
  if (realRoot) {
    for (let i = 0; i < tokens.length; i++) {
      const raw = tokens[i];
      const tok = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : raw;
      if (tok.startsWith('~')) return false;
      if (i === 0 && isTrustedNodeExec(tok.replace(/\\/g, '/'))) continue;
      if (tok.startsWith('/') || tok.startsWith('\\') || tok.includes('/') || tok.includes('\\') || tok.includes('..')) {
        const rel = relative(realRoot, realpathOr((tok.startsWith('/') || tok.startsWith('\\')) ? tok : resolve(root, tok)));
        if (rel.startsWith('..') || isAbsolute(rel)) return false;
      }
    }
  }
  if (/\s+(--help|--version|-v|-h)(\s+|$)/i.test(trimmed) || /^(adlc|npx\s+(--no-install\s+)?adlc)\s+(ticket|doctor|status|help|version|list)/i.test(trimmed)) return false;
  if (!packageManifestMutated && !shellMutated) {
    if (/^(npm\s+(test|run\s+(test|preflight))|((adlc|npx\s+--no-install\s+adlc)\s+(hollow-test|rails-guard|preflight))|npx\s+--no-install\s+(mocha|jest|vitest))\s*$/i.test(trimmed)) return true;
  }
  const isNodeBin = tokens.length >= 2 && (/^node$/i.test(tokens[0]) || isTrustedNodeExec(tokens[0].replace(/\\/g, '/')));
  if (isNodeBin && tokens[1] === '--test' && (tokens.length === 2 || (tokens.length === 3 && /^(test|tests|spec)\/?$/i.test(tokens[2])))) {
    return !(root && ['node', 'node.exe', join('node_modules', '.bin', 'node'), join('node_modules', '.bin', 'node.exe')].some((p) => existsSync(join(root, p))));
  }
  return false;
}
