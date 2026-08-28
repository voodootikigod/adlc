// The AC registry (spec AC 1, 111, 114, 121): an EXPLICIT map from every §16
// criterion number to one or more exported test functions, each with the
// mutation seam that makes it fail (or a `noFixture` reason, capped at 5 in
// total). spec-coverage.test.mjs is the gate that turns this map into a proof:
// it parses §16 at the pinned blob, executes every function here, checks each
// registered test's title and its production seam statically, and asserts the
// named fixture bites.
//
// Entry shape: { fn: '<exported name>', file: '<test file>', seam: '<module.defect>' | null, noFixture?: '<reason>' }

export const REGISTRY = {
  1: [{ fn: 'ac1_registryExecutesEveryFunction', file: 'spec-coverage.test.mjs', seam: null, noFixture: 'the gate itself; its self-tests (AC 111/114/121) are the fixture' }],
  2: [
    { fn: 'ac2_quotaMatrix', file: 'quota.test.mjs', seam: 'quota.forceOk' },
    { fn: 'ac2_endpointHeadersAndFallback', file: 'quota.test.mjs', seam: 'quota.forceOk' },
    { fn: 'ac2_forceOkSeamBites', file: 'quota.test.mjs', seam: 'quota.forceOk' },
  ],
  5: [{ fn: 'ac5_dispatchArgv', file: 'run.test.mjs', seam: 'fleetArgs.dropNoPr' }],
  12: [
    { fn: 'ac12_sevenKeyBearingCommandsAreTheAuthority', file: 'keys.test.mjs', seam: 'keys.leakKey', noFixture: 'the allowlist constant has no runtime seam; the full-sequence half (sequence.test.mjs) carries keys.leakKey' },
    { fn: 'ac12_onlyThePinnedAdlcCarriesTheKey', file: 'keys.test.mjs', seam: 'keys.leakKey' },
  ],
  13: [{ fn: 'ac13_unitShape', file: 'service.test.mjs', seam: 'service.omitEnvironmentFile' }],
  24: [
    { fn: 'ac24_derivedPathsAreAbsoluteUnderRoot', file: 'paths.test.mjs', seam: 'input.acceptAnything' },
    { fn: 'ac24_linkedWorktreeRefused', file: 'paths.test.mjs', seam: 'paths.allowLinkedWorktree' },
  ],
  25: [{ fn: 'ac25_globalBudget', file: 'run.test.mjs', seam: 'run.budgetNotGlobal', noFixture: 'remainingBudget is pure; the round-consumption seam run.budgetNotGlobal is exercised by sequence.test.mjs' }],
  41: [
    { fn: 'ac41_and_90_outcomeMapping', file: 'run.test.mjs', seam: 'run.acceptUnknownReason' },
    { fn: 'ac41_dispatchParsesResultAndResume', file: 'run.test.mjs', seam: 'dispatch.keyInFleetEnv' },
  ],
  60: [{ fn: 'ac60_preStrikeResolvedValues', file: 'run.test.mjs', seam: 'fleetArgs.bareAdlcInHelper' }],
  78: [{ fn: 'ac78_readSetAndWritableRoots', file: 'run.test.mjs', seam: 'fleetArgs.readSetIncludesRepo' }],
  81: [{ fn: 'ac81_mirrorIsTheOnlyGitDatabase', file: 'run.test.mjs', seam: 'fleetArgs.readSetIncludesRepo' }],
  90: [{ fn: 'ac41_and_90_outcomeMapping', file: 'run.test.mjs', seam: 'run.acceptUnknownReason' }],
  103: [{ fn: 'ac103_preStrikeMinimalEnv', file: 'run.test.mjs', seam: 'fleetArgs.leakEnvToHelper' }],
  113: [{ fn: 'ac113_systemRootException', file: 'run.test.mjs', seam: 'fleetArgs.bindToolDirs' }],
  152: [{ fn: 'ac152_and_162_argv', file: 'run.test.mjs', seam: 'fleetArgs.openEgress' }],
  162: [{ fn: 'ac152_and_162_argv', file: 'run.test.mjs', seam: 'fleetArgs.openEgress' }],
  22: [
    { fn: 'ac22_twoStartersOneWins', file: 'lock.test.mjs', seam: 'lock.alwaysAcquire' },
    { fn: 'ac22_reclaimRules', file: 'lock.test.mjs', seam: 'lock.alwaysAcquire' },
    { fn: 'ac22_releaseChecksToken', file: 'lock.test.mjs', seam: 'lock.releaseAnyToken' },
    { fn: 'ac22_alwaysAcquireSeamBites', file: 'lock.test.mjs', seam: 'lock.alwaysAcquire' },
    { fn: 'ac22_corruptOwnerIsReclaimable', file: 'lock.test.mjs', seam: 'lock.alwaysAcquire' },
  ],
  23: [{ fn: 'ac23_fallbackGrammar', file: 'quota.test.mjs', seam: 'quota.lenientSchema', noFixture: 'the fallback grammar is a pure parser whose only seam (quota.lenientSchema) is on the endpoint path' }],
  27: [{ fn: 'ac27_overshootAndReserve', file: 'quota.test.mjs', seam: 'quota.noReserve' }],
  28: [
    { fn: 'ac28_operatorLocalPrecedence', file: 'config.test.mjs', seam: 'config.honourRepoOperatorKeys' },
    { fn: 'ac28_seamsBite', file: 'config.test.mjs', seam: 'config.allowRaise' },
  ],
  31: [{ fn: 'ac31_gitSpawnClassifier', file: 'git-env.test.mjs', seam: 'input.acceptAnything', noFixture: 'the classifier is pure; the spawn-list half of AC 31 (sequence.test.mjs) carries the fixture' }],
  37: [{ fn: 'ac37_thresholdCeiling', file: 'config.test.mjs', seam: 'config.acceptAnyThreshold' }],
  47: [
    { fn: 'ac47_strictSchemaAndNoScopedLimit', file: 'quota.test.mjs', seam: 'quota.lenientSchema' },
    { fn: 'ac47_lenientSchemaSeamBites', file: 'quota.test.mjs', seam: 'quota.lenientSchema' },
  ],
  49: [
    { fn: 'ac49_deadlineSignalsGroupThenKills', file: 'deadline.test.mjs', seam: 'spawn.noDeadline' },
    { fn: 'ac49_deadlineTableIsTheSpecTable', file: 'deadline.test.mjs', seam: 'spawn.noDeadline' },
    { fn: 'ac49_retryOnlyRetryable', file: 'deadline.test.mjs', seam: 'spawn.noDeadline' },
    { fn: 'ac49_stdoutCapKillsChild', file: 'deadline.test.mjs', seam: 'spawn.noDeadline' },
    { fn: 'ac49_envIsExactlyWhatWasPassed', file: 'deadline.test.mjs', seam: 'spawn.noDeadline' },
  ],
  53: [{ fn: 'ac53_repoAndPushBinding', file: 'remote.test.mjs', seam: 'input.acceptAnything' }],
  54: [{ fn: 'ac74_paginationContract', file: 'github.test.mjs', seam: 'input.acceptAnything' }],
  64: [{ fn: 'ac64_argvArrayShellFalse', file: 'deadline.test.mjs', seam: 'spawn.shellTrue' }],
  65: [{ fn: 'ac65_familyNormalization', file: 'quota.test.mjs', seam: 'quota.forceOk' }],
  68: [
    { fn: 'ac68_repoBinIsSkippedAndSystemPinned', file: 'tools.test.mjs', seam: 'tools.trustAnyPath' },
    { fn: 'ac68_untrustedTool', file: 'tools.test.mjs', seam: 'tools.trustAnyPath' },
    { fn: 'ac68_trustedBinDirsNarrows', file: 'tools.test.mjs', seam: 'tools.trustAnyPath' },
  ],
  71: [{ fn: 'ac71_absolutePathsAndModes', file: 'service.test.mjs', seam: 'service.omitEnvironmentFile' }],
  73: [
    { fn: 'ac73_issueNumberGrammar', file: 'input.test.mjs', seam: 'input.acceptAnything' },
    { fn: 'ac73_oidGrammar', file: 'input.test.mjs', seam: 'input.acceptAnything' },
    { fn: 'ac73_ticketIdGrammar', file: 'input.test.mjs', seam: 'input.acceptAnything' },
    { fn: 'ac73_branchIsConstructedNeverSupplied', file: 'input.test.mjs', seam: 'input.acceptAnything' },
    { fn: 'ac73_pathComponentsAndRealpath', file: 'input.test.mjs', seam: 'input.acceptAnything' },
  ],
  74: [
    { fn: 'ac74_paginationContract', file: 'github.test.mjs', seam: 'input.acceptAnything' },
    { fn: 'ac74_truncationCases', file: 'github.test.mjs', seam: 'input.acceptAnything' },
  ],
  77: [{ fn: 'ac77_ticketSyncValidates', file: 'config.test.mjs', seam: 'config.honourRepoOperatorKeys', noFixture: 'the ticketSync schema check has no seam of its own; a schema-lite defect is exercised by AC 125' }],
  87: [{ fn: 'ac87_sampleNeverReusedPastTtl', file: 'quota.test.mjs', seam: 'quota.reuseStale' }],
  88: [
    { fn: 'ac88_everyPatternIsReplacedWithItsName', file: 'redact.test.mjs', seam: 'redactor.disable' },
    { fn: 'ac88_failClosedOnThrowOrResidual', file: 'redact.test.mjs', seam: 'redactor.skipSecondPass' },
  ],
  99: [{ fn: 'ac99_chunkedRedactionCatchesStraddlingSecret', file: 'redact.test.mjs', seam: 'redactor.disable' }],
  102: [{ fn: 'ac102_promptOnStdinNeverArgv', file: 'deadline.test.mjs', seam: 'spawn.shellTrue', noFixture: 'stdin transport has no production seam that keeps the wrapper importable; argv safety (AC 64) covers the adjacent defect' }],
  105: [{ fn: 'ac105_structuredRedactionKeepsSchema', file: 'redact.test.mjs', seam: 'redactor.disable' }],
  112: [{ fn: 'ac112_credentialsNeverEscape', file: 'remote.test.mjs', seam: 'input.acceptAnything' }],
  124: [
    { fn: 'ac124_sanitizedGitEnv', file: 'git-env.test.mjs', seam: 'gitEnv.keepInherited' },
    { fn: 'ac124_repoConfigAudit', file: 'git-env.test.mjs', seam: 'gitEnv.auditPasses' },
  ],
  125: [{ fn: 'ac125_exampleIsValidJsonAndSchemaClean', file: 'config.test.mjs', seam: 'config.honourRepoOperatorKeys' }],
  126: [
    { fn: 'ac126_boundTableIsSevenRowsInOrder', file: 'git-env.test.mjs', seam: 'gitEnv.dropIdentityRows' },
    { fn: 'ac126_boundEnvBeatsRewrittenFile', file: 'git-env.test.mjs', seam: 'gitEnv.dropIdentityRows' },
  ],
  132: [{ fn: 'ac132_sshOnlyForms', file: 'remote.test.mjs', seam: 'input.acceptAnything' }],
  143: [{ fn: 'ac143_netGitTemplateAndVerify', file: 'git-env.test.mjs', seam: 'gitEnv.auditPasses' }],
  148: [{ fn: 'ac148_ghHostBinding', file: 'remote.test.mjs', seam: 'input.acceptAnything' }],
  153: [{ fn: 'ac68_untrustedTool', file: 'tools.test.mjs', seam: 'tools.trustAnyPath' }],
  163: [{ fn: 'ac163_everyGhSpawnIsHostBound', file: 'github.test.mjs', seam: 'github.dropHostBinding' }],
};

/** The critical set for which the mutation-fixture check is mandatory (AC 114): quota, authorization, redaction, retirement, attestation. */
export const CRITICAL_CRITERIA = Object.freeze([2, 27, 33, 47, 63, 65, 70, 79, 85, 87, 88, 91, 92, 96, 105, 109, 155, 36, 38, 46, 144]);
