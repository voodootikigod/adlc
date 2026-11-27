// Polyglot and workspace import extraction and candidate resolution.

import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const workspaceCache = new Map();

function resolveExportValue(val) {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    if (val.import !== undefined) {
      const imp = resolveExportValue(val.import);
      if (imp) return imp;
    }
    if (val.default !== undefined) {
      return resolveExportValue(val.default);
    }
  }
  return null;
}

function getWorkspaceMap(rootNorm) {
  let cached = workspaceCache.get(rootNorm);
  if (cached) return cached;
  cached = new Map();
  let entries;
  try {
    entries = readdirSync(join(rootNorm, 'packages'), { withFileTypes: true });
  } catch {
    workspaceCache.set(rootNorm, cached);
    return cached;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    try {
      const pkgJson = JSON.parse(readFileSync(join(rootNorm, 'packages', ent.name, 'package.json'), 'utf8'));
      if (typeof pkgJson?.name === 'string' && pkgJson.name.startsWith('@')) {
        cached.set(pkgJson.name, { pkgDir: `packages/${ent.name}`, pkgJson });
      }
    } catch {
      // Skip unreadable workspace package.json
    }
  }
  workspaceCache.set(rootNorm, cached);
  return cached;
}

function safePkgPath(pkgDir, relTarget) {
  const cleaned = String(relTarget).replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!cleaned || cleaned.startsWith('/')) return null;
  const joined = posix.normalize(`${pkgDir}/${cleaned}`);
  if (joined === pkgDir || !joined.startsWith(`${pkgDir}/`)) return null;
  return joined;
}

export function extractPolyglotSpecifiers(content, filePath) {
  if (typeof content !== 'string' || typeof filePath !== 'string') return [];
  const fp = filePath.replace(/\\/g, '/');
  const out = new Set();

  if (fp.endsWith('.py')) {
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) continue;
      const fromMatch = line.match(/^from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z_][A-Za-z0-9_.]*)\s+import\s+(.+)$/);
      if (fromMatch) {
        const mod = fromMatch[1];
        if (/^\.+$/.test(mod)) {
          for (const part of fromMatch[2].replace(/[()]/g, '').split(',')) {
            const ident = part.trim().split(/\s+as\s+/)[0].trim();
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) out.add(`${mod}${ident}`);
          }
        } else {
          out.add(mod);
        }
        continue;
      }
      const impMatch = line.match(/^import\s+(.+)$/);
      if (impMatch) {
        for (const part of impMatch[1].split(',')) {
          const mod = part.trim().split(/\s+as\s+/)[0].trim();
          if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(mod)) out.add(mod);
        }
      }
    }
    return [...out];
  }

  if (fp.endsWith('.rs')) {
    const stripped = content.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
    let m;
    const modRe = /(?:^|[;\s}])(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(?:r#)?([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
    while ((m = modRe.exec(stripped)) !== null) out.add(m[1]);

    const useRe = /(?:^|[;\s}])(?:pub(?:\s*\([^)]*\))?\s+)?use\s+(crate::[^;]+);/g;
    while ((m = useRe.exec(stripped)) !== null) {
      const rawUse = m[1].trim();
      const braceIdx = rawUse.indexOf('{');
      if (braceIdx !== -1) {
        const prefix = rawUse.slice(0, braceIdx).replace(/::\s*$/, '').trim();
        const inner = rawUse.slice(braceIdx + 1, rawUse.lastIndexOf('}'));
        if (prefix && prefix !== 'crate') out.add(prefix);
        for (const item of inner.split(',')) {
          const seg = item.trim().split(/\s+as\s+/)[0].replace(/::\*$/, '').trim();
          if (seg && seg !== 'self' && seg !== '*' && /^[A-Za-z0-9_:]+$/.test(seg)) {
            out.add(`${prefix}::${seg}`);
          }
        }
      } else {
        const cleaned = rawUse.replace(/::\*$/, '').split(/\s+as\s+/)[0].trim().replace(/r#/g, '');
        if (/^crate::[A-Za-z0-9_:]+$/.test(cleaned)) out.add(cleaned);
      }
    }
    return [...out];
  }

  const jsScopedRe = /(?:(?:import|from|require)\s+|(?:require|import)\s*\(\s*)['"](@[^/'"]+\/[^'"]+)['"]/g;
  let m;
  while ((m = jsScopedRe.exec(content)) !== null) out.add(m[1]);
  return [...out];
}

