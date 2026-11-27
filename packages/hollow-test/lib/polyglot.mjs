// hollow-test/lib/polyglot.mjs
// Polyglot (.py, .go, .rs) language detection, test-path exclusion, string-masked
// line-level mutation operators, and isolated temp-file syntax validation.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeCandidateEnv } from '@adlc/core';

export function polyglotLanguage(file) {
  if (typeof file !== 'string') return null;
  if (/\.py$/i.test(file)) return 'python';
  if (/\.go$/i.test(file)) return 'go';
  if (/\.rs$/i.test(file)) return 'rust';
  return null;
}

export function isPolyglotTestFile(file) {
  if (typeof file !== 'string') return false;
  const norm = file.replaceAll('\\', '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (/^(?:test_[^/]*|[^/]*_test|conftest)\.py$/i.test(base)) return true;
  if (/^[^/]*_test\.go$/i.test(base)) return true;
  return /(?:^|\/)tests\/.*\.rs$/i.test(norm);
}

function maskQuotedLiteral(line, start, quote) {
  let out = quote;
  let i = start + quote.length;
  while (i < line.length) {
    if (line[i] === '\\') {
      const step = i + 1 < line.length ? 2 : 1;
      out += ' '.repeat(step);
      i += step;
    } else if (line.startsWith(quote, i)) {
      return out + quote;
    } else {
      out += ' ';
      i += 1;
    }
  }
  return out;
}

function maskPythonLine(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.triple !== null) {
      if (line[i] === '\\' && i + 1 < line.length) { out += '  '; i += 2; }
      else if (line.startsWith(state.triple, i)) { out += state.triple; state.triple = null; i += 3; }
      else { out += ' '; i += 1; }
      continue;
    }
    if (line[i] === '#') { out += ' '.repeat(line.length - i); break; }
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state.triple = line.slice(i, i + 3);
      out += state.triple;
      i += 3;
      continue;
    }
    if (line[i] === '"' || line[i] === "'") {
      const maskedQuote = maskQuotedLiteral(line, i, line[i]);
      out += maskedQuote;
      i += maskedQuote.length;
      continue;
    }
    out += line[i];
    i += 1;
  }
  return out;
}

function maskCFamilyLine(line, lang, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.inBlock) {
      if (line[i] === '*' && line[i + 1] === '/') { out += '  '; state.inBlock = false; i += 2; }
      else { out += ' '; i += 1; }
      continue;
    }
    if (state.inRaw) {
      if (line[i] === '`') { out += '`'; state.inRaw = false; }
      else out += ' ';
      i += 1;
      continue;
    }
    if (state.rawHashes !== null) {
      const closer = '"' + '#'.repeat(state.rawHashes);
      if (line.startsWith(closer, i)) { out += closer; i += closer.length; state.rawHashes = null; }
      else { out += ' '; i += 1; }
      continue;
    }
    if (line[i] === '/' && line[i + 1] === '/') { out += ' '.repeat(line.length - i); break; }
    if (line[i] === '/' && line[i + 1] === '*') { out += '  '; state.inBlock = true; i += 2; continue; }
    if (lang === 'go' && line[i] === '`') { out += '`'; state.inRaw = true; i += 1; continue; }
    if (lang === 'rust' && (line[i] === 'r' || (line[i] === 'b' && line[i + 1] === 'r')) && (i === 0 || !/\w/.test(line[i - 1]))) {
      const p = line[i] === 'b' ? i + 2 : i + 1;
      let h = 0;
      while (line[p + h] === '#') h += 1;
      if (line[p + h] === '"') {
        const prefix = line.slice(i, p + h + 1);
        out += prefix;
        state.rawHashes = h;
        i += prefix.length;
        continue;
      }
    }
    if (line[i] === '"') {
      const maskedQuote = maskQuotedLiteral(line, i, '"');
      out += maskedQuote;
      i += maskedQuote.length;
      continue;
    }
    if (line[i] === "'") {
      const chLit = line.slice(i).match(/^'(?:\\u\{[0-9a-fA-F_]+\}|\\x[0-9a-fA-F]{2}|\\.|[^'\\])'/);
      if (chLit) { out += `'${' '.repeat(chLit[0].length - 2)}'`; i += chLit[0].length; continue; }
    }
    out += line[i];
    i += 1;
  }
  return out;
}

function spliceEarliest(line, masked, swaps) {
  let best = null;
  for (const [re, replacement] of swaps) {
    const m = masked.match(re);
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, length: m[0].length, replacement };
    }
  }
  return best ? line.slice(0, best.index) + best.replacement + line.slice(best.index + best.length) : null;
}

const COMPARISON_SWAPS = [
  [/(?<![=!<>])==(?!=)/, '!='],
  [/(?<![=!<>])!=(?!=)/, '=='],
  [/(?<![<>=!])<=(?!=)/, '>'],
  [/(?<![<>=!])>=(?!=)/, '<'],
];

const PYTHON_OPERATORS = [
  { name: 'invert-comparison', apply: (l, m) => spliceEarliest(l, m, COMPARISON_SWAPS) },
  { name: 'none-check', apply: (l, m) => spliceEarliest(l, m, [[/\bis\s+not\s+None\b/, 'is None'], [/\bis\s+None\b/, 'is not None']]) },
  { name: 'bool-flip', apply: (l, m) => spliceEarliest(l, m, [[/\bTrue\b/, 'False'], [/\bFalse\b/, 'True']]) },
  { name: 'logic-swap', apply: (l, m) => spliceEarliest(l, m, [[/\band\b/, 'or'], [/\bor\b/, 'and']]) },
  {
    name: 'null-return',
    apply: (_l, masked) => {
      const m = masked.match(/^(\s*)return\s+(?![(\s]*None\b[\s);]*$)(?!\s*;?\s*$)/);
      return m ? `${m[1]}return None` : null;
    },
  },
];

