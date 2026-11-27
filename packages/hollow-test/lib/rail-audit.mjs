// hollow-test/lib/rail-audit.mjs
// P3 static anti-mock and assertion adequacy audit for test rail files.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const ASSERTION_PY_RE =
  /\b(?:assert(?:\s*\.|\s*\(|\s*!|_eq!|_ne!|\s)|expect\s*\(|\.should\b|t\.(?:Fatal|Fatalf|Error|Errorf)\s*\()/g;
const ASSERTION_CODE_RE =
  /\b(?:assert(?:\s*\.|\s*\(|\s*!|_eq!|_ne!)|expect\s*\(|\.should\b|t\.(?:Fatal|Fatalf|Error|Errorf)\s*\()/g;

const TAUTOLOGICAL_PATTERNS = [
  /^assert\s*\.\s*ok\(\s*true\s*(?:,\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*)?\)/,
  /^assert\s*\(\s*true\s*(?:,\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*)?\)/,
  /^assert\s*!\(\s*true\s*\)/,
  /^assert\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual)\(\s*(true|false|\d+|'[^']*'|"[^"]*")\s*,\s*\1\s*\)/,
  /^assert_eq!\(\s*(true|false|\d+)\s*,\s*\1\s*\)/,
  /^expect\(\s*true\s*\)\s*\.\s*(?:toBe\(\s*true\s*\)|toEqual\(\s*true\s*\)|toStrictEqual\(\s*true\s*\)|toBeTruthy\(\s*\))/,
  /^expect\(\s*false\s*\)\s*\.\s*(?:toBe\(\s*false\s*\)|toEqual\(\s*false\s*\)|toBeFalsy\(\s*\))/,
  /^assert\s+\(?\s*True\s*\)?\s*(?:,\s*(?:'[^']*'|"[^"]*")\s*)?(?:;|\s*$)/,
];

const MOCK_CODE_PATTERNS = [/(?:vi|jest)\.mock\(\s*(['"])( +)\1/g, /\bmock\.module\(\s*(['"])( +)\1/g];
const IMPORT_CODE_PATTERNS = [
  /(?:^|[^\w$.])(?:import|export)\s+(?:[^;'"]*?\s+from\s+)?(['"])( +)\1/g,
  /\bimport\s*\(\s*(['"])( +)\1\s*\)/g,
  /\brequire\s*\(\s*(['"])( +)\1\s*\)/g,
];

const PY_IMPORT_LINE_RE = /^\s*(?:import\b|from\s+\S+\s+import\b)/;
const REGEX_PUNCT = new Set(['', '\n', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);
const REGEX_WORDS = new Set([
  'return', 'typeof', 'throw', 'case', 'instanceof', 'delete', 'void', 'yield',
  'else', 'do', 'in', 'of', 'new', 'await', 'default', 'export', 'import', 'from', 'as', 'extends', 'async', 'satisfies',
]);

function scanJsRegexEnd(source, start) {
  let j = start + 1;
  let inClass = false;
  while (j < source.length && source[j] !== '\n') {
    const c = source[j];
    if (c === '\\') { if (j + 1 >= source.length || source[j + 1] === '\n') return -1; j += 2; continue; }
    if (inClass) { if (c === ']') inClass = false; j += 1; continue; }
    if (c === '[') { inClass = true; j += 1; continue; }
    if (c === '/') return j + 1;
    j += 1;
  }
  return -1;
}

function maskCommentsAndStrings(source, lang) {
  let clean = '';
  let code = '';
  let i = 0;
  let inBlock = false;
  let quote = null;
  let rustRawHashes = null;
  const interpolations = [];
  let lastSig = '\n';
  let lastWord = '';
  let wordAfterDot = false;

  const pushBlank = (s) => {
    for (let k = 0; k < s.length; k += 1) {
      const b = s[k] === '\n' ? '\n' : ' ';
      clean += b;
      code += b;
    }
  };
  const pushStrBody = (s) => {
    clean += s;
    for (let k = 0; k < s.length; k += 1) {
      code += s[k] === '\n' ? '\n' : ' ';
    }
  };
  const pushCode = (s) => { clean += s; code += s; };

  while (i < source.length) {
    const ch = source[i];
    if (inBlock) {
      if (ch === '*' && source[i + 1] === '/') { pushBlank('  '); inBlock = false; i += 2; }
      else { pushBlank(ch); i += 1; }
      continue;
    }
    if (rustRawHashes !== null) {
      const closer = '"' + '#'.repeat(rustRawHashes);
      if (source.startsWith(closer, i)) { pushCode(closer); i += closer.length; rustRawHashes = null; }
      else { pushStrBody(ch); i += 1; }
      continue;
    }
    if (quote !== null) {
      if (quote === '`' && lang === 'go') {
        if (ch === '`') { pushCode('`'); quote = null; } else pushStrBody(ch);
        i += 1;
        continue;
      }
      if (ch === '\\' && i + 1 < source.length) { pushStrBody(source.slice(i, i + 2)); i += 2; continue; }
      if (quote === '`' && lang === 'js' && ch === '$' && source[i + 1] === '{') {
        pushCode('${'); interpolations.push(0); quote = null; lastSig = '{'; lastWord = ''; wordAfterDot = false; i += 2; continue;
      }
      if (source.startsWith(quote, i)) {
        pushCode(quote); lastSig = quote[0]; lastWord = ''; wordAfterDot = false; i += quote.length; quote = null; continue;
      }
      pushStrBody(ch); i += 1; continue;
    }
    if (lang === 'python') {
      if (ch === '#') { const nl = source.indexOf('\n', i); const end = nl === -1 ? source.length : nl; pushBlank(source.slice(i, end)); i = end; continue; }
      if (source.startsWith('"""', i) || source.startsWith("'''", i)) { quote = source.slice(i, i + 3); pushCode(quote); i += 3; continue; }
      if (ch === '"' || ch === "'") { quote = ch; pushCode(ch); i += 1; continue; }
      pushCode(ch); i += 1; continue;
    }
    if (ch === '/' && source[i + 1] === '/') { const nl = source.indexOf('\n', i); const end = nl === -1 ? source.length : nl; pushBlank(source.slice(i, end)); i = end; continue; }
    if (ch === '/' && source[i + 1] === '*') { pushBlank('  '); inBlock = true; i += 2; continue; }
    if (lang === 'js' && interpolations.length > 0 && (ch === '{' || ch === '}')) {
      const top = interpolations.length - 1;
      if (ch === '{') { interpolations[top] += 1; pushCode('{'); lastSig = '{'; lastWord = ''; wordAfterDot = false; i += 1; continue; }
      if (interpolations[top] === 0) { interpolations.pop(); pushCode('}'); quote = '`'; i += 1; continue; }
      interpolations[top] -= 1; pushCode('}'); lastSig = '}'; lastWord = ''; wordAfterDot = false; i += 1; continue;
    }
    if (lang === 'js' && ch === '/' && (REGEX_PUNCT.has(lastSig) || (!wordAfterDot && REGEX_WORDS.has(lastWord)))) {
      const end = scanJsRegexEnd(source, i);
      if (end !== -1) { pushCode('/'); pushStrBody(source.slice(i + 1, end - 1)); pushCode('/'); lastSig = '/'; lastWord = ''; wordAfterDot = false; i = end; continue; }
    }
    if (lang === 'rust' && (ch === 'r' || (ch === 'b' && source[i + 1] === 'r')) && (i === 0 || !/[\w$]/.test(source[i - 1]))) {
      const p = ch === 'b' ? i + 2 : i + 1;
      let h = 0; while (source[p + h] === '#') h += 1;
      if (source[p + h] === '"') { const pfx = source.slice(i, p + h + 1); pushCode(pfx); rustRawHashes = h; i += pfx.length; continue; }
    }
    if (lang === 'go' && ch === '`') { quote = '`'; pushCode('`'); i += 1; continue; }
    if ((lang === 'go' || lang === 'rust') && ch === "'") {
      const chLit = source.slice(i).match(/^'(?:\\u\{[0-9a-fA-F_]+\}|\\x[0-9a-fA-F]{2}|\\.|[^'\\\n])'/);
      if (chLit) { pushCode("'"); pushStrBody(chLit[0].slice(1, -1)); pushCode("'"); i += chLit[0].length; continue; }
    }
    if (ch === '"' || (lang === 'js' && (ch === "'" || ch === '`'))) { quote = ch; pushCode(ch); i += 1; continue; }
    if (lang === 'js' && /[\w$]/.test(ch)) {
      let end = i + 1; while (end < source.length && /[\w$]/.test(source[end])) end += 1;
      wordAfterDot = lastSig === '.'; lastWord = source.slice(i, end); lastSig = source[end - 1]; pushCode(lastWord); i = end; continue;
    }
    if (lang === 'js' && !/\s/.test(ch)) { lastSig = ch; lastWord = ''; wordAfterDot = false; }
    pushCode(ch); i += 1;
  }
  return { clean, code };
}

function extractRelativeSpecs(clean, code, patterns) {
  const specs = [];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) {
      const qIdx = m[0].lastIndexOf(m[1], m[0].length - 2);
      const spec = clean.slice(m.index + qIdx + 1, m.index + qIdx + 1 + m[2].length);
      if (/^\.\.?\//.test(spec)) specs.push(spec);
    }
  }
  return specs;
}

const resolveStem = (absFile, spec) => resolve(dirname(absFile), spec).replace(/\.(?:[mc]?[jt]sx?)$/i, '');
const escapesRoot = (rel) => rel === '' || rel.split(sep)[0] === '..' || isAbsolute(rel);

function analyzeFile(realFile, relFile, rawSource) {
  const lang = /\.py$/i.test(realFile) ? 'python' : /\.go$/i.test(realFile) ? 'go' : /\.rs$/i.test(realFile) ? 'rust' : 'js';
  const { clean, code } = maskCommentsAndStrings(rawSource, lang);
  const mockedByStem = new Map();
  for (const spec of extractRelativeSpecs(clean, code, MOCK_CODE_PATTERNS)) {
    const stem = resolveStem(realFile, spec);
    if (!mockedByStem.has(stem)) mockedByStem.set(stem, spec);
  }
  const importedStems = new Set(extractRelativeSpecs(clean, code, IMPORT_CODE_PATTERNS).map((s) => resolveStem(realFile, s)));

  let assertionCount = 0;
  let tautologicalCount = 0;
  const assertRe = lang === 'python' ? ASSERTION_PY_RE : ASSERTION_CODE_RE;
  const codeLines = code.split('\n');
  const cleanLines = clean.split('\n');
  for (let idx = 0; idx < codeLines.length; idx++) {
    if (lang === 'python' && PY_IMPORT_LINE_RE.test(codeLines[idx])) continue;
    for (const m of codeLines[idx].matchAll(assertRe)) {
      assertionCount += 1;
      if (TAUTOLOGICAL_PATTERNS.some((p) => p.test(cleanLines[idx].slice(m.index)))) tautologicalCount += 1;
    }
  }
  return { realFile, relFile, assertionCount, tautologicalCount, mockedByStem, mockedStems: new Set(mockedByStem.keys()), importedStems };
}

export function auditRailAdequacy(files, { root = process.cwd() } = {}) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('auditRailAdequacy requires at least one file path');
  const realRoot = realpathSync(root);
  const entries = [];
  const seen = new Set();

  for (const rawFile of files) {
    if (typeof rawFile !== 'string' || rawFile.trim() === '') throw new Error('rail audit file path must be a non-empty string');
    const candidate = resolve(root, rawFile);
    if (!existsSync(candidate)) {
      if (escapesRoot(relative(realRoot, resolve(realRoot, rawFile)))) throw new Error(`rail file escapes repository root: ${rawFile}`);
      throw new Error(`rail file not found: ${rawFile}`);
    }
    const realFile = realpathSync(candidate);
    const rel = relative(realRoot, realFile);
    if (escapesRoot(rel)) throw new Error(`rail file escapes repository root: ${rawFile}`);
    if (!statSync(realFile).isFile()) throw new Error(`rail path is not a regular file: ${rawFile}`);
    if (seen.has(realFile)) continue;
    seen.add(realFile);
    entries.push(analyzeFile(realFile, rel.replaceAll('\\', '/'), readFileSync(realFile, 'utf8')));
  }

  const violations = [];
  for (const entry of entries) {
    if (entry.assertionCount === 0) {
      violations.push({ file: entry.relFile, reason: 'missing-assertions', detail: 'test file contains zero assertions' });
    } else if (entry.tautologicalCount === entry.assertionCount) {
      violations.push({ file: entry.relFile, reason: 'tautological-only', detail: 'every assertion in test file is tautological' });
    }
    if (entry.mockedByStem.size > 0) {
      const unbacked = [...entry.mockedByStem.entries()]
        .filter(([stem]) => !entries.some((o) => o.realFile !== entry.realFile && o.importedStems.has(stem) && !o.mockedStems.has(stem)))
        .map(([, spec]) => spec);
      if (unbacked.length > 0) {
        violations.push({
          file: entry.relFile,
          reason: 'mock-only-internal',
          detail: `mocks relative internal module(s) with no unmocked rail coverage: ${unbacked.join(', ')}`,
        });
      }
    }
  }
  return { ok: violations.length === 0, audited: entries.length, violations };
}
