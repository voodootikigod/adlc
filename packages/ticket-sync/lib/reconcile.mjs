// reconcile.mjs — the pure 3-way conflict decision (design D6). Given the
// last-synced BASE (a canonical-block hash stored in the sidecar), the LOCAL
// block, and the REMOTE block, decide what pull should do for one ticket. No I/O.
//
// The base is what makes "remote changed" distinguishable from "both changed".
// A missing/corrupt base FAILS SAFE to conflict (never a silent take-remote),
// so deleting or tampering with the sidecar can at worst force a prompt.

import { canonicalHash } from './canonical.mjs';

const hashOf = (block) => (block == null ? null : canonicalHash(block, { omit: ['$schema'] }));

/**
 * @param {{ baseHash: string|null, local: object|null, remote: object|null }} args
 * @returns {{ action: 'converged'|'take-remote'|'keep-local'|'conflict', reason?: string }}
 */
export function reconcileBlock({ baseHash, local, remote }) {
  const localHash = hashOf(local);
  const remoteHash = hashOf(remote);

  // Equal on both sides (including both-absent, or both-edited-to-identical) → done.
  if (localHash === remoteHash) return { action: 'converged' };

  // They differ. Without a usable base we cannot tell who changed → fail safe.
  if (!baseHash) return { action: 'conflict', reason: 'no base (sidecar missing/corrupt) and local != remote' };

  const localChanged = localHash !== baseHash;
  const remoteChanged = remoteHash !== baseHash;

  if (remoteChanged && !localChanged) return { action: 'take-remote' };
  if (localChanged && !remoteChanged) return { action: 'keep-local' };
  // Both changed since the base, to different values.
  return { action: 'conflict', reason: 'both local and remote changed since last sync' };
}
