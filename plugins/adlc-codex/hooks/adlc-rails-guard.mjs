#!/usr/bin/env node
// KEEP IN SYNC — the shell classifier functions in this file (shellTokens,
// shellHasMutation, shellHasOpaqueMutation, shellIsPositivelyReadOnly,
// shellHasWriteOption, shellChangesCwd, shellHasExpansion, collectShellPaths,
// looksPathLike/looksBarePathLike/keyValuePath) are a verbatim inline copy of
// the CANONICAL module packages/core/lib/shell.mjs (@adlc/core). This hook
// script cannot resolve npm packages at runtime, hence the copy; a drift test
// (packages/core/test/shell.test.mjs) pins the two together.
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, dirname, basename, join } from 'node:path';
import { loadTicketStoreReadOnly } from './generated-ticket-reader.mjs';
import {
  resolveActiveTicketId as resolveActiveTicketIdCanonical,
  resolveActiveTicketAgainst,
} from './generated-active-ticket.mjs';
import {
  toolNameOf,
  isRecoveryEligibleToolName,
  isBareInspectionPwd,
  matchRecoveryCommand,
  resolveTrustedBinary,
  recordRecoveryUnderBand,
  resolveHandoffSessionIdLocal,
} from './adlc-handoff-gate.mjs';
import { resolveContextHandoffEntry } from './handoff-resolve.mjs';

function fail(message) {
  console.error(`adlc-rails-guard: ${message}`);
  process.exit(2);
}

function notice(message) {
  console.error(`adlc-rails-guard: ${message}`);
}

function parseJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') throw err;
    fail(`malformed JSON in ${path}: ${err.message}`);
  }
}

function readRequiredJson(path) {
  try {
    return parseJson(path);
  } catch (err) {
    if (err?.code === 'ENOENT') fail(`file not found: ${path}`);
    throw err;
  }
}


// The rail/scope glob matcher is a GENERATED verbatim copy of
// packages/core/lib/glob.mjs: this file is installed without node_modules, so it
// cannot import @adlc/core, and a hand-kept copy is what drifted before.
import { globMatch } from './generated-glob-match.mjs';

function loadTickets(path) {
  const data = readRequiredJson(path);
  if (!Array.isArray(data.tickets)) fail(`${path} must contain a tickets array`);
  const ids = new Set();
  const errors = [];
  for (const ticket of data.tickets) {
    if (!ticket || typeof ticket !== 'object') {
      errors.push('ticket is not an object');
      continue;
    }
    if (!ticket.id || typeof ticket.id !== 'string') errors.push('ticket missing string id');
    if (!ticket.title || typeof ticket.title !== 'string') errors.push(`${ticket.id ?? '?'}: missing string title`);
    if (ticket.rails !== undefined && !Array.isArray(ticket.rails)) errors.push(`${ticket.id}: rails must be an array`);
    if (ticket.id) {
      if (ids.has(ticket.id)) errors.push(`duplicate ticket id: ${ticket.id}`);
      ids.add(ticket.id);
    }
  }
  if (errors.length > 0) fail(`ticket file errors: ${errors.join('; ')}`);
  return data.tickets;
}

function collectPaths(value, out = new Set()) {
  if (typeof value === 'string') {
    collectPatchPaths(value, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (['path', 'filePath', 'file_path', 'target', 'targetPath', 'target_path'].includes(key) && typeof child === 'string') {
      out.add(child);
    } else if (['paths', 'filePaths', 'file_paths'].includes(key) && Array.isArray(child)) {
      for (const item of child) {
        if (typeof item === 'string') out.add(item);
        else collectPaths(item, out);
      }
    } else if (['command', 'cmd', 'patch', 'input'].includes(key) && typeof child === 'string') {
      collectPatchPaths(child, out);
    } else {
      collectPaths(child, out);
    }
  }
  return out;
}

function collectCommandText(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectCommandText(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (['command', 'cmd', 'input', 'script', 'chars'].includes(key) && typeof child === 'string') {
      out.push(child);
    } else {
      collectCommandText(child, out);
    }
  }
  return out;
}

function collectPatchPaths(text, out) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    for (const prefix of ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: ']) {
      if (line.startsWith(prefix)) {
        const path = line.slice(prefix.length).trim();
        if (path) out.add(path);
      }
    }
  }
}

function shellTokens(text) {
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s;&|<>]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function looksPathLike(value) {
  return (
    !value.startsWith('-') &&
    !value.includes('=') &&
    /^[A-Za-z0-9_./@+-]+$/.test(value) &&
    (/[/\\]/.test(value) || /\.[A-Za-z0-9]+$/.test(value))
  );
}

