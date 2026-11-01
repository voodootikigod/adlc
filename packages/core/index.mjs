// @adlc/core — single import surface for all ADLC tools.
export * from './lib/llm.mjs';
export * from './lib/git.mjs';
export * from './lib/cli.mjs';
export * from './lib/ledger.mjs';
export * from './lib/tickets.mjs';
export * from './lib/revision.mjs';
export * from './lib/risk-tier.mjs';
export * from './lib/scaffold-hygiene.mjs';
export * from './lib/prosecutor.mjs';
export * from './lib/markdown.mjs';
export * from './lib/shell.mjs';
export * from './lib/railpath.mjs';
export * as mutate from './lib/mutate.mjs';
export * from './lib/text.mjs';
export * from './lib/syntax.mjs';
export * from './lib/primitives.mjs';
export * from './lib/inflight.mjs';
export * from './lib/cluster.mjs';
export * from './lib/proc.mjs';
export * from './lib/trusted-binary.mjs';
export * from './lib/diff-mask.mjs';

// Promoted shared helpers
export { activeTickets } from './lib/tickets.mjs';
export { isPlainObject, OpError, tokenizeCommand } from './lib/cli.mjs';
export {
  writeFileAtomic,
  acquireDirLock,
  redactSecrets,
  readVerdictSource,
  recordPromptOnlyVerdict,
} from './lib/primitives.mjs';
export {
  makeTempPath,
  writeInflightAtomic,
  probeOwner,
  ownerStateFor,
  isContainedRelPath,
  resolveTarget,
  sweepStaleTemps,
  clearRecord,
} from './lib/inflight.mjs';
export {
  BASE_STOPWORDS,
  jaccard,
  clusterByTokenSets,
} from './lib/cluster.mjs';
export {
  thisHost,
  pidAlive,
  procStartTimeOf,
  selfProcessIdentity,
  defaultLockProbes,
} from './lib/proc.mjs';
export {
  resolveTrustedBinary,
  ownershipRejection,
  ancestorDirs,
  candidateAncestors,
  binaryCandidates,
  candidateStats,
  candidateRejection,
  untrustedBinaryReason,
} from './lib/trusted-binary.mjs';

