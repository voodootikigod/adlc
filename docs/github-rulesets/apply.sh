#!/usr/bin/env bash
# Apply the ADLC repository protections via the GitHub REST API:
#   1. Provision and VERIFY the `npm-publish` protected environment (the real
#      publish gate). Referencing a missing environment in a workflow silently
#      creates it with NO protection, so this script creates it with required
#      reviewers AND a deployment-ref allowlist, then fails closed unless both
#      are present.
#   2. Apply the branch and tag rulesets idempotently (update-or-create, refuse
#      on duplicate) so a re-run never strands a stale active ruleset.
#
# Prerequisites:
#   - gh CLI authenticated with admin rights on the repo (gh auth status)
#   - jq on PATH
#
# Environment overrides:
#   - REPO            target repo (default voodootikigod/adlc)
#   - REVIEWER_IDS    comma-separated numeric GitHub user IDs for required
#                     reviewers (1-6). Defaults to the authenticated user, so a
#                     solo maintainer gets a manual approval gate on every publish.
#   - ALLOWED_BRANCHES space/comma list of branch name patterns allowed to deploy
#                      to the environment (default "main").
#   - ALLOWED_TAGS     space/comma list of tag name patterns allowed to deploy
#                      (default "v*"). Together these constrain which code can be
#                      published, even via manual workflow_dispatch.
#
# IMPORTANT: required status checks can only be selected after the CI workflow
# has run at least once on the repo. Merge/run a PR first so the
# "test (18)/(20)/(22)" check contexts exist, otherwise the rule is created but
# matches nothing.
set -euo pipefail

REPO="${REPO:-voodootikigod/adlc}"
ENVIRONMENT="npm-publish"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }

# --- 1. Protected environment ------------------------------------------------

# Parse REVIEWER_IDS (or the authenticated user) into a validated JSON array of
# numeric IDs. Fails closed on empty/non-numeric input so the publish gate can
# never be created without a real reviewer.
build_reviewers() {
  local ids="${REVIEWER_IDS:-}"
  if [ -z "$ids" ]; then
    ids="$(gh api /user --jq '.id')"
    echo "    no REVIEWER_IDS given; using authenticated user id=$ids" >&2
  fi

  local arr
  arr="$(echo "$ids" | tr ', ' '\n' | grep -E '^[0-9]+$' | jq -R 'tonumber' | jq -s 'unique')"

  local n
  n="$(echo "$arr" | jq 'length')"
  if [ "$n" -lt 1 ] || [ "$n" -gt 6 ]; then
    echo "    FAIL: need 1-6 numeric reviewer IDs, parsed $n from REVIEWER_IDS='${REVIEWER_IDS:-<auth user>}'" >&2
    return 1
  fi
  echo "$arr"
}

provision_environment() {
  echo "==> Environment: $ENVIRONMENT"

  local reviewers
  reviewers="$(build_reviewers)"
  REVIEWERS_REQUESTED="$reviewers"   # stash for verification

  local body
  body="$(jq -n --argjson r "$reviewers" '{
    wait_timer: 0,
    prevent_self_review: false,
    reviewers: ($r | map({type:"User", id:.})),
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  }')"

  echo "$body" | gh api --method PUT \
    -H "Accept: application/vnd.github+json" \
    "/repos/$REPO/environments/$ENVIRONMENT" \
    --input - >/dev/null

  provision_branch_policies
  verify_environment
}

# The exact, sorted set of "type:name" deployment policies the environment should
# have, derived from the allowlist. This is the single source of truth used for
# both reconciliation and verification.
desired_policies() {
  {
    local b t
    for b in $(echo "${ALLOWED_BRANCHES:-main}" | tr ', ' ' '); do
      [ -n "$b" ] && echo "branch:$b"
    done
    for t in $(echo "${ALLOWED_TAGS:-v*}" | tr ', ' ' '); do
      [ -n "$t" ] && echo "tag:$t"
    done
  } | grep -v '^$' | sort -u
}

