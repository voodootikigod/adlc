// mcp-file-uri.mjs — decode MCP Roots `file://` URIs to absolute paths (T65).

import { normalizeRootPath } from './workspace-resolve.mjs';

/**
 * Decode a Roots `uri` into a normalized absolute filesystem path, or null.
 * Supports `file:///path`, `file://localhost/path`, and Windows
 * `file:///C:/...` / `file://localhost/C:/...`.
 */
export function fileUriToPath(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return null;
  let raw = uri.trim();
  if (!/^file:/i.test(raw)) return null;

  try {
    const u = new URL(raw);
    let pathname = decodeURIComponent(u.pathname || '');
    // Windows: /C:/Users/... → C:/Users/...
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    // file://localhost/C:/... already covered by pathname
    if (u.hostname && u.hostname !== 'localhost' && u.hostname !== '') {
      // UNC-style file://server/share — not used by Cursor Roots today
      pathname = `//${u.hostname}${pathname}`;
    }
    return normalizeRootPath(pathname) || (pathname ? normalizeRootPath(pathname.replace(/\//g, '\\')) : null) || pathname || null;
  } catch {
    return null;
  }
}

/** Extract absolute paths from a roots/list result payload. */
export function pathsFromRootsListResult(result) {
  const roots = result?.roots;
  if (!Array.isArray(roots)) return [];
  const out = [];
  for (const root of roots) {
    const uri = root?.uri ?? root?.URL ?? root?.url;
    const p = fileUriToPath(uri);
    if (p) out.push(p);
  }
  return [...new Set(out)];
}
