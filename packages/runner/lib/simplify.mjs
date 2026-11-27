import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { OpError, sha256 } from '@adlc/core';

const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.worktrees', 'test', 'tests', 'dist', 'build', '.adlc']);
const SOURCE_EXT_RE = /\.(?:mjs|cjs|js|jsx|ts|tsx)$/i;
const DECLARATION_RE = /\.d\.[cm]?ts$/i;
const WINDOW_SIZE = 12;

const REINVENTED_FN_RE =
  /\b(?:export\s+)?(?:async\s+)?function\s+(writeFileAtomic|acquireDirLock|canonicalJson|redactSecrets|globMatch|resolveTrustedBinary)\b/g;

const REINVENTED_CONST_RE =
  /\b(?:export\s+)?const\s+(writeFileAtomic|acquireDirLock|canonicalJson|redactSecrets|globMatch|resolveTrustedBinary)\s*=\s*(?:async\s*)?(?:\(|function\b)/g;

const CORE_IMPORT_RE = /\bimport\s*(?:[\w$]+\s*,\s*)?\{([^{}]*)\}\s*from\s*['"]@adlc\/core(?:\/[^'"]*)?['"]/g;

function walkSourceFiles(rootDir) {
  const collected = [];
  function visit(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        visit(fullPath);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.bundle.mjs')) continue;
        if (DECLARATION_RE.test(entry.name)) continue;
        if (!SOURCE_EXT_RE.test(entry.name)) continue;
        collected.push(fullPath);
      }
    }
  }
  visit(rootDir);
  return collected;
}

export function stripCommentsPreservingLines(source) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'line') {
      if (ch === '\n') {
        out += '\n';
        state = 'code';
      }
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        out += ' ';
        i += 1;
        state = 'code';
      } else if (ch === '\n') {
        out += '\n';
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      out += ch;
      if (ch === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 1;
        continue;
      }
      if (
        (state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"') ||
        (state === 'template' && ch === '`')
      ) {
        state = 'code';
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 1;
      state = 'line';
    } else if (ch === '/' && next === '*') {
      i += 1;
      state = 'block';
    } else if (ch === "'") {
      out += ch;
      state = 'single';
    } else if (ch === '"') {
      out += ch;
      state = 'double';
    } else if (ch === '`') {
      out += ch;
      state = 'template';
    } else {
      out += ch;
    }
  }
  return out;
}

function extractCoreImportedSymbols(strippedSource) {
  const imported = new Set();
  for (const match of strippedSource.matchAll(CORE_IMPORT_RE)) {
    const body = match[1] ?? '';
    for (const rawSpec of body.split(',')) {
      const spec = rawSpec.trim();
      if (!spec) continue;
      const parts = spec.split(/\s+as\s+/);
      if (parts[0]?.trim()) imported.add(parts[0].trim());
      if (parts[1]?.trim()) imported.add(parts[1].trim());
    }
  }
  return imported;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function isCoreFile(relFile) {
  return relFile.startsWith('packages/core/') || /(?:^|\/)packages\/core\//.test(relFile);
}

export function scanRepositoryBloat({ root = process.cwd() } = {}) {
  const absRoot = resolve(root);
  if (!existsSync(absRoot) || !statSync(absRoot).isDirectory()) {
    throw new OpError(`root directory does not exist: ${root}`);
  }

  const files = walkSourceFiles(absRoot);
  const windowBuckets = new Map();
  const coreReinventions = [];

  for (const absFile of files) {
    const relFile = relative(absRoot, absFile).replaceAll('\\', '/');
    let source;
    try {
      source = readFileSync(absFile, 'utf8');
    } catch {
      continue;
    }
    const stripped = stripCommentsPreservingLines(source);
    const rawLines = stripped.split('\n');
    const normalizedLines = [];
    for (let idx = 0; idx < rawLines.length; idx += 1) {
      const trimmed = rawLines[idx].replace(/\r$/, '').trim();
      if (trimmed.length > 0) {
        normalizedLines.push({ text: trimmed, line: idx + 1 });
      }
    }

    for (let i = 0; i + WINDOW_SIZE <= normalizedLines.length; i += 1) {
      const windowSlice = normalizedLines.slice(i, i + WINDOW_SIZE);
      const windowText = windowSlice.map((entry) => entry.text).join('\n');
      const hash = sha256(windowText);
      let bucket = windowBuckets.get(hash);
      if (!bucket) {
        bucket = { hash, lineCount: WINDOW_SIZE, sample: windowText, locations: [], files: new Set() };
        windowBuckets.set(hash, bucket);
      }
      bucket.locations.push({ file: relFile, startLine: windowSlice[0].line });
      bucket.files.add(relFile);
    }

    if (!isCoreFile(relFile)) {
      const coreImported = extractCoreImportedSymbols(stripped);
      const fileHits = [];
      for (const regex of [REINVENTED_FN_RE, REINVENTED_CONST_RE]) {
        for (const match of stripped.matchAll(regex)) {
          const helper = match[1];
          if (coreImported.has(helper)) continue;
          fileHits.push({
            helper,
            file: relFile,
            line: lineNumberAt(stripped, match.index ?? 0),
          });
        }
      }
      fileHits.sort((a, b) => a.line - b.line || a.helper.localeCompare(b.helper));
      coreReinventions.push(...fileHits);
    }
  }

  const duplicateBlocks = [];
  for (const bucket of windowBuckets.values()) {
    if (bucket.files.size >= 2) {
      duplicateBlocks.push({
        hash: bucket.hash,
        lineCount: WINDOW_SIZE,
        sample: bucket.sample,
        locations: bucket.locations,
      });
    }
  }

  return {
    root: absRoot,
    filesScanned: files.length,
    duplicateBlocks,
    coreReinventions,
  };
}
