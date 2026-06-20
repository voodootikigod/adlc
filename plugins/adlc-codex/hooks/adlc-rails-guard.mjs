#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

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

function readOptionalJson(path) {
  try {
    return parseJson(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined;
    throw err;
  }
}

function globMatch(pattern, path) {
  const regex = new RegExp(
    '^' +
      pattern
        .split(/(\*\*\/|\*\*|\*)/)
        .map((part) => {
          if (part === '**/') return '(?:.*/)?';
          if (part === '**') return '.*';
          if (part === '*') return '[^/]*';
          return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('') +
      '$'
  );
  return regex.test(path);
}

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
    if (['command', 'cmd', 'input', 'script'].includes(key) && typeof child === 'string') {
      out.push(child);
    } else {
      collectCommandText(child, out);
    }
  }
  return out;
}

function collectPatchPaths(text, out) {
  for (const line of text.split(/\r?\n/)) {
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

function keyValuePath(value) {
  const match = value.match(/^(?:--?[A-Za-z0-9_-]+|[A-Za-z_][A-Za-z0-9_-]*)=(.+)$/);
  if (!match) return null;
  const path = match[1].replace(/^["']|["']$/g, '');
  return looksPathLike(path) ? path : null;
}

function shellHasMutation(text) {
  return (
    /(^|[\s;&|])(?:>>?|[0-9]>>?|[0-9]>)\s*\S+/.test(text) ||
    /\b(?:tee|touch|rm|mv|cp|install|dd|truncate|rsync)\b/.test(text) ||
    /\bfind\b[^;&|]*(?:-delete|-exec(?:dir)?\b|-ok(?:dir)?\b)/.test(text) ||
    /\b(?:sed|perl)\s+[^;&|]*-(?:i|p?i)\b/.test(text) ||
    /\bsed\b[^;&|]*(?:"[^"\n]*\bw\s+\S+[^"\n]*"|'[^'\n]*\bw\s+\S+[^'\n]*')/.test(text) ||
    /\bawk\s+[^;&|]*\s-i(?:\s|=)/.test(text) ||
    /\b(?:node|python3?|ruby)\b[^;&|]*(?:writeFile|appendFile|rmSync|renameSync|copyFile|truncateSync|mkdirSync|write_text|write_bytes)/.test(text) ||
    /\bopen\s*\([^)]*,\s*['"][^'"]*[wax+][^'"]*['"]/.test(text) ||
    /\bFile\.(?:write|open)\b/.test(text)
  );
}

function shellIsPositivelyReadOnly(text) {
  const normalized = text.trim();
  return (
    normalized === '' ||
    /^(?:git\s+(?:status|diff|show|log|rev-parse|branch|ls-files)\b|pwd\b|ls\b|rg\b|grep\b|cat\b|sed\s+-n\b|head\b|tail\b|wc\b|nl\b|node\s+(?:--check|--test)\b|npm\s+(?:test|run\s+test)\b|adlc\s+(?:hollow-test|rails-guard|flail-detector|preflight|run\s+p[34])\b)/.test(normalized)
  );
}

function shellChangesCwd(text) {
  return /(^|[\s;&|()])(?:cd|pushd|popd)\b/.test(text);
}

function shellHasExpansion(text) {
  return /(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\(|`|[*?]|\[[^\]\n]+\])/.test(text);
}

function collectShellPaths(text, out) {
  const redirectPattern = /(?:^|[\s])(?:>>?|[0-9]>>?|[0-9]>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
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
  }
}

function toolName(payload) {
  return payload.tool_name ?? payload.toolName ?? payload.tool ?? payload.name ?? '';
}

function isShellToolName(name) {
  return /(^|\.)(bash|shell|exec|exec_command|run_command)$/i.test(String(name));
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function resolveActiveTicketId() {
  const envTicket = process.env.ADLC_TICKET;
  let fileTicket;
  const current = readOptionalJson('.adlc/current-ticket.json');
  if (current) {
    fileTicket = current.id ?? current.ticket ?? current.ticketId;
  }

  if (envTicket && fileTicket && envTicket !== fileTicket) {
    fail(`ADLC_TICKET (${envTicket}) conflicts with .adlc/current-ticket.json (${fileTicket})`);
  }
  return envTicket ?? fileTicket;
}

if (process.env.ADLC_P4_ENFORCEMENT !== '1') {
  notice('P4 rail hook inactive');
  process.exit(0);
}

const ticketId = resolveActiveTicketId();
if (!ticketId) fail('ADLC_P4_ENFORCEMENT=1 but no active ticket source resolved');

const tickets = loadTickets(process.env.ADLC_TICKETS ?? '.adlc/tickets.json');

const ticket = tickets.find((t) => t.id === ticketId);
if (!ticket) fail(`unknown active ticket: ${ticketId}`);
const rails = ticket.rails ?? [];
if (rails.length === 0) fail(`ticket ${ticketId} has no rails`);

let payload = {};
const raw = await stdinText();
if (raw.trim()) {
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    fail(`malformed hook payload JSON: ${err.message}`);
  }
}

function normalizePath(path) {
  const normalized = path.replaceAll('\\', '/');
  const absolute = isAbsolute(normalized) ? normalized : resolve(process.cwd(), normalized);
  const projectRelative = relative(process.cwd(), absolute).replaceAll('\\', '/');
  return projectRelative.startsWith('..') ? normalized : projectRelative;
}

const rawPaths = collectPaths(payload);
const shellTool = isShellToolName(toolName(payload));
let shellMutating = false;
let cwdChangingShellMutation = false;
let expandingShellMutation = false;
const commandTexts = shellTool ? collectCommandText(payload) : [];
if (shellTool) {
  for (const commandText of commandTexts) {
    if (shellHasMutation(commandText)) shellMutating = true;
    if (shellHasMutation(commandText) && shellChangesCwd(commandText)) cwdChangingShellMutation = true;
    if (shellHasMutation(commandText) && shellHasExpansion(commandText)) expandingShellMutation = true;
    collectShellPaths(commandText, rawPaths);
  }
}

if (cwdChangingShellMutation) {
  fail('mutating shell payload changes cwd; use a structured edit tool or project-relative shell target paths');
}
if (expandingShellMutation) {
  fail('mutating shell payload uses shell expansion; use a structured edit tool or literal project-relative shell target paths');
}

const paths = Array.from(rawPaths).map(normalizePath);
if (paths.length === 0) {
  if (shellTool && !shellMutating && commandTexts.length > 0 && commandTexts.every(shellIsPositivelyReadOnly)) {
    notice('shell command has no editable rail targets');
    process.exit(0);
  }
  fail(shellTool ? 'shell payload did not include literal editable paths or a known read-only command' : 'active hook payload did not include any editable paths');
}
const blocked = paths.filter((path) => rails.some((rail) => globMatch(rail, path)));
if (blocked.length > 0) fail(`blocked rail edit for ${ticketId}: ${blocked.join(', ')}`);

process.exit(0);
