<!--
Thanks for contributing to ADLC! Please fill out this template.
Keep PRs focused — one logical change per PR.
-->

## Summary

<!-- What does this PR do and why? Link any related issue: Closes #123 -->

## Type of change

- [ ] 🐛 Bug fix
- [ ] ✨ New feature / tool
- [ ] ♻️ Refactor
- [ ] 📖 Documentation
- [ ] ✅ Tests
- [ ] 🔧 Chore / CI

## Affected package(s)

<!-- e.g. @adlc/spec-lint -->

## Checklist

- [ ] I read [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md) and [CONVENTIONS.md](../blob/main/CONVENTIONS.md).
- [ ] Changes stay inside a single `packages/<name>/` (or are an intentional cross-cutting change).
- [ ] No new runtime dependencies (Node built-ins + `@adlc/core` only).
- [ ] `packages/core/` is unchanged (it is frozen).
- [ ] Exit codes follow the contract (0 = pass, 1 = op error, 2 = gate fail).
- [ ] LLM-backed changes support `--prompt-only`; output supports `--json`.
- [ ] Added/updated tests; they run offline and leave no trace.
- [ ] `npm test` passes locally.
- [ ] Updated the package README and docs where relevant.
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## How to test

<!-- Commands a reviewer can run to verify this change -->

```sh
node --test packages/<name>/test/*.test.mjs
```

## Notes for reviewers

<!-- Anything else worth calling out: tradeoffs, follow-ups, open questions -->
