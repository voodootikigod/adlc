// Version-probe classification for the watcher (issue #832). A FAILED probe
// (herdr not on PATH, a transient IPC hiccup at session start) is a different
// event from a SUCCESSFUL probe whose version is too new or unparseable: the
// first should be retried, the second is the deliberate degrade path. Before
// this split the empty stdout of a failed probe was fed to versionGate and
// published as "untested herdr version (unparseable)" — through the very shim
// that had just failed — and the watcher gave up for the whole session.
import { versionGate } from './tokens.mjs';

/** Longest probe detail echoed to stderr — enough to diagnose, never a dump. */
const MAX_DETAIL_CHARS = 200;

/**
 * What a failed probe tells us, as one trimmed line: the child's stderr, else
 * the spawn error message, else its exit code, else a fixed marker.
 */
function probeDetail(version) {
  const stderr = typeof version?.stderr === 'string' ? version.stderr.trim() : '';
  if (stderr) return stderr.slice(0, MAX_DETAIL_CHARS);
  const error = typeof version?.error === 'string' ? version.error.trim() : '';
  if (error) return error.slice(0, MAX_DETAIL_CHARS);
  if (Number.isInteger(version?.code)) return `exit ${version.code}`;
  return 'no output';
}

/**
 * Classify a `runHerdr(['--version'])` result against the tested ceiling.
 *
 * Pure: reads its arguments, mutates nothing. Exactly one of:
 *   { kind: 'probe-failed', detail }  — the probe itself did not succeed
 *   { kind: 'unsupported', token }    — it succeeded; versionGate degrades it
 *   { kind: 'supported' }             — it succeeded within the ceiling
 */
export function probeOutcome(version, ceiling) {
  if (version?.ok !== true) return { kind: 'probe-failed', detail: probeDetail(version) };
  const gate = versionGate(typeof version.stdout === 'string' ? version.stdout : '', ceiling);
  if (!gate.supported) return { kind: 'unsupported', token: gate.token };
  return { kind: 'supported' };
}
