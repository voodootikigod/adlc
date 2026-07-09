// extension.mjs — pi extension wiring for ADLC enforcement.
//
// All decisions live in rails-checker.mjs (delegating to @adlc/core); all
// prompt text lives in doctrine.mjs. This module maps pi's extension events
// (v0.80.3 contract: write/edit carry input.path, bash carries input.command)
// onto those decisions. index.ts is a typed shim around createExtension().

import {
  resolveActiveTicket,
  checkStructuredWrite,
  checkShellCommand,
  railHit,
  getAllowedSuppressions,
  SUPPRESSION_MARKERS,
} from './rails-checker.mjs';
import { appendToSystemPrompt, buildTicketDoctrine, buildErrorDoctrine } from './doctrine.mjs';

export function createExtension({ env = process.env } = {}) {
  return function adlcPiExtension(pi) {
    let activeCwd = process.cwd();
    let active = { ticketId: null, ticket: null, error: null };

    function reload(cwd) {
      activeCwd = cwd ?? activeCwd;
      active = resolveActiveTicket(activeCwd, env);
      return active;
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
        return undefined;
      }

      return undefined;
    });

    // =====================================================================
    // Reactive gate (tool_result) — diff-based rail revert + suppression scan.
    // Known blast-radius issues (whole-file HEAD revert, `git add -N .`,
    // repo-wide diff) are ticket T21's deliverable; behavior preserved here.
    // =====================================================================

    pi.on('tool_result', async (event, ctx) => {
      if (active.ticketId && (active.error || !active.ticket)) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'ADLC Locked: enforcement context failed to load. Tool changes rejected.' }],
        };
      }
      if (!active.ticket) return undefined;
      if (event.toolName !== 'write' && event.toolName !== 'edit' && event.toolName !== 'bash') {
        return undefined;
      }

      try {
        // Make untracked files visible to git diff (intent-to-add).
        await pi.exec('git', ['add', '-N', '.']);

        const { stdout: filesText } = await pi.exec('git', ['diff', 'HEAD', '--name-only']);
        const modifiedFiles = filesText.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);

        const railViolations = modifiedFiles.filter((f) => railHit(f, active.ticket, activeCwd));
        if (railViolations.length > 0) {
          ctx.ui.notify(`Blocked modifications to frozen rails: ${railViolations.join(', ')}`, 'error');
          for (const f of railViolations) {
            await pi.exec('git', ['checkout', 'HEAD', '--', f]);
            await pi.exec('git', ['reset', 'HEAD', f]);
          }
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `GATE FAILED: You modified frozen rails: ${railViolations.join(', ')}. These modifications have been automatically reverted.`,
              },
            ],
          };
        }

        const { stdout: diffText } = await pi.exec('git', ['diff', 'HEAD']);
        if (!diffText.trim()) return undefined;

        const violations = [];
        let currentFile = '';
        let lineCount = 0;
        const allowedSuppressions = getAllowedSuppressions(active.ticket);

        for (const line of diffText.split(/\r?\n/)) {
          if (line.startsWith('+++ b/')) {
            currentFile = line.slice(6).trim();
            lineCount = 0;
            continue;
          }
          if (line.startsWith('@@')) {
            const match = line.match(/\+(\d+)/);
            if (match) lineCount = parseInt(match[1], 10) - 1;
            continue;
          }
          if (line.startsWith('+') && !line.startsWith('+++')) {
            lineCount++;
            const addedContent = line.slice(1);
            for (const marker of SUPPRESSION_MARKERS) {
              if (addedContent.includes(marker) && !allowedSuppressions.includes(marker)) {
                violations.push({ file: currentFile, lineNo: lineCount, marker, content: addedContent.trim() });
              }
            }
          } else if (!line.startsWith('-')) {
            lineCount++;
          }
        }

        if (violations.length > 0) {
          ctx.ui.notify(`Blocked unallowed suppression marker: ${violations[0].marker}`, 'error');
          const uniqueFiles = Array.from(new Set(violations.map((v) => v.file)));
          for (const f of uniqueFiles) {
            await pi.exec('git', ['checkout', 'HEAD', '--', f]);
            await pi.exec('git', ['reset', 'HEAD', f]);
          }
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `GATE FAILED: You introduced unallowed suppression markers. The following changes have been automatically REVERTED from HEAD:\n${violations
                  .map((v) => `- ${v.file}:${v.lineNo} -> introduced marker "${v.marker}" in "${v.content}"`)
                  .join('\n')}\nTo use this marker, request authorization in the ticket body via: "allow-suppression: ${violations[0].marker}" or add it to allowedSuppressions in tickets.json`,
              },
            ],
          };
        }
      } catch (err) {
        ctx.ui.notify(`ADLC Error during verification: ${err.message}`, 'error');
        return {
          isError: true,
          content: [
            { type: 'text', text: `GATE FAILED: ADLC verification failed during diff/revert: ${err.message}. Fail-closed active.` },
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