# Reconcile the environment's deployment ref policies to EXACTLY the allowlist:
# delete any pre-existing policy not in the desired set (e.g. a broad `branch:*`
# or `tag:*` that would otherwise keep publishing open), then add any missing.
provision_branch_policies() {
  local desired
  desired="$(desired_policies)"
  if [ -z "$desired" ]; then
    echo "    FAIL: no deployment refs configured (ALLOWED_BRANCHES/ALLOWED_TAGS empty)." >&2
    return 1
  fi

  local existing
  existing="$(gh api --paginate "/repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies?per_page=100" \
    | jq -rs '[.[].branch_policies[]?] | .[] | "\(.id)\t\(.type):\(.name)"')"

  # Delete unexpected policies.
  local id key
  while IFS=$'\t' read -r id key; do
    [ -z "$id" ] && continue
    if ! echo "$desired" | grep -qxF "$key"; then
      echo "    removing unexpected deployment policy: $key (id=$id)"
      gh api --method DELETE \
        "/repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies/$id" >/dev/null
    fi
  done <<< "$existing"

  # Add missing policies.
  local existing_keys
  existing_keys="$(echo "$existing" | cut -f2-)"
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    if echo "$existing_keys" | grep -qxF "$key"; then
      echo "    deployment policy already present: $key"
    else
      echo "    adding deployment policy: $key"
      gh api --method POST \
        -H "Accept: application/vnd.github+json" \
        "/repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
        -f "name=${key#*:}" -f "type=${key%%:*}" >/dev/null
    fi
  done <<< "$desired"
}

verify_environment() {
  local env_json
  env_json="$(gh api "/repos/$REPO/environments/$ENVIRONMENT")"

  # Required reviewers must exist AND contain every requested ID.
  local got
  got="$(echo "$env_json" \
    | jq '[.protection_rules[]? | select(.type=="required_reviewers")
           | .reviewers[]? | .reviewer.id] | sort')"
  local want
  want="$(echo "$REVIEWERS_REQUESTED" | jq 'sort')"

  if [ "$(echo "$got" | jq 'length')" -lt 1 ]; then
    echo "    FAIL: $ENVIRONMENT has no required reviewers. Publish is NOT gated." >&2
    return 1
  fi
  if ! jq -n --argjson g "$got" --argjson w "$want" '($w - $g) | length == 0' | grep -qx true; then
    echo "    FAIL: required reviewers $got do not include all requested $want." >&2
    return 1
  fi

  # Deployment ref allowlist must be active.
  if [ "$(echo "$env_json" | jq '.deployment_branch_policy.custom_branch_policies // false')" != "true" ]; then
    echo "    FAIL: $ENVIRONMENT allows deployment from any ref (no custom branch policy)." >&2
    return 1
  fi

  # The live policy set must EXACTLY equal the desired allowlist — no missing
  # entries and no stale/broad extras.
  local desired actual
  desired="$(desired_policies)"
  actual="$(gh api --paginate "/repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies?per_page=100" \
    | jq -rs '[.[].branch_policies[]?] | .[] | "\(.type):\(.name)"' | sort -u)"
  if [ "$desired" != "$actual" ]; then
    echo "    FAIL: deployment ref policies do not match the allowlist." >&2
    echo "      desired: $(echo "$desired" | tr '\n' ' ')" >&2
    echo "      actual:  $(echo "$actual" | tr '\n' ' ')" >&2
    return 1
  fi

  echo "    verified: required reviewers $got, deployment refs [$(echo "$actual" | tr '\n' ' ')]."
}

# --- 2. Rulesets (idempotent) ------------------------------------------------

apply_ruleset() {
  local file="$1"
  local name
  name="$(jq -r '.name' "$file")"

  echo "==> Ruleset: $name"

  local ids
  ids="$(gh api "/repos/$REPO/rulesets" --paginate \
    | jq --arg n "$name" '[.[] | select(.name == $n) | .id]')"

  local count
  count="$(echo "$ids" | jq 'length')"

  if [ "$count" -gt 1 ]; then
    echo "    refusing: $count rulesets already named \"$name\" (ids: $(echo "$ids" | jq -c .))." >&2
    echo "    Resolve the duplicates manually, then re-run." >&2
    return 1
  fi

  if [ "$count" -eq 1 ]; then
    local id
    id="$(echo "$ids" | jq '.[0]')"
    echo "    updating existing ruleset id=$id"
    gh api --method PUT \
      -H "Accept: application/vnd.github+json" \
      "/repos/$REPO/rulesets/$id" \
      --input "$file" >/dev/null
  else
    echo "    creating new ruleset"
    gh api --method POST \
      -H "Accept: application/vnd.github+json" \
      "/repos/$REPO/rulesets" \
      --input "$file" >/dev/null
  fi
}

echo "Applying protections to $REPO ..."
provision_environment
apply_ruleset "$DIR/main-branch-ruleset.json"
apply_ruleset "$DIR/release-tag-ruleset.json"

echo
echo "Done. Verify with:"
echo "  gh api /repos/$REPO/environments/$ENVIRONMENT | jq .protection_rules"
echo "  gh api /repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies"
echo "  gh api /repos/$REPO/rulesets"
echo
echo "Also recommended (not scriptable here):"
echo "  - Settings > Actions > Workflow permissions: default GITHUB_TOKEN to read-only."
echo "  - Settings > General > Pull Requests: allow squash only, auto-delete head branches."
