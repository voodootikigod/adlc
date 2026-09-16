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

/**
 * Resolve the filesystem location carried by an MCP Root object.
 *
 * Cursor 3.20 can return bare absolute paths instead of file: URIs. A URI
 * scheme requires at least two characters before ":" so Windows drive
 * letters are not misclassified as schemes.
 */
export function rootUriToPath(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return null;
  const raw = uri.trim();
  if (/^file:/i.test(raw)) return fileUriToPath(raw);

  const windows = raw.match(/^([A-Za-z]):[\\/](.*)$/);
  if (windows) {
    return normalizeRootPath(raw) || `${windows[1]}:\\${windows[2].replace(/\//g, '\\')}`;
  }

  const cursorWindows = raw.match(/^\/([A-Za-z]):\/(.*)$/);
  if (cursorWindows) {
    return normalizeRootPath(raw) || `${cursorWindows[1]}:\\${cursorWindows[2].replace(/\//g, '\\')}`;
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(raw)) return null;
  if (!raw.startsWith('/')) return null;
  return normalizeRootPath(raw);
}

/**
 * Decode a roots/list response without silently dropping invalid Root entries.
 *
 * @returns {{ ok: true, paths: string[] } | { ok: false, message: string }}
 */
export function decodeRootsListResult(result) {
  const roots = result?.roots;
  if (!Array.isArray(roots)) {
    return { ok: false, message: 'roots/list result must contain a roots array' };
  }
  const out = [];
  for (const [index, root] of roots.entries()) {
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      return { ok: false, message: `Root at index ${index} must be an object with a uri` };
    }
    const uri = root.uri;
    if (typeof uri !== 'string' || !uri.trim()) {
      return { ok: false, message: `Root at index ${index} must have a uri` };
    }
    const path = rootUriToPath(uri);
    if (!path) {
      return { ok: false, message: `Root at index ${index} has an unsupported or relative uri` };
    }
    out.push(path);
  }
  return { ok: true, paths: [...new Set(out)] };
}

/** Extract valid absolute paths for callers that do not need failure detail. */
export function pathsFromRootsListResult(result) {
  const roots = result?.roots;
  if (!Array.isArray(roots)) return [];
  const paths = [];
  for (const root of roots) {
    if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
    const path = rootUriToPath(root.uri);
    if (path) paths.push(path);
  }
  return [...new Set(paths)];
}
