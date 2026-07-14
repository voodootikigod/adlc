import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { ADLC_DIR, ledgerPath, sha256, withLedgerLock } from '@adlc/core';
import { getKey, signEntry, verifyEntrySig } from './sign.mjs';
import { verify } from './verify.mjs';

const RESERVED = new Set(['seq', 'prev', 'sig', 'sigVersion']);

function payloadFrom(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !RESERVED.has(key)));
}

function chainPayloads(payloads, key) {
  let previousRaw = null;
  return payloads.map((payload, index) => {
    const normalized = {
      ...payload,
      gate: payload.gate ?? payload.type ?? 'evidence',
      ts: payload.ts ?? new Date().toISOString(),
      files: payload.files ?? {},
    };
    const entry = {
      seq: index + 1,
      ...normalized,
      prev: previousRaw === null ? null : sha256(previousRaw),
    };
    if (key) {
      entry.sigVersion = 2;
      entry.sig = signEntry(key, entry);
    }
    previousRaw = JSON.stringify(entry);
    return entry;
  });
}

function durableWrite(path, content) {
  const descriptor = openSync(path, 'wx');
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function repairChain({
  dir = ADLC_DIR,
  reason,
  write = false,
  attestUnsigned = false,
} = {}) {
  if (typeof reason !== 'string' || reason.trim().length < 8) {
    throw new Error('repair reason must be at least 8 characters');
  }
  const path = ledgerPath('manifest', dir);
  if (!existsSync(path)) throw new Error(`manifest does not exist: ${path}`);
  const original = readFileSync(path, 'utf8');
  const sourceLines = original
    .split('\n')
    .map((line, index) => ({ line, lineNo: index + 1 }))
    .filter(({ line }) => line.trim() !== '');
  const entries = sourceLines.map(({ line, lineNo }) => {
    try { return JSON.parse(line); }
    catch (err) { throw new Error(`manifest line ${lineNo} is malformed: ${err.message}`); }
  });
  const integrity = verify(dir);
  if (integrity.valid) throw new Error('manifest chain is already valid; repair refused');
  const invalidEntryIndex = entries.findIndex(
    (entry) => !entry || typeof entry !== 'object' || Array.isArray(entry),
  );
  if (invalidEntryIndex !== -1) {
    throw new Error(`manifest line ${sourceLines[invalidEntryIndex].lineNo} must contain an entry object`);
  }
  const key = getKey();
  const unsignedLines = sourceLines
    .filter((_, index) => typeof entries[index]?.sig !== 'string')
    .map(({ lineNo }) => lineNo);
  if (attestUnsigned && !key) {
    throw new Error('--attest-unsigned requires ADLC_MANIFEST_KEY');
  }
  if (!key && entries.some((entry) => typeof entry.sig === 'string')) {
    throw new Error('manifest contains signed entries; configure ADLC_MANIFEST_KEY before repair');
  }
  if (key) {
    const invalidSignedIndex = entries.findIndex(
      (entry) => typeof entry.sig === 'string' && !verifyEntrySig(key, entry),
    );
    if (invalidSignedIndex !== -1) {
      throw new Error(
        `manifest signature at line ${invalidSignedIndex + 1} does not match ADLC_MANIFEST_KEY; repair refused`,
      );
    }
    if (unsignedLines.length > 0 && !attestUnsigned) {
      throw new Error(
        `manifest contains ${unsignedLines.length} unsigned entr${unsignedLines.length === 1 ? 'y' : 'ies'}; ` +
        'repair would cryptographically attest them; rerun with --attest-unsigned after reviewing the backup',
      );
    }
  }
  const originalHash = sha256(original);
  const backup = `${path}.pre-repair-${originalHash.slice(0, 16)}.bak`;
  const repair = {
    type: 'manifest-chain-repair',
    ts: new Date().toISOString(),
    reason: reason.trim(),
    originalHash,
    originalEntries: entries.length,
    backup,
    newlySignedEntries: key ? unsignedLines.length : 0,
    newlySignedLines: key ? unsignedLines : [],
  };
  const repaired = chainPayloads([...entries.map(payloadFrom), repair], key);
  const output = `${repaired.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  const result = {
    ok: true,
    write,
    path,
    backup,
    originalHash,
    originalEntries: entries.length,
    repairedEntries: repaired.length,
    newlySignedEntries: repair.newlySignedEntries,
    newlySignedLines: repair.newlySignedLines,
  };
  if (!write) return result;

  mkdirSync(dirname(path), { recursive: true });
  return withLedgerLock(path, () => {
    const current = readFileSync(path, 'utf8');
    if (sha256(current) !== originalHash) {
      throw new Error('manifest changed after repair planning; retry from fresh state');
    }
    if (existsSync(backup)) {
      if (readFileSync(backup, 'utf8') !== original) {
        throw new Error(`repair backup exists with different content: ${backup}`);
      }
    } else {
      durableWrite(backup, original);
    }

    const temporary = `${path}.repair-${process.pid}-${randomUUID()}`;
    try {
      durableWrite(temporary, output);
      renameSync(temporary, path);
      if (process.platform !== 'win32') {
        const directory = openSync(dirname(path), 'r');
        try { fsyncSync(directory); }
        finally { closeSync(directory); }
      }
    } finally {
      try { unlinkSync(temporary); } catch {}
    }
    return result;
  });
}
