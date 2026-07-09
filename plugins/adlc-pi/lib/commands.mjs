// commands.mjs — the interactive `/adlc-*` command trio for pi (spec Phase 3.1).
//
// These are registerCommand handlers (signature `(args, ctx)` per the pi
// v0.80.3 contract), NOT agent tools. That distinction is load-bearing: the
// rail trust-root freeze governs the AGENT acting through tool_call events —
// it does not govern a human driving these command handlers, so /adlc-ticket
// may write `.adlc/current-ticket.json` directly (the privileged path the spec
// calls out) while an agent write to the same file is denied by the gate.
//
// Every dialog result is checked for `undefined`/false so the commands degrade
// cleanly in non-TUI modes (rpc/json/print): pi's dialogs resolve undefined
// there (ctx.hasUI === false in print/json), and a command must notify + return
// rather than hang or throw.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadTickets, sha256 } from '@adlc/core';
import { ensureGitignore, ensureFormatterIgnores } from '@adlc/core';
import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { recordGateEvent } from './evidence.mjs';

/**
 * Register the interactive command trio on a pi ExtensionAPI.
 *
 * @param {object} pi - the ExtensionAPI (registerCommand, exec, appendEntry)
 * @param {object} deps
 * @param {object} deps.env - environment (ADLC_TICKETS override)
 * @param {(cwd: string) => object} deps.reload - the extension's reload path;
 *   called after activation so the NEXT tool_call gates the new ticket without
 *   waiting for a turn boundary (spec AC2).
 * @param {() => {ticketId: string|null}} deps.getActive - current active ticket.
 * @param {() => string} deps.getCwd - the extension's live cwd, for the
 *   completion callback (which pi calls without a ctx).
 */
