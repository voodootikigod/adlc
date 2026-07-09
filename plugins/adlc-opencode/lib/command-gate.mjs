// command-gate.mjs — T32: advisory checks on slash-command execution, wired to
// experimental command.execute.before(input:{command,sessionID,arguments}, ...).
// ADVISORY ONLY — commands are human-invoked; these WARN, never block. Two pure,
// injectable helpers so index.mjs just surfaces the returned message via a toast.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveActiveTicketId } from '../rails-checker.mjs';

/**
 * Normalize the host's `command` field to a bare adlc command name.
 * The host may pass "/adlc-decompose", "adlc-decompose", or "adlc-decompose foo".
 * Returns '' for anything that is not an adlc command.
 */
export function normalizeCommandName(command) {
  const first = String(command ?? '').trim().replace(/^\//, '').split(/\s+/)[0] ?? '';
  return /^adlc-[a-z-]+$/.test(first) ? first : '';
}

// Lifecycle-order prerequisites: a command's phase expects an earlier phase's
// gate to have LEFT EVIDENCE (a manifest entry) for the active ticket. Advisory
// — a missing prerequisite warns, it does not block. Keyed by command name.
const PHASE_PREREQ = {
  'adlc-decompose': { gates: ['spec-lint', 'premortem'], hint: 'no approved spec (P1) recorded for this ticket — run /adlc-spec then /adlc-approve-spec first' },
  'adlc-prosecute': { gates: ['coldstart'], hint: 'this ticket has not been decomposed (P2) — run /adlc-decompose first' },
};

/** Read (gate, ticket) pairs from .adlc/manifest.jsonl; [] when absent/unreadable. */
function manifestEntries(root) {
  const path = join(root, '.adlc', 'manifest.jsonl');
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Advisory lifecycle-order check. Returns { warn: string|null }.
 * Only warns when: the command has a declared prerequisite, enforcement is on
 * with an unambiguous active ticket, AND the manifest has NO entry for any of
 * the prerequisite gates on that ticket. Fail-OPEN everywhere else — advisory.
 */
export function checkCommandOrder(command, root, env = process.env) {
  const name = normalizeCommandName(command);
  const prereq = PHASE_PREREQ[name];
  if (!prereq) return { warn: null };
  const active = resolveActiveTicketId(root, env);
  if (active.conflict || !active.id) return { warn: null };
  const entries = manifestEntries(root);
  const satisfied = entries.some((e) => e?.ticket === active.id && prereq.gates.includes(e?.gate));
  if (satisfied) return { warn: null };
  return { warn: `ADLC lifecycle: /${name} — ${prereq.hint}. (advisory; not blocked)` };
}

/**
 * Tamper notice. Returns { warn: string|null }. The invoked command's DEPLOYED
 * markdown (.opencode/commands/<name>.md) is byte-compared against the plugin's
 * packaged source (command/<name>.md). A mismatch means the command prompt was
 * locally edited — warn (the prompt drives an agent, so silent drift matters).
 * Fail-open: if either copy is missing/unreadable, no warning (nothing to prove).
 */
export function checkCommandTamper(command, pkgRoot, root) {
  const name = normalizeCommandName(command);
  if (!name) return { warn: null };
  const deployed = join(root, '.opencode', 'commands', `${name}.md`);
  const source = join(pkgRoot, 'command', `${name}.md`);
  if (!existsSync(deployed) || !existsSync(source)) return { warn: null };
  try {
    if (readFileSync(deployed, 'utf8') !== readFileSync(source, 'utf8')) {
      return { warn: `ADLC: /${name} command prompt has been locally modified (differs from the packaged source). Re-run /adlc-init to restore, or keep the edit deliberately.` };
    }
  } catch { return { warn: null }; }
  return { warn: null };
}

/** Package source dir names that exist, for a defensive membership check. */
export function packagedCommandNames(pkgRoot) {
  const dir = join(pkgRoot, 'command');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
}
