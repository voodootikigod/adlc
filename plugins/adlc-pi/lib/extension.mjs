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
  BASH_SCAN_FILE_CAP,
} from './reactive-gate.mjs';
import { parseAddedLines } from '@adlc/rails-guard/lib/suppressions.mjs';
import { appendToSystemPrompt, buildTicketDoctrine, buildErrorDoctrine } from './doctrine.mjs';

// Bound the pending-snapshot map: a blocked call never gets a tool_result, so
// stale entries are evicted oldest-first well past any realistic concurrency.
const SNAPSHOT_MAP_CAP = 100;

export function createExtension({ env = process.env } = {}) {
  return function adlcPiExtension(pi) {
    let activeCwd = process.cwd();
    let active = { ticketId: null, ticket: null, error: null };
    let ticketStamp = null;
    const snapshots = new Map();

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

    // =====================================================================
    // Lifecycle
    // =====================================================================

    pi.on('session_start', async (_event, ctx) => {
      reload(ctx.cwd);
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
    });

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
          return { block: true, reason: `Blocked ${event.toolName}: ${verdict.reason} (ticket ${active.ticketId})` };
        }
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
      const added = diffAddedLines(snap.existed ? snap.content ?? '' : '', newContent, path);
      const violations = scanAddedLines(
        added,
        new Map([[path, newContent]]),
        getAllowedSuppressions(active.ticket),
        active.ticket.body
      );
      if (violations.length === 0) return undefined;

      const restored = restoreSnapshot(activeCwd, snap);
      ctx.ui.notify(`Blocked unallowed suppression marker: ${violations[0].marker}`, 'error');
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
      async handler(ctx) {
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

    // Exposed for tests only (not part of the pi extension contract).
    return { reload, getActive: () => active };
  };
}