export function registerCommands(pi, { env = process.env, reload, getActive, getCwd } = {}) {
  const ticketsPathFor = (cwd) => env.ADLC_TICKETS ?? join(cwd, '.adlc', 'tickets.json');
  const ticketLabel = (t) => (t.title ? `${t.id} — ${t.title}` : t.id);

  // =====================================================================
  // /adlc-init — scaffold .adlc/ + hygiene ignores. Idempotent; never clobbers.
  // =====================================================================
  pi.registerCommand('adlc-init', {
    description: 'Bootstrap the ADLC runtime (.adlc/) and hygiene ignores in this repo',
    async handler(_args, ctx) {
      const root = ctx.cwd;

      // Never scaffold a workspace whose gates cannot run: a missing/failing
      // `adlc` CLI stops here with the install command (spec AC5). pi.exec may
      // reject (ENOENT) or resolve with a non-zero code — treat either as
      // missing.
      let cliOk = true;
      try {
        const res = await pi.exec('adlc', ['--version']);
        if (res && typeof res.code === 'number' && res.code !== 0) cliOk = false;
      } catch {
        cliOk = false;
      }
      if (!cliOk) {
        ctx.ui.notify('ADLC CLI not found. Install it first: npm install -g @adlc/cli', 'error');
        return;
      }

      const adlcDir = join(root, '.adlc');
      const ticketsPath = join(adlcDir, 'tickets.json');
      let ticketsCreated = false;
      try {
        mkdirSync(adlcDir, { recursive: true });
        if (!existsSync(ticketsPath)) {
          writeFileSync(ticketsPath, JSON.stringify({ tickets: [] }, null, 2) + '\n');
          ticketsCreated = true;
        }
      } catch (err) {
        ctx.ui.notify(`ADLC init failed to scaffold .adlc/: ${err.message}`, 'error');
        return;
      }

      // Track the contract, ignore the runtime; exclude .adlc/ from whatever
      // formatter/linter the repo already uses. Both core helpers are
      // idempotent — a second run changes nothing (spec AC5).
      let gi;
      let fmt;
      try {
        gi = ensureGitignore(root);
        fmt = ensureFormatterIgnores(root);
      } catch (err) {
        ctx.ui.notify(`ADLC init: hygiene step failed: ${err.message}`, 'error');
        return;
      }

      const giMsg = gi.changed
        ? `.gitignore updated (${gi.added.length ? gi.added.join(', ') : 'ordering fix'})`
        : '.gitignore already correct';
      const fmtChanged = Object.entries(fmt)
        .filter(([, r]) => r && r.changed)
        .map(([tool]) => tool);
      const fmtMsg = fmtChanged.length
        ? `formatter/linter ignores updated: ${fmtChanged.join(', ')}`
        : 'formatter/linter ignores unchanged';

      ctx.ui.notify(
        `ADLC init complete. ` +
          `${ticketsCreated ? 'Created .adlc/tickets.json' : '.adlc/tickets.json already present'}. ` +
          `${giMsg}. ${fmtMsg}.`,
        'info'
      );
    },
  });

  // =====================================================================
  // /adlc-ticket [id] — activate a ticket (picker or by id) + reload.
  // =====================================================================
  pi.registerCommand('adlc-ticket', {
    description: 'Activate an ADLC ticket (picker or by id) and reload enforcement',
    // Completes ticket ids. pi invokes this WITHOUT a ctx, so cwd comes from
    // the extension's live accessor; any failure degrades to no completions.
    getArgumentCompletions(prefix) {
      try {
        const cwd = typeof getCwd === 'function' ? getCwd() : process.cwd();
        const { tickets } = loadTickets(ticketsPathFor(cwd));
        const items = tickets
          .filter((t) => typeof t.id === 'string' && t.id.startsWith(prefix ?? ''))
          .map((t) => ({ value: t.id, label: ticketLabel(t) }));
        return items.length > 0 ? items : null;
      } catch {
        return null;
      }
    },
    async handler(args, ctx) {
      const root = ctx.cwd;
      const { tickets, errors } = loadTickets(ticketsPathFor(root));
      // Only hard-fail when there is nothing selectable: an unreadable/missing
      // file yields empty tickets + errors; soft per-ticket validation warnings
      // on an otherwise-populated file must not block activating a valid id.
      if (tickets.length === 0) {
        const why = errors && errors.length ? errors[0] : 'no tickets found';
        ctx.ui.notify(`ADLC: ${why}. Run /adlc-init or author a ticket first.`, errors && errors.length ? 'error' : 'warning');
        return;
      }

      const requested = (args ?? '').trim();
      let chosenId;
      if (requested) {
        const match = tickets.find((t) => t.id === requested);
        if (!match) {
          ctx.ui.notify(`ADLC: ticket "${requested}" not found in the tickets file.`, 'error');
          return;
        }
        chosenId = match.id;
      } else {
        // No id → interactive picker. In non-TUI modes select() resolves
        // undefined, so require an explicit id there instead of prompting.
        if (!ctx.hasUI) {
          ctx.ui.notify('ADLC: /adlc-ticket needs a ticket id in non-interactive mode (e.g. /adlc-ticket T1).', 'warning');
          return;
        }
        const options = tickets.map(ticketLabel);
        const picked = await ctx.ui.select('Select the active ADLC ticket', options);
        if (picked === undefined) {
          // Cancelled / timed out — leave state untouched (spec AC3).
          ctx.ui.notify('ADLC: ticket selection cancelled — active ticket unchanged.', 'info');
          return;
        }
        const idx = options.indexOf(picked);
        if (idx < 0) {
          ctx.ui.notify('ADLC: selection did not match a known ticket — active ticket unchanged.', 'warning');
          return;
        }
        chosenId = tickets[idx].id;
      }

      // Activate: write the pointer DIRECTLY. This is the human acting through
      // a command handler, not the agent through a tool — the trust-root freeze
      // governs agent tool_call events, not this privileged path.
      const currentPath = join(root, '.adlc', 'current-ticket.json');
      try {
        mkdirSync(join(root, '.adlc'), { recursive: true });
        writeFileSync(currentPath, JSON.stringify({ id: chosenId }, null, 2) + '\n');
      } catch (err) {
        ctx.ui.notify(`ADLC: failed to write current-ticket.json: ${err.message}`, 'error');
        return;
      }

      // Evidence rail (best-effort; never blocks the switch).
      recordGateEvent({ pi, ctx, root, ticketId: chosenId, type: 'ticket-switch', detail: { to: chosenId } });

      // Reload NOW so the very next tool_call gates against the new ticket —
      // no turn boundary needed (spec AC2).
      if (typeof reload === 'function') reload(root);
      ctx.ui.notify(`ADLC: active ticket set to ${chosenId}. Enforcement reloaded.`, 'info');
    },
  });

  // =====================================================================
  // /adlc-approve-spec <spec-path> — the G1 human gate as a real confirm modal.
  // =====================================================================
  pi.registerCommand('adlc-approve-spec', {
    description: 'Record human spec approval (P1 Gate 1) as a confirm modal',
    async handler(args, ctx) {
      const root = ctx.cwd;
      const specArg = (args ?? '').trim();
      if (!specArg) {
        ctx.ui.notify('ADLC: /adlc-approve-spec needs a spec path (e.g. /adlc-approve-spec .adlc/specs/foo.md).', 'error');
        return;
      }
      const specPath = isAbsolute(specArg) ? specArg : join(root, specArg);

      // Missing/unreadable spec → error notify, NO dialog (spec AC4).
      let bytes;
      try {
        bytes = readFileSync(specPath);
      } catch (err) {
        ctx.ui.notify(`ADLC: cannot read spec "${specArg}": ${err.message}. Nothing recorded.`, 'error');
        return;
      }

      // G1 is a human decision — the model cannot self-approve, and there is no
      // dialog to prompt with in non-TUI modes. Record nothing and say so.
      if (!ctx.hasUI) {
        ctx.ui.notify('ADLC: spec approval requires interactive confirmation (G1 is a human gate) — nothing recorded.', 'warning');
        return;
      }

      const approved = await ctx.ui.confirm(
        'Approve spec (P1 G1)',
        `Record your human approval of "${specArg}"? This is the G1 gate — the model cannot self-approve.`
      );
      if (!approved) {
        // Declined or timed out (confirm resolves false) → record nothing.
        ctx.ui.notify('ADLC: spec approval declined — nothing recorded.', 'info');
        return;
      }

      const hash = sha256(bytes);
      const active = typeof getActive === 'function' ? getActive() : null;
      const ticketId = active && active.ticketId ? active.ticketId : undefined;
      try {
        // Chain-valid manifest entry naming the spec + its sha256 (spec AC4).
        record({
          gate: 'spec-approval',
          ticket: ticketId,
          rawData: JSON.stringify({ spec: specArg, sha256: hash, verdict: 'approved' }),
          dir: join(root, '.adlc'),
        });
      } catch (err) {
        ctx.ui.notify(`ADLC: failed to record spec approval: ${err.message}`, 'error');
        return;
      }
      ctx.ui.notify(
        `ADLC: recorded spec approval for "${specArg}" (sha256 ${hash.slice(0, 12)}…)${ticketId ? ' on ticket ' + ticketId : ''}.`,
        'info'
      );
    },
  });
}
