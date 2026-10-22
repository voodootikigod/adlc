// spec-approval.mjs — P1 Gate 1 interrogation & spec-binding validator (#1181).
// Shared between `gate-manifest record spec-approval` (pre-append guard) and
// `@adlc/runner` `assertPhase('p1')` so the ledger cannot accept an entry that
// `adlc run p1` will later reject.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashFiles, sha256 } from '@adlc/core';
import { parseFileList } from './record.mjs';

function entryType(entry) {
  return entry?.type ?? entry?.gate;
}

function matchesTicket(entry, ticket) {
  return ticket === undefined || entry?.ticket === ticket;
}

/**
 * Validate the latest `spec-approval` entry in `entries` (optionally scoped to `ticket`).
 */
export function specApprovalIntegrityErrors(entries, ticket, cwd = process.cwd()) {
  const entry = entries
    .filter((candidate) => entryType(candidate) === 'spec-approval' && matchesTicket(candidate, ticket))
    .at(-1);
  if (!entry) return [];
  const errors = [];
  const data = entry.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['P1 evidence is incomplete: spec-approval missing interrogation payload (data)'];
  }
  if (data.verdict !== 'approved') {
    errors.push('P1 evidence is contradictory: spec-approval verdict is not "approved" (a rejected, pending, or missing verdict cannot pass Gate 1)');
  }
  if (typeof data.approver !== 'string' || !data.approver.trim()) {
    errors.push('P1 evidence is incomplete: spec-approval missing a non-empty approver');
  }
  if (!Number.isInteger(data.rounds) || data.rounds < 1) {
    errors.push('P1 evidence is incomplete: spec-approval missing a positive integer rounds (zero proves no interrogation activity)');
  }
  if (!Number.isInteger(data.questions) || data.questions < 1) {
    errors.push('P1 evidence is incomplete: spec-approval missing a positive integer questions (zero proves no interrogation activity)');
  }
  if (!Array.isArray(data.sources) || data.sources.length === 0) {
    errors.push('P1 evidence is incomplete: spec-approval sources must name at least one interrogation source actually consulted (an empty list proves nothing was checked)');
  } else if (!data.sources.every((source) => typeof source === 'string' && Boolean(source.trim()))) {
    errors.push('P1 evidence is incomplete: spec-approval sources must be non-empty strings naming the interrogation source actually consulted');
  }
  if (data.unresolved !== 0) {
    errors.push('P1 evidence is contradictory: spec-approval requires unresolved === 0 (record unresolved divergences as approved_assumptions instead)');
  }
  if (data.approved_assumptions !== undefined && !Array.isArray(data.approved_assumptions)) {
    errors.push('P1 evidence is incomplete: spec-approval approved_assumptions must be an array');
  }

  const filePaths = Object.keys(entry.files ?? {});
  let path, recordedHash;
  if (filePaths.length !== 1) {
    errors.push('P1 evidence is incomplete: spec-approval must bind exactly one spec file via --files');
  } else {
    [path] = filePaths;
    recordedHash = entry.files[path];
    if (typeof data.spec_hash !== 'string' || !data.spec_hash) {
      errors.push('P1 evidence is incomplete: spec-approval missing spec_hash');
    } else if (recordedHash !== data.spec_hash) {
      errors.push('P1 evidence is contradictory: spec-approval spec_hash does not match the recorded file hash');
    }
    try {
      const currentHash = sha256(readFileSync(resolve(cwd, path)));
      if (currentHash !== recordedHash) {
        errors.push(`P1 evidence is stale: spec file changed after approval was recorded: ${path}`);
      }
    } catch (err) {
      errors.push(`P1 evidence is stale: spec file cannot be read: ${path}: ${err.message}`);
    }
  }

  const entryIndex = entries.indexOf(entry);
  const latestSpecLint = entries.reduce((acc, e, i) => (entryType(e) === 'spec-lint' && matchesTicket(e, ticket) ? { entry: e, index: i } : acc), null);
  const latestPremortem = entries.reduce((acc, e, i) => (entryType(e) === 'premortem' && matchesTicket(e, ticket) ? { entry: e, index: i } : acc), null);

  function auditMatchesApprovedSpec(audit) {
    if (!path) return true;
    const auditPaths = Object.keys(audit.entry.files ?? {});
    if (auditPaths.length !== 1) return false;
    const [auditPath] = auditPaths;
    return resolve(cwd, auditPath) === resolve(cwd, path) && audit.entry.files[auditPath] === recordedHash;
  }

  if (!latestSpecLint || entryIndex < latestSpecLint.index) {
    errors.push('P1 evidence is stale: spec-approval was recorded before the latest spec-lint evidence for this ticket');
  } else {
    if (!auditMatchesApprovedSpec(latestSpecLint)) {
      errors.push('P1 evidence is contradictory: the latest spec-lint evidence for this ticket does not audit the approved spec file');
    }
    if (latestSpecLint.entry.data?.verified !== true) {
      errors.push('P1 evidence is incomplete: the latest spec-lint evidence for this ticket is not a verified (passing) result');
    }
  }
  if (!latestPremortem || entryIndex < latestPremortem.index) {
    errors.push('P1 evidence is stale: spec-approval was recorded before the latest premortem evidence for this ticket');
  } else if (!auditMatchesApprovedSpec(latestPremortem)) {
    errors.push('P1 evidence is contradictory: the latest premortem evidence for this ticket does not analyze the approved spec file');
  }

  return errors;
}

/**
 * Validate a candidate `spec-approval` record before appending it to the manifest.
 */
export function validateSpecApprovalRecord({
  ticket,
  data,
  files,
  entries = [],
  cwd = process.cwd(),
} = {}) {
  const filePaths = Array.isArray(files) ? files : parseFileList(files);
  const candidate = {
    gate: 'spec-approval',
    ticket,
    data,
    files: hashFiles(filePaths, (p) => readFileSync(resolve(cwd, p))),
  };
  return specApprovalIntegrityErrors([...entries, candidate], ticket, cwd);
}
