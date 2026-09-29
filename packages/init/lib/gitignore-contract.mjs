/**
 * The committability contract a .gitignore must satisfy: every path in
 * REQUIRED_COMMITTABLE_PATHS stays un-ignored.
 *
 * Evaluation prefers real git, in this order:
 *   1. `git check-ignore` in `root` itself, when `root` is a repository git
 *      can open — the answer includes .git/info/exclude and nested ignores;
 *   2. `git check-ignore` in a throwaway repository holding only `lines` as
 *      its .gitignore — `root` is not (yet) a repository, or git refuses it
 *      (e.g. dubious ownership), but git's own matcher is still available;
 *   3. evaluateGitignoreContract, a JavaScript model of git's matcher, only
 *      when git cannot be run at all.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIVE_DIRECTORY } from '@adlc/tickets';

export const REQUIRED_COMMITTABLE_PATHS = Object.freeze([
  '.adlc/config.json',
  '.adlc/manifest.jsonl',
  `${ACTIVE_DIRECTORY}/.store.json`,
  '.adlc/manifest.d/seg-1.jsonl',
]);

/**
 * The probe child needs no secrets and must answer for `root`, not whatever
 * repository the caller's environment points at: the manifest key is dropped
 * (a child that does not need the key never inherits it), and so are the
 * GIT_* repository selectors, which would otherwise redirect the probe.
 */
export function gitProbeEnv(env = process.env) {
  const scrubbed = { ...env };
  for (const name of ['ADLC_MANIFEST_KEY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete scrubbed[name];
  return scrubbed;
}

function runGit(cwd, args) {
  return spawnSync('git', args, { cwd, env: gitProbeEnv(), stdio: 'ignore' }).status;
}

/** 0 = ignored, 1 = not ignored, anything else = git could not answer. */
function gitCheckIgnore(cwd, relPath) {
  return runGit(cwd, ['check-ignore', '--no-index', '-q', '--', relPath]);
}

/** Ignored paths per git in `cwd`, or null when git cannot answer there. */
function ignoredPerGit(cwd, paths) {
  const ignored = [];
  for (const path of paths) {
    const status = gitCheckIgnore(cwd, path);
    if (status !== 0 && status !== 1) return null;
    if (status === 0) ignored.push(path);
  }
  return ignored;
}

/** Ignored paths per git for `lines` alone, or null when git cannot run. */
function ignoredPerScratchRepository(lines, paths) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-init-gitignore-'));
  try {
    if (runGit(dir, ['init', '-q']) !== 0) return null;
    writeFileSync(join(dir, '.gitignore'), `${lines.join('\n')}\n`);
    return ignoredPerGit(dir, paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function evaluateEffectiveGitignoreContract(root, lines, paths = REQUIRED_COMMITTABLE_PATHS) {
  return ignoredPerGit(root, paths)
    ?? ignoredPerScratchRepository(lines, paths)
    ?? evaluateGitignoreContract(lines, paths);
}

// ---------------------------------------------------------------------------
// JavaScript model of git's matcher (used only without a git binary).

const REGEX_SPECIAL = /[.+^${}()|\\/]/;

/** Translate one `[...]` class starting at `i`; null when it is unterminated. */
function translateClass(glob, i) {
  let j = i + 1;
  if (glob[j] === '!' || glob[j] === '^') j += 1;
  if (glob[j] === ']') j += 1;
  while (j < glob.length && glob[j] !== ']') j += 1;
  if (j >= glob.length) return null;
  const negated = glob[i + 1] === '!' || glob[i + 1] === '^';
  const body = glob.slice(i + (negated ? 2 : 1), j).replace(/\\/g, '\\\\');
  return { source: `[${negated ? '^' : ''}${body}]`, end: j + 1 };
}

/** Regex source for a gitignore glob whose `**` runs have been expanded by the caller. */
function translateSegmentGlob(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '\\' && i + 1 < glob.length) {
      i += 1;
      out += REGEX_SPECIAL.test(glob[i]) || /[*?[\]]/.test(glob[i]) ? `\\${glob[i]}` : glob[i];
    } else if (ch === '*') {
      while (glob[i + 1] === '*') i += 1;
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      const cls = translateClass(glob, i);
      if (cls) {
        out += cls.source;
        i = cls.end - 1;
      } else {
        out += '\\[';
      }
    } else {
      out += REGEX_SPECIAL.test(ch) || ch === ']' ? `\\${ch}` : ch;
    }
  }
  return out;
}

/** Regex source for a full gitignore glob, honouring `**` only as a whole segment. */
function translateGlob(glob) {
  const segments = glob.split('/');
  let out = '';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      out += last ? '.*' : '(?:[^/]*/)*';
      return;
    }
    out += translateSegmentGlob(segment);
    if (!last) out += '/';
  });
  return out;
}

/** Parse one .gitignore line into a matcher, or null for blanks and comments. */
export function parseGitignoreLine(rawLine) {
  let line = rawLine.replace(/\r$/, '');
  line = line.replace(/(?<!\\)\s+$/, '');
  if (line === '' || line.startsWith('#')) return null;
  const negated = line.startsWith('!');
  if (negated) line = line.slice(1);
  if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
  const dirOnly = line.endsWith('/');
  if (dirOnly) line = line.slice(0, -1);
  if (line === '') return null;
  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);
  const re = new RegExp(`^${translateGlob(line)}$`);
  return { negated, dirOnly, anchored, re };
}

function matches(rule, path, isDir) {
  if (rule.dirOnly && !isDir) return false;
  const subject = rule.anchored ? path : path.slice(path.lastIndexOf('/') + 1);
  return rule.re.test(subject);
}

/** Last-match-wins verdict for one path; undefined when no rule matches. */
function lastVerdict(rules, path, isDir) {
  let verdict;
  for (const rule of rules) {
    if (matches(rule, path, isDir)) verdict = !rule.negated;
  }
  return verdict;
}

/**
 * Git never looks inside an excluded directory, so a path whose ancestor is
 * ignored stays ignored whatever negations follow; otherwise the path's own
 * last matching rule decides.
 */
function isIgnored(rules, path) {
  const segments = path.split('/');
  for (let depth = 1; depth < segments.length; depth += 1) {
    if (lastVerdict(rules, segments.slice(0, depth).join('/'), true) === true) return true;
  }
  return lastVerdict(rules, path, false) === true;
}

export function evaluateGitignoreContract(lines, paths = REQUIRED_COMMITTABLE_PATHS) {
  const rules = lines.map(parseGitignoreLine).filter(Boolean);
  return paths.filter((path) => isIgnored(rules, path));
}