const GO_OPERATORS = [
  { name: 'invert-comparison', apply: (l, m) => spliceEarliest(l, m, COMPARISON_SWAPS) },
  { name: 'bool-flip', apply: (l, m) => spliceEarliest(l, m, [[/\btrue\b/, 'false'], [/\bfalse\b/, 'true']]) },
  { name: 'logic-swap', apply: (l, m) => spliceEarliest(l, m, [[/&&/, '||'], [/\|\|/, '&&']]) },
];

const RUST_OPERATORS = [
  ...GO_OPERATORS,
  { name: 'option-check', apply: (l, m) => spliceEarliest(l, m, [[/\.is_some\(\s*\)/, '.is_none()'], [/\.is_none\(\s*\)/, '.is_some()']]) },
];

export function generatePolyglotMutants(content, lang, { targetLines, maxMutants = 50 } = {}) {
  if (typeof content !== 'string' || maxMutants < 1) return [];
  const ops = lang === 'python' ? PYTHON_OPERATORS : lang === 'go' ? GO_OPERATORS : lang === 'rust' ? RUST_OPERATORS : null;
  if (ops === null) return [];
  const allow = targetLines ? new Set([...targetLines]) : null;
  const state = { triple: null, inBlock: false, inRaw: false, rawHashes: null };
  const lines = content.split('\n');
  const mutants = [];

  for (let i = 0; i < lines.length && mutants.length < maxMutants; i++) {
    const lineNo = i + 1;
    const original = lines[i];
    const masked = lang === 'python' ? maskPythonLine(original, state) : maskCFamilyLine(original, lang, state);
    if (allow && !allow.has(lineNo)) continue;
    if (masked.trim() === '') continue;
    for (const op of ops) {
      const mutated = op.apply(original, masked);
      if (mutated === null || mutated === original) continue;
      mutants.push({ line: lineNo, operator: op.name, original, mutated });
      if (mutants.length >= maxMutants) break;
    }
  }
  return mutants;
}

const SYNTAX_SPECS = {
  python: { ext: '.py', bin: 'python3', args: (f) => ['-I', '-m', 'py_compile', f] },
  go: { ext: '.go', bin: 'gofmt', args: (f) => ['-e', f] },
  rust: { ext: '.rs', bin: 'rustfmt', args: (f) => ['--emit', 'stdout', f] },
};

export function checkPolyglotSyntax(filePath, content, lang, { env = process.env, timeoutMs = 30_000 } = {}) {
  const spec = SYNTAX_SPECS[lang ?? polyglotLanguage(filePath)];
  if (!spec) return { verdict: 'unknown', detail: `unsupported polyglot language for ${String(filePath)}` };
  const dir = mkdtempSync(join(tmpdir(), 'adlc-polyglot-'));
  let result;
  try {
    const tmpFile = join(dir, `check${spec.ext}`);
    writeFileSync(tmpFile, content, 'utf8');
    result = spawnSync(spec.bin, spec.args(tmpFile), {
      shell: false,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizeCandidateEnv(env),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (result.error?.code === 'ENOENT') return { verdict: 'unknown', detail: `missing toolchain binary "${spec.bin}" (${result.error.message})` };
  if (result.error?.code === 'ETIMEDOUT') return { verdict: 'unknown', detail: `${spec.bin} syntax check timed out` };
  if (result.error) return { verdict: 'unknown', detail: `${spec.bin} syntax check failed: ${result.error.message}` };
  if (result.signal) return { verdict: 'unknown', detail: `${spec.bin} killed by ${result.signal}` };
  if (typeof result.status !== 'number') return { verdict: 'unknown', detail: `${spec.bin} exited without status` };
  if (result.status === 0) return { verdict: 'valid', detail: null };
  const detail = String(result.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? `exit ${result.status}`;
  return { verdict: 'invalid', detail };
}

/**
 * Execute one polyglot mutant trial (syntax check + atomic write/restore + test run).
 */
export function executePolyglotMutant({
  target,
  mutant,
  content,
  mutatedContent,
  polyLang,
  targetTestCmd,
  timeoutMs,
  cwd,
  runTestFn,
  writeFileFn,
  beforeWrite,
  afterRestore,
}) {
  const polySyntax = checkPolyglotSyntax(target.absolutePath, mutatedContent, polyLang);
  if (polySyntax.verdict === 'unknown') {
    return {
      killed: false,
      invalid: false,
      undetermined: true,
      reason: `syntax check did not run (${polySyntax.detail})`,
      timedOut: false,
      exitCode: null,
    };
  }
  if (polySyntax.verdict === 'invalid') {
    return {
      killed: false,
      invalid: true,
      undetermined: false,
      reason: null,
      timedOut: false,
      exitCode: null,
    };
  }

  beforeWrite?.();
  let rawTrial;
  try {
    writeFileFn(target.absolutePath, mutatedContent);
    rawTrial = runTestFn(targetTestCmd, timeoutMs, cwd);
  } finally {
    writeFileFn(target.absolutePath, content);
    afterRestore?.();
  }

  if (rawTrial.spawnFailed) {
    return {
      killed: false,
      invalid: false,
      undetermined: true,
      reason: `test command did not run (${rawTrial.reason})`,
      timedOut: false,
      exitCode: null,
    };
  }
  return {
    killed: rawTrial.timedOut || rawTrial.status !== 0,
    invalid: false,
    undetermined: false,
    reason: null,
    timedOut: rawTrial.timedOut,
    exitCode: rawTrial.status,
  };
}
