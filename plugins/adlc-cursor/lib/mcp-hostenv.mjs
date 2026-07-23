// mcp-hostenv.mjs — thin host-env consumer-root resolver for MCP tests (T65).
// Production ship path is the lifecycle Roots proxy. This helper MUST NOT
// unlock "MCP shipped" claims and MUST NOT fall back to process.cwd().

import { normalizeRootPath, isAdlcBearing, classifyRoot } from './workspace-resolve.mjs';

/**
 * Resolve a single consumer root from host env only.
 * @returns {{ ok: true, root: string } | { ok: false, code: string, message: string }}
 */
export function resolveHostEnvRoot(env = process.env) {
  const raw = env.ADLC_CURSOR_MCP_ROOT ?? env.CURSOR_PROJECT_DIR ?? null;
  if (typeof raw !== 'string' || !raw.trim()) {
    return {
      ok: false,
      code: 'HOST_ENV_ABSENT',
      message:
        'ADLC MCP host-env root absent (set ADLC_CURSOR_MCP_ROOT for tests). ' +
        'Production uses the lifecycle Roots proxy; process.cwd() is never used.',
    };
  }
  const root = normalizeRootPath(raw.trim());
  if (!root) {
    return { ok: false, code: 'HOST_ENV_INVALID', message: `host env root is not a usable absolute path: ${raw}` };
  }
  if (!isAdlcBearing(root, env)) {
    return { ok: false, code: 'HOST_ENV_NOT_ADLC', message: `host env root is not ADLC-bearing: ${root}` };
  }
  const classified = classifyRoot(root, env);
  if (classified.kind === 'error-bearing') {
    return { ok: false, code: classified.code || 'HOST_ENV_ERROR', message: classified.message };
  }
  return { ok: true, root };
}
