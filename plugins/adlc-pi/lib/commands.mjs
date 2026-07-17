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

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadTickets, sha256 } from '@adlc/core';
import { ensureGitignore, ensureFormatterIgnores, ensureTicketStore } from '@adlc/core';
import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { ticketHash, writeActiveTicket } from '@adlc/tickets';
import { recordGateEvent } from './evidence.mjs';
import { buildRollbackCandidates } from './rollback.mjs';

// Parse a CLI's `--json` stdout into an object, or null when it is not JSON.
// pi.exec results carry stdout as a string; a non-JSON body (an operational
// error printed to stderr, an empty pass line) yields null so callers fall back
// to the exit code rather than throwing.
function parseJsonStdout(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

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
  const ticketsPathFor = (cwd) => {
    const configured = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS;
    return configured ? (isAbsolute(configured) ? configured : join(cwd, configured)) : join(cwd, '.adlc', 'tickets.json');
  };
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
      let ticketStore;
      try {
        mkdirSync(adlcDir, { recursive: true });
        ticketStore = ensureTicketStore(root);
      } catch (err) {
        ctx.ui.notify(`ADLC init failed to scaffold .adlc/: ${err.message}`, 'error');
        return;
      }

      // A legacy store remains fully usable until the human explicitly accepts
      // migration. Non-interactive init never prompts or migrates.
      if (ticketStore.legacyMigrationAvailable && ctx.hasUI) {
        let plan = null;
        try {
          const preview = await pi.exec('adlc', ['ticket', 'store', 'migrate', '--json'], { cwd: root });
          plan = parseJsonStdout(preview?.stdout);
        } catch {
          // The legacy store still works; preview failure is reported below.
        }
        if (!plan) {
          ctx.ui.notify('ADLC found legacy .adlc/tickets.json, but could not calculate a migration plan. Continuing on legacy storage.', 'warning');
        } else {
          const approved = await ctx.ui.confirm(
            'Migrate ticket storage?',
            `Replace .adlc/tickets.json with ${plan.ticketCount ?? '?'} independently mergeable ticket shard(s)? This changes representation only and does not commit files.`
          );
          if (approved) {
            try {
              const applied = await pi.exec('adlc', ['ticket', 'store', 'migrate', '--write', '--yes', '--json'], { cwd: root });
              if (applied?.code !== undefined && applied.code !== 0) throw new Error(applied.stderr || `exit ${applied.code}`);
              ticketStore = { backend: 'directory', created: true, legacyMigrationAvailable: false };
            } catch (err) {
              ctx.ui.notify(`ADLC migration failed; the recovery journal preserves the state: ${err.message}`, 'error');
              return;
            }
          } else {
            ctx.ui.notify('ADLC migration declined. Continuing on the legacy flat file; you can migrate later with `adlc ticket store migrate`.', 'info');
          }
        }
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
          `${ticketStore.created ? 'Created sharded ticket and archive stores' : `${ticketStore.backend} ticket store already present`}. ` +
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
      let chosenTicket;
      if (requested) {
        const match = tickets.find((t) => t.id === requested);
        if (!match) {
          ctx.ui.notify(`ADLC: ticket "${requested}" not found in the tickets file.`, 'error');
          return;
        }
        chosenId = match.id;
        chosenTicket = match;
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
        chosenTicket = tickets[idx];
      }

      // Activate: write the pointer DIRECTLY. This is the human acting through
      // a command handler, not the agent through a tool — the trust-root freeze
      // governs agent tool_call events, not this privileged path.
      //
      // Atomic (temp + rename): every hook re-reads this pointer on each tool
      // call, so a plain writeFileSync exposes a torn read to whatever is gating
      // concurrently. writeActiveTicket also guarantees the canonical
      // {id, ticketHash} shape — never a deprecated alias.
      try {
        writeActiveTicket(root, { id: chosenId, ticketHash: ticketHash(chosenTicket) });
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

  // =====================================================================
  // /adlc-accept <packet.json> — the P6 human acceptance gate (spec 4.5).
  // Wraps `adlc behavior-diff compare` (verdict shown to the human) and
  // `adlc accept` (recorded only on approve). The model cannot self-accept.
  // =====================================================================
  pi.registerCommand('adlc-accept', {
    description: 'Record human P6 acceptance (behavior-diff review + acceptance packet) as a confirm modal',
    async handler(args, ctx) {
      const root = ctx.cwd;
      const packetArg = (args ?? '').trim();
      if (!packetArg) {
        ctx.ui.notify('ADLC: /adlc-accept needs a packet path (e.g. /adlc-accept .adlc/packet.json).', 'error');
        return;
      }
      const packetPath = isAbsolute(packetArg) ? packetArg : join(root, packetArg);

      // Missing/unreadable/invalid packet → error notify, NO dialog, NO exec.
      let packet;
      try {
        packet = JSON.parse(readFileSync(packetPath, 'utf8'));
      } catch (err) {
        ctx.ui.notify(`ADLC: cannot read acceptance packet "${packetArg}": ${err.message}. Nothing recorded.`, 'error');
        return;
      }

      // Ticket: the active session ticket is authoritative; a packet-named
      // ticket is the fallback when no session ticket is set.
      const active = typeof getActive === 'function' ? getActive() : null;
      const ticketId =
        (active && active.ticketId) || (packet && typeof packet.ticket === 'string' ? packet.ticket : undefined);
      if (!ticketId) {
        ctx.ui.notify('ADLC: no active ticket and the packet names none — cannot accept. Nothing recorded.', 'error');
        return;
      }

      // Acceptance is a human decision — there is no confirm to prompt with in
      // non-TUI modes. Abort before running any CLI (spec: notify + abort).
      if (!ctx.hasUI) {
        ctx.ui.notify('ADLC: acceptance requires interactive confirmation (P6 is a human gate) — nothing recorded.', 'warning');
        return;
      }

      // behavior-diff compare when the packet references before/after captures
      // that exist. The verdict feeds the confirm summary; it never blocks.
      const before = typeof packet.before === 'string' ? packet.before : null;
      const after = typeof packet.after === 'string' ? packet.after : null;
      const haveDiff =
        before &&
        after &&
        existsSync(isAbsolute(before) ? before : join(root, before)) &&
        existsSync(isAbsolute(after) ? after : join(root, after));

      let diffLine = 'behavior-diff: not run (no before/after captures referenced in the packet)';
      if (haveDiff) {
        try {
          const res = await pi.exec('adlc', ['behavior-diff', 'compare', before, after, '--json']);
          const parsed = parseJsonStdout(res?.stdout);
          if (parsed && typeof parsed === 'object') {
            diffLine = `behavior-diff: ${parsed.changed ?? '?'} changed, ${parsed.unreachable ?? '?'} unreachable, ${parsed.identical ?? '?'} identical`;
          } else {
            diffLine = `behavior-diff: ran (exit ${res?.code ?? '?'}) — no structured verdict; review "${before}" vs "${after}" manually`;
          }
        } catch (err) {
          diffLine = `behavior-diff: FAILED to run (${err.message}) — review the captures manually`;
        }
      }

      const approved = await ctx.ui.confirm(
        'Accept ticket (P6 human gate)',
        `Record P6 acceptance for ticket ${ticketId} using packet "${packetArg}"?\n${diffLine}\nThis is the human acceptance gate — the model cannot self-accept.`
      );
      if (!approved) {
        // Declined or timed out (confirm resolves false/undefined) → record nothing.
        ctx.ui.notify('ADLC: acceptance declined — nothing recorded.', 'info');
        return;
      }

      const acceptArgs = ['accept', '--ticket', ticketId, '--packet', packetArg, '--json'];
      if (haveDiff) acceptArgs.push('--before', before, '--after', after);

      let res;
      try {
        res = await pi.exec('adlc', acceptArgs);
      } catch (err) {
        ctx.ui.notify(`ADLC: acceptance failed to run: ${err.message}. Nothing recorded.`, 'error');
        return;
      }
      const parsed = parseJsonStdout(res?.stdout);
      const ok = parsed ? parsed.ok === true : res?.code === 0;
      if (!ok) {
        const why = parsed && Array.isArray(parsed.errors) && parsed.errors.length
          ? parsed.errors.join('; ')
          : `exit ${res?.code ?? '?'}${res?.stderr ? `: ${res.stderr}` : ''}`;
        ctx.ui.notify(`ADLC: acceptance gate FAILED for ${ticketId}: ${why}. Not recorded.`, 'error');
        return;
      }

      // Mirror the human acceptance onto the pi evidence rail (the CLI already
      // recorded the p6-acceptance-packet; this is the session-side note).
      recordGateEvent({
        pi,
        ctx,
        root,
        ticketId,
        type: 'adlc-accept',
        detail: { packet: packetArg, revision: parsed?.revision ?? null, diff: diffLine, ok: true },
      });
      ctx.ui.notify(
        `ADLC: recorded P6 acceptance for ticket ${ticketId}${parsed?.revision ? ` at ${String(parsed.revision).slice(0, 12)}` : ''}.`,
        'info'
      );
    },
  });

  // =====================================================================
  // /adlc-rollback — fork the session back to a labeled pre-failure entry
  // (spec 4.6). ctx.fork exists ONLY on the command context; this is the
  // session-tree-native "undo" no sibling integration has.
  // =====================================================================
  pi.registerCommand('adlc-rollback', {
    description: 'Fork the session back to an earlier entry (session-tree-native rollback)',
    async handler(_args, ctx) {
      const root = ctx.cwd;

      // Defensive: the session-tree API and fork() must both be present. When
      // the shape differs from the types (fake/older ctx), notify — never throw.
      const sm = ctx?.sessionManager;
      if (!sm || typeof sm.getBranch !== 'function' || typeof ctx.fork !== 'function') {
        ctx.ui.notify('ADLC: rollback unavailable — the session-tree/fork API is not accessible in this context.', 'warning');
        return;
      }

      let branch;
      try {
        branch = sm.getBranch() ?? [];
      } catch (err) {
        ctx.ui.notify(`ADLC: rollback unavailable — could not read the session tree: ${err.message}`, 'warning');
        return;
      }

      const candidates = buildRollbackCandidates(branch);
      if (candidates.length === 0) {
        ctx.ui.notify('ADLC: no fork-eligible session entries to roll back to.', 'info');
        return;
      }

      // fork is a human decision; there is no select to drive in non-TUI modes.
      if (!ctx.hasUI) {
        ctx.ui.notify('ADLC: /adlc-rollback needs interactive selection — nothing done.', 'warning');
        return;
      }

      const options = candidates.map((c) => c.label);
      const picked = await ctx.ui.select('Roll back (fork) the session to which entry?', options);
      if (picked === undefined) {
        // Cancelled / timed out — fork nothing (spec AC3).
        ctx.ui.notify('ADLC: rollback cancelled — session unchanged.', 'info');
        return;
      }
      const idx = options.indexOf(picked);
      if (idx < 0) {
        ctx.ui.notify('ADLC: selection did not match a known entry — session unchanged.', 'warning');
        return;
      }
      const target = candidates[idx];

      try {
        const res = await ctx.fork(target.id);
        if (res && res.cancelled) {
          ctx.ui.notify('ADLC: fork cancelled — session unchanged.', 'info');
          return;
        }
      } catch (err) {
        ctx.ui.notify(`ADLC: fork failed: ${err.message}. Session unchanged.`, 'error');
        return;
      }

      const active = typeof getActive === 'function' ? getActive() : null;
      const ticketId = active && active.ticketId ? active.ticketId : undefined;
      recordGateEvent({ pi, ctx, root, ticketId, type: 'adlc-rollback', detail: { entryId: target.id, label: target.label } });
      ctx.ui.notify(`ADLC: rolled back (forked) to ${target.digest}.`, 'info');
    },
  });
}
