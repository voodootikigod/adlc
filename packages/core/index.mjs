// @adlc/core — single import surface for all ADLC tools.
export * from './lib/llm.mjs';
export { inferModelProviderFamily } from './lib/model-family.mjs';
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
export * from './lib/workspace-root.mjs';

// Promoted shared helpers
export { activeTickets } from './lib/tickets.mjs';
export { isPlainObject, OpError, tokenizeCommand } from './lib/cli.mjs';
export {
  CLAUDE_CLI_MODELS,
  CODEX_CLI_MODELS,
} from './lib/cli-providers.mjs';
export {
  STRUCTURAL_FALLBACK_OPERATORS,
  dropObjectArgKey,
} from './lib/structural-mutate.mjs';
export {
  writeFileAtomic,
  acquireDirLock,
  withDirLock,
  heartbeat,
  redactSecrets,
  readVerdictSource,
  recordPromptOnlyVerdict,
  VALID_ATTESTATION_MODES,
  escapeSeatbeltPath,
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
  sanitizeCandidateEnv,
  resolveSandboxBinary,
  detectSandbox,
  buildSandboxedArgs,
  spawnSandboxed,
  spawnCandidateCmd,
  buildMacOSSbpl,
  seatbeltWrap,
  SANDBOX_PROFILES,
  SENSITIVE_HOME_DIRS,
  SENSITIVE_HOME_FILES,
  USER_EPHEMERAL_ROOTS,
  collectMaskedEnvFiles,
  collectWorktreeSiblingMasks,
  collectBwrapHomeMasks,
  resolveEnvMasks,
  resolveCommonGitInfo,
  buildBwrapIsolationMounts,
  realpathSafe,
  isUnderOrEqual,
  isInsideClone,
} from './lib/sandbox-runner.mjs';
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

