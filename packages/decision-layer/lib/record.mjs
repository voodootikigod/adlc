// The run record: one JSON line per completed run, appended to
// .adlc/decisions/runs.jsonl in the main checkout. `.adlc/*` is already ignored,
// so records are local telemetry, never committed evidence. A record holds the
// hash of the sanitized input, never the input itself.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RecordError } from './errors.mjs';

export const RECORD_SCHEMA_VERSION = 1;

/** Where runs from any worktree of the repository at `mainRoot` are recorded. */
export function recordPath(mainRoot) {
  return join(mainRoot, '.adlc', 'decisions', 'runs.jsonl');
}

/** Append `record` as one line; a failure is a RecordError (the run was not recorded). */
export function appendRecord(path, record) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch (error) {
    throw new RecordError(`could not write the run record to ${path}: ${error.message}`);
  }
}