export function resolvePolyglotCandidates(specifier, importingFile, root) {
  if (typeof specifier !== 'string' || typeof importingFile !== 'string' || typeof root !== 'string') {
    return [];
  }
  const spec = specifier.trim();
  if (!spec) return [];

  const impNorm = importingFile.replace(/\\/g, '/').replace(/^\/+/, '');
  const rawDir = posix.dirname(impNorm);
  const impDir = rawDir === '.' ? '' : rawDir;
  const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '') || '/';

  if (impNorm.endsWith('.py')) {
    const relMatch = spec.match(/^(\.+)([A-Za-z0-9_.]*)$/);
    if (relMatch) {
      const upCount = relMatch[1].length - 1;
      const dirParts = impDir ? impDir.split('/') : [];
      if (upCount > dirParts.length) return [];
      const baseParts = dirParts.slice(0, dirParts.length - upCount);
      const modParts = relMatch[2] ? relMatch[2].split('.').filter(Boolean) : [];
      const fullParts = [...baseParts, ...modParts];
      if (fullParts.length === 0) return ['__init__.py'];
      const relBase = fullParts.join('/');
      return [`${relBase}.py`, `${relBase}/__init__.py`];
    }
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(spec)) {
      const modPath = spec.replace(/\./g, '/');
      return [`${modPath}.py`, `${modPath}/__init__.py`, `src/${modPath}.py`, `src/${modPath}/__init__.py`];
    }
    return [];
  }

  if (impNorm.endsWith('.rs')) {
    const crateMatch = spec.match(/^(?:(?:pub(?:\s*\([^)]*\))?\s+)?use\s+)?crate::([A-Za-z0-9_:#]+?)\s*;?$/);
    if (crateMatch) {
      const parts = crateMatch[1].split('::').map((s) => s.replace(/^r#/, '')).filter(Boolean);
      if (parts.length === 0) return [];
      const dirSegs = impDir ? impDir.split('/') : [];
      const srcIdx = dirSegs.lastIndexOf('src');
      const crateSrcDir = srcIdx !== -1 ? dirSegs.slice(0, srcIdx + 1).join('/') : impDir;
      const pfx = crateSrcDir ? `${crateSrcDir}/` : '';
      const full = parts.join('/');
      const candidates = [`${pfx}${full}.rs`, `${pfx}${full}/mod.rs`];
      if (parts.length >= 2) candidates.push(`${pfx}${parts.slice(0, -1).join('/')}.rs`);
      return [...new Set(candidates)];
    }
    const modMatch = spec.match(/^(?:(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+|mod::)?(?:r#)?([A-Za-z_][A-Za-z0-9_]*)\s*;?$/);
    if (modMatch) {
      const pfx = impDir ? `${impDir}/` : '';
      return [`${pfx}${modMatch[1]}.rs`, `${pfx}${modMatch[1]}/mod.rs`];
    }
    return [];
  }

  const wsMatch = spec.match(/^(@[^/]+\/[^/]+)(?:\/(.+))?$/);
  if (!wsMatch) return [];
  const [, pkgName, subpath] = wsMatch;
  const hit = getWorkspaceMap(rootNorm).get(pkgName);
  if (!hit) return [];
  const { pkgDir, pkgJson } = hit;
  if (!subpath) {
    const rawExports = pkgJson.exports;
    const dotVal = typeof rawExports === 'string' ? rawExports : rawExports?.['.'];
    const entry = resolveExportValue(dotVal) ?? (typeof pkgJson.main === 'string' ? pkgJson.main : null) ?? 'index.mjs';
    const resolved = safePkgPath(pkgDir, entry);
    return resolved ? [resolved] : [];
  }
  const subExport = resolveExportValue(pkgJson.exports?.['./' + subpath]);
  const base = safePkgPath(pkgDir, subExport ?? subpath);
  if (!base) return [];
  return [...new Set([base, `${base}.mjs`, `${base}.js`, `${base}.ts`, `${base}/index.mjs`, `${base}/index.js`, `${base}/index.ts`])];
}
