// extension.mjs — pi extension wiring for ADLC enforcement.
//
// All decisions live in rails-checker.mjs (delegating to @adlc/core); the
// post-tool verification layer lives in reactive-gate.mjs (snapshot-based —
// the gate never touches a file the tool did not write); all prompt text
// lives in doctrine.mjs. This module maps pi's extension events (v0.80.3
// contract: write/edit carry input.path, bash carries input.command) onto
// those pieces. index.ts is a typed shim around createExtension().

import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveActiveTicket,
  checkStructuredWrite,
  checkShellCommand,
  checkCustomTool,
  railHit,
  getAllowedSuppressions,
} from './rails-checker.mjs';
import {
  snapshotFile,
  restoreSnapshot,
  snapshotForBash,
  touchedSince,
  diffAddedLines,
  scanAddedLines,
  scanOperativeDelta,
  mergeViolations,
  BASH_SCAN_FILE_CAP,
} from './reactive-gate.mjs';
import { recordGateEvent } from './evidence.mjs';
import { parseAddedLines } from '@adlc/rails-guard/lib/suppressions.mjs';
import { appendToSystemPrompt, buildTicketDoctrine, buildErrorDoctrine } from './doctrine.mjs';
import { createFitnessTracker, checkBuildGate } from './build-gate.mjs';
import { createFlailTracker } from './flail.mjs';
import { registerCommands } from './commands.mjs';
import { renderWidgetLines } from './widget.mjs';
import { createRenderers } from './renderers.mjs';
import { registerProsecuteTool } from './prosecute-tool.mjs';
import { registerGateTool } from './gate-tool.mjs';
import { makeCompletionListener } from './completion.mjs';
import { makeCompactionListener, readSessionEntries } from './compaction.mjs';
import { makeShutdownListener } from './shutdown.mjs';

// Bound the pending-snapshot map: a blocked call never gets a tool_result, so
// stale entries are evicted oldest-first well past any realistic concurrency.
const SNAPSHOT_MAP_CAP = 100;

