// gemini-stop-verify.mjs — Antigravity (agy) / JetSki Stop-hook verification
// and PreInvocation metadata sanitization (strictly < 400 lines).

import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  canonicalizePath as canonPath,
  extractToolWorkdir,
  isPathInside,
  preferInnermostCheckout,
} from '@adlc/core';
import { detectTicketStore } from '@adlc/tickets';
import { resolveActiveTicketId } from './pretool.mjs';
import { resolveTranscriptPath, parseTranscriptRecords } from './flail-transcript.mjs';
import {
  classifyTool,
  isShellTool,
  extractCommandString,
  isTrustRootOrSecretPath,
  isTrustRootSecretAccess,
  hasShellTrustRootSecretAccess,
  hasShellSymlinkOrSecretEscape,
  isReadonlyCommand,
  isVerificationCommand,
  resolveUserHome,
} from './command-verify.mjs';
import {
  createPersistentTracker,
  resolveSessionId,
  computePrefixHash,
  hasDiscoverableTests,
  getOrCreateSessionSecret,
  getMasterKeyRaw,
  rotateMasterKey,
  verifyPreExistingTestFiles,
} from './session-tracker.mjs';

const GLOB_SAFE_RE = /^[a-zA-Z0-9._/*?[\]{}@+!-]+$/;

export function sanitizeField(value, maxLen = 128) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]/g, ' ').trim().slice(0, maxLen);
}

export function sanitizeGlobList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 200) continue;
    if (!GLOB_SAFE_RE.test(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

const loadStoreReadOnly = (root, env) =>
  detectTicketStore({
    root,
    ticketStore: env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || undefined,
    allowRecovery: true,
    env,
  }).load();

function buildOverrideRegex(env) {
  const ov = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  if (!ov || typeof ov !== 'string' || !ov.trim()) return null;
  const escaped = ov.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[\\s=;,"\'/$.()[\\]])(' + escaped + '|ADLC_TICKET_STORE|ADLC_TICKETS)', 'i');
}

function checkTranscriptIntegrity(transcriptPath, tracker, sessionID, cont) {
  const trackerInfo = tracker.lastTranscript ? tracker.lastTranscript(sessionID) : { initial: tracker.initialTranscript?.(sessionID) };
  const initialTranscript = trackerInfo?.initial;
  if (!transcriptPath || (!initialTranscript && !trackerInfo?.lastHash)) return null;
  if (initialTranscript?.path && transcriptPath !== initialTranscript.path) {
    return cont('Session transcript path changed during session.');
  }
  try {
    const curStat = lstatSync(transcriptPath);
    if (initialTranscript && (curStat.ino !== initialTranscript.ino || curStat.dev !== initialTranscript.dev)) {
      return cont('Session transcript file identity (inode/device) changed during session.');
    }
    if (initialTranscript?.size && curStat.size < initialTranscript.size) {
      return cont('Session transcript file size shrank unexpectedly during session.');
    }
    if (initialTranscript?.hash && initialTranscript.size > 0) {
      if (computePrefixHash(transcriptPath, initialTranscript.size) !== initialTranscript.hash) {
        return cont('Session transcript prefix content was modified during session.');
      }
    }
    if (trackerInfo?.lastHash && trackerInfo?.lastSize && trackerInfo.lastSize > 0) {
      if (computePrefixHash(transcriptPath, trackerInfo.lastSize) !== trackerInfo.lastHash) {
        return cont('Session transcript content was modified during session.');
      }
    }
  } catch {
    return cont('Session transcript became unreadable or missing during Stop verification.');
  }
  return null;
}

export function evaluateGeminiStop(payload, { env = process.env, helpers } = {}) {
  const cont = (reason) => ({ decision: 'continue', reason: `ADLC Rails-Guard: ${reason}` });
  const {
    PLUGIN_ROOT,
    resolveWorkspaceRoot,
    declaredOuterWorkspace,
    discoverRootFromTranscriptRecords,
    hasUnambiguousWorkspaceCwd,
    extractToolCalls,
    extractToolName,
    extractArgs,
    extractFilePaths,
    findAdlcRoot,
    canonicalizeExisting,
  } = helpers;

  try {
    if (env?.ADLC_P4_ENFORCEMENT !== '1') return { decision: 'stop' };
    const sid = resolveSessionId({ payload, env });
    let root = resolveWorkspaceRoot(payload, env);
    const tp = resolveTranscriptPath({ payload, conversationId: sid, env });
    let records = [];
    if (tp) {
      try {
        const before = lstatSync(tp);
        records = parseTranscriptRecords(tp, { readFull: true });
        const after = lstatSync(tp);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          records = parseTranscriptRecords(tp, { readFull: true });
        }
      } catch {
        records = [];
      }
    }

    const outerWs = declaredOuterWorkspace(payload, root);
    const discoveredRoot = records.length > 0
      ? discoverRootFromTranscriptRecords(records, env, { anchorBase: outerWs })
      : null;
    if (!root) {
      root = discoveredRoot;
    } else if (discoveredRoot) {
      const declaredMulti = ['workspacePaths', 'workspace_paths', 'workspaceRoots', 'workspace_roots']
        .flatMap((k) => (Array.isArray(payload?.[k]) ? payload[k] : []))
        .filter((s) => typeof s === 'string' && s.trim());
      if (declaredMulti.length > 1 && declaredMulti.some((w) => canonPath(w) === canonPath(discoveredRoot))) {
        root = discoveredRoot;
      } else {
        root = preferInnermostCheckout(root, [discoveredRoot], {
          storeOverride: env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null,
          homeDir: resolveUserHome(env) || homedir(),
          pluginDir: PLUGIN_ROOT,
          preserveSpelling: true,
        }) ?? root;
      }
    }
    if (!root) return cont('Repository workspace root cannot be resolved under enforcement during Stop verification.');

    const initialActive = resolveActiveTicketId(root, env);
    const tr = createPersistentTracker(root, env);
    if (tr.isInvalidated?.(sid)) return cont('Session invalidated due to secret disclosure.');

    const transcriptErr = checkTranscriptIntegrity(tp, tr, sid, cont);
    if (transcriptErr) return transcriptErr;

    if (tr.isCorrupted?.()) return cont('Session tracking store was corrupted or unreadable under enforcement.');
    if (tr.validateBaseline && !tr.validateBaseline(sid)) return cont('Session baseline signature mismatch or missing tracking entry.');
    if (tr.validateLedger && !tr.validateLedger(sid)) return cont('Session ledger integrity verification failed.');

    const trackedInitialTicket = tr.initialTicket(sid);
    const initialActiveId = trackedInitialTicket ?? initialActive.id;
    if (!tp || records.length === 0) {
      if (initialActiveId || initialActive.conflict) {
        return cont('Session transcript is missing or unreadable under enforcement.');
      }
      return { decision: 'stop' };
    }

    const overrideEscaped = buildOverrideRegex(env);
    let callSeq = 0;
    let rootCallSeq = 0;
    let mutatingCallSeq = 0;
    let lastMut = -1;
    let lastTest = -1;
    let pkgMut = false;
    let shellMut = false;
    const isNested = Boolean(outerWs) && canonPath(outerWs) !== canonPath(root) && isPathInside(root, outerWs);
    const fileAnchorBase = isNested ? outerWs : root;

    for (const r of records) {
      if (!r || typeof r !== 'object' || Array.isArray(r) || r.__oversized || r.__unparseable) {
        return cont('Corrupted or oversized transcript records detected during Stop verification.');
      }
      const mk = getMasterKeyRaw(env);
      const sec = getOrCreateSessionSecret(root, env);
      const rStr = JSON.stringify(r);
      if (mk && rStr.includes(mk)) {
        rotateMasterKey(env);
        tr.invalidateSession?.(sid);
        return cont('Master key disclosure detected in transcript. Global key revoked and rotated, session permanently invalidated.');
      }
      if (sec && rStr.includes(sec)) {
        tr.invalidateSession?.(sid);
        return cont('Secret disclosure detected in transcript. Session is permanently invalidated.');
      }
      const calls = extractToolCalls(r);
      if (calls.length === 0 && Object.keys(r).some((k) => /(tool|function|action|invocation)/i.test(k))) {
        return cont('Transcript record contains unrecognized tool envelope — schema corruption detected.');
      }

      for (const c of calls) {
        callSeq++;
        const name = extractToolName({ toolCall: c }) || (c?.name ?? c?.toolName ?? c?.tool_name ?? '');
        const args = extractArgs({ toolCall: c });
        const fps = extractFilePaths({ toolCall: c });
        const isShell = isShellTool(name, args);
        const isMut = !isShell && classifyTool(name, args) !== 'readonly';
        const rawWd = extractToolWorkdir(args);
        const effAnchor = rawWd && typeof rawWd === 'string' && rawWd.trim()
          ? (isAbsolute(rawWd.trim()) ? rawWd.trim() : resolve(fileAnchorBase, rawWd.trim()))
          : fileAnchorBase;

        let callTargetsOuterOnly = false;
        if (isNested) {
          const fpRoots = fps
            .filter((p) => typeof p === 'string' && p.trim())
            .map((p) => (isAbsolute(p.trim()) ? p.trim() : resolve(effAnchor, p.trim())))
            .map((ap) => findAdlcRoot(canonicalizeExisting(ap), env) ?? findAdlcRoot(ap, env))
            .filter(Boolean);
          const wdRoot = rawWd && typeof rawWd === 'string' && rawWd.trim()
            ? (findAdlcRoot(canonicalizeExisting(effAnchor), env) ?? findAdlcRoot(effAnchor, env))
            : null;
          const allRoots = [...(wdRoot ? [wdRoot] : []), ...fpRoots];
          if (allRoots.length > 0 && allRoots.every((cr) => canonPath(cr) !== canonPath(root))) {
            callTargetsOuterOnly = true;
          }
        }
        if (!callTargetsOuterOnly) rootCallSeq++;
        if (isMut && !callTargetsOuterOnly) mutatingCallSeq++;

        if (isMut) {
          if (fps.some((p) => /(^|[/\\])\.(adlc|booster)([/\\]|$)/i.test(p)) || (overrideEscaped && fps.some((p) => overrideEscaped.test(p)))) {
            return cont('Trust-root store or secret was modified during session.');
          }
          if (fps.some((p) => isTrustRootOrSecretPath(p, env))) {
            return cont('Tampering with trust-root secret or executable is strictly prohibited.');
          }
          if (fps.some((p) => /(^|[/\\]|\.system_generated[/\\]logs[/\\])transcript.*\.jsonl$/i.test(p))) {
            return cont('Tampering with session transcript files is strictly prohibited.');
          }
          if (!callTargetsOuterOnly && fps.some((p) => {
            const abs = isAbsolute(p) ? p : resolve(effAnchor, p);
            const rel = relative(root, abs);
            return rel.startsWith('..') || isAbsolute(rel);
          })) {
            return cont('File modification outside repository workspace detected.');
          }
          lastMut = callSeq;
          if (fps.length === 0) {
            pkgMut = true;
            const argsStr = JSON.stringify(args ?? {});
            if (/(^|[=\s"';,/])(\.adlc|\.adlc-secrets|\.adlc-runtime-secrets|\.system_generated|transcript.*\.jsonl)/i.test(argsStr)) {
              return cont('Trust-root store or secret was modified during session.');
            }
          }
          if (fps.some((p) => /(^|[/\\])(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(p))) {
            pkgMut = true;
          }
        } else if (isShell) {
          const cmd = extractCommandString(args);
          const normCmd = String(cmd ?? '').replace(/\\/g, '/');
          const shellAnchorBase = isNested ? outerWs : root;
          const actualCwd = rawWd && typeof rawWd === 'string' && rawWd.trim()
            ? (isAbsolute(rawWd.trim()) ? rawWd.trim() : resolve(shellAnchorBase, rawWd.trim()))
            : root;
          const allowImplicit = hasUnambiguousWorkspaceCwd(payload, env, root);
          const ro = isReadonlyCommand(cmd, { root: callTargetsOuterOnly ? outerWs : root, cwd: actualCwd, env });
          if (
            (!ro && isTrustRootSecretAccess(cmd, overrideEscaped)) ||
            hasShellTrustRootSecretAccess(cmd, { root, cwd: actualCwd, env }) ||
            hasShellSymlinkOrSecretEscape(cmd, { root, cwd: actualCwd, env }) ||
            (!ro && /(^|[\s=;,"'/$.()[\]])transcript.*\.jsonl/i.test(normCmd))
          ) {
            return cont('Shell modification of trust-root store or transcript is strictly prohibited.');
          }
          if (isVerificationCommand(cmd, { root, workdirAnchorBase: shellAnchorBase, toolArgs: args, allowImplicitCwd: allowImplicit, packageManifestMutated: pkgMut, shellMutated: shellMut })) {
            const ec = r?.exit_code ?? r?.exitCode ?? c?.exitCode;
            const st = String(r?.status ?? c?.status ?? '').toLowerCase();
            const isSuccess = ec === 0 || (ec === undefined && (st === 'done' || st === 'success' || r?.success === true));
            const isFailure = (typeof ec === 'number' && ec !== 0) || st === 'error' || st === 'failed' || r?.success === false;
            const outStr = typeof r?.content === 'string' ? r.content : (typeof r?.output === 'string' ? r.output : JSON.stringify(r));
            const isZeroTests = /\b(tests|pass)\s+0\b/i.test(outStr) || /\b0\s+(tests|passing)\b/i.test(outStr);
            if (isSuccess && !isFailure && hasDiscoverableTests(root) && !isZeroTests) {
              lastTest = callSeq;
            }
          } else if (!ro && !isVerificationCommand(cmd, { root, workdirAnchorBase: shellAnchorBase, toolArgs: args, allowImplicitCwd: allowImplicit })) {
            if (!callTargetsOuterOnly) mutatingCallSeq++;
            lastMut = callSeq;
            shellMut = true;
            if (/(^|[\s=;,"'/$.()[\]])(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|vitest\.config|jest\.config|\.mocharc|node_modules\/\.bin|npm\s+(pkg|install|i|add|remove|rm|uninstall))\b/i.test(normCmd)) {
              pkgMut = true;
            }
          }
        }
      }
    }

    const active = resolveActiveTicketId(root, env);
    if (initialActiveId && active.id !== initialActiveId) {
      return cont(`Active ticket ID changed from ${initialActiveId} to ${active.id ?? 'none'} during session.`);
    }
    if (!active.id) {
      if (active.conflict) return cont('Active ticket state conflict detected during Stop verification.');
      if (lastMut !== -1) return cont('Active ticket is missing while unverified edits exist in session.');
      return { decision: 'stop' };
    }
    const trackedInitialPointer = tr.initialPointer?.(sid) ?? null;
    if (trackedInitialPointer?.exists && !existsSync(join(root, '.adlc', 'current-ticket.json'))) {
      return cont('Active ticket pointer (.adlc/current-ticket.json) was removed during session.');
    }

    let ticket = null;
    try {
      const snap = loadStoreReadOnly(root, env);
      ticket = snap.get(active.id);
      if (!ticket) return cont(`Active ticket ${active.id} not found in validated ticket store.`);
      if (active.ticketHash) {
        const expectedHash = snap.ticketHashes?.[active.id] ?? snap.ticketHashes?.get?.(active.id);
        if (expectedHash && expectedHash !== active.ticketHash) {
          return cont(`Active ticket hash mismatch for ${active.id} during Stop verification.`);
        }
      }
    } catch {
      return cont('Corrupt or unreadable ticket store during Stop verification.');
    }

    if (lastMut !== -1 && (lastTest === -1 || lastMut > lastTest)) {
      return cont('Active ticket has unverified file edits. Verification/test commands must be run after the last edit before completing.');
    }

    const trackedDepth = tr.mutatingCalls ? tr.mutatingCalls(sid) : tr.depth(sid);
    if (trackedDepth > 0 && mutatingCallSeq !== trackedDepth) {
      return cont('Untracked or missing tool execution records detected in transcript during Stop verification.');
    }
    const trackedTotal = tr.totalCalls ? tr.totalCalls(sid) : 0;
    if (trackedTotal > 0 && rootCallSeq !== trackedTotal) {
      return cont('Untracked or missing tool execution records detected in transcript during Stop verification.');
    }
    if (trackedDepth === 0 && mutatingCallSeq > 0 && trackedInitialTicket) {
      return cont('Untracked tool execution records detected in transcript during Stop verification.');
    }

    const sessionsFile = join(root, '.adlc', 'sessions.json');
    const ledgerFile = join(root, '.adlc', 'session-ledger.jsonl');
    const hasInfra = existsSync(sessionsFile) || existsSync(ledgerFile) || Boolean(tr.hasSnapshot?.(sid)) || Boolean(trackedInitialTicket) || trackedDepth > 0 || trackedTotal > 0;
    if (!hasInfra && mutatingCallSeq > 0) {
      return cont('Session tracking store was missing or deleted during verification.');
    }
    if (hasInfra && !existsSync(sessionsFile) && (trackedDepth > 0 || trackedTotal > 0 || mutatingCallSeq > 0 || trackedInitialTicket)) {
      return cont('Session tracking store was missing or deleted during verification.');
    }
    if (hasInfra && existsSync(sessionsFile)) {
      const sStore = tr.rawStore?.();
      if (!sStore || sStore._corrupted) {
        return cont('Session baseline signature mismatch or missing tracking entry.');
      }
      if (mutatingCallSeq > 0 && !sStore[sid]) {
        return cont('Session tracking entry was deleted, evicted, reset, or missing during Stop verification.');
      }
    }

    const testCheck = verifyPreExistingTestFiles(root, tr.initialTestFiles?.(sid), ticket);
    if (!testCheck.ok) return { decision: 'continue', reason: testCheck.reason };
    tr.markSessionEnded?.(sid);
    return { decision: 'stop' };
  } catch {
    return env?.ADLC_P4_ENFORCEMENT === '1'
      ? cont('Internal error evaluating Stop hook under enforcement.')
      : { decision: 'stop' };
  }
}
