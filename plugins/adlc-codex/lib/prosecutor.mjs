// prosecutor.mjs — re-export shim over @adlc/core's prosecutor module (T54,
// mirroring plugins/adlc-claude-code/lib/prosecutor.mjs). The single
// implementation of the P5 prosecution registry and pure orchestration
// helpers (dedupe, verifier-majority, loop-until-dry) lives in
// packages/core/lib/prosecutor.mjs; this file only re-exposes it at the path
// this plugin's skill/tests reference. Reference-equality with @adlc/core is
// asserted by lib/test/prosecutor-delegation.test.mjs, so a reintroduced
// local copy fails CI.
//
// NOTE (shim form): the aliased `export const` bindings — rather than a bare
// `export { X } from '@adlc/core'` — are deliberate, matching the Claude Code
// plugin's shim: each binding is the SAME reference as @adlc/core's export
// (no copies, no wrappers).

import {
  LENSES as coreLenses,
  VERIFIER as coreVerifier,
  ALL_AGENTS as coreAllAgents,
  findingKey as coreFindingKey,
  dedupeFindings as coreDedupeFindings,
  survivesVerification as coreSurvivesVerification,
  shouldContinue as coreShouldContinue,
} from '@adlc/core';

export const LENSES = coreLenses;
export const VERIFIER = coreVerifier;
export const ALL_AGENTS = coreAllAgents;
export const findingKey = coreFindingKey;
export const dedupeFindings = coreDedupeFindings;
export const survivesVerification = coreSurvivesVerification;
export const shouldContinue = coreShouldContinue;
