// @adlc/quartermaster — the operator-local supply layer (docs/specs/operating-stack.md).
//
// Two seams, nothing else: (a) load and validate the operator-local channel
// registry, and (b) route a lifecycle job to a channel, a reviewer group, or the
// deterministic path. No LLM calls, no repo-side channel selection, no defaults.

export {
  CHANNEL_NAMES,
  REVIEWER_GROUP_NAMES,
  TRANSPORT_PREFIXES,
  DIRECT_TRANSPORT_PREFIXES,
  BUILD_JOBS,
  NON_BUILD_JOB_ROUTES,
  SPEC_CLASS_CATEGORIES,
  isDeterministicJob,
  hasKnownTransportPrefix,
  isDirectTransport,
  transportClass,
} from './lib/channels.mjs';

export { normalizeProviderName, isNormalizedProvider } from './lib/provider.mjs';

export {
  REGISTRY_ENV,
  REGISTRY_BASENAME,
  IN_REPO_REGISTRY_PATHS,
  resolveRegistryPath,
  findIgnoredInRepoRegistries,
  isInside,
} from './lib/registry-path.mjs';

export { HARNESS_DEFAULT_MODEL } from './lib/channels.mjs';
export { REGISTRY_SCHEMA_VERSION, RULE, RegistryValidationError, validateRegistry } from './lib/registry.mjs';

export { RegistryLoadError, loadRegistry, resolveRoute } from './lib/load.mjs';

export { routeJob, deriveBuildJob } from './lib/route-job.mjs';

export { LADDER_CHANNELS, channelForAttempt, escalationRungs, rungForAttempt } from './lib/escalate.mjs';
