// gate-fuzzing/lib/sandbox.mjs
// OS sandbox integration (§1.7, F6 — fix 1). The implementation now lives in
// @adlc/core (sandbox-runner) so every tool shares one sandboxed runner.

export {
  escapeSeatbeltPath,
  SENSITIVE_HOME_DIRS,
  SENSITIVE_HOME_FILES,
  collectMaskedEnvFiles,
  collectWorktreeSiblingMasks,
  buildMacOSSbpl,
  seatbeltWrap,
  SANDBOX_PROFILES,
  sanitizeCandidateEnv,
  resolveSandboxBinary,
  detectSandbox,
  buildSandboxedArgs,
  spawnSandboxed,
  spawnCandidateCmd,
} from '@adlc/core';
