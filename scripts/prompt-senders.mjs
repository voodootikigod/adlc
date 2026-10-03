// prompt-senders.mjs — find every module that sends a prompt to a model.
//
// The prompt-fencing completeness sweep demands a written classification for
// each module reported here, so a sender this detector misses ships
// unclassified. Every uncertain case therefore counts as a sender: a dynamic
// import of core whose bindings cannot be read is treated as one.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** @adlc/core exports that send a prompt to a model. */
export const PROMPT_SENDERS = ['complete', 'fan', 'fanProviders'];

const CORE_SPEC = String.raw`['"][^'"]*(?:@adlc\/core|core\/index\.mjs|\.\.\/core)['"]`;
const STATIC_IMPORT_RE = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${CORE_SPEC}`, 'g');
const DYNAMIC_IMPORT_RE = new RegExp(String.raw`import\(\s*${CORE_SPEC}\s*\)`, 'g');
const AWAIT_BINDINGS_RE = /\{([^}]*)\}\s*=\s*await\s*$/;
const THEN_BINDINGS_RE = /^\s*\.then\(\s*(?:async\s*)?\(\s*\{([^}]*)\}\s*\)/;

/** Host-harness sends: an SDK session prompt, or a CLI spawned in print mode. */
const HOST_SEND_RES = [
  /\bsession\.prompt\(/,
  /\[\s*['"](?:-p|--print)['"]\s*,\s*prompt\b/,
];

/** Directories that hold tests or fixtures, never shipped senders. */
const SKIP_DIRS = new Set(['node_modules', 'test', 'cli-test', 'adapter-test', 'fixtures']);

function bindingNames(list) {
  return list.split(',').map((s) => s.trim().split(/\s*:\s*|\s+as\s+/)[0].trim()).filter(Boolean);
}

function namesSender(list) {
  return bindingNames(list).some((n) => PROMPT_SENDERS.includes(n));
}

function dynamicImportSends(src, match) {
  const before = src.slice(0, match.index);
  const after = src.slice(match.index + match[0].length);
  const bound = AWAIT_BINDINGS_RE.exec(before) ?? THEN_BINDINGS_RE.exec(after);
  return bound ? namesSender(bound[1]) : true;
}

/**
 * Whether a module's source sends a prompt to a model.
 * @param {string} src
 * @returns {boolean}
 */
export function sendsPrompts(src) {
  if ([...src.matchAll(STATIC_IMPORT_RE)].some((m) => namesSender(m[1]))) return true;
  if ([...src.matchAll(DYNAMIC_IMPORT_RE)].some((m) => dynamicImportSends(src, m))) return true;
  return HOST_SEND_RES.some((re) => re.test(src));
}

function moduleFiles(dir, rel) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : moduleFiles(join(dir, entry.name), `${rel}/${entry.name}`);
    }
    return entry.name.endsWith('.mjs') ? [`${rel}/${entry.name}`] : [];
  });
}

function candidateFiles(root) {
  const packages = readdirSync(join(root, 'packages')).flatMap((pkg) =>
    ['lib', 'bin'].flatMap((sub) => moduleFiles(join(root, 'packages', pkg, sub), `packages/${pkg}/${sub}`)));
  const plugins = existsSync(join(root, 'plugins'))
    ? readdirSync(join(root, 'plugins')).flatMap((p) => moduleFiles(join(root, 'plugins', p), `plugins/${p}`))
    : [];
  return [...packages, ...plugins];
}

/**
 * Repo-relative paths of every shipped module under packages/<pkg>/{lib,bin}
 * and plugins/<plugin>, at any depth, that sends a prompt to a model.
 * @param {string} root repository root
 * @returns {string[]} sorted
 */
export function promptSendingModules(root) {
  return candidateFiles(root)
    .filter((rel) => sendsPrompts(readFileSync(join(root, rel), 'utf8')))
    .sort();
}
