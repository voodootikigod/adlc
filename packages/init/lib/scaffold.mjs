import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ADLC_GITIGNORE_LINES } from './gitignore-defaults.mjs';

function configForHarness(harness) {
  const harnesses = harness === 'cursor'
    ? { cursor: { railEnforcement: 'auto' } }
    : { codex: { railEnforcement: 'auto' } };
  // securityMode is required for config-integrity once a config is committed;
  // acknowledgedNewRailBypass must NOT be self-set here — that is a protected-base
  // ceremony field. Keep generated configs local until that ceremony runs.
  return `${JSON.stringify({ version: 1, securityMode: 'unsigned-fallback', harnesses }, null, 2)}\n`;
}

const WHOLE_ADLC_IGNORES = new Set(['.adlc', '.adlc/', '/.adlc', '/.adlc/']);

export const CODEX_AGENT_TEMPLATES = Object.freeze({
  'adlc-explorer.toml': `name = "adlc-explorer"
description = "Read-only ADLC evidence gatherer for tickets, rails, manifests, and implementation paths."
sandbox_mode = "read-only"
developer_instructions = """
Trace the active ADLC ticket, its acceptance criteria, rails, and the real execution path.
Return concise evidence with file and symbol references. Do not edit files or declare gates passed.
"""
`,
  'adlc-reviewer.toml': `name = "adlc-reviewer"
description = "Fresh-context P5 reviewer focused on correctness, security, contracts, and test strength."
sandbox_mode = "read-only"
model_reasoning_effort = "high"
developer_instructions = """
Review the target diff against the active ADLC ticket and frozen rails.
Prioritize correctness, security, contract drift, rollback risk, and hollow tests.
Return reproducible findings and an explicit SHIP or NO-SHIP verdict. Never record evidence yourself.
"""
`,
  'adlc-verifier.toml': `name = "adlc-verifier"
description = "Independent verifier that reproduces review findings and checks ADLC gate evidence."
sandbox_mode = "read-only"
model_reasoning_effort = "high"
developer_instructions = """
Independently reproduce claimed defects and gate results from repository evidence.
Reject stale, non-reproducible, or revision-unbound findings. Report exactly what was verified.
"""
`,
});

function record(result, kind, path) {
  result[kind].push(path);
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function canonicalTarget(value) {
  const requested = resolve(value);
  let ancestor = requested;
  while (lstatIfPresent(ancestor) === null) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve scaffold root: ${requested}`);
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), relative(ancestor, requested));
}

function rejectSymlinkComponents(root, relativePath) {
  let current = root;
  for (const part of relativePath.split('/')) {
    current = join(current, part);
    if (lstatIfPresent(current)?.isSymbolicLink()) {
      throw new Error(`refusing to follow symlink while initializing: ${relativePath}`);
    }
  }
}

function writeFileNoFollow(path, content, { exclusive = false } = {}) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = exclusive
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow
    : constants.O_WRONLY | constants.O_TRUNC | noFollow;
  const descriptor = openSync(path, flags, 0o666);
  try {
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}

function writeMissing(root, relativePath, content, result) {
  const path = join(root, relativePath);
  rejectSymlinkComponents(root, relativePath);
  if (lstatIfPresent(path) !== null) {
    record(result, 'unchanged', relativePath);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  rejectSymlinkComponents(root, relativePath);
  writeFileNoFollow(path, content, { exclusive: true });
  record(result, 'created', relativePath);
}

function ensureGitignore(root, result) {
  const relativePath = '.gitignore';
  const path = join(root, relativePath);
  rejectSymlinkComponents(root, relativePath);
  const existed = lstatIfPresent(path) !== null;
  const original = existed ? readFileSync(path, 'utf8') : '';
  const normalizedLines = original.split(/\r?\n/).map((line) => (
    WHOLE_ADLC_IGNORES.has(line.trim()) ? '.adlc/*' : line
  ));
  const normalized = normalizedLines.join('\n');
  const present = new Set(normalizedLines);
  const missing = ADLC_GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length === 0 && normalized === original) {
    record(result, 'unchanged', relativePath);
    return;
  }
  const prefix = normalized === '' || normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  const separator = prefix !== '' && !prefix.endsWith('\n\n') ? '\n' : '';
  rejectSymlinkComponents(root, relativePath);
  writeFileNoFollow(path, `${prefix}${separator}# ADLC runtime\n${missing.join('\n')}\n`, {
    exclusive: !existed,
  });
  record(result, existed ? 'updated' : 'created', relativePath);
}

export function scaffold({ root = '.', codexAgents = true, harness = null } = {}) {
  const target = canonicalTarget(root);
  const result = { root: target, created: [], updated: [], unchanged: [], warnings: [] };
  if (harness === 'cursor') codexAgents = false;

  const destinations = ['.adlc/specs', '.adlc/config.json', '.gitignore'];
  if (codexAgents) {
    destinations.push(...Object.keys(CODEX_AGENT_TEMPLATES).map((name) => `.codex/agents/${name}`));
  }
  for (const destination of destinations) rejectSymlinkComponents(target, destination);

  rejectSymlinkComponents(target, '.adlc/specs');
  mkdirSync(join(target, '.adlc/specs'), { recursive: true });
  rejectSymlinkComponents(target, '.adlc/specs');
  writeMissing(target, '.adlc/config.json', configForHarness(harness), result);
  ensureGitignore(target, result);

  if (codexAgents) {
    for (const [name, content] of Object.entries(CODEX_AGENT_TEMPLATES)) {
      writeMissing(target, `.codex/agents/${name}`, content, result);
    }
  }

  return result;
}
