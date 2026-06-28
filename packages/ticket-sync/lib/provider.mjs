// provider.mjs — the provider INTERFACE (a documented module shape). There is
// deliberately NO runtime registry: GitHub is the only implementation, so a
// registry would be premature indirection (design D2). A second provider slots in
// by implementing this shape and being imported where the bin selects a provider.
//
// A provider module exports:
//   listIssues(ctx)            -> { ok, issues:[{number, nodeId, url, title, body, labels, state}], error? }
//   createIssue(ctx, {title, body}) -> { ok, number, nodeId, url, error? }   (T9/push)
//   updateIssueBody(ctx, ref, body) -> { ok, error? }                        (T9/push)
//   ensureLabels(ctx, ref, labels)  -> { ok, error? }                        (T9/push)
//   upsertStatusComment(ctx, ref, body) -> { ok, error? }                    (T9/push)
// where `ctx` = { runner, repo, dryRun } (the injected gh runner + target repo).

const REQUIRED = ['listIssues'];

/** Throw if `provider` does not implement the read contract needed for pull. */
export function assertReadProvider(provider) {
  const missing = REQUIRED.filter((m) => typeof provider?.[m] !== 'function');
  if (missing.length) throw new Error(`provider is missing required method(s): ${missing.join(', ')}`);
  return provider;
}
