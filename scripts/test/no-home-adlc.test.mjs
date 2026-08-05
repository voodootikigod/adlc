// no-home-adlc.test.mjs — nothing in ADLC may resolve a path under `~/.adlc`.
//
// `.adlc/` is the marker meaning "this directory is an ADLC repo". Any `~/.adlc`
// therefore makes `$HOME` read as a repo to every ancestor walk, capturing every
// unrelated project beneath it. Three separate code paths created one before:
//
//   • adlc-cursor kept user-scoped session state there by design (now
//     ~/.cursor/adlc, matching @adlc/gemini's ~/.gemini/antigravity-cli);
//   • the codex/copilot flail hooks `mkdir -p`'d `<cwd>/.adlc/.plugin-data`
//     with no repo guard, so a tool failure with cwd=$HOME created it;
//   • adlc-cursor's scaffolder defaulted its target to `.`, so an init run
//     from $HOME wrote a config AND a ticket store there.
//
// Each has its own behavioural test. This one is the standing invariant, so a
// FOURTH path cannot reintroduce the collision unnoticed. It is a source scan:
// cheap, and it catches the construction rather than waiting to observe it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ROOTS = ['packages', 'plugins', 'scripts', 'apps'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', '.claude', 'dist', 'build', 'coverage']);

/** Every source file under ROOTS, excluding tests (which legitimately name the
 *  forbidden path in order to assert against it). */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'test' || e.name === 'tests') continue;
        walk(full);
      } else if (/\.(mjs|cjs|js|ts)$/.test(e.name) && !/\.test\.(mjs|cjs|js|ts)$/.test(e.name)) {
        out.push(full);
      }
    }
  };
  for (const r of ROOTS) {
    try { if (statSync(join(REPO_ROOT, r)).isDirectory()) walk(join(REPO_ROOT, r)); } catch { /* absent */ }
  }
  return out;
}

/** Strip comments so prose ABOUT the collision (including this repo's own
 *  explanatory headers) is not mistaken for code that creates one. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

// `join(homedir(), '.adlc')`, `${homedir()}/.adlc`, `~/.adlc`, and the
// process.env.HOME spellings of the same.
const FORBIDDEN = [
  { re: /homedir\s*\([^)]*\)[^;\n]{0,60}?['"`]\.adlc/, why: "homedir() joined with '.adlc'" },
  { re: /homedir\s*\([^)]*\)\s*\}?\s*\/\.adlc/, why: 'a template path under homedir()/.adlc' },
  { re: /['"`]~\/\.adlc/, why: "a literal '~/.adlc' path" },
  { re: /process\.env\.HOME[^;\n]{0,60}?['"`]\.adlc/, why: "process.env.HOME joined with '.adlc'" },
];

test('no source file resolves a path under ~/.adlc', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }
    if (!src.includes('.adlc')) continue; // fast reject
    const code = stripComments(src);
    for (const { re, why } of FORBIDDEN) {
      if (re.test(code)) offenders.push(`${relative(REPO_ROOT, file)} — ${why}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'These files resolve a path under ~/.adlc, which makes $HOME read as an ADLC repo.\n' +
    'User-scoped state belongs in the HOST namespace (e.g. ~/.cursor/adlc, ~/.gemini/...).\n' +
    `Offenders:\n  ${offenders.join('\n  ')}`,
  );
});

// Guards the scanner itself: a scan that cannot fail proves nothing.
test('the scan detects each forbidden spelling', () => {
  const samples = [
    "const d = join(homedir(), '.adlc');",
    'const d = `${homedir()}/.adlc`;',
    "const d = '~/.adlc/state.json';",
    'const d = join(process.env.HOME, ".adlc");',
  ];
  for (const sample of samples) {
    assert.ok(
      FORBIDDEN.some(({ re }) => re.test(sample)),
      `scanner missed a forbidden spelling: ${sample}`,
    );
  }
});

test('the scan does not flag legitimate neighbours', () => {
  const benign = [
    "const d = join(homedir(), '.cursor', 'adlc');",
    "const d = join(homedir(), '.gemini', 'antigravity-cli');",
    "const d = join(root, '.adlc', 'tickets.json');",
    "const d = join(homedir(), '.config', 'adlc', 'registry.json');",
  ];
  for (const sample of benign) {
    const hit = FORBIDDEN.find(({ re }) => re.test(sample));
    assert.equal(hit, undefined, `scanner false-positived on: ${sample} (${hit?.why})`);
  }
});
