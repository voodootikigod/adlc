// flail-inline.mjs — self-contained target-file edit churn tracking for adlc-antigravity.
// Uses ONLY Node builtins (no npm @adlc/* runtime dependencies).

export const DEFAULT_FLAIL_THRESHOLD = 3;
export const DEFAULT_WINDOW = 200;

export function detectEditChurn(logLines, threshold = DEFAULT_FLAIL_THRESHOLD) {
  const counts = new Map();
  for (const line of logLines) {
    const match = typeof line === 'string' ? line.match(/^Editing\s+(.+)$/) : null;
    if (match?.[1]) {
      const path = match[1].trim();
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  const result = [];
  for (const [path, count] of counts.entries()) {
    if (count >= threshold) result.push({ path, count });
  }
  return result;
}

export function createFlailTracker({ window = DEFAULT_WINDOW, threshold = DEFAULT_FLAIL_THRESHOLD } = {}) {
  const lines = new Map();
  const warned = new Map();

  return {
    record({ sessionID, tool, filePath }) {
      if (!sessionID || !filePath) return { churning: [] };
      const buf = lines.get(sessionID) ?? [];
      buf.push(`Editing ${filePath}`);
      if (buf.length > window) buf.splice(0, buf.length - window);
      lines.set(sessionID, buf);

      const seen = warned.get(sessionID) ?? new Set();
      const churning = detectEditChurn(buf, threshold).filter((c) => !seen.has(c.path));
      for (const c of churning) seen.add(c.path);
      warned.set(sessionID, seen);

      return { churning };
    },
    evict(sessionID) {
      lines.delete(sessionID);
      warned.delete(sessionID);
    },
  };
}

export function flailMessage({ path, count }) {
  return `ADLC flail check: ${path} has been edited ${count}× this session — repeated rewrites often signal the model is stuck. Consider stepping back or starting a fresh session.`;
}
