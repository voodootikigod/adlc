// Action planning (plan §5.3). Pure logic behind bin/action.mjs, pinned by
// test/action.test.mjs. Invariants: fail closed on malformed context or an
// unresolvable repo (a clear notification plan, nothing spawned); every
// executable plan is a fixed argv array resolved from trusted PATH (fleet
// K1/A2); every plan echoes the resolved repo + ticket; all rendered text is
// sanitized.
import { sanitize, sanitizeToken } from './sanitize.mjs';

// A leading hyphen would let an id read from untrusted .adlc/ state or herdr
// context be delivered to a CLI as an OPTION instead of an operand (CWE-88
// argument injection). Forbid it in first position; spawn plans also insert a
// `--` end-of-options separator before every externally-derived positional.
const PANE_ID_RE = /^[A-Za-z0-9:_][A-Za-z0-9:_-]*$/;
const TICKET_ID_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/** Validate HERDR_PLUGIN_CONTEXT_JSON (live-probed shape, 2026-07-23). */
export function parseContext(jsonText) {
  if (typeof jsonText !== 'string') return { ok: false, reason: 'missing context' };
  let ctx;
  try {
    ctx = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: 'malformed context JSON' };
  }
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return { ok: false, reason: 'malformed context' };
  if (typeof ctx.focused_pane_id !== 'string' || !PANE_ID_RE.test(ctx.focused_pane_id)) {
    return { ok: false, reason: 'missing or invalid pane id' };
  }
  if (ctx.focused_pane_cwd !== undefined && typeof ctx.focused_pane_cwd !== 'string') {
    return { ok: false, reason: 'invalid pane cwd' };
  }
  return { ok: true, ctx };
}

/** Resolve the target repo: live foreground_cwd, then pane cwd, then the
 *  context's (launch-time) cwd. Fails closed when nothing resolves. */
export function resolveTarget({ ctx, paneInfo, resolveRepoRoot }) {
  const dir = (paneInfo && typeof paneInfo.foreground_cwd === 'string' && paneInfo.foreground_cwd)
    || (paneInfo && typeof paneInfo.cwd === 'string' && paneInfo.cwd)
    || (ctx && typeof ctx.focused_pane_cwd === 'string' && ctx.focused_pane_cwd)
    || null;
  if (!dir) return { ok: false, reason: 'no directory for pane' };
  let root = null;
  try {
    root = resolveRepoRoot(dir);
  } catch {
    root = null;
  }
  if (typeof root !== 'string' || root.length === 0) return { ok: false, reason: 'not inside a git repository' };
  return { ok: true, repoRoot: root };
}

/** Plan an action. Returns {kind:'refuse'|'gate'|'spawn-pane', ...} — plans
 *  carry fixed argv arrays only; execution stays in bin/action.mjs. */
export function planAction(actionId, target, active, opts = {}) {
  const refuse = (body) => ({ kind: 'refuse', title: 'ADLC', body: sanitize(body), sound: 'request' });
  if (!target || target.ok !== true) {
    return refuse('cannot act: pane does not resolve to a git repository');
  }
  const { repoRoot } = target;
  const ticketLabel = active?.state === 'active' ? active.id : 'none';
  const echo = `repo ${repoRoot} · ticket ${sanitizeToken(String(ticketLabel))}`;
  switch (actionId) {
    case 'gate':
      // --allow-legacy-unsigned tolerates a repo's honest pre-signing history
      // without weakening detection of real tampering — see
      // packages/gate-manifest/lib/verify.mjs.
      return { kind: 'gate', argv: ['adlc', 'gate-manifest', 'verify', '--json', '--allow-legacy-unsigned'], cwd: repoRoot, echo };
    case 'ticket-show': {
      if (!active || active.state !== 'active') return refuse(`no active or readable ticket to show (${echo})`);
      if (!TICKET_ID_RE.test(active.id)) return refuse('active ticket id fails validation');
      const pluginRoot = typeof opts.pluginRoot === 'string' ? opts.pluginRoot : '.';
      return {
        kind: 'spawn-pane',
        herdrArgs: [
          'agent', 'start', 'adlc-ticket', '--cwd', repoRoot, '--split', 'down', '--',
          'node', `${pluginRoot}/bin/show-ticket.mjs`, repoRoot, active.id,
        ],
        echo,
      };
    }
    case 'prosecute':
      return {
        kind: 'spawn-pane',
        requiresBin: 'adversarial-review',
        herdrArgs: [
          'agent', 'start', 'adlc-p5', '--cwd', repoRoot, '--split', 'right', '--',
          'adversarial-review', '--base', 'main',
        ],
        echo,
      };
    case 'ticket-complete': {
      // Completing writes the trust root, so this action only PREVIEWS: it spawns
      // `adlc ticket complete <id>` as a dry-run (no --write); the human drives
      // the actual completion in the pane. The id comes from .adlc/ state, so it
      // is validated (a leading hyphen would be arg-injection into adlc).
      if (!active || active.state !== 'active') return refuse(`no active ticket to complete (${echo})`);
      if (!TICKET_ID_RE.test(active.id)) return refuse('active ticket id fails validation');
      return {
        kind: 'spawn-pane',
        requiresBin: 'adlc',
        herdrArgs: [
          'agent', 'start', 'adlc-complete', '--cwd', repoRoot, '--split', 'down', '--',
          'adlc', 'ticket', 'complete', active.id,
        ],
        echo,
      };
    }
    case 'adlc-init':
      // Bootstraps .adlc/ in the pane's repo — no active ticket required (this is
      // how a repo GETS one). Fixed argv of the trusted `adlc` binary.
      return {
        kind: 'spawn-pane',
        requiresBin: 'adlc',
        herdrArgs: [
          'agent', 'start', 'adlc-init', '--cwd', repoRoot, '--split', 'down', '--',
          'adlc', 'init',
        ],
        echo,
      };
    default:
      return refuse(`unknown action: ${actionId}`);
  }
}

/** The exact herdr argv for a notification — argv construction stays in
 *  tested code (bin glue only passes it through the shim). */
export function notifyArgs(title, body, sound = 'request') {
  return ['notification', 'show', sanitizeToken(String(title), 80), '--body', sanitize(String(body)), '--sound', sound];
}

/** Render the gate verify result as a notification plan; fail soft on
 *  unreadable output; strip escapes from everything. */
export function gateNotification(output, echo) {
  const cleanEcho = sanitize(String(echo ?? ''));
  let parsed = null;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.valid !== 'boolean') {
    return { title: 'ADLC gate', body: `${cleanEcho}\ngate output unreadable`, sound: 'request' };
  }
  const message = sanitize(typeof parsed.message === 'string' ? parsed.message : String(parsed.valid));
  return {
    title: parsed.valid ? 'ADLC gate: pass' : 'ADLC gate: FAIL',
    body: `${cleanEcho}\n${message}`,
    sound: parsed.valid ? 'done' : 'request',
  };
}