function looksBarePathLike(value) {
  return !value.startsWith('-') && !value.includes('=') && /^[A-Za-z0-9_./@+-]+$/.test(value);
}

function keyValuePath(value) {
  const match = value.match(/^(?:--?[A-Za-z0-9_-]+|[A-Za-z_][A-Za-z0-9_-]*)=(.+)$/);
  if (!match) return null;
  const path = match[1].replace(/^["']|["']$/g, '');
  return looksPathLike(path) ? path : null;
}

function hasUnquotedFileRedirect(text) {
  const s = String(text ?? '');
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote === null && c === '\\') { i += 1; continue; }
    if (quote === null && (c === "'" || c === '"')) { quote = c; continue; }
    if (quote !== null) {
      if (quote === '"' && c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '>') {
      let j = s[i + 1] === '>' ? i + 2 : i + 1;
      while (s[j] === ' ' || s[j] === '\t') j += 1;
      if (s[j] !== undefined && s[j] !== '&') return true;
    }
  }
  return false;
}

function shellHasMutation(text) {
  return (
    /(^|[\s;&|])(?:>>?|[0-9]>>?|[0-9]>)\s*\S+/.test(text) ||
    hasUnquotedFileRedirect(text) ||
    /\b(?:tee|touch|rm|mv|cp|install|dd|truncate|rsync|chmod|chown|ln|mkdir|mktemp|shred)\b/.test(text) ||
    /\bcurl\b[^;&|]*(?:\s-[oO]\b|\s--output\b|\s--remote-name\b)/.test(text) ||
    /\bwget\b[^;&|]*(?:\s-O\b|\s--output-document\b)/.test(text) ||
    /\bgit\s+(?:apply|am|checkout|restore|reset|clean|merge|rebase|cherry-pick|stash|commit)\b/.test(text) ||
    /\b(?:patch|tar|unzip)\b/.test(text) ||
    /\bfind\b[^;&|]*(?:-delete|-exec(?:dir)?\b|-ok(?:dir)?\b)/.test(text) ||
    /\b(?:sed|perl)\s+[^;&|]*-(?:i|p?i)\b/.test(text) ||
    /\bsed\b[^;&|]*(?:"[^"\n]*\bw\s+\S+[^"\n]*"|'[^'\n]*\bw\s+\S+[^'\n]*')/.test(text) ||
    /\bawk\b[^;&|]*(?:\s-i(?:\s|=)|\s--in-place\b)/.test(text) ||
    /\b(?:node|python3?|ruby)\b[^;&|]*(?:writeFile|appendFile|rmSync|renameSync|copyFile|truncateSync|mkdirSync|write_text|write_bytes)/.test(text) ||
    /\bopen\s*\([^)]*,\s*['"][^'"]*[wax+][^'"]*['"]/.test(text) ||
    /\bFile\.(?:write|open)\b/.test(text)
  );
}

function shellHasOpaqueMutation(text) {
  return (
    /\bgit\s+(?:apply|am|checkout|restore|reset|clean|merge|rebase|cherry-pick|stash|commit)\b/.test(text) ||
    /\b(?:patch|tar|unzip)\b/.test(text)
  );
}

/**
 * Split a shell payload on UNQUOTED separators (`;` `&` `|` `&&` `||` newline).
 *
 * Splitting with a plain regex (the pre-#216 behaviour) ignores quoting, so a
 * read-only command carrying a quoted separator was shredded into fragments that
 * could not match the allowlist:
 *
 *   rg -n '"(prepack|prepare|postpack)"' package.json
 *     -> ["rg -n '\"(prepack", "prepare", "postpack)\"' package.json"]
 *
 * Only the first fragment starts with an allowlisted command, so `.every(...)`
 * failed and the hook denied a purely read-only search. That blocked a mandatory
 * cross-model review.
 *
 * Returns `null` when the payload cannot be parsed confidently (an unterminated
 * quote), so the caller can FAIL CLOSED. That direction matters: the allowlist
 * only inspects each segment's PREFIX, so a separator we fail to split on is
 * fail-open — `cat x | rm -rf y` left unsplit still starts with `cat` and would
 * be allowed. Missing a real separator is the dangerous error, never the
 * reverse.
 */
function splitOnUnquotedSeparators(text) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === null && c === '\\') {
      current += c + (text[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (quote === null && (c === "'" || c === '"')) {
      quote = c;
      current += c;
      continue;
    }
    if (quote !== null) {
      // Inside double quotes a backslash still escapes; inside single quotes
      // everything is literal, so only consume an escape for the former.
      if (quote === '"' && c === '\\') {
        current += c + (text[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if ((c === '&' && text[i + 1] === '&') || (c === '|' && text[i + 1] === '|')) {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (quote !== null) return null; // unterminated quote — refuse to guess
  segments.push(current);
  return segments;
}

function shellIsPositivelyReadOnly(text) {
  const normalized = String(text ?? '').trim();
  if (normalized === '') return true;
  const readOnlyPrefix = /^(?:git\s+(?:status|diff|show|log|rev-parse|branch|ls-files)\b|pwd\b|ls\b|rg\b|grep\b|cat\b|sed\s+-n\b|head\b|tail\b|wc\b|nl\b|node\s+(?:--check|--test)\b|npm\s+(?:test|run\s+test)\b|adlc\s+(?:hollow-test|rails-guard|flail-detector|preflight|run\s+p[34])\b)/;
  const segments = splitOnUnquotedSeparators(normalized);
  if (segments === null) return false; // unparseable → not positively read-only
  return segments
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .every((segment) => readOnlyPrefix.test(segment));
}

function shellHasWriteOption(text) {
  return /\s--(?:output|output-file|test-reporter-destination|reporter-destination)(?:=|\s+)\S+/.test(text);
}

function firstShellWorkdir(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstShellWorkdir(item);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (['workdir', 'cwd', 'workingDirectory', 'working_directory'].includes(key) && typeof child === 'string') {
      return child;
    }
    const found = firstShellWorkdir(child);
    if (found) return found;
  }
  return null;
}

function shellChangesCwd(text) {
  return /(^|[\s;&|()])(?:cd|pushd|popd)\b/.test(text);
}

function shellHasExpansion(text) {
  return /(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\(|`|[*?]|\[[^\]\n]+\])/.test(text);
}

function collectShellPaths(text, out) {
  const redirectPattern = /(?:[0-9])?>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
  let redirect;
  while ((redirect = redirectPattern.exec(text)) !== null) {
    out.add(redirect[1] ?? redirect[2] ?? redirect[3]);
  }

  const quotedPathPattern = /["'`]([^"'`\n]*[/\\][^"'`\n]*)["'`]/g;
  let quoted;
  while ((quoted = quotedPathPattern.exec(text)) !== null) {
    const value = quoted[1];
    if (looksPathLike(value)) out.add(value);
  }

  const sedWritePattern = /\bsed\b[^;&|]*(?:"[^"\n]*\bw\s+([A-Za-z0-9_./@+-]+)[^"\n]*"|'[^'\n]*\bw\s+([A-Za-z0-9_./@+-]+)[^'\n]*')/g;
  let sedWrite;
  while ((sedWrite = sedWritePattern.exec(text)) !== null) {
    const value = sedWrite[1] ?? sedWrite[2];
    if (value && looksPathLike(value)) out.add(value);
  }

  for (const token of shellTokens(text)) {
    const path = keyValuePath(token);
    if (path) out.add(path);
    else if (looksPathLike(token)) out.add(token);
    else if (looksBarePathLike(token)) out.add(token);
  }
}

function railMatchesPath(rail, path) {
  if (path === '' || path === '.') return true;
  if (path === '..' || path.startsWith('../')) return true;
  if (globMatch(rail, path)) return true;
  if (rail.endsWith('/**')) return path === rail.slice(0, -3);
  return false;
}

function toolName(payload) {
  return payload.tool_name ?? payload.toolName ?? payload.tool ?? payload.name ?? payload.recipient_name ?? '';
}

function isShellToolName(name) {
  return /(^|\.)(bash|shell|exec|exec_command|run_command|write_stdin)$/i.test(String(name));
}

function collectShellInvocations(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectShellInvocations(item, out);
    return out;
  }
  if (isShellToolName(toolName(value))) {
    const name = String(toolName(value));
    const workdir = firstShellWorkdir(value);
    for (const commandText of collectCommandText(value)) {
      out.push({ commandText, workdir, name });
    }
    return out;
  }
  for (const child of Object.values(value)) collectShellInvocations(child, out);
  return out;
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Resolve the active ticket id through the canonical pointer contract
 * (generated-active-ticket.mjs, generated from packages/tickets/lib/pointer.mjs).
 * This was a hand-rolled copy; it accepted `ticketId` while the claude-code and
 * build-gate copies did not, so the same pointer enforced here and silently
 * disabled enforcement there. Any denial fails closed.
 */
function resolveActiveTicketId() {
  const resolved = resolveActiveTicketIdCanonical({ root: process.cwd(), env: process.env });
  if (!resolved.ok) fail(resolved.message);
  return { id: resolved.value?.id ?? undefined };
}

function safeRealpath(fp) {
  try {
    return realpathSync(fp);
  } catch {
    const parent = dirname(fp);
    if (parent === fp) return fp;
    try {
      return resolve(safeRealpath(parent), basename(fp));
    } catch {
      return fp;
    }
  }
}

function normalizePath(path, baseCwd = process.cwd()) {
  const normalized = path.replaceAll('\\', '/');
  const absolute = safeRealpath(isAbsolute(normalized) ? normalized : resolve(baseCwd, normalized));
  const projectRoot = safeRealpath(process.cwd());
  const projectRelative = relative(projectRoot, absolute).replaceAll('\\', '/');
  return projectRelative.startsWith('..') ? normalized : projectRelative;
}

// Payload parsing happens FIRST, before ANY ticket/pointer/rails resolution
// below — see the Recovery/Inspection Exception block immediately following
// for why. It must not be moved back down past that block.
let payload = {};
const raw = await stdinText();
if (raw.trim()) {
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    fail(`malformed hook payload JSON: ${err.message}`);
  }
}

// Recovery Exception & Inspection Bash Exception (context-rot-threshold-
// calibration spec §1.3), applied to THIS gate too — evaluated before
// EVERYTHING else in this file, including active-ticket resolution and
// ticket-store loading, not just the shell-classification logic further
// down. This gate runs FIRST in hooks.json's PreToolUse pipeline
// (rails-guard, then build-gate, then handoff-gate) for every shell tool
// identity. Two independent lockout causes were found and fixed here in
// sequence: (1) the shell classifier has no concept of the recovery CLI's
// argument shape — a bypass/unlock/repair/write/resume invocation is
// neither a recognized read-only command nor a recognized path-transparent
// mutation, so it was denied by that classifier; (2) even after this check
// was added AFTER active-ticket/store resolution, a corrupt pointer, an
// unreadable/malformed ticket store, an unknown ticket id, or a hash
// mismatch would `fail()` during THAT resolution — before this check ever
// ran — reproducing the identical total-lockout failure through the
// gate's OWN state-validation path instead of its shell classifier. Moving
// this block to run on nothing but the raw stdin payload closes both.
// Reuses the same trusted, package-independent matcher as the other two
// gates (imported from the sibling adlc-handoff-gate.mjs — a plugin-owned,
// trusted file, never the dynamically-loaded project-resolved package), so
// all three gates share one definition of what an authorized
// recovery/inspection command is.
{
  const name = toolNameOf(payload);
  if (isRecoveryEligibleToolName(name)) {
    const candidates = collectCommandText(payload).filter((c) => typeof c === 'string' && c.length > 0);
    if (candidates.length === 1) {
      const [candidateCommand] = candidates;
      if (isBareInspectionPwd(candidateCommand)) process.exit(0); // unconditional allow, no audit record
      // Resolution walks the PROJECT's own node_modules, the same way
      // loadContextHandoff does elsewhere — this does not import/execute
      // the package, only locates it, but a repository that ships its own
      // @adlc/context-handoff controls what path this resolves to (see
      // adlc-handoff-gate.mjs's identical comment for the full residual).
      const entry = resolveContextHandoffEntry({ projectRoot: process.cwd() });
      const trustedRecoveryCliPath = entry ? join(dirname(dirname(entry)), 'bin', 'handoff.mjs') : null;
      if (trustedRecoveryCliPath) {
        const sessionId = resolveHandoffSessionIdLocal({
          candidates: [payload.session_id, payload.sessionId],
          transcriptPath: payload.transcript_path,
        });
        const recoveryMatch = matchRecoveryCommand(candidateCommand, {
          interpreterPath: process.execPath,
          scriptPath: trustedRecoveryCliPath,
          sessionId,
        });
        if (recoveryMatch.matched) {
          recordRecoveryUnderBand({
            subcommand: recoveryMatch.subcommand,
            sessionId,
            trustedEnv: process.env,
            adlcBinPath: resolveTrustedBinary('adlc', process.env.PATH),
          });
          process.exit(0); // allow — never gated on the audit record above succeeding
        }
      }
    }
  }
}

const explicitEnforcement = process.env.ADLC_P4_ENFORCEMENT;
if (explicitEnforcement === '0') {
  notice('P4 rail hook explicitly disabled');
  process.exit(0);
}
if (explicitEnforcement !== undefined && explicitEnforcement !== '1') {
  fail('ADLC_P4_ENFORCEMENT must be 0, 1, or unset');
}

const activeTicket = resolveActiveTicketId();
const ticketId = activeTicket.id;
if (!ticketId) {
  if (explicitEnforcement === '1') fail('ADLC_P4_ENFORCEMENT=1 but no active ticket source resolved');
  notice('P4 rail hook inactive: no current ticket selected');
  process.exit(0);
}

let snapshot;
try { snapshot = loadTicketStoreReadOnly({ root: process.cwd(), env: process.env }); }
catch (error) { fail(`ticket store failed to load: ${error.message}`); }
const tickets = snapshot.tickets;

const ticket = tickets.find((t) => t.id === ticketId);
if (!ticket) fail(`unknown active ticket: ${ticketId}`);
// Re-resolve against the loaded store so the pinned ticketHash is verified by the
// same contract every other reader uses. allowLegacyPointer keeps the documented
// 1.x bridge: a pointer that pins no hash still resolves (this harness never
// required one), but a hash that IS present is always verified.
const activeAgainstStore = resolveActiveTicketAgainst(snapshot, { root: process.cwd(), env: process.env, allowLegacyPointer: true });
if (!activeAgainstStore.ok) fail(activeAgainstStore.message);
const ticketsPath = process.env.ADLC_TICKET_STORE ?? process.env.ADLC_TICKETS ?? (snapshot.backend === 'directory' ? '.adlc/tickets' : '.adlc/tickets.json');
const declaredRails = ticket.rails ?? [];
if (explicitEnforcement !== '1' && ticket.completed === true) {
  notice(`P4 rail hook inactive: ticket ${ticketId} is completed`);
  process.exit(0);
}
if (declaredRails.length === 0) {
  if (explicitEnforcement === '1') fail(`ticket ${ticketId} has no rails`);
  notice(`P4 rail hook inactive: ticket ${ticketId} has no rails`);
  process.exit(0);
}
const rails = [...declaredRails, snapshot.backend === 'directory' ? '.adlc/tickets/**' : normalizePath(ticketsPath), '.adlc/current-ticket.json'];

const rawPaths = collectPaths(payload);
const paths = Array.from(rawPaths).map((path) => normalizePath(path));
const shellInvocations = collectShellInvocations(payload);
const shellTool = shellInvocations.length > 0;
let shellMutating = false;
let cwdChangingShellMutation = false;
let expandingShellMutation = false;
if (shellTool) {
  for (const { commandText, workdir, name } of shellInvocations) {
    if (/(^|\.)write_stdin$/i.test(name)) {
      if (commandText.trim() === '') continue;
      fail('interactive shell stdin payload cannot be verified during active P4');
    }
    const commandMutating = shellHasMutation(commandText);
    if (!commandMutating && shellIsPositivelyReadOnly(commandText)) {
      if (shellHasWriteOption(commandText)) {
        fail('read-only shell payload uses an output option; use a structured edit tool or literal path-transparent mutation');
      }
      continue;
    }

    if (!commandMutating) {
      fail('shell payload is neither a known read-only command nor a path-transparent mutation');
    }
    if (shellHasOpaqueMutation(commandText)) {
      fail('mutating shell payload uses an opaque command; use a structured edit tool or literal path-transparent mutation');
    }
    shellMutating = true;
    if (shellChangesCwd(commandText)) cwdChangingShellMutation = true;
    if (shellHasExpansion(commandText)) expandingShellMutation = true;
    const commandPaths = new Set();
    collectShellPaths(commandText, commandPaths);
    if (commandPaths.size === 0) {
      fail('mutating shell payload did not include literal editable paths');
    }
    const shellBaseCwd = workdir ? resolve(process.cwd(), workdir) : process.cwd();
    for (const path of commandPaths) paths.push(normalizePath(path, shellBaseCwd));
  }
}

if (cwdChangingShellMutation) {
  fail('mutating shell payload changes cwd; use a structured edit tool or project-relative shell target paths');
}
if (expandingShellMutation) {
  fail('mutating shell payload uses shell expansion; use a structured edit tool or literal project-relative shell target paths');
}

if (paths.length === 0) {
  if (shellTool && !shellMutating && shellInvocations.length > 0 && shellInvocations.every(({ commandText }) => shellIsPositivelyReadOnly(commandText))) {
    notice('shell command has no editable rail targets');
    process.exit(0);
  }
  fail(shellTool ? 'shell payload did not include literal editable paths or a known read-only command' : 'active hook payload did not include any editable paths');
}
const blocked = paths.filter((path) => rails.some((rail) => railMatchesPath(rail, path)));
if (blocked.length > 0) fail(`blocked rail edit for ${ticketId}: ${blocked.join(', ')}`);

process.exit(0);
