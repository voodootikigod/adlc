// The AC registry (spec AC 1, 111, 114, 121): an EXPLICIT map from every §16
// criterion number to one or more exported test functions, each with the
// mutation seam that makes it fail (or a `noFixture` reason, capped at 5 in
// total). spec-coverage.test.mjs is the gate that turns this map into a proof:
// it parses §16 at the pinned blob, executes every function here, checks each
// registered test's title and its production seam statically, and asserts the
// named fixture bites.
//
// Entry shape: { fn: '<exported name>', file: '<test file>', seam: '<module.defect>' | null, noFixture?: '<reason>' }
//           or { manual: '<what a human does and records>' } for the spec's MANUAL criteria (AC 17 only).

export const REGISTRY = {
  1: [{ fn: 'ac1_registryExecutesEveryFunction', file: 'spec-coverage.test.mjs', seam: null, noFixture: 'the gate itself; its self-tests (AC 111/114/121) are the fixture' }],
  2: [
    { fn: 'ac2_quotaMatrix', file: 'quota.test.mjs', seam: 'quota.forceOk' },
    { fn: 'ac2_endpointHeadersAndFallback', file: 'quota.test.mjs', seam: 'quota.forceOk' },
    { fn: 'ac2_forceOkSeamBites', file: 'quota.test.mjs', seam: 'quota.forceOk' },
    { fn: 'ac2_productionReaderHasATransport', file: 'quota.test.mjs', seam: 'context.noUsageTransport' },
  ],
  3: [{ fn: 'ac3_selection', file: 'select.test.mjs', seam: 'select.ignoreLabels' }],
  4: [
    { fn: 'ac4_gateFailuresClarifyWithFindingsAndTemplate', file: 'triage.test.mjs', seam: 'triage.acceptRootWildcard' },
    { fn: 'ac4_clarifyEffectsReconcileAgainstGithub', file: 'triage.test.mjs', seam: 'effects.trustRecord' },
    { fn: 'ac4_terminalEffectsReconcileIndependently', file: 'terminal-effects.test.mjs', seam: 'effects.skipIntent' },
    { fn: 'ac4_intentPersistedBeforeEffects', file: 'terminal-effects.test.mjs', seam: 'effects.skipIntent' },
    { fn: 'ac4_redactionFailureWithholdsBodyKeepsLabel', file: 'terminal-effects.test.mjs', seam: 'redactor.disable' },
    { fn: 'ac4_labelOnGithubAbsentFromRecord', file: 'terminal-effects.test.mjs', seam: 'effects.trustRecord' },
    { fn: 'ac4_commentSearchCoversEveryPage', file: 'github.test.mjs', seam: 'github.paginateAll' },
  ],
  5: [{ fn: 'ac5_dispatchArgv', file: 'run.test.mjs', seam: 'fleetArgs.dropNoPr' }],
  11: [
    { fn: 'ac11_missingLabelsNamesTheAbsentOnes', file: 'labels.test.mjs', seam: 'labels.ignoreMissing' },
    { fn: 'ac11_ensureLabelsCreatesIdempotently', file: 'labels.test.mjs', seam: 'labels.skipCreate' },
    { fn: 'ac11_redFixturesPerItem', file: 'preflight.test.mjs', seam: 'preflight.skipKeyFileCheck' },
  ],
  19: [
    { fn: 'ac19_corruptAttemptLedgerFailsClosed', file: 'loop.test.mjs', seam: 'selection.failOpenAttempts' },{ fn: 'ac19_pinnedIssueHonorsExclusions', file: 'select.test.mjs', seam: 'select.forceLiftsAll' }],
  26: [{ fn: 'ac26_trustedBlockSkipsShapingButGatesStillRun', file: 'triage.test.mjs', seam: 'triage.skipDenylist' }],
  32: [
    { fn: 'ac32_trustedBlockAssembly', file: 'triage.test.mjs', seam: 'triage.shapeTrustedBlock' },
    { fn: 'ac32_blockGrammarFailsClosed', file: 'block.test.mjs', seam: 'block.lenientGrammar' },
  ],
  33: [{ fn: 'ac33_oneAuthorizationPredicate', file: 'select.test.mjs', seam: 'authorize.trustWriteActors' }],
  35: [{ fn: 'ac35_shapingBounds', file: 'triage.test.mjs', seam: 'spawn.noDeadline' }],
  59: [{ fn: 'ac59_durableAttemptLedger', file: 'triage.test.mjs', seam: 'attempts.ignoreStarted' }],
  79: [{ fn: 'ac79_dispatchApprovalModes', file: 'select.test.mjs', seam: 'authorize.acceptUnknownMode' }],
  85: [{ fn: 'ac85_dispatchApprovalDefault', file: 'select.test.mjs', seam: 'authorize.trustedAuthorsDefault' }],
  96: [{ fn: 'ac96_modelInputsAreRedacted', file: 'triage.test.mjs', seam: 'triage.skipRedaction' }],
  97: [
    { fn: 'ac97_tombstoneBeforeUnlink', file: 'records.test.mjs', seam: 'records.unlinkBeforeTombstone' },{ fn: 'ac97_selectionTimeRemoteCheck', file: 'select.test.mjs', seam: 'select.skipRemoteRefCheck' }],
  101: [{ fn: 'ac101_bodyOnlyModelInput', file: 'triage.test.mjs', seam: 'triage.fetchComments' }],
  109: [{ fn: 'ac109_labelRemovalRevokes', file: 'select.test.mjs', seam: 'authorize.ignoreUnlabel' }],
  115: [
    { fn: 'ac115_resetAttemptsGrammar', file: 'triage.test.mjs', seam: 'attempts.resetWithoutLock' },
    { fn: 'ac115_resetIsTheExitFromShapingFailed', file: 'triage.test.mjs', seam: 'attempts.noArchive' },
  ],
  118: [{ fn: 'ac118_archivePrecedesPruning', file: 'triage.test.mjs', seam: 'attempts.pruneOnReset' }],
  123: [{ fn: 'ac123_crashIdempotentReset', file: 'triage.test.mjs', seam: 'attempts.skipJournal' }],
  134: [{ fn: 'ac134_framedArchiveRecovery', file: 'triage.test.mjs', seam: 'attempts.acceptTruncatedTail' }],
  140: [
    { fn: 'ac140_denylistDerivesFromTrustRootLists', file: 'denylist.test.mjs', seam: 'denylist.staticOnly' },
    { fn: 'ac140_scopeIntersectionIsConservative', file: 'denylist.test.mjs', seam: 'denylist.allowShrink' },
    { fn: 'ac140_denylistInDiffCheck', file: 'diffcheck.test.mjs', seam: 'diffcheck.skipDenylist' },
  ],
  150: [{ fn: 'ac150_corruptArchiveLineIsQuarantined', file: 'triage.test.mjs', seam: 'attempts.skipQuarantine' }],
  155: [{ fn: 'ac155_authorizationBindsRevision', file: 'select.test.mjs', seam: 'authorize.ignoreEdits' }],
  12: [
    { fn: 'ac12_sevenKeyBearingCommandsAreTheAuthority', file: 'keys.test.mjs', seam: 'keys.leakKey', noFixture: 'the allowlist constant has no runtime seam; the sibling entry carries keys.leakKey' },
    { fn: 'ac12_onlyThePinnedAdlcCarriesTheKey', file: 'keys.test.mjs', seam: 'keys.leakKey' },
  ],
  13: [{ fn: 'ac13_unitShape', file: 'service.test.mjs', seam: 'service.omitEnvironmentFile' }],
  24: [
    { fn: 'ac24_derivedPathsAreAbsoluteUnderRoot', file: 'paths.test.mjs', seam: 'input.acceptAnything' },
    { fn: 'ac24_linkedWorktreeRefused', file: 'paths.test.mjs', seam: 'paths.allowLinkedWorktree' },
    { fn: 'ac24_pathResolution', file: 'create.test.mjs', seam: 'create.cwdRepoRoot' },
  ],
  25: [{ fn: 'ac25_globalBudget', file: 'run.test.mjs', seam: 'run.budgetNotGlobal' }],
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
  162: [
    { fn: 'ac152_and_162_argv', file: 'run.test.mjs', seam: 'fleetArgs.openEgress' },
    { fn: 'ac162_workerDepsBuilt', file: 'deps.test.mjs', seam: 'deps.useOperatorHome' },
  ],
  22: [
    { fn: 'ac22_lockPublishIsAtomic', file: 'lock.test.mjs', seam: 'lock.twoStepPublish' },
    { fn: 'ac22_twoStartersOneWins', file: 'lock.test.mjs', seam: 'lock.alwaysAcquire' },
    { fn: 'ac22_reclaimRules', file: 'lock.test.mjs', seam: 'lock.alwaysAcquire' },
    { fn: 'ac22_releaseChecksToken', file: 'lock.test.mjs', seam: 'lock.releaseAnyToken' },
    { fn: 'ac22_alwaysAcquireSeamBites', file: 'lock.test.mjs', seam: 'lock.alwaysAcquire' },
  ],
  23: [{ fn: 'ac23_fallbackGrammar', file: 'quota.test.mjs', seam: 'quota.lenientText' }],
  27: [{ fn: 'ac27_overshootAndReserve', file: 'quota.test.mjs', seam: 'quota.noReserve' }],
  28: [
    { fn: 'ac28_operatorLocalPrecedence', file: 'config.test.mjs', seam: 'config.honourRepoOperatorKeys' },
    { fn: 'ac28_loweringIsApplied', file: 'loop.test.mjs', seam: 'config.allowRaise' },
  ],
  31: [
    { fn: 'ac31_gitSpawnClassifier', file: 'git-env.test.mjs', seam: 'gitEnv.classifierNetworkBlind' },
    { fn: 'ac31_baselineByOid', file: 'preflight.test.mjs', seam: 'preflight.fetchByName' },
  ],
  37: [{ fn: 'ac37_thresholdCeiling', file: 'config.test.mjs', seam: 'config.acceptAnyThreshold' }],
  47: [
    { fn: 'ac47_strictSchemaAndNoScopedLimit', file: 'quota.test.mjs', seam: 'quota.lenientSchema' },
    { fn: 'ac47_lenientSchemaSeamBites', file: 'quota.test.mjs', seam: 'quota.lenientSchema' },
  ],
  49: [
    { fn: 'ac49_deadlineSignalsGroupThenKills', file: 'deadline.test.mjs', seam: 'spawn.noDeadline' },
    { fn: 'ac49_retryOnlyRetryable', file: 'deadline.test.mjs', seam: 'spawn.retryEverything' },
    { fn: 'ac49_stdoutCapKillsChild', file: 'deadline.test.mjs', seam: 'spawn.noStdoutCap' },
    { fn: 'ac49_envIsExactlyWhatWasPassed', file: 'deadline.test.mjs', seam: 'spawn.inheritEnv' },
  ],
  53: [{ fn: 'ac53_repoAndPushBinding', file: 'remote.test.mjs', seam: 'remote.ignorePushUrl' }],
  54: [{ fn: 'ac74_paginationContract', file: 'github.test.mjs', seam: 'github.paginateAll' }],
  64: [{ fn: 'ac64_argvArrayShellFalse', file: 'deadline.test.mjs', seam: 'spawn.shellTrue' }],
  65: [{ fn: 'ac65_familyNormalization', file: 'quota.test.mjs', seam: 'quota.forceOk' }],
  68: [
    { fn: 'ac68_repoBinIsSkippedAndSystemPinned', file: 'tools.test.mjs', seam: 'tools.trustAnyPath' },
    { fn: 'ac68_untrustedTool', file: 'tools.test.mjs', seam: 'tools.trustAnyPath' },
  ],
  71: [{ fn: 'ac71_absolutePathsAndModes', file: 'service.test.mjs', seam: 'service.relativeWorkingDirectory' }],
  73: [
    { fn: 'ac73_issueNumberGrammar', file: 'input.test.mjs', seam: 'input.acceptAnything' },
    { fn: 'ac73_oidGrammar', file: 'input.test.mjs', seam: 'input.acceptAnything' },
    { fn: 'ac73_ticketIdGrammar', file: 'input.test.mjs', seam: 'input.acceptAnything' },
    { fn: 'ac73_branchIsConstructedNeverSupplied', file: 'input.test.mjs', seam: 'input.acceptAnything' },
    { fn: 'ac73_pathComponentsAndRealpath', file: 'input.test.mjs', seam: 'input.acceptAnything' },
  ],
  74: [
    { fn: 'ac74_paginationContract', file: 'github.test.mjs', seam: 'github.paginateAll' },
    { fn: 'ac74_truncationCases', file: 'github.test.mjs', seam: 'github.paginateAll' },
  ],
  77: [{ fn: 'ac77_ticketSyncValidates', file: 'config.test.mjs', seam: 'config.skipTicketSyncSchema' }],
  87: [
    { fn: 'ac87_sampleNeverReusedPastTtl', file: 'quota.test.mjs', seam: 'quota.reuseStale' },
    { fn: 'ac87_ordinalIsRecordedUnderTheLock', file: 'status.test.mjs', seam: 'status.noLockForOrdinal' },
    { fn: 'ac87_reconciliationAppendsToStatusAndRecord', file: 'status.test.mjs', seam: 'quota-gate.skipRecordAppend' },
  ],
  88: [
    { fn: 'ac88_everyPatternIsReplacedWithItsName', file: 'redact.test.mjs', seam: 'redactor.disable' },
    { fn: 'ac88_failClosedOnThrowOrResidual', file: 'redact.test.mjs', seam: 'redactor.skipSecondPass' },
  ],
  99: [{ fn: 'ac99_chunkedRedactionCatchesStraddlingSecret', file: 'redact.test.mjs', seam: 'redactor.disable' }],
  102: [
    { fn: 'ac102_promptTransport', file: 'triage.test.mjs', seam: 'triage.promptInArgv' },
    { fn: 'ac102_promptOnStdinNeverArgv', file: 'deadline.test.mjs', seam: 'spawn.shellTrue', noFixture: 'stdin transport has no production seam that keeps the wrapper importable; triage.promptInArgv above is the biting fixture' },
  ],
  105: [{ fn: 'ac105_structuredRedactionKeepsSchema', file: 'redact.test.mjs', seam: 'redactor.disable' }],
  112: [{ fn: 'ac112_credentialsNeverEscape', file: 'remote.test.mjs', seam: 'remote.keepCredentials' }],
  124: [
    { fn: 'ac124_sanitizedGitEnv', file: 'git-env.test.mjs', seam: 'gitEnv.keepInherited' },
    { fn: 'ac124_repoConfigAudit', file: 'git-env.test.mjs', seam: 'gitEnv.auditPasses' },
    { fn: 'ac124_everyGitSpawnIsSanitized', file: 'git-runner.test.mjs', seam: 'gitRunner.inheritEnv' },
    { fn: 'ac124_auditBeforeLsRemote', file: 'preflight.test.mjs', seam: 'preflight.skipConfigAudit' },
  ],
  125: [{ fn: 'ac125_exampleIsValidJsonAndSchemaClean', file: 'config.test.mjs', seam: 'config.skipTicketSyncSchema' }],
  126: [
    { fn: 'ac126_boundTableIsSevenRowsInOrder', file: 'git-env.test.mjs', seam: 'gitEnv.dropIdentityRows' },
    { fn: 'ac126_boundEnvBeatsRewrittenFile', file: 'git-env.test.mjs', seam: 'gitEnv.dropUrlRows' },
    { fn: 'ac126_netCarriesBoundTableOnly', file: 'git-runner.test.mjs', seam: 'gitRunner.noOverlay' },
  ],
  132: [{ fn: 'ac132_sshOnlyForms', file: 'remote.test.mjs', seam: 'remote.acceptHttps' }],
  143: [
    { fn: 'ac143_netGitTemplateAndVerify', file: 'git-env.test.mjs', seam: 'gitEnv.verifyNetGitAlways' },
    { fn: 'ac143_netGitIsolatesTransport', file: 'git-runner.test.mjs', seam: 'gitRunner.skipRevalidation' },
  ],
  148: [
    { fn: 'ac148_freshContextIsPinned', file: 'preflight.test.mjs', seam: 'preflight.skipPinWhenPathSet' },
    { fn: 'ac148_ghHostBinding', file: 'remote.test.mjs', seam: 'remote.acceptAnyGhHost' },
    { fn: 'ac148_knownHostsFromMeta', file: 'ssh.test.mjs', seam: 'ssh.knownHostsAnyHost' },
    { fn: 'ac148_hostBindingInPhaseA', file: 'preflight.test.mjs', seam: 'preflight.skipHostBinding' },
  ],
  153: [
    { fn: 'ac68_untrustedTool', file: 'tools.test.mjs', seam: 'tools.trustAnyPath' },
    { fn: 'ac153_pinnedSshTools', file: 'ssh.test.mjs', seam: 'ssh.unpinnedTools' },
    { fn: 'ac153_untrustedSshAdd', file: 'preflight.test.mjs', seam: 'preflight.trustInheritedTools' },
  ],
  163: [{ fn: 'ac163_everyGhSpawnIsHostBound', file: 'github.test.mjs', seam: 'github.dropHostBinding' }],
  136: [
    { fn: 'ac136_readOnlyCommandsReleaseSshMaterial', file: 'loop.test.mjs', seam: 'loop.leakDryRunSsh' },
    { fn: 'ac136_authModeExclusive', file: 'ssh.test.mjs', seam: 'ssh.preferAgentWhenAmbiguous' },
    { fn: 'ac136_modesInPhaseA', file: 'preflight.test.mjs', seam: 'ssh.acceptInsecureIdentity' },
  ],
  145: [
    { fn: 'ac145_keyMatchRule', file: 'ssh.test.mjs', seam: 'ssh.acceptFirstCandidate' },
    { fn: 'ac145_paginatedKeysInPhaseA', file: 'preflight.test.mjs', seam: 'ssh.acceptFirstCandidate' },
  ],
  129: [
    { fn: 'ac129_wrapperTemplate', file: 'ssh.test.mjs', seam: 'ssh.wrapperOmitOptions' },
    { fn: 'ac129_knownHostsAndWrapperOnNetSpawn', file: 'preflight.test.mjs', seam: 'ssh.acceptAnyKnownHosts' },
  ],
  139: [
    { fn: 'ac139_wrapperOddPathsRealSsh', file: 'ssh.test.mjs', seam: 'ssh.noShellQuote' },
  ],
  146: [
    { fn: 'ac146_bindingUsesCopy', file: 'ssh.test.mjs', seam: 'ssh.fingerprintOriginal' },
  ],
  147: [
    { fn: 'ac147_revalidation', file: 'ssh.test.mjs', seam: 'ssh.skipRevalidation' },
    { fn: 'ac147_netRevalidatesMaterialBeforeSpawn', file: 'git-runner.test.mjs', seam: 'gitRunner.skipRevalidation' },
  ],
  151: [
    { fn: 'ac151_explicitKeyIsCopy', file: 'ssh.test.mjs', seam: 'ssh.wrapperNamesOriginal' },
  ],
  159: [
    { fn: 'ac159_dryRunDirOutsideRepo', file: 'ssh.test.mjs', seam: 'ssh.dryRunUnderRepo' },
    { fn: 'ac159_dryRunTransport', file: 'preflight.test.mjs', seam: 'ssh.dryRunUnderRepo' },
  ],
  127: [
    { fn: 'ac127_identityRewriteBeatsPrefix', file: 'git-runner.test.mjs', seam: 'gitRunner.identityRowsDropped' },
  ],
  138: [
    { fn: 'ac138_identityAssertion', file: 'git-runner.test.mjs', seam: 'gitRunner.skipIdentityCheck' },
  ],
  119: [
    { fn: 'ac119_identityIsOperatorLocal', file: 'preflight.test.mjs', seam: 'preflight.trustBlobRepo' },
  ],
  117: [
    { fn: 'ac117_phasesAreOrdered', file: 'preflight.test.mjs', seam: 'preflight.phaseBWithoutBaseline' },
  ],
  20: [
    { fn: 'ac20_baselineFailureIsUnresolved', file: 'preflight.test.mjs', seam: 'preflight.ignoreFetchFailure' },
    { fn: 'ac20_gateSpawnsCarryBaseOid', file: 'gates.test.mjs', seam: 'gates.spawnPreflightAlways' },
  ],
  86: [
    { fn: 'ac86_parityReadsBaseline', file: 'preflight.test.mjs', seam: 'preflight.parityFromWorkingTree' },
  ],
  116: [
    { fn: 'ac116_configFromBlob', file: 'preflight.test.mjs', seam: 'preflight.trustWorkingTreeConfig' },
  ],
  120: [
    { fn: 'ac120_fleetDryRunWorktree', file: 'preflight.test.mjs', seam: 'preflight.keepPreflightWorktree' },
  ],
  133: [
    { fn: 'ac133_fleetDryRunBoundToOid', file: 'preflight.test.mjs', seam: 'preflight.acceptAnyBaseSha' },
  ],
  158: [
    { fn: 'ac158_tokenMargin', file: 'preflight.test.mjs', seam: 'preflight.ignoreTokenMargin' },
  ],
  80: [
    { fn: 'ac80_newestApprovalHashPinned', file: 'preflight-spec.test.mjs', seam: 'specApproval.oldestWins' },
  ],
  83: [
    { fn: 'ac83_unsignedApprovalIsRefused', file: 'preflight-spec.test.mjs', seam: 'specApproval.acceptUnsigned' },
    { fn: 'ac83_realRunnerGate', file: 'preflight-spec.test.mjs', seam: 'specApproval.skipRunnerGate' },
    { fn: 'ac83_contentHashNeverBlobOid', file: 'preflight-spec.test.mjs', seam: 'preflight.acceptBlobOidAsSpecHash' },
    { fn: 'ac83_specApprovalRequiresKeyedVerify', file: 'preflight-spec.test.mjs', seam: 'specApproval.skipSignedVerify' },
  ],
  89: [
    { fn: 'ac89_mergeIdentity', file: 'preflight-spec.test.mjs', seam: 'specApproval.skipMergeIdentity' },
  ],
  154: [
    { fn: 'ac154_assumptionsBound', file: 'preflight-spec.test.mjs', seam: 'specApproval.skipAssumptions' },
  ],
  34: [
    { fn: 'ac34_actualDiffCheckScopeManifestSymlink', file: 'diffcheck.test.mjs', seam: 'diffcheck.skipManifestAppendOnly' },
  ],
  55: [
    { fn: 'ac55_ticketSnapshot', file: 'diffcheck.test.mjs', seam: 'diffcheck.skipTicketSnapshot' },
  ],
  76: [
    { fn: 'ac76_everySecretLiteralIsScanned', file: 'diffcheck.test.mjs', seam: 'diffcheck.scanKeyOnly' },
    { fn: 'ac76_secretScanFailClosed', file: 'diffcheck.test.mjs', seam: 'diffcheck.skipSecretScan' },
    { fn: 'ac76_binaryBlobsFailClosed', file: 'diffcheck.test.mjs', seam: 'diffcheck.allowBinary' },
  ],
  98: [
    { fn: 'ac98_criteriaDocTracked', file: 'diffcheck.test.mjs', seam: 'diffcheck.skipCriteriaHash' },
    { fn: 'ac98_criteriaDocumentIsTracked', file: 'create.test.mjs', seam: 'create.untrackedCriteria' },
  ],
  100: [
    { fn: 'ac100_foreignManifestLines', file: 'diffcheck.test.mjs', seam: 'diffcheck.skipForeignLineCheck' },
  ],
  52: [
    { fn: 'ac52_dependencyDiffCheck', file: 'deps.test.mjs', seam: 'deps.ignoreScripts' },
  ],
  56: [
    { fn: 'ac56_lockfileCanonical', file: 'deps.test.mjs', seam: 'lockfile.ignoreResolved' },
  ],
  75: [
    { fn: 'ac75_exactNameGuard', file: 'deps.test.mjs', seam: 'deps.allowAnyDep' },
  ],
  157: [
    { fn: 'ac157_gateInstallSanitized', file: 'deps.test.mjs', seam: 'deps.allowOnlineGate' },
    { fn: 'ac157_sandboxDepsResolve', file: 'gates.test.mjs', seam: 'gates.skipDepsBind' },
  ],
  84: [
    { fn: 'ac84_workerMirror', file: 'mirror.test.mjs', seam: 'mirror.keepRemote' },
  ],
  94: [
    { fn: 'ac94_mirrorOutsideWorktree', file: 'mirror.test.mjs', seam: 'mirror.keepStale' },
  ],
  106: [
    { fn: 'ac106_fetchBack', file: 'mirror.test.mjs', seam: 'mirror.skipAncestorCheck' },
  ],
  161: [
    { fn: 'ac161_gateMirror', file: 'mirror.test.mjs', seam: 'mirror.skipVerify' },
  ],
  122: [
    { fn: 'ac122_bracket', file: 'gates.test.mjs', seam: 'gates.skipBracket' },
  ],
  135: [
    { fn: 'ac135_trackingRefVerified', file: 'gates.test.mjs', seam: 'gates.skipSnapshotCheck' },
  ],
  141: [
    { fn: 'ac141_trackingRefNeverClobbered', file: 'gates.test.mjs', seam: 'gates.clobberTrackingRef' },
  ],
  149: [
    { fn: 'ac149_gatesSandboxedArgv', file: 'gates.test.mjs', seam: 'gates.allowNetwork' },
    { fn: 'ac149_realBwrapGates', file: 'gates.test.mjs', seam: 'gates.skipSnapshotCheck' },
  ],
  21: [
    { fn: 'ac21_recoveryTableRows', file: 'recover.test.mjs', seam: 'recover.deleteRecordDespiteRemoteRef' },
    { fn: 'ac21_resumableRunsAreResumed', file: 'loop.test.mjs', seam: 'loop.ignoreRecoveryActions' },
  ],
  29: [
    { fn: 'ac29_ownershipCheckedDeletion', file: 'recover.test.mjs', seam: 'retire.skipMarkerCheck' },
  ],
  42: [
    { fn: 'ac42_remotePendingResettable', file: 'recover.test.mjs', seam: 'reset.leaselessDelete' },
  ],
  43: [
    { fn: 'ac43_rearmVsRetire', file: 'recover.test.mjs', seam: 'recover.retireInsteadOfRearm' },
  ],
  45: [
    { fn: 'ac45_orphanResetAuthorization', file: 'recover.test.mjs', seam: 'reset.markerOptional' },
  ],
  58: [
    { fn: 'ac58_oidMismatchWithoutPr', file: 'recover.test.mjs', seam: 'recover.rearmWithoutPr' },
  ],
  63: [
    { fn: 'ac63_leaseGuardedRemoteDeleteIsOperatorOnly', file: 'recover.test.mjs', seam: 'reset.skipFreshnessCheck' },
  ],
  67: [
    { fn: 'ac67_authorizedUnlabel', file: 'recover.test.mjs', seam: 'recover.trustAnyUnlabel' },
  ],
  70: [
    { fn: 'ac70_localDeletionRevalidation', file: 'recover.test.mjs', seam: 'retire.skipTipCheck' },
  ],
  92: [
    { fn: 'ac92_detachBeforeRefDelete', file: 'recover.test.mjs', seam: 'retire.noDetach' },
  ],
  93: [
    { fn: 'ac93_crashSafeCreation', file: 'recover.test.mjs', seam: 'create.repairIgnoresTipMove' },
  ],
  104: [
    { fn: 'ac104_stagedCreation', file: 'recover.test.mjs', seam: 'create.skipStaging' },
  ],
  107: [
    { fn: 'ac107_creationPhasesJournaled', file: 'recover.test.mjs', seam: 'create.phaseAfterGit' },
  ],
  110: [
    { fn: 'ac110_pinnedRemoteUrl', file: 'recover.test.mjs', seam: 'reset.skipUrlRecheck' },
    { fn: 'ac110_pinnedRemoteUrl', file: 'push.test.mjs', seam: 'push.useOriginName' },
  ],
  72: [
    { fn: 'ac72_p0p1RecordMechanics', file: 'create.test.mjs', seam: 'create.recordDespiteGaps' },
  ],
  30: [
    { fn: 'ac30_fullSequence', file: 'sequence.test.mjs', seam: 'run.budgetNotGlobal' },
  ],
  36: [
    { fn: 'ac36_verifyThenPushSequence', file: 'sequence.test.mjs', seam: 'push.skipHeadCheck' },
    { fn: 'ac36_verifyThenPush', file: 'push.test.mjs', seam: 'push.skipLease' },
  ],
  38: [
    { fn: 'ac38_reviewedAttestedPushed', file: 'sequence.test.mjs', seam: 'review.reopenWithoutAuthorize' },
    { fn: 'ac38_reviewedEqualsAttestedEqualsPushed', file: 'review.test.mjs', seam: 'review.attestWithoutHeadCheck' },
  ],
  46: [
    { fn: 'ac46_reopenForRetry', file: 'sequence.test.mjs', seam: 'review.reopenWithoutAuthorize' },
    { fn: 'ac46_reopenForRetry', file: 'review.test.mjs', seam: 'review.reopenWithoutAuthorize' },
  ],
  82: [
    { fn: 'ac82_revalidationBeforeWriteAndDispatch', file: 'sequence.test.mjs', seam: 'run.skipRevalidation' },
  ],
  108: [
    { fn: 'ac108_mirrorOutputReachesIntegrationBranch', file: 'sequence.test.mjs', seam: 'run.skipFastForward' },
  ],
  144: [
    { fn: 'ac144_pushSourceIsTheAttestedOid', file: 'sequence.test.mjs', seam: 'push.sourceIsBranchName' },
    { fn: 'ac144_pushSourceIsTheAttestedOid', file: 'push.test.mjs', seam: 'push.sourceIsBranchName' },
  ],
  9: [
    { fn: 'ac9_wallClockKillsFleet', file: 'run.test.mjs', seam: 'dispatch.noDeadline' },
  ],
  95: [
    { fn: 'ac95_privateTmpAndPerFileToolBinds', file: 'run.test.mjs', seam: 'fleetArgs.bindToolDirs' },
  ],
  18: [
    { fn: 'ac18_quotaRecheckPoints', file: 'quota.test.mjs', seam: 'quota.forceOk' },
  ],
  39: [
    { fn: 'ac39_coldstartIsGated', file: 'quota.test.mjs', seam: 'quota.forceOk' },
  ],
  50: [
    { fn: 'ac50_effectiveModelPropagates', file: 'quota.test.mjs', seam: 'quota.forceOk' },
  ],
  10: [
    { fn: 'ac10_dryRunHonesty', file: 'loop.test.mjs', seam: 'loop.dryRunClaimsComplete' },
  ],
  128: [
    { fn: 'ac128_dryRunNeverNeedsAWorktree', file: 'loop.test.mjs', seam: 'loop.dryRunOmitsWorktreeItem' },
  ],
  15: [
    { fn: 'ac15_dependencyDiscipline', file: 'deps.test.mjs', seam: 'deps.allowAnyDep' },
  ],
  14: [{ fn: 'ac14_registryGuards', file: 'repo-guards.test.mjs', seam: null, noFixture: 'the guard suites are external (apps/docs); no autopilot seam can make them fail' }],
  16: [{ fn: 'ac16_gateRecordsForTheBuildTicket', file: 'repo-guards.test.mjs', seam: null, noFixture: 'the records live in this repository\'s committed manifest; the code-level approve is a PR-time process step (prosecute tier-check)' }],
  17: [{ manual: 'live canary — `adlc-autopilot once --issue <docs issue>` produces one PR with green CI and a manifest carrying coldstart, spec-lint, cross-model-review bound to the ULID; `adlc run p5 --ticket <ULID>` exits 0 in that worktree; recorded in the PR body' }],
  111: [{ fn: 'ac111_gateRejectsHollowEntries', file: 'spec-coverage.test.mjs', seam: 'gate.acceptHollowEntries' }],
  114: [{ fn: 'ac114_everyRegisteredFunctionExecutes', file: 'spec-coverage.test.mjs', seam: null, noFixture: 'the executor of every registered function cannot run itself under a fixture' }],
  121: [
    { fn: 'ac121_everyCriterionHasABitingFixture', file: 'spec-coverage.test.mjs', seam: null, noFixture: 'the fixture checker cannot run itself under a fixture; its rules are self-tested below' },
    { fn: 'ac121_fixtureRulesSelfTest', file: 'spec-coverage.test.mjs', seam: 'gate.acceptHollowEntries' },
  ],
  156: [{ fn: 'ac156_syntheticHomeContract', file: 'repo-guards.test.mjs', seam: null, noFixture: 'the contract is fleet\'s real-bwrap suite, spawned as a child test run' }],
  6: [
    { fn: 'ac6_prUpsertEditsOnSecondRun', file: 'pr.test.mjs', seam: 'push.alwaysCreate' },
  ],
  57: [
    { fn: 'ac57_upsertHeadBinding', file: 'pr.test.mjs', seam: 'push.upsertWithoutHeadBinding' },
  ],
  8: [
    { fn: 'ac8_ciFollowUpTable', file: 'ci.test.mjs', seam: 'ci.skippedIsPass' },
  ],
  40: [
    { fn: 'ac40_ciBudgetIndependentOfBuildBudget', file: 'ci.test.mjs', seam: 'ci.shareBudgets' },
  ],
  51: [
    { fn: 'ac51_headBindingDuringCi', file: 'ci.test.mjs', seam: 'ci.ignoreHeadBinding' },
  ],
  66: [
    { fn: 'ac66_normalizationContractFromRealFixture', file: 'ci.test.mjs', seam: 'ci.missingBucketIsPass' },
  ],
  7: [
    { fn: 'ac7_rebasePaths', file: 'maintain.test.mjs', seam: 'maintain.countStaleTowardCap' },
  ],
  48: [
    { fn: 'ac48_carryForwardEquivalence', file: 'maintain.test.mjs', seam: 'maintain.carryForwardWithoutPatchId' },
  ],
  61: [
    { fn: 'ac61_ownershipAndSelector', file: 'maintain.test.mjs', seam: 'maintain.skipProvenance' },
  ],
  62: [
    { fn: 'ac62_prLifecycle', file: 'maintain.test.mjs', seam: 'maintain.deleteRecordWithRemoteRef' },
  ],
  69: [
    { fn: 'ac69_digestProtocol', file: 'digest.test.mjs', seam: 'digest.skipSentinelSearch' },
  ],
  44: [
    { fn: 'ac44_diffSizeGate', file: 'review.test.mjs', seam: 'review.skipSizeGate' },
  ],
  130: [
    { fn: 'ac130_identityObservedUnoverlaid', file: 'preflight-transport.test.mjs', seam: 'gitRunner.overlayObserve' },
  ],
  131: [
    { fn: 'ac131_sshTransportSurvivesConfigRace', file: 'preflight-transport.test.mjs', seam: 'gitRunner.noGitSsh' },
  ],
  137: [
    { fn: 'ac137_splitPushUrlIsRefused', file: 'preflight-transport.test.mjs', seam: 'preflight.ignorePushUrl' },
  ],
  142: [
    { fn: 'ac142_fetchAndPushUrlsAreOneString', file: 'preflight-transport.test.mjs', seam: 'gitRunner.identityRowsDropped' },
  ],
  91: [{ fn: 'ac91_outwardRedactionOnEveryExitPath', file: 'redact.test.mjs', seam: 'redactor.disable' }],
  160: [{ fn: 'ac160_verifySpawnCarriesTheKey', file: 'manifest-verify.test.mjs', seam: 'diffcheck.skipManifestVerify' }],
};

/** The critical set for which the mutation-fixture check is mandatory (AC 114): quota, authorization, redaction, retirement, attestation. */
export const CRITICAL_CRITERIA = Object.freeze([2, 27, 33, 47, 63, 65, 70, 79, 85, 87, 88, 91, 92, 96, 105, 109, 155, 36, 38, 46, 144]);
