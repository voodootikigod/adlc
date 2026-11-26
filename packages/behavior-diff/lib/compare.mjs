// lib/compare.mjs — load and compare two capture snapshots

import { readFileSync } from 'node:fs';
import { sha256 } from '@adlc/core';
import { diffRoute, diffBodies, routeKey, commandKey, isJsonBody } from './diff.mjs';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Load and parse a snapshot file.
 * Throws with a descriptive message on failure.
 */
export function loadSnapshot(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read snapshot file "${filePath}": ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`snapshot file "${filePath}" is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`snapshot file "${filePath}" is missing required .routes array`);
  }

  const hasRoutes = parsed.routes !== undefined;
  const hasCommands = parsed.commands !== undefined;

  if (!hasRoutes && !hasCommands) {
    throw new Error(`snapshot file "${filePath}" is missing required .routes array`);
  }

  if (hasRoutes) {
    if (!Array.isArray(parsed.routes)) {
      throw new Error(`snapshot file "${filePath}" is missing required .routes array`);
    }
    if (parsed.routes.length === 0 && (!hasCommands || (Array.isArray(parsed.commands) && parsed.commands.length === 0))) {
      throw new Error(`snapshot file "${filePath}" has empty routes array`);
    }
    for (const [i, route] of parsed.routes.entries()) {
      if (!route || typeof route !== 'object' || Array.isArray(route)) {
        throw new Error(`snapshot file "${filePath}" route at index ${i} is not an object`);
      }
      if (route.id !== undefined && (typeof route.id !== 'string' || route.id.trim() === '')) {
        throw new Error(`snapshot file "${filePath}" route at index ${i} has an invalid id (expected non-empty string)`);
      }
      if (typeof route.method !== 'string' || route.method.trim() === '') {
        throw new Error(`snapshot file "${filePath}" route at index ${i} lacks non-empty string method`);
      }
      if (typeof route.path !== 'string' || route.path.trim() === '') {
        throw new Error(`snapshot file "${filePath}" route at index ${i} lacks non-empty string path`);
      }
      // capture writes exactly one of {status, contentType, body} or {error}.
      // diffRoute compares whatever is there, so two entries carrying NEITHER
      // (no HTTP result was ever captured) diff as identical — a false green.
      if (route.error !== undefined && typeof route.error !== 'string') {
        throw new Error(`snapshot file "${filePath}" route at index ${i} has a non-string error`);
      }
      // fetch() only ever yields an integer HTTP status in 100..599; anything
      // else (-1, 0, 999) is a failed or hand-made capture, not an observation.
      if (route.status !== undefined && !(Number.isInteger(route.status) && route.status >= 100 && route.status <= 599)) {
        throw new Error(`snapshot file "${filePath}" route at index ${i} has an invalid HTTP status (expected an integer 100-599): ${JSON.stringify(route.status)}`);
      }
      const hasError = typeof route.error === 'string' && route.error.trim() !== '';
      const hasStatus = route.status !== undefined;
      if (!hasError && !hasStatus) {
        throw new Error(`snapshot file "${filePath}" route at index ${i} records no observation (neither an integer status nor a non-empty error string)`);
      }
      if (hasError && hasStatus) {
        throw new Error(`snapshot file "${filePath}" route at index ${i} records both an error and a status`);
      }
      // A captured response is {status, contentType, body} — always all three
      // (see capture.mjs). A status-only entry compares missing contentType and
      // body as equal on both sides, so a changed body would read as identical.
      if (hasStatus && (typeof route.contentType !== 'string' || !Object.hasOwn(route, 'body'))) {
        throw new Error(`snapshot file "${filePath}" route at index ${i} is an incomplete observation (a captured response carries status, contentType and body)`);
      }
      // Non-JSON bodies are compared by hash (diffRoute), and a body without a
      // textHash compares null === null — two different malformed text bodies
      // would read as identical. capture writes {textHash, bytes} for text.
      if (hasStatus && !isJsonBody(route)) {
        const b = route.body;
        const wellFormed = !!b && typeof b === 'object' && !Array.isArray(b)
          && typeof b.textHash === 'string' && SHA256_HEX.test(b.textHash)
          && Number.isInteger(b.bytes) && b.bytes >= 0;
        if (!wellFormed) {
          throw new Error(`snapshot file "${filePath}" route at index ${i} has a malformed text body (expected {textHash: <sha256 hex>, bytes: <integer >= 0>} for content-type ${JSON.stringify(route.contentType)})`);
        }
      }
    }
    // compareSnapshots keys each side on routeKey() alone, so two entries sharing a
    // key silently collapse to the LAST one — a changed duplicate hidden behind an
    // unchanged duplicate reads as identical (false green). Refuse the snapshot.
    const seen = new Set();
    for (const [i, route] of parsed.routes.entries()) {
      const key = routeKey(route);
      if (seen.has(key)) {
        throw new Error(`snapshot file "${filePath}" route at index ${i} duplicates an earlier "${key}" entry — a duplicate key would be silently collapsed by compare`);
      }
      seen.add(key);
    }
  }

  if (hasCommands) {
    if (!Array.isArray(parsed.commands)) {
      throw new Error(`snapshot file "${filePath}" has non-array .commands`);
    }
    if (parsed.commands.length === 0 && (!hasRoutes || parsed.routes.length === 0)) {
      throw new Error(`snapshot file "${filePath}" has empty commands array`);
    }
    const seenCmds = new Set();
    for (const [i, cmd] of parsed.commands.entries()) {
      if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
        throw new Error(`snapshot file "${filePath}" command at index ${i} is not an object`);
      }
      if (typeof cmd.id !== 'string' || cmd.id.trim() === '') {
        throw new Error(`snapshot file "${filePath}" command at index ${i} lacks non-empty string id`);
      }
      if (typeof cmd.cmd !== 'string' || cmd.cmd.trim() === '') {
        throw new Error(`snapshot file "${filePath}" command at index ${i} lacks non-empty string cmd`);
      }
      if (cmd.error !== undefined && typeof cmd.error !== 'string') {
        throw new Error(`snapshot file "${filePath}" command at index ${i} has a non-string error`);
      }
      const hasError = typeof cmd.error === 'string' && cmd.error.trim() !== '';
      const hasExitCode = cmd.exitCode !== undefined;
      if (!hasError && !hasExitCode) {
        throw new Error(`snapshot file "${filePath}" command at index ${i} records no observation (neither exitCode nor error)`);
      }
      if (hasError && hasExitCode) {
        throw new Error(`snapshot file "${filePath}" command at index ${i} records both an error and an exitCode`);
      }
      if (hasExitCode) {
        if (!Number.isInteger(cmd.exitCode)) {
          throw new Error(`snapshot file "${filePath}" command at index ${i} has non-integer exitCode`);
        }
        if (cmd.stdoutFormat !== 'json' && cmd.stdoutFormat !== 'text') {
          throw new Error(`snapshot file "${filePath}" command at index ${i} has invalid stdoutFormat: ${JSON.stringify(cmd.stdoutFormat)}`);
        }
        if (!Object.hasOwn(cmd, 'stdout') || typeof cmd.stderr !== 'string') {
          throw new Error(`snapshot file "${filePath}" command at index ${i} is an incomplete observation (requires stdout and string stderr)`);
        }
        if (cmd.stdoutFormat === 'text') {
          const s = cmd.stdout;
          const wellFormed = !!s && typeof s === 'object' && !Array.isArray(s)
            && typeof s.textHash === 'string' && SHA256_HEX.test(s.textHash)
            && Number.isInteger(s.bytes) && s.bytes >= 0;
          if (!wellFormed) {
            throw new Error(`snapshot file "${filePath}" command at index ${i} has a malformed text stdout`);
          }
        }
      }
      const key = commandKey(cmd);
      if (seenCmds.has(key)) {
        throw new Error(`snapshot file "${filePath}" command at index ${i} duplicates an earlier "${key}" entry`);
      }
      seenCmds.add(key);
    }
  }

  return parsed;
}

export function diffCommand(beforeCmd, afterCmd) {
  const key = commandKey(beforeCmd);
  const id = typeof beforeCmd.id === 'string' ? beforeCmd.id.trim() : beforeCmd.id;
  const diffs = [];

  if (beforeCmd.error && afterCmd.error) {
    return { kind: 'command', id, route: key, unreachable: true, error: beforeCmd.error };
  }

  if (beforeCmd.error || afterCmd.error) {
    diffs.push({
      field: 'error',
      before: beforeCmd.error ?? null,
      after: afterCmd.error ?? null,
    });
    return { kind: 'command', id, route: key, diffs };
  }

  if (beforeCmd.exitCode !== afterCmd.exitCode) {
    diffs.push({ field: 'exitCode', before: beforeCmd.exitCode, after: afterCmd.exitCode });
  }

  if (beforeCmd.stdoutFormat !== afterCmd.stdoutFormat) {
    diffs.push({ field: 'stdoutFormat', before: beforeCmd.stdoutFormat, after: afterCmd.stdoutFormat });
  } else if (beforeCmd.stdoutFormat === 'json') {
    const { changes, capped, total } = diffBodies(beforeCmd.stdout, afterCmd.stdout);
    if (changes.length > 0) {
      diffs.push({ field: 'stdout', type: 'json', changes, capped, total });
    }
  } else {
    const beforeHash = beforeCmd.stdout?.textHash ?? null;
    const afterHash = afterCmd.stdout?.textHash ?? null;
    if (beforeHash !== afterHash) {
      diffs.push({
        field: 'stdout',
        type: 'text',
        before: { textHash: beforeHash, bytes: beforeCmd.stdout?.bytes },
        after: { textHash: afterHash, bytes: afterCmd.stdout?.bytes },
      });
    }
  }

  const beforeStderrHash = sha256(beforeCmd.stderr ?? '');
  const afterStderrHash = sha256(afterCmd.stderr ?? '');
  if (beforeStderrHash !== afterStderrHash) {
    diffs.push({
      field: 'stderr',
      before: { textHash: beforeStderrHash, bytes: Buffer.byteLength(beforeCmd.stderr ?? '', 'utf8') },
      after: { textHash: afterStderrHash, bytes: Buffer.byteLength(afterCmd.stderr ?? '', 'utf8') },
    });
  }

  return diffs.length > 0 ? { kind: 'command', id, route: key, diffs } : null;
}

/**
 * Compare two snapshots.
 * Returns { identical, changed, unreachable, onlyInBefore, onlyInAfter }.
 *
 * `unreachable` holds routes or commands that errored on BOTH sides (dead in before and
 * after). These are surfaced separately so an all-error before/after pair can
 * never be reported as a clean "identical" pass through the P6 human gate.
 */
export function compareSnapshots(before, after) {
  const beforeRouteMap = new Map();
  for (const r of before.routes ?? []) {
    beforeRouteMap.set(routeKey(r), r);
  }

  const afterRouteMap = new Map();
  for (const r of after.routes ?? []) {
    afterRouteMap.set(routeKey(r), r);
  }

  const allRouteKeys = new Set([...beforeRouteMap.keys(), ...afterRouteMap.keys()]);
  const identical = [];
  const changed = [];
  const unreachable = [];
  const onlyInBefore = [];
  const onlyInAfter = [];

  for (const key of allRouteKeys) {
    const b = beforeRouteMap.get(key);
    const a = afterRouteMap.get(key);

    if (b && !a) {
      onlyInBefore.push(key);
    } else if (a && !b) {
      onlyInAfter.push(key);
    } else {
      const diff = diffRoute(b, a);
      if (diff === null) {
        identical.push(key);
      } else if (diff.unreachable) {
        unreachable.push({ route: diff.route, error: diff.error });
      } else {
        changed.push(diff);
      }
    }
  }

  const beforeCmdMap = new Map();
  for (const c of before.commands ?? []) {
    beforeCmdMap.set(commandKey(c), c);
  }

  const afterCmdMap = new Map();
  for (const c of after.commands ?? []) {
    afterCmdMap.set(commandKey(c), c);
  }

  const allCmdKeys = new Set([...beforeCmdMap.keys(), ...afterCmdMap.keys()]);
  for (const key of allCmdKeys) {
    const b = beforeCmdMap.get(key);
    const a = afterCmdMap.get(key);

    if (b && !a) {
      onlyInBefore.push(key);
    } else if (a && !b) {
      onlyInAfter.push(key);
    } else {
      const diff = diffCommand(b, a);
      if (diff === null) {
        identical.push(key);
      } else if (diff.unreachable) {
        unreachable.push({ kind: 'command', id: diff.id, route: diff.route, error: diff.error });
      } else {
        changed.push(diff);
      }
    }
  }

  return { identical, changed, unreachable, onlyInBefore, onlyInAfter };
}