export function createExtension({ env = process.env } = {}) {
  return async function adlcPiExtension(pi) {
    let activeCwd = process.cwd();
    let active = { ticketId: null, ticket: null, error: null };
    let ticketStamp = null;
    const snapshots = new Map();
    const fitness = createFitnessTracker();
    const flail = createFlailTracker();
    const unvettedSeen = new Set();
    // Most recent gate event, summarized for the live widget (line 3).
    let lastGateEvent = null;
    // TUI-only message renderers, isolated so this module stays loadable under
    // `node --test` (no top-level @earendil-works/pi-tui import).
    const renderers = createRenderers();

    // ctx.getContextUsage() is TUI/SDK-provided; degrade to null when absent
    // (a missing signal must not crash the gate — compaction still covers it).
    function safeUsage(ctx) {
      try { return typeof ctx?.getContextUsage === 'function' ? ctx.getContextUsage() : null; }
      catch { return null; }
    }

    // =====================================================================
    // Live widget + gate-notice choke point (spec 3.2 / 3.3)
    // =====================================================================

    // Refresh the above-editor widget from live state. Shown ONLY while a
    // ticket resolves; cleared with undefined otherwise. All ui access is
    // guarded (setWidget is absent on older/fake ctx) — the widget is cosmetic
    // and must never break a gate (AC4).
    function refreshWidget(ctx) {
      const setWidget = ctx?.ui?.setWidget;
      if (typeof setWidget !== 'function') return;
      try {
        if (!active.ticketId) {
          setWidget.call(ctx.ui, 'adlc', undefined);
          return;
        }
        const usage = safeUsage(ctx);
        const lines = renderWidgetLines({
          ticketId: active.ticketId,
          ticketTitle: active.ticket?.title ?? null,
          enforcement: active.ticket ? 'active' : 'error',
          contextPercent: usage?.percent ?? null,
          degraded: fitness.isCompacted(),
          lastGateEvent,
        });
        setWidget.call(ctx.ui, 'adlc', lines.length ? lines : undefined);
      } catch {
        // A widget failure must never affect enforcement.
      }
    }

    // A short path-ish token for the widget's "last gate" line and the notice.
    function gateSummary(detail) {
      return detail?.path || detail?.paths?.[0] || detail?.tool || '';
    }

    // Deny/revert events render as structured 'adlc-gate-notice' messages in
    // addition to the per-site ctx.ui.notify (which stays the fallback).
    function shouldNoticeGate(type) {
      return /-deny$|-revert$/.test(type);
    }

    function emitGateNotice(type, detail) {
      try {
        const summary = gateSummary(detail);
        pi.sendMessage({
          customType: 'adlc-gate-notice',
          content: `ADLC ${type}${summary ? `: ${summary}` : ''}${detail?.reason ? ` — ${detail.reason}` : ''}`,
          display: true,
          details: { type, ticketId: active.ticketId, ...detail },
        });
      } catch {
        // Structured channel is best-effort; ctx.ui.notify already fired.
      }
    }

    // ONE choke point for every gate event: persist evidence, update the live
    // widget, and (for denies/reverts) emit the structured TUI notice. Call
    // sites pass only { ctx, type, detail }; pi/root/ticketId are filled here.
    function noteGate({ ctx, type, detail = {} }) {
      lastGateEvent = { type, summary: gateSummary(detail) };
      recordGateEvent({ pi, ctx, root: activeCwd, ticketId: active.ticketId, type, detail });
      refreshWidget(ctx);
      if (shouldNoticeGate(type)) emitGateNotice(type, detail);
    }

    function steerFlailAdvisories(filePath, ctx) {
      for (const churn of flail.recordMutation(filePath)) {
        const text = `ADLC flail advisory: ${churn.path} has been edited ${churn.count} times this session. Stop, re-read the failing evidence, and reconsider the approach before editing it again.`;
        ctx.ui.notify(text, 'warning');
        try {
          pi.sendMessage(
            { customType: 'adlc-flail-advisory', content: text, display: true },
            { deliverAs: 'steer' }
          );
        } catch {
          // Advisory only — a sendMessage failure must never affect the call.
        }
      }
    }

    function stampTicketFiles(cwd) {
      const mtime = (p) => {
        try { return statSync(join(cwd, p)).mtimeMs; } catch { return 'absent'; }
      };
      return `${env.ADLC_TICKET ?? ''}|${mtime('.adlc/current-ticket.json')}|${mtime(env.ADLC_TICKETS ?? '.adlc/tickets.json')}`;
    }

    function reload(cwd) {
      activeCwd = cwd ?? activeCwd;
      active = resolveActiveTicket(activeCwd, env);
      ticketStamp = stampTicketFiles(activeCwd);
      return active;
    }

    // Live ticket lifecycle: a ticket activated or switched mid-session is
    // picked up on the next turn via a cheap mtime check.
    function maybeReload(cwd) {
      const nextCwd = cwd ?? activeCwd;
      if (nextCwd !== activeCwd || stampTicketFiles(nextCwd) !== ticketStamp) reload(nextCwd);
    }

    function rememberSnapshot(toolCallId, snap) {
      if (snapshots.size >= SNAPSHOT_MAP_CAP) {
        const oldest = snapshots.keys().next().value;
        snapshots.delete(oldest);
      }
      snapshots.set(toolCallId, snap);
    }

    async function git(args) {
      const { stdout } = await pi.exec('git', args);
      return stdout;
    }

    // Structured renderers for our custom message types (spec 3.3). Registered
    // at load; guarded because registerMessageRenderer is absent on fake/older
    // pi (the notify fallback still covers those).
    try {
      pi.registerMessageRenderer?.('adlc-flail-advisory', renderers.flailAdvisory);
      pi.registerMessageRenderer?.('adlc-gate-notice', renderers.gateNotice);
    } catch {
      // Renderer registration is cosmetic — never fail extension load.
    }

    // Completion-protocol listener (spec 4.2): watches message_end for the
    // TICKET-DONE / TICKET-BLOCKED tokens the doctrine already demands.
    const completion = makeCompletionListener({
      pi,
      getActive: () => active,
      note: noteGate,
    });

    // Post-compaction ADLC-state re-assertion (spec 4.4): after any compaction,
    // re-assert unresolved enforcement state (recent denies/reverts, degraded
    // flag, active ticket) as a nextTurn digest so context-rot cannot silently
    // drop enforcement history.
    const compaction = makeCompactionListener({
      pi,
      getActive: () => active,
      getEntries: readSessionEntries,
      isDegraded: () => fitness.isCompacted(),
    });

    // Session-shutdown open-ticket capture (spec 4.5): on teardown, if a ticket
    // is active and the session ended carrying unresolved denies/reverts, append
    // one durable 'session-shutdown-open-ticket' manifest entry. Never blocks
    // shutdown; the session-side write is best-effort as the file may be closing.
    const shutdown = makeShutdownListener({
      pi,
      getActive: () => active,
      getCwd: () => activeCwd,
      getEntries: readSessionEntries,
    });

    // =====================================================================
    // Lifecycle
    // =====================================================================

    pi.on('session_start', async (_event, ctx) => {
      reload(ctx.cwd);
      fitness.reset();
      flail.reset();
      unvettedSeen.clear();
      lastGateEvent = null;
      refreshWidget(ctx);
      if (!active.ticketId) return;
      if (active.error) {
        ctx.ui.setStatus('adlc-ticket', `🎟️ Ticket: \x1b[31m${active.ticketId} (ERROR)\x1b[0m`);
        ctx.ui.notify(`ADLC Error: ${active.error}`, 'error');
      } else {
        ctx.ui.setStatus('adlc-ticket', `🎟️ Ticket: \x1b[33m${active.ticketId}\x1b[0m`);
        ctx.ui.notify(`ADLC Session Active: Ticket ${active.ticketId} loaded.`, 'info');
      }
    });

    pi.on('turn_start', async (_event, ctx) => {
      maybeReload(ctx?.cwd);
      // A new turn re-arms the once-per-turn completion listener (spec 4.2).
      completion.resetTurn();
      // Picks up a mid-session ticket switch AND clears the widget with
      // undefined once a ticket deactivates (AC2).
      refreshWidget(ctx);
    });

    // Completion-protocol interception: TICKET-DONE nudges prosecution,
    // TICKET-BLOCKED records the reason. Never rewrites the message.
    pi.on('message_end', completion.onMessageEnd);

    // A threshold/overflow compaction marks the session context-degraded for
    // the build gate; a manual /compact does not. Regardless of reason, re-assert
    // unresolved ADLC enforcement state (spec 4.4) — state loss is state loss.
    pi.on('session_compact', async (event, ctx) => {
      fitness.markCompaction(event.reason);
      // Surface the degraded flag in the widget immediately.
      refreshWidget(ctx);
      await compaction(event, ctx);
    });

    // Extension teardown (quit/reload/replacement): capture an open ticket with
    // unresolved enforcement state before the runtime goes away (spec 4.5).
    pi.on('session_shutdown', shutdown);

    // Append (never replace) the ADLC doctrine to the turn's system prompt.
    pi.on('before_agent_start', async (event, _ctx) => {
      if (active.ticketId && active.error) {
        return {
          systemPrompt: appendToSystemPrompt(
            event.systemPrompt,
            buildErrorDoctrine(active.ticketId, active.error)
          ),
        };
      }
      if (!active.ticket) return {};
      return {
        systemPrompt: appendToSystemPrompt(event.systemPrompt, buildTicketDoctrine(active.ticket)),
      };
    });

    // =====================================================================
    // Proactive gate (tool_call) — P3/P4 rails, scope, shell ladder
    // =====================================================================

    pi.on('tool_call', async (event, ctx) => {
      if (active.ticketId && (active.error || !active.ticket)) {
        return {
          block: true,
          reason: `ADLC Locked: enforcement context failed to load for "${active.ticketId}". ${active.error ?? ''}`,
        };
      }
      if (!active.ticket) return undefined;

      if (event.toolName === 'write' || event.toolName === 'edit') {
        const filePath = event.input?.path;
        if (typeof filePath !== 'string' || filePath.trim() === '') {
          // A mutating tool whose target cannot be extracted fails CLOSED.
          return { block: true, reason: `Blocked ${event.toolName}: no extractable target path (ticket ${active.ticketId})` };
        }
        const verdict = checkStructuredWrite(filePath, active.ticket, activeCwd);
        if (verdict.decision === 'deny') {
          ctx.ui.notify(`Blocked ${event.toolName}: ${verdict.reason}`, 'error');
          noteGate({ ctx, type: 'rail-deny', detail: { tool: event.toolName, path: filePath, reason: verdict.reason } });
          return { block: true, reason: `Blocked ${event.toolName}: ${verdict.reason} (ticket ${active.ticketId})` };
        }
        // Build-gate backstop (spec 2.1): a high-risk ticket in a degraded
        // context may not take structured mutations without an audited override.
        const gate = checkBuildGate({
          ticket: active.ticket,
          usage: safeUsage(ctx),
          compacted: fitness.isCompacted(),
          env,
          root: activeCwd,
        });
        if (gate.decision === 'deny') {
          ctx.ui.notify(`Build gate: ${gate.reason}`, 'error');
          noteGate({ ctx, type: 'build-gate-deny', detail: { tool: event.toolName, path: filePath, reason: gate.reason } });
          return { block: true, reason: `Blocked ${event.toolName} by the ADLC build gate: ${gate.reason} (ticket ${active.ticketId})` };
        }
        // Flail advisory (spec 2.2): never blocks.
        steerFlailAdvisories(filePath, ctx);
        // Snapshot the target so a post-write violation restores exactly this
        // state — never HEAD, never any other file.
        rememberSnapshot(event.toolCallId, { kind: 'file', snap: snapshotFile(activeCwd, filePath) });
        return undefined;
      }

      if (event.toolName === 'bash') {
        const command = event.input?.command;
        if (typeof command !== 'string') {
          return { block: true, reason: `Blocked bash: no extractable command (ticket ${active.ticketId})` };
        }
        const verdict = checkShellCommand(command, active.ticket, activeCwd);
        if (verdict.decision === 'deny') {
          ctx.ui.notify(`Blocked shell command: ${verdict.reason}`, 'error');
          noteGate({ ctx, type: 'shell-deny', detail: { reason: verdict.reason } });
          return { block: true, reason: `Blocked command: ${verdict.reason} (ticket ${active.ticketId})` };
        }
        if (verdict.mutating) {
          // Allowed transparent mutation: snapshot the rail set + dirty-file
          // stamps so the result gate inspects only what THIS call changed.
          try {
            const lsFiles = await git(['ls-files']);
            const status = await git(['status', '--porcelain']);
            rememberSnapshot(event.toolCallId, snapshotForBash(activeCwd, active.ticket, lsFiles, status));
          } catch {
            // Snapshot failure must not fail open silently at result time.
            rememberSnapshot(event.toolCallId, { kind: 'bash', railFiles: new Map(), preStamps: new Map(), degraded: true });
          }
        }
        return undefined;
      }

      // Third-party (custom) tool coverage (spec 2.5): rail-check extractable
      // targets; record no-target unknown tools as unvetted.
      const custom = checkCustomTool(event.toolName, event.input, active.ticket, activeCwd);
      if (custom.decision === 'deny') {
        ctx.ui.notify(`Blocked ${event.toolName}: ${custom.reason}`, 'error');
        noteGate({ ctx, type: 'custom-tool-deny', detail: { tool: event.toolName, reason: custom.reason } });
        return { block: true, reason: `Blocked ${event.toolName}: ${custom.reason} (ticket ${active.ticketId})` };
      }
      if (custom.unvetted && !unvettedSeen.has(event.toolName)) {
        // Once per tool name per session — evidence, not noise.
        unvettedSeen.add(event.toolName);
        noteGate({ ctx, type: 'unvetted-tool', detail: { tool: event.toolName } });
      }
      return undefined;
    });

    // user_bash advisory (spec 2.3): `!` commands are human-typed and bypass
    // tool gates by design. A command that would mutate a frozen rail is
    // warned about and recorded — never blocked.
    pi.on('user_bash', async (event, ctx) => {
      if (!active.ticket) return undefined;
      const verdict = checkShellCommand(event.command, active.ticket, activeCwd);
      // Advise on any MUTATING deny (rail hit, opaque git checkout/apply,
      // expansion, output-option smuggle…) — keying on the mutation class,
      // not the reason string, so `git checkout -- <rail>` is audited too
      // (P5 finding F2). Non-mutating unverifiable commands (npm run build)
      // stay silent: warning a human about every build command is noise.
      if (verdict.decision === 'deny' && verdict.mutating) {
        ctx.ui.notify(`ADLC: the agent would be denied this command under ticket ${active.ticketId} (${verdict.reason}) — running anyway (human override), recorded to evidence`, 'warning');
        noteGate({ ctx, type: 'user-bash-rail-override', detail: { command: event.command, reason: verdict.reason } });
      }
      return undefined;
    });

    // =====================================================================
    // Reactive gate (tool_result) — snapshot-scoped verification
    // =====================================================================

    async function verifyStructuredWrite(entry, ctx) {
      const { snap } = entry;
      const path = snap.path;
      const current = snapshotFile(activeCwd, path);
      const newContent = current.existed ? current.content ?? '' : '';
      const oldContent = snap.existed ? snap.content ?? '' : '';
      const added = diffAddedLines(oldContent, newContent, path);
      const allowed = getAllowedSuppressions(active.ticket);
      const violations = mergeViolations(
        scanAddedLines(added, new Map([[path, newContent]]), allowed, active.ticket.body),
        // Position-aware delta: catches a pre-existing marker line relocated
        // from an inert to an operative position (multiset-invisible).
        scanOperativeDelta(oldContent, newContent, path, allowed, active.ticket.body)
      );
      if (violations.length === 0) return undefined;

      const restored = restoreSnapshot(activeCwd, snap);
      ctx.ui.notify(`Blocked unallowed suppression marker: ${violations[0].marker}`, 'error');
      noteGate({ ctx, type: 'suppression-revert', detail: { path, markers: violations.map((v) => v.marker), restored } });
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `GATE FAILED: You introduced unallowed suppression markers:\n${violations
              .map((v) => `- ${v.file}:${v.lineNo} -> "${v.marker}" in "${v.content.trim()}"`)
              .join('\n')}\n${restored
              ? 'The write has been reverted to its pre-tool state (your other changes are untouched).'
              : 'The write could NOT be auto-reverted — remove the marker manually.'}\nTo use a marker, add "allow-suppression: ${violations[0].marker}" to the ticket body or allowedSuppressions in tickets.json.`,
          },
        ],
      };
    }

    async function verifyBash(entry, ctx) {
      // Rail integrity: compare every snapshotted rail file against its
      // pre-call state; restore exactly that state on any change.
      const railViolations = [];
      const unrestorable = [];
      for (const [path, snap] of entry.railFiles) {
        const now = snapshotFile(activeCwd, path);
        const changed = now.existed !== snap.existed || (now.content ?? '') !== (snap.content ?? '');
        if (!changed) continue;
        railViolations.push(path);
        if (!restoreSnapshot(activeCwd, snap)) unrestorable.push(path);
      }

      // New files created by THIS call that land on a rail glob (not in the
      // pre-call rail set) are removed — they did not exist before. On a
      // DEGRADED snapshot we cannot know whether the file pre-existed, so
      // deleting would destroy a rail that was merely modified; report it as
      // unrestorable instead (P5 finding: degraded-bash rail deletion).
      const postStatus = await git(['status', '--porcelain']);
      const touched = touchedSince(activeCwd, entry.preStamps, postStatus);
      for (const path of touched) {
        if (entry.railFiles.has(path)) continue;
        if (railHit(path, active.ticket, activeCwd)) {
          railViolations.push(path);
          if (entry.degraded) {
            unrestorable.push(path);
          } else if (!restoreSnapshot(activeCwd, { path, existed: false })) {
            unrestorable.push(path);
          }
        }
      }

      if (railViolations.length > 0) {
        ctx.ui.notify(`Blocked modifications to frozen rails: ${railViolations.join(', ')}`, 'error');
        noteGate({ ctx, type: 'bash-rail-revert', detail: { paths: railViolations, unrestorable, degraded: entry.degraded === true } });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GATE FAILED: This command modified frozen rails: ${railViolations.join(', ')}. ${
                unrestorable.length
                  ? `Restored to pre-command state except: ${unrestorable.join(', ')} — restore these manually.`
                  : 'They have been restored to their pre-command state (other changes are untouched).'
              }${entry.degraded ? ' (rail snapshot was degraded — verify the rail set manually)' : ''}`,
            },
          ],
        };
      }

      // Suppression scan over the files THIS call touched (bounded). A cap
      // trip is surfaced loudly — silent truncation would read as "scanned
      // everything" (P5 finding: silent suppression truncation).
      const nonRailTouched = touched.filter((p) => !railHit(p, active.ticket, activeCwd));
      const scanFiles = nonRailTouched.slice(0, BASH_SCAN_FILE_CAP);
      if (nonRailTouched.length > scanFiles.length) {
        ctx.ui.notify(
          `ADLC: suppression scan truncated to ${scanFiles.length} of ${nonRailTouched.length} touched files — the CI rails-guard gate remains the backstop`,
          'warning'
        );
      }
      const allViolations = [];
      const contents = new Map();
      for (const path of scanFiles) {
        const current = snapshotFile(activeCwd, path);
        const newContent = current.existed ? current.content ?? '' : '';
        contents.set(path, newContent);
        let added;
        if (entry.preStamps.has(path)) {
          // Was already dirty before the call: attribute via git (scoped to
          // this file; imperfect only if user and agent edited the same file).
          const diff = await git(['diff', 'HEAD', '--unified=0', '--', path]);
          added = parseAddedLines(diff);
        } else {
          // Created (or first dirtied) by this call: everything vs HEAD-state
          // is unattributable, so diff against nothing only for untracked
          // creations; tracked files fall back to the scoped git diff too.
          const diff = await git(['diff', 'HEAD', '--unified=0', '--', path]);
          added = diff.trim() ? parseAddedLines(diff) : diffAddedLines('', newContent, path);
        }
        allViolations.push(
          ...scanAddedLines(added, contents, getAllowedSuppressions(active.ticket), active.ticket.body)
        );
      }

      if (allViolations.length > 0) {
        ctx.ui.notify(`Blocked unallowed suppression marker: ${allViolations[0].marker}`, 'error');
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GATE FAILED: This command introduced unallowed suppression markers:\n${allViolations
                .map((v) => `- ${v.file}:${v.lineNo} -> "${v.marker}"`)
                .join('\n')}\nNo files were auto-reverted (shell writes are not snapshotted per-file) — remove the markers, or add "allow-suppression: ${allViolations[0].marker}" to the ticket body.`,
            },
          ],
        };
      }

      return undefined;
    }

    pi.on('tool_result', async (event, ctx) => {
      if (active.ticketId && (active.error || !active.ticket)) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'ADLC Locked: enforcement context failed to load. Tool changes rejected.' }],
        };
      }
      if (!active.ticket) return undefined;

      const entry = snapshots.get(event.toolCallId);
      if (!entry) return undefined;
      snapshots.delete(event.toolCallId);

      try {
        if (entry.kind === 'file') return await verifyStructuredWrite(entry, ctx);
        if (entry.kind === 'bash') return await verifyBash(entry, ctx);
      } catch (err) {
        ctx.ui.notify(`ADLC Error during verification: ${err.message}`, 'error');
        return {
          isError: true,
          content: [
            { type: 'text', text: `GATE FAILED: ADLC verification failed: ${err.message}. Fail-closed active.` },
          ],
        };
      }
      return undefined;
    });

    // =====================================================================
    // Commands
    // =====================================================================

    pi.registerCommand('ticket', {
      description: 'Display the active ADLC ticket and scope constraints',
      // pi command handlers receive (args, ctx) — the ctx-first shape was a
      // latent crash on live /ticket invocations (caught in T24 review).
      async handler(_args, ctx) {
        reload(ctx.cwd);

        if (!active.ticketId) {
          ctx.ui.notify('No active ADLC ticket resolved. Set ADLC_TICKET or .adlc/current-ticket.json', 'warning');
          return;
        }
        if (active.error) {
          ctx.ui.notify(`Ticket configuration failed to load: ${active.error}`, 'error');
          return;
        }

        const ticket = active.ticket;
        ctx.ui.notify(`Active Ticket: ${ticket.id}`, 'info');
        ctx.ui.notify(
          `${ticket.id}: ${ticket.title}\nScope: ${ticket.scope?.join(', ') || 'No restrictions'}\nRails: ${ticket.rails?.join(', ') || 'None declared'}\nAllowed Suppressions: ${getAllowedSuppressions(ticket).join(', ') || 'None allowed'}`,
          'info'
        );
      },
    });

    // Interactive `/adlc-*` command surface (spec Phase 3.1). Handlers act on
    // behalf of the human, so /adlc-ticket writes the trust-root pointer
    // directly and calls reload() so the next tool_call gates the new ticket.
    registerCommands(pi, {
      env,
      reload,
      getActive: () => active,
      getCwd: () => activeCwd,
    });

    // Native deterministic P5 prosecutor tool (spec 4.1). Registered LAST and
    // AWAITED so the tool exists before pi starts the agent loop (pi awaits the
    // extension factory — a fire-and-forget registration races an instant first
    // turn and loses). Loading TypeBox (a pi-runtime-only peer) throws under a
    // plain `node --test`, so the failure is swallowed: there the tool simply
    // never registers and the /adlc-prosecute command + CI remain the backstop.
    // All pi.on/registerCommand wiring above ran synchronously already, so unit
    // tests that read pi.handlers without awaiting this factory still see them.
    const noteFromTool = (evt) => noteGate({ ctx: null, type: evt.type, detail: evt.detail });
    await registerProsecuteTool(pi, {
      pi,
      getActive: () => active,
      getCwd: () => activeCwd,
      env,
      note: noteFromTool,
    }).catch(() => {
      // Best-effort at load — see above.
    });

    // Native adlc_gate tool (spec 4.3): the model runs deterministic gates
    // through the rails-aware argv policy instead of shelling `adlc <gate>`.
    // Awaited (TypeBox load) and swallowed under a plain `node --test`, exactly
    // like adlc_prosecute above.
    await registerGateTool(pi, {
      pi,
      getActive: () => active,
      getCwd: () => activeCwd,
      note: noteFromTool,
    }).catch(() => {
      // Best-effort at load — see above.
    });

    // Exposed for tests only (not part of the pi extension contract).
    return { reload, getActive: () => active };
  };
}
