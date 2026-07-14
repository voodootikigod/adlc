#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const PLUGIN_VERSION = JSON.parse(readFileSync(resolve(PLUGIN_ROOT, 'package.json'), 'utf8')).version;
const EXECUTION_TIMEOUT_MS = Math.min(300_000, Math.max(1, Number(process.env.ADLC_MCP_TIMEOUT_MS) || 120_000));

const ALLOWED_GATES = new Set([
  'coldstart',
  'flail-detector',
  'gate-manifest',
  'merge-forecast',
  'model-router',
  'parallax',
  'premortem',
  'rails-guard',
  'skill-rot',
  'spec-lint',
]);

const PROMPT_ONLY_GATES = new Set(['coldstart', 'parallax', 'premortem']);

const FORBIDDEN_FLAGS = new Set([
  '--append',
  '--attest-unsigned',
  '--authorize',
  '--fix',
  '--llm',
  '--model',
  '--out',
  '--output',
  '--provider',
  '--providers',
  '--record',
  '--record-verdict',
  '--review-cmd',
  '--stamp',
  '--test-cmd',
  '--unsafe-no-sandbox',
  '--write',
  '--yes',
]);

export const TOOLS = [
  {
    name: 'adlc_gate',
    description: 'Run one allowlisted ADLC check in the current repository. Writer and nested-command arguments are rejected.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['gate'],
      properties: {
        gate: { type: 'string', enum: [...ALLOWED_GATES].sort() },
        args: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 500 } },
      },
    },
  },
  {
    name: 'adlc_prosecute',
    description: 'Record revision- and ticket-bound P5 review evidence from an existing prosecution input file.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['input', 'ticket'],
      properties: {
        input: { type: 'string', minLength: 1 },
        ticket: { type: 'string', minLength: 1, maxLength: 128 },
        revision: { type: 'string', minLength: 1, maxLength: 256 },
        dir: { type: 'string', minLength: 1, default: '.adlc' },
      },
    },
  },
];

function invalid(message) {
  const error = new Error(message);
  error.code = -32602;
  return error;
}

function assertString(value, label, maxLength = 500) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw invalid(`${label} must be a non-empty string no longer than ${maxLength} characters`);
  if (/[\0\r\n]/.test(value)) throw invalid(`${label} contains a control character`);
  return value;
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw invalid(`cannot safely inspect path: ${path}`);
  }
}

function resolvedThroughExistingAncestor(target, label) {
  let ancestor = target;
  while (lstatIfPresent(ancestor) === null) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  try {
    return resolve(realpathSync(ancestor), relative(ancestor, target));
  } catch {
    throw invalid(`${label} contains an unresolved symlink`);
  }
}

function assertContainedPath(root, target, label) {
  const canonicalRoot = realpathSync(root);
  const canonicalTarget = resolvedThroughExistingAncestor(target, label);
  const rel = relative(canonicalRoot, canonicalTarget);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw invalid(`${label} escapes the repository`);
}

function safeRelativePath(value, label) {
  const path = assertString(value, label);
  if (isAbsolute(path)) throw invalid(`${label} must be repository-relative`);
  const root = resolve(process.cwd());
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('../')) throw invalid(`${label} escapes the repository`);
  assertContainedPath(root, target, label);
  return path;
}

function validateGateArgs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw invalid('args must be an array with at most 32 entries');
  return value.map((arg, index) => {
    const checked = assertString(arg, `args[${index}]`);
    const flag = checked.split('=', 1)[0];
    if (FORBIDDEN_FLAGS.has(flag)) throw invalid(`mutating flag is not allowed through adlc_gate: ${flag}`);
    const candidate = checked.startsWith('--') && checked.includes('=')
      ? checked.slice(checked.indexOf('=') + 1)
      : checked;
    if (
      isAbsolute(candidate)
      || candidate === '..'
      || candidate.startsWith('../')
      || candidate.includes('/../')
      || candidate.endsWith('/..')
      || candidate.startsWith('..\\')
      || candidate.includes('\\..\\')
      || candidate.endsWith('\\..')
    ) throw invalid(`argument escapes the repository: args[${index}]`);
    const target = resolve(process.cwd(), candidate);
    assertContainedPath(process.cwd(), target, `args[${index}]`);
    return checked;
  });
}

function validateGateInvocation(gate, args) {
  if (gate === 'gate-manifest' && !['show', 'verify'].includes(args[0])) {
    throw invalid('adlc_gate only permits gate-manifest show or verify');
  }
  if (PROMPT_ONLY_GATES.has(gate) && !args.includes('--prompt-only')) {
    throw invalid(`adlc_gate requires --prompt-only for ${gate}`);
  }
}

function command() {
  if (process.env.ADLC_CLI_BIN) return { file: process.execPath, prefix: [resolve(process.env.ADLC_CLI_BIN)] };
  const bundled = resolve(PLUGIN_ROOT, 'node_modules/@adlc/cli/bin/adlc.mjs');
  if (existsSync(bundled)) return { file: process.execPath, prefix: [bundled] };
  return { file: 'adlc', prefix: [] };
}

function execute(args) {
  const target = command();
  try {
    const stdout = execFileSync(target.file, [...target.prefix, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: EXECUTION_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    return {
      ok: false,
      exitCode: Number.isInteger(error.status) ? error.status : 1,
      stdout: error.stdout?.toString().trim() ?? '',
      stderr: error.stderr?.toString().trim() ?? error.message,
    };
  }
}

export function callTool(name, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('tool arguments must be an object');
  let args;
  if (name === 'adlc_gate') {
    const gate = assertString(input.gate, 'gate', 128);
    if (!ALLOWED_GATES.has(gate)) throw invalid(`gate is not allowlisted: ${gate}`);
    const gateArgs = validateGateArgs(input.args);
    validateGateInvocation(gate, gateArgs);
    args = [gate, ...gateArgs];
  } else if (name === 'adlc_prosecute') {
    const evidence = safeRelativePath(input.input, 'input');
    const ticket = assertString(input.ticket, 'ticket', 128);
    const dir = safeRelativePath(input.dir ?? '.adlc', 'dir');
    args = ['prosecute', '--input', evidence, '--ticket', ticket, '--dir', dir, '--json'];
    if (input.revision !== undefined) args.push('--revision', assertString(input.revision, 'revision', 256));
  } else throw invalid(`unknown tool: ${name}`);

  const result = execute(args);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError: !result.ok,
  };
}

export function handleRequest(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') throw invalid('invalid JSON-RPC request');
  if (request.method === 'initialize') {
    return {
      protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'adlc-codex', version: PLUGIN_VERSION },
    };
  }
  if (request.method === 'tools/list') return { tools: TOOLS };
  if (request.method === 'tools/call') return callTool(request.params?.name, request.params?.arguments ?? {});
  if (request.method.startsWith('notifications/')) return undefined;
  const error = new Error(`method not found: ${request.method}`);
  error.code = -32601;
  throw error;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
      const result = handleRequest(request);
      if (request.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      if (request?.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: error.code ?? -32603, message: error.message } });
    }
  });
}
