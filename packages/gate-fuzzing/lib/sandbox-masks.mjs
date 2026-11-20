// gate-fuzzing/lib/sandbox-masks.mjs
// Filesystem secret-masking primitives now live in @adlc/core (sandbox-runner).

export {
  SENSITIVE_HOME_DIRS,
  SENSITIVE_HOME_FILES,
  USER_EPHEMERAL_ROOTS,
  resolveEnvMasks,
  realpathSafe,
  isUnderOrEqual,
  isInsideClone,
  resolveCommonGitInfo,
  collectWorktreeSiblingMasks,
  collectMaskedEnvFiles,
  collectBwrapHomeMasks,
  buildBwrapIsolationMounts,
} from '@adlc/core';
