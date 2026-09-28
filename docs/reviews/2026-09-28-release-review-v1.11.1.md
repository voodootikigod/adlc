# Release review: v1.11.1 to main (2026-09-28)

This review covers every change merged since the v1.11.1 tag (`b378c2a3`): 119 squash-merged PRs across 716 files. Each PR was judged against its ticket's acceptance criteria and its linked issue. Every defect class it fixed was searched for repo-wide, and each finding was then checked by an independent verifier who tried to refute it.

## Numbers

| Stage | Count |
|---|---|
| PRs reviewed | 119 |
| Raw findings | 390 |
| Refuted by verification | 16 |
| Verified CRITICAL / HIGH / MEDIUM | 1 / 10 / 150 |
| Verified LOW (report only) | 213 |
| Release-readiness gaps from the completeness pass | 3 |

## Fix policy

CRITICAL, HIGH and MEDIUM findings are fixed on this branch, each with a test that fails without the fix. LOW findings are listed in the appendix and not changed. Fixes that touch trust-root paths are listed separately; they need the owner's cross-model attestation before merge.

## Not fixed here

| Finding | Why |
|---|---|
| Seven tickets behind PRs #1087 to #1094 were never marked complete, so their rails still freeze 13 paths repo-wide. | Completing a ticket is a direct push to main by the owner. |
| Commit 50eb558c rewrote three trust-root test files by direct push, so no PR gate ran on it. | History; the owner should decide whether to re-review it. |
| 44 tickets created in the range carry no signed create entry, and CI never checks that a new shard has one. | Needs a design decision on whether rails-guard-ci should require creation evidence. |
| Eleven tickets declared rails on paths that never existed, so their freeze protected nothing. No gate rejects a rail that matches nothing. | Needs a decision on whether ticket create or coldstart should reject rails that match no file. |
| Claude Code's build-gate bypass recorder still hands the signing key to a PATH-resolved `adlc`. | That spawn helper is shared with the rails-bypass recorder, and keeping signed entries signed needs the key. The owner should pick between signing and isolation. |

## Fixes by area

### core test-kit: correct types, fail closed without a test context, and fix the callers that leak

| Finding | Sev | Status | What changed |
|---|---|---|---|
| The `declare module '@adlc/core/test-kit'` block is a module augmentation of an untyped subpath and makes every nodenext TypeScript consumer of @adlc/core fail  | HIGH | fixed | Confirmed at HEAD: TS2665 from index.d.ts(374,16) plus TS7016 on the test-kit import. I removed the augmentation block. index.d.ts now re-exports the types from ./lib/test-kit.mjs. I added lib/test-kit.d.mts and changed the ./test-kit export to {types, default}. The new consumer tests failed before  |
| The shipped-declaration compile gate lists only packages/tickets/index.d.ts, so packages/core/index.d.ts (which #1098 extended) is never compiled and the TS2665 | MEDIUM | fixed | I added a new gate instead of editing the existing one. It builds its package list from every packages/*/package.json that has a types field, and every export entry with a types condition. It then compiles a strict nodenext consumer of each entry's full runtime export surface. On the old code the @a |
| tmp()/gitRepo() silently register no cleanup when the first argument lacks `.after` (null, undefined, a string prefix, an options object, or a describe/before S | MEDIUM | fixed | tmp() and gitRepo() now throw a TypeError ('requires a test context') when the first argument has no callable .after, before creating anything. tmp registers its removal hook before it creates the directory, so a context that refuses the hook leaves nothing behind. Covered cases: no argument, null,  |
| tmp() silently skips cleanup registration when no test context is passed, and the boundary guard cannot see kit-based fixtures, so a forgotten `t` is a silent l | MEDIUM | fixed | Same root cause as F003, closed by the same change. A forgotten `t` is now a loud TypeError, not a silent leak. |
| tmp() silently registers no cleanup when handed a context without .after (e.g. the SuiteContext a describe-level before() hook receives), and the boundary guard | MEDIUM | fixed | A describe-level SuiteContext now throws. createScope() gives before()/after() blocks an explicit alternative: dispose() removes everything registered on the scope, and registering after dispose throws. |
| The guard is blind to the repo's new dominant fixture factory: test-kit `tmp()`/`gitRepo()` called without a test context silently returns an unregistered direc | MEDIUM | fixed | tmp('prefix') and gitRepo({prefix}) now throw instead of returning an unregistered directory, so the guard's blind spot has nothing left to miss. |
| The fixture-leak guard cannot see a leak created through test-kit's tmp('prefix') / tmp(null, ...) forms, contradicting its own header claim. | MEDIUM | fixed | Fixed at the source as the cluster note directs, because tmp-fixture-boundary.test.mjs is frozen. The context-less forms the guard could not see no longer exist. The guard's own header text is unchanged (frozen). |
| The fixture-leak guard only scans files containing the literal `mkdtempSync`, so every file converted to `tmp()` has left its coverage and a kit-minted leak is  | MEDIUM | fixed | Fixed at the source: a kit-created directory now always has a registered removal, or the call throws. The guard's mkdtempSync-only scan is unchanged because the file is frozen, but kit callers can no longer leak through it. |
| The tmp-fixture guard only scans files containing the literal `mkdtempSync`, so leaks routed through tmp(null\|undefined, …) or context-less helpers such as scr | MEDIUM | fixed | tmp(null\|undefined) now throws. The `t = null` defaults in autopilot scratch() now default to SCRATCH_SCOPE, which removes everything it registered when the process exits. The test checks this in a child process and fails if the exit handler is removed. The prosecute helpers now fall back to a file |
| The guard only scans files containing the token `mkdtempSync`, so a suite file that leaks via test-kit `tmp(string\|null)` or `gitRepo(no-ctx)` is never examine | MEDIUM | fixed | Took the finding's fail-closed alternative: gitRepo('feat/x') and tmp('x-') throw. The guard is unchanged (frozen). |
| The repo-wide @adlc/core/test-kit gitRepo() fixture (29 adopters, introduced in this range) disables commit.gpgsign but not gc.autoDetach, and tmp() tears down  | MEDIUM | fixed | gitRepo sets gc.auto=0 and gc.autoDetach=false. Removal uses the new exported, frozen FIXTURE_RM_OPTIONS {recursive, force, maxRetries: 10, retryDelay: 50}. Both are pinned by tests, and deleting either config line or zeroing either retry value makes a test fail. The retry option itself is only pinn |
| The added 'per-test lifecycle cleanup' regression test re-implements the compat shim inline and never exercises the production `test()` wrapper, so any mutation | MEDIUM | fixed | I deleted both the t.after polyfill in core.test.mjs and its test, which re-implemented the polyfill inline. core.test.mjs now uses node:test's test directly. On a runtime without t.after, tmp() now throws instead of leaking, and the context-less test above pins that. Identical polyfills in three sc |
| Registry-exported AC functions converted to tmp(t) leak their fixture roots when the autopilot AC gate (part of `npm test`) calls them without a test context. | HIGH | fixed | spec-coverage.test.mjs now calls every registered function through helpers/run-registered.mjs (withScopedContext) in the AC114 pass and in both legs of AC121. Each call's fixtures are removed when it settles. With a private TMPDIR the test leaves nothing behind, and it fails if runRegistered drops t |
| loop.test.mjs's converted fixtures register no cleanup when the spec-coverage gate calls the exported functions without a TestContext, so the AC121 mutation pas | MEDIUM | fixed | The AC121 mutation leg now runs ac136 under a scoped context. The ap-dryrun-ssh-* directories it creates are removed even when the planted mutation makes the function throw. loop.test.mjs itself did not need to change. |
| fixture(t, prefix) was given a `t` parameter that no caller passes, so tmp() registers no cleanup; the file was removed from the allowlist yet the guard can no  | MEDIUM | fixed | All 9 supervise-cli callers now pass `t` to fixture(t), and the redundant try/finally rmSync blocks are gone. Before, a bare fixture() would now throw. continue-cli-support's withTempRepo no longer calls the kit without a context: it uses a bound mkdtempSync result and removes it in a finally, which |

### scripts and fixtures: stop leaking temp dirs outside the guard's reach and close the git gc teardown races

| Finding | Sev | Status | What changed |
|---|---|---|---|
| makeLab() mints a mkdtemp lab per leg and nothing removes it; the unit test scripts/test/copilot-live-deny.test.mjs drives the script through all three legs on  | MEDIUM | fixed | copilot-live-deny.mjs now records each mkdtemp lab root and removes all of them in cleanup(), which runs from the finally block and the signal handlers. Before the fix both tests failed with three leftover adlc-copilot-livedeny-* dirs in a private TMPDIR. They pass now, and the existing copilot-live |
| The gemini install smoke mints `repo` with mkdtempSync and never removes it (rmSync is not even imported); scripts/run-tests.mjs runs this script on every `npm  | MEDIUM | fixed | gemini-install-smoke.mjs wraps the shim drive in try/finally with a retrying rmSync. Before the fix the test failed with gemini-smoke-* left in the private TMPDIR; it passes now. |
| provisionClone() mints and populates the clone (line 84 onward) before the sandbox check in spawnCandidateCmd throws 'No OS sandbox binary', and no try/finally  | MEDIUM | fixed | provisionClone now does its clone, patch and setup work in populateClone() inside a try/catch that destroys the clone and rethrows. The no-sandbox refusal still throws (fail-closed), and a success still returns the clone intact (pinned by a test). Both tests failed before the fix. The misleading com |
| The SHA-256 test in the same file still runs `git commit` without the gc flags and tears down with a no-retry rmSync, so the #981 race is left open inside the f | MEDIUM | fixed | The hermetic git env moved into packages/fleet/test/helpers/hermetic-git.mjs and now carries gc.auto=0 and gc.autoDetach=false as GIT_CONFIG_* entries, so git calls made without gitAt (the SHA-256 test) are covered too. git-mirror.test.mjs uses it and its teardown rmSync calls retry. The new test fi |
| codex-install-smoke tears down a directory in which the live codex CLI clones a git repo, with no gc.autoDetach override in the codex env and no rmSync retry; C | MEDIUM | fixed | codex-install-smoke.mjs adds GIT_CONFIG_COUNT/KEY/VALUE (gc.autoDetach=false) to the codex spawn env, and its teardown rmSync now uses maxRetries 10 and retryDelay 50. A fake codex on PATH records `git config --get gc.autoDetach`: it read empty before the fix and reads false after. |
| The codex smoke cleanup test still counts temp-root prefixes in the shared system tmpdir across a spawned child, the non-parallel-safe pattern #1023 removed fro | MEDIUM | fixed | The cleanup test now runs the smoke with a private TMPDIR from tmp(t) and asserts that directory is empty. A new positive-control test shows an unwritable TMPDIR causes EACCES before the injected failure, which proves the roots are created under TMPDIR. Before the fix, running a concurrent mktemp lo |

### core: railpath symlink/.. resolution, fence() opts shape, mutate export-const, churn quotepath, agy stdin EPIPE

| Finding | Sev | Status | What changed |
|---|---|---|---|
| A `..` segment following a symlinked directory is folded lexically by `join` before any symlink is resolved, so the returned path names a location the write nev | HIGH | fixed | resolveRailPath now resolves segments left to right from the real root, expanding each symlink before the next segment, so a `..` applies to the resolved prefix. Three `..` tests (relative, node_modules/@adlc/core climb into .adlc/tickets, absolute) failed before the change and pass now. The first a |
| A symlink whose own target file does not exist yet is treated as missing by `existsSync`, so the walk steps over the link and returns the lexical alias name whi | MEDIUM | fixed | The walk calls lstat on each segment and follows dangling links through readlink, so a link to a not-yet-existing file resolves to that file. Four dangling-link tests (file, missing dir, absolute target, dir link) failed before and pass now. The existing loop test still gets a lexical fallback, and  |
| fence() fails closed on a wrong bias VALUE but fails open on a wrong opts SHAPE: a positional string or misspelled key silently reinstates tail truncation. | MEDIUM | fixed | fence() now accepts only undefined, null or a plain object whose only key is `bias`, and throws on anything else. All 8 malformed-shape tests failed before and pass now. The well-formed shapes are also pinned. The packages/core README documents opts; core.mdx does not describe fence, so it needed no |
| The 'does NOT double-cover' test uses a line the fallback regex can never match, so it passes whether or not the fallback is gated on producedForLine. | MEDIUM | fixed | The new test uses lines that both a primary operator and the fallback pattern match (`const limit = 3;`, `const ok = a > b;`, `export const N = 3;`) and asserts exactly one operator. It passes at HEAD because the guard is correct. Both the producedForLine bool-flip and removing the guard made it fai |
| `export const NAME = <rhs>;` — the motivating shape with an export prefix — still yields zero mutants because VALUE_ASSIGNMENT_RE anchors on `^\s*const`. | MEDIUM | fixed | VALUE_ASSIGNMENT_RE now admits an optional `export` prefix. The export-const tests failed before and pass now. Exported let/var and exports bound to undefined/null still produce no mutant. |
| churn() reads `git log --name-only` without -z or core.quotepath=false, so non-ASCII paths are C-quoted and never match the walker's keys — the same silent scor | MEDIUM | fixed | churn() and coChange() now share commitFileLists, which reads `git log -z --pretty=format:/` as a buffer and splits it with splitNulPaths. A field starting with `/` marks a new commit, which no repo-relative path can start with. The churn and coChange tests failed before and pass now. model-ratchet  |
| agySend writes the prompt to the agy CLI's stdin with no 'error' handler and no process-level timeout, so an agy that exits before draining a >64 KiB prompt cra | MEDIUM | fixed | agySend now listens for stdin errors. A non-zero exit rejects with `agy exit N` as before, and an exit 0 after a stdin error now rejects with `agy did not read the full prompt`. The first test failed with UNCAUGHT EPIPE before the change, in 3 of 3 runs; all 3 tests pass now. Spawn and fetch timeout |

### scripts: replace hand-built file:// entry guards so gates run from paths with spaces

| Finding | Sev | Status | What changed |
|---|---|---|---|
| The PreToolUse secret-exposure deny hook uses the same hand-built file:// guard and silently allows everything when the checkout path contains a space. | MEDIUM | fixed | scripts/block-secret-exposure.mjs now gates main() on Boolean(argv[1]) && import.meta.url === pathToFileURL(argv[1]).href. The new test copies the hook into a directory named 'a b' and asserts a deny decision. Before the fix it failed with empty stdout, which the harness reads as allow. |
| Four more hand-built file:// entry guards remain in CI/preflight scripts; two of them make a local `npm run preflight` report green without running the gate fro | MEDIUM | fixed | Fixed the hand-built guards in scan-findings-ledger, guard-findings-ledger-append-only, ceremony-drift and apps/docs/scripts/check-links. Added spaced-path subprocess tests for each script, plus a repo scan of scripts/ and apps/docs/scripts/ that fails on any reintroduced hand-built guard. It listed |
| The repo's PreToolUse Bash secret-exposure guard hand-builds its file:// URL, so from a checkout path containing a space main() never runs and every command is  | MEDIUM | fixed | Duplicate of F190, fixed by the same change and test. |
| CI gate scan-findings-ledger silently exits 0 without scanning when invoked from a path containing a space. | MEDIUM | fixed | Switched the guard to pathToFileURL. From a spaced path a malformed ledger now exits non-zero; before the fix it exited 0 silently. |
| CI gate guard-findings-ledger-append-only exits 0 without checking append-only-ness when run from a path containing a space, even with a base ref supplied. | MEDIUM | fixed | Switched the guard to pathToFileURL. With no argument from a spaced path it now prints usage and exits 1; before the fix it exited 0 silently. |
| ceremony-drift's entry guard hand-builds the file:// URL, so from a space-containing path the reporter silently does nothing and exits 0. | MEDIUM | fixed | Switched the guard to pathToFileURL. From a spaced path in an empty cwd, main() now runs and exits 1 with 'could not compute drift'; before the fix it exited 0 silently. |

### plugins (codex, copilot, cursor, claude-code): bound hook spawns, scrub the manifest key from the bypass recorder env, and widen the hook-spawn drift guard

| Finding | Sev | Status | What changed |
|---|---|---|---|
| Codex and Copilot lifecycle hooks still spawn git and adlc unbounded through run() and verifyOutput(), the exact twins of the calls #1045 bounded. | MEDIUM | fixed | Codex and Copilot adlc-lifecycle.mjs run() now passes timeout (5000 ms default, floored at 1 ms) and killSignal SIGKILL. gitChangedPaths hands each git call the remainder of one 5000 ms scan budget, and verifyOutput is bounded. Before the fix the blocked-git and blocked-adlc subprocess tests ran int |
| Cursor stop hook's run()/gitChangedPaths spawn git with no timeout, the same shape #1045 fixed in adlc-hook.mjs. | MEDIUM | fixed | Cursor adlc-stop.mjs run() and gitChangedPaths now have the same bounds (shared git budget, 5 s per adlc call, SIGKILL). The blocked-git and blocked-adlc stop-hook tests went from the 30 s hard kill to about 5.2 s. Added plugins/adlc-cursor/test/helpers/run-hook.mjs, a verbatim copy of the existing  |
| Codex and Copilot enforcing build-gate hooks record the audited bypass with an unbounded spawnSync, while the claude-code twin is now bounded via runAdlc. | MEDIUM | fixed | The Codex and Copilot recordBuildGateBypass spawns now pass timeout 5000 and killSignal SIGKILL. A killed recorder returns false, so the gate denies (fail-closed direction asserted as {ok:false}). The test ran into the 30 s hard kill before the fix and takes about 5 s after. |
| The Codex and Copilot hooks still spawn `adlc` with no timeout (build-gate bypass recorder and lifecycle gate-manifest verify), the pattern #1045 bounded only i | MEDIUM | fixed | This duplicates F160 and F162 (the four unbounded adlc spawn sites in codex and copilot) and is covered by those fixes. The verify test also asserts that a killed verifier is reported as a failed verification and never passes silently. |
| Copilot's and Claude Code's build-gate bypass recorders spawn a bare PATH-resolved `adlc` with the hook's full environment (ADLC_MANIFEST_KEY included), the exp | MEDIUM | fixed | Copilot half. recordBuildGateBypass now resolves adlc through an inlined resolveTrustedBinary (skips node_modules entries and files owned by another uid), runs the realpath through process.execPath, and passes only the exported BYPASS_RECORD_ENV_ALLOWLIST. Before the fix the env-dump test saw ADLC_M |
| F342-claude-code | ? | report-only | Claude-code half, not changed. adlc-hook.mjs recordBuildGateBypass goes through runAdlc, which is shared with the rails bypass recorder. The file's scrubHandoffSecrets comment says the buildgate child legitimately needs ADLC_MANIFEST_KEY to sign its entry. Without the key, gate-manifest record appen |
| The same unbounded hook-test spawn class exists in six twin plugins whose hook tests live in plugins/<host>/test/, which the guard's directory list and its file | MEDIUM | fixed | The guard now scans every plugins/*/test and plugins/*/hooks/test directory found on disk (pluginTestDirectories). The 27 files that already spawn Node raw are pinned by exact count in a shrink-only PENDING_CONVERSION map, which reds when an entry is stale, under-counted or outside a scanned directo |
| The detector does not recognise `spawnSync('node', …)`, `spawnSync(process.argv[0], …)` or `execSync(`${process.execPath} …`)`, and it returns [] on an unparsea | MEDIUM | fixed | The detector moved to scripts/test/raw-spawn-sites.mjs. SPAWN_FNS now includes execSync and exec. It recognises 'node' literals, process.argv[0], and command lines headed by node or execPath (template or + concatenation). A parse failure is reported as {reason:'unparseable'} instead of []. Negative  |

### pi and opencode plugins: fail closed on signal-killed gates and unparseable lenses, fence prosecutor prompts, bound opencode spawns, read git paths with -z

| Finding | Sev | Status | What changed |
|---|---|---|---|
| A gate child killed by an external signal (not pi's own timeout) still renders PASS and records a code-0 state-resolving gate-run entry, because pi normalizes i | MEDIUM | fixed | New exported verdictFailureReason in plugins/adlc-pi/lib/gate-tool.mjs adds 'exit 0 with no parseable JSON on stdout' to execFailureReason. adlc_gate throws on it before recording evidence, and /adlc-accept now accepts only a parsed ok:true. The existing exec-fail-closed.test.mjs case that required  |
| OpenCode's adlc_gate maps a signal-killed child (status null, no error) to exitCode 0 and reports "adlc <gate> → exit 0", the same killed-exec fail-open #986 cl | MEDIUM | fixed | opencode runGate no longer maps status:null to 0. A run with no numeric status now returns exitCode null, a 'did not complete' title and error spawn-failed, timed-out, killed or no-exit-code. The spawn now uses killSignal SIGKILL. The tests include a real child that SIGKILLs itself. |
| adlc-opencode's adlc_gate reports `exit 0` for a gate child killed by a signal, the same killed-exec-as-pass shape #986 fixed in adlc-pi. | MEDIUM | fixed | This has the same gate-tool root cause as F336, fixed in the same place. session-hooks run() and watcher run() also no longer normalize a null status to 0. A killed or timed-out gate-manifest verify now returns ok:false with a 'did not finish' warning, and a killed git checkout is reported as 'could |
| The pi prosecutor treats unparseable/refusal lens output as zero findings and converges to CLEAN — the same false-green class #640 fixed in gate-fuzzing, and it | MEDIUM | fixed | pi parseFindings now returns {findings, parsed}. A refusal, prose, empty reply or non-finding JSON gives parsed:false. The loop records that lens as degraded ('unparseable lens output'), so computeVerdict returns INCONCLUSIVE. The old prosecutor.test.mjs assertion that garbage yields [] was changed  |
| The pi and opencode plugin prosecutors splice the PR diff and lens-authored findings raw into lens/verifier prompts — the same steer-the-judge class #750 fixed  | MEDIUM | fixed | This is the pi half only. The diff, ticket title and finding JSON now reach lens and verifier prompts only through @adlc/core fence() with a per-call nonce, behind an untrusted-data directive. The diff and finding are never truncated; the title is capped to its first 500 characters. A GUARDED entry  |
| The pi and OpenCode prosecutor lens/verifier prompts embed the PR diff and the ticket title raw with no fence() or untrusted-data directive, so diff content can | MEDIUM | fixed | Duplicate of F066, fixed by the same pi change. The opencode half (prosecute-runner.mjs) is blocked by PR #1141 and is recorded in the ticket's OUT OF SCOPE. |
| OpenCode plugin's run() helper spawns git and adlc with no timeout, in-process inside the harness, so a blocked child wedges the harness with no outer bound at  | MEDIUM | fixed | session-hooks run() now passes timeout (5000 ms) and killSignal SIGKILL. gitChangedPaths shares one 5000 ms budget across all its git calls, with a 1 ms floor. watcher run() is also bounded at 5000 ms with SIGKILL. With the old code the real-blocking tests hung until an outer timeout killed them (RE |
| adlc-opencode spawns `adlc` and `git` with spawnSync and no timeout inside the OpenCode host process, where no wrapper or hooks.json bound exists, so a blocked  | MEDIUM | fixed | This has the same root cause as F159 and adds the keyless-bridge spawn, now bounded at 120000 ms with SIGKILL. A killed --prompt-only run now reports 'did not complete (<code or signal>)'. Tests check that every spawn from checkPreflight, auditGateManifest, auditAdversarialReview, the watcher and th |
| The OpenCode plugin's `ensureConfig` still treats any existing `.adlc/config.json` inode as satisfied and reports it 'present' with exit 0, the exact defect #66 | MEDIUM | fixed | ensureConfig now parses an existing config.json and requires a JSON object. Otherwise it returns a warning ('.adlc/config.json exists but is not readable JSON: <reason>') and leaves the file untouched. scaffold-cli prints the warning to stderr and exits 1. Tests cover garbage, empty, array, scalar a |
| gitChangedPaths() in the claude-code and opencode plugins reads `git diff --name-only` without -z, so a non-ASCII changed path arrives C-quoted and classifyRisk | MEDIUM | fixed | Both gitChangedPaths copies (claude-code adlc-hook.mjs and opencode session-hooks.mjs) now read ls-files and diff --name-only with -z and split on NUL. The false 'never quote' comment was corrected in both. The tests run real git: claude-code failed RED before the change, and opencode session-hooks- |

### cursor and gemini plugins: MCP proxy null-line crash, zero-root test, ensureConfig readability, gemini test-mode switch and stale-lock race, host-state-dependent test

| Finding | Sev | Status | What changed |
|---|---|---|---|
| A bare `null` JSON line on the client stdin throws an unhandled TypeError and kills the entire MCP proxy process. | MEDIUM | fixed | The Roots proxy now drops any client line that is not a JSON object (checked by the new isJsonObject in mcp-json-rpc-bridge.mjs) before it reads a field. The committed bundle was rebuilt with scripts/build-cursor-mcp.mjs. Four tests covering the source and the bundle, with null/42/string/[]/true lin |
| AC7's zero-root Roots case (`roots: []`) is not exercised by any test, although one-root and multi-root are. | MEDIUM | fixed | Added an end-to-end zero-root test against both the source and the bundle: cwd and CURSOR_PROJECT_DIR both point at an ADLC repo, the proxy replies UNRESOLVED, and the fake server is never spawned. The behaviour was already correct, so this test passed from the start. To confirm it catches a regress |
| The Cursor plugin's `ensureConfig` reports an empty or malformed `.adlc/config.json` as 'present' with exit 0, with no readability probe. | MEDIUM | fixed | ensureConfig now parses an existing config.json. If the file is not a JSON object it is left untouched and returned with a warning, and scaffold-cli prints that warning to stderr and exits 1. 6 of the 9 new tests failed before the fix. I updated the cursor README, docs/integrations/cursor.md and the |
| The gemini host plugin's production hook code honours an `ADLC_TEST_MODE=1` environment switch that substitutes the session secret and redirects the trust-root  | MEDIUM | fixed | Removed every ADLC_TEST_MODE branch from shipped gemini code: the ADLC_HOME_DIR home, the ADLC_SESSION_SECRET passthrough, the widening of the transcript allowlist to tmpdir, workspacePaths and any .adlc ancestor, the ADLC_HOME_DIR secret home, and the ADLC_AGY_ADAPTER_OVERRIDE module path in the .c |
| The gemini plugin's inline session-store lock removes a `.stale-*` renamed lock without checking it is the one it judged stale, and then retries mkdir, so a los | MEDIUM | fixed | Split the stale-lock logic into two exported functions. judgeStaleLock snapshots the lock (owner bytes, or inode and mtime when there is no owner). reclaimJudgedLock renames the lock to a private name and deletes it only if it still matches that snapshot; otherwise it renames it back. The new test f |
| The two 'plain workspace' tests let the hook adopt a host-global /tmp/.adlc as trust root, so they fail on any host where that directory exists and append to it | MEDIUM | fixed | The plain-workspace tests now use tmp() fixtures and a plainWorkspaceEnv helper that sets ANTIGRAVITY_WORKSPACE and a fixture HOME. The new isolation test places the workspace under a parent that has its own foreign .adlc. With the old env it fails with the exact 'Session ledger integrity verificati |

### fence every prompt sender the completeness sweep misses and stop lesson-foundry splicing descriptions into generated code

| Finding | Sev | Status | What changed |
|---|---|---|---|
| The completeness sweep's static-import regex misses packages/gate-fuzzing/lib/fan.mjs, a live prompt sender that imports core's complete() dynamically and embed | MEDIUM | fixed | Moved the sweep's detector into the new scripts/prompt-senders.mjs. It now matches dynamic core imports (both `.then(({ complete }))` and `const { … } = await import(...)`). A dynamic import whose bindings it cannot read counts as a sender (fail closed). It also walks lib/bin recursively. fan.mjs no |
| The completeness sweep only detects static core imports, so packages/gate-fuzzing/lib/fan.mjs sends prompts via complete() while appearing in neither GUARDED no | MEDIUM | fixed | Same root cause as F083, same fix. scripts/test/prompt-fencing.test.mjs uses the shared detector and requires fan.mjs to be GUARDED with fence('GATE_DOCS'/'BASELINE_MANIFEST'/'PRIOR_DEFEATS'). With the original fan.mjs restored, the sweep failed 3 tests (checked by temporarily swapping the file). |
| The prompt-fencing completeness sweep only detects modules with a static `import { complete\|fan\|fanProviders } from '@adlc/core'` under packages/*/lib\|bin, s | MEDIUM | fixed | The detector now also walks plugins/* and counts host-harness sends: session.prompt( and a ['-p'\|'--print', prompt] argv. The pi prosecutor (DIFF, FINDING, TICKET_TITLE) and the opencode prosecute-runner (DIFF, FINDING) now fence their content and are GUARDED. The fleet adapters and the opencode ke |
| buildCheckScript splices a finding's description into the generated gate script's source with only backticks stripped, so a newline in the description injects e | MEDIUM | fixed | emit.mjs has a new oneLine() that turns line terminators (including U+2028/2029) and control characters into spaces. It is applied to desc before the generated script's `// Grep gate:` comment, and to the SKILL.md frontmatter description and name. Backticks are still replaced. The new test failed 9  |

### parallax: validate the route-mode judge payload, keep a CLI test off real providers, and fix every harness doc that drops --ticket

| Finding | Sev | Status | What changed |
|---|---|---|---|
| The P1 harness flow still instructs `parallax --prompt-only --record-verdict <file>` with no --ticket, which at HEAD exits 1 and records nothing. | HIGH | fixed | Three adlc-spec step-1 invocations were missing --ticket: claude-code commands, cursor command (the commands dir is a symlink to it) and pi prompts. Three examples in packages/parallax/README.md were missing it too. All six now pass --ticket, with a one-line reason. I grepped all of plugins/, .claud |
| Route mode's judge payload is not schema-validated: an off-schema `equivalent` (any non-empty string) coerces to true and emits `{questions: [], gate: true}` ex | MEDIUM | fixed | Added an exported pure judgePayloadError to lib/modes.mjs. It requires a boolean equivalent, a non-empty string answer when equivalent is true, and a non-empty array of string variants when it is false. runRouteMode throws on any other payload, so the CLI exits 1. It fails closed and does not coerce |
| The 'seam is ignored unless NODE_ENV is test' CLI test inherits the developer's real API keys, so on a keyed machine it performs live LLM calls and can fail spu | MEDIUM | fixed | The seam test in fan-integrity.test.mjs now strips ANTHROPIC/OPENAI/GEMINI keys, ADLC_AGY and ADLC_PROVIDER from the child environment. It asserts 'no LLM provider configured', which proves the seam was bypassed. I added a route-mode twin in the new file. Before the fix, the old test's command run w |
| parallax feeds model-authored readings and answers, and raw ticket titles, into judge prompts unfenced — the same class #1010 fixed in lesson-foundry. | MEDIUM | fixed | prompts.mjs now fences each fan reading (reading-n, cap 12000), each route answer (answer-n, cap 6000) and each ticket title (ticket-<id>-title, cap 300), all head-biased. The UNTRUSTED directive is added to the divergence and route-judge prompts. The three fencing tests failed before and pass now.  |

### backlog-groom: tree/blob confusion, cache keying, per-location clustering, bounded gh/git spawns, lock liveness and hand-back race, one-shot key, honest trust claims and docs

| Finding | Sev | Status | What changed |
|---|---|---|---|
| A cited path that is a git directory (e.g. `.adlc/manifest.d`) verifies `fixed` because `cat-file -e` accepts trees and `git show rev:dir` returns a tree listin | MEDIUM | fixed | verify.mjs now resolves citations with `git cat-file -t` (exported pathKindAtRevision); a tree or commit is unverifiable. The seam io.pathExists became io.pathKind. The new test failed at HEAD because the export was missing. |
| `fixed`, `moved` and `unverifiable` verdicts are cached under an updatedAt-only key whenever any cited path is unreadable/never-existed, so a code change (e.g.  | MEDIUM | fixed | cache.mjs now holds only unverifiable/unverified under a null contentHash, and enforces this on both write and read. Entries carry verifiedPaths and CACHE_SCHEMA_VERSION is 3. Eight tests failed at HEAD. |
| An unverified location (never-existed path, or a path with no excerpt) drives clustering and an `area` relabel proposal whenever a sibling citation makes the is | MEDIUM | fixed | verifyIssue returns per-citation verifiedPaths. unitsForIssue/verifiedLocations use only those paths, intersected with cited paths, so clusters, relabels and revalidateRelabel all ignore unverified locations. Relabel evidence names only verified paths. |
| The `gh issue list` network call and every per-citation git subprocess in the read path run with no `timeout`, while the same package's write path bounds its ch | MEDIUM | fixed | fetch.mjs bounds `gh issue list` at 120s with SIGKILL, and a timeout is reported as unconsultable. Read-path git calls in verify.mjs and content-hash.mjs now go through the new lib/git-read.mjs, bounded at 30s with SIGKILL. |
| A null revision silently disables the generatedFor staleness check and unpins io, and nothing tests that direction. | MEDIUM | fixed | applyRun now throws an isOpError, before any review or write, unless the revision is a 40- or 64-hex commit id. generatedFor is always required and io is always pinned. Existing tests use a local wrapper that supplies a fixed commit. |
| The apply-lock liveness probe treats EPERM as 'dead', so a live lock held by another uid is recovered and two writers run. | MEDIUM | fixed | The new exported pidAlive treats EPERM as alive and is the default liveness probe for acquireApplyLock. The test uses pid 1 as uid 1000. |
| Every gh spawn in the writer is unbounded while the apply lock is held; only the git baseline lookup got a timeout. | MEDIUM | fixed | gh.mjs passes a 60s timeout with SIGKILL on every writer call, and a timeout error names the subcommand. gate.mjs bounds the reviewer at its own --timeout plus REVIEW_GRACE_S (120s). |
| The gh writer spawns `gh` with no timeout while the apply lock is held, so a stalled network call wedges every later --apply behind the lock. | MEDIUM | fixed | Duplicate of F102: the gh writer spawn now carries a timeout and killSignal, and a test pins both. |
| The round-4 fix bounded only io.mjs's children; the gh writer's spawns (and the reviewer spawn) are network calls made while the apply lock is held and still ha | MEDIUM | fixed | Duplicate of F102 and F183: the gh writer and the reviewer spawn are both bounded and pinned the way remote-base.test pins git. |
| The reviewer spawnSync has no parent-side `timeout`; it relies entirely on adversarial-review honouring its own `--timeout` flag. | MEDIUM | fixed | makeReviewRunner passes timeout (timeout + 120) * 1000 with SIGKILL. A killed reviewer still throws 'did not run' and is never read as a verdict. |
| The AC17 guard misses `gh api <path> -X/-f` and `gh issue --repo … close`, so the 'enforcement' the skill relies on has common holes. | MEDIUM | fixed | The new test/gh-mutation-matcher.mjs parses each gh invocation: persistent flags, the method anywhere, and fields as an implicit POST. skill-no-direct-mutation.test.mjs now uses it. The --repo, method-last and -f forms that the old substring list missed are all caught. This is a test-only fix: the n |
| The one-shot ledger is gitignored per-checkout state that an absent file resets, yet the skill and docs present the refusal as something re-asking cannot get pa | MEDIUM | fixed | This is a docs-only fix; the ledger was not made durable. README, mdx and SKILL.md now state that the ledger is gitignored per-checkout state, that a fresh checkout or worktree forgets spent reviews, and that the key is the boundary. A guard test pins the claim. |
| README, docs page, binary header and --help all still say the package/binary is read-only and writes nothing, while `--apply` in this package closes issues. | MEDIUM | fixed | The README opener, mdx front matter and gate line, bin header and --help title now say the tool is read-only by default and writes with --apply. The README documents --apply/--set and the exit codes. |
| The 'remote-anchored' floor baseline resolves `origin` from local .git/config, so one local `git remote set-url` moves the comparison point the docs say the cal | MEDIUM | fixed | Per the cluster note this is a docs-only fix: the remote is not pinned, because pinning it is not cheap (the apply-e2e fixture uses a filesystem origin). README, mdx and SKILL.md now state that `origin` is whatever .git/config names, and name the ledger key as the boundary against a caller who can r |
| The floor baseline is anchored to whatever `origin` currently points at, and the origin URL is local mutable config, so a caller with the same capability #1036  | MEDIUM | fixed | Same docs fix as F107: the unrecorded residual is now stated on every surface. No new trust anchor was invented. |
| A `close` supplied via `proposals[]` carries an unvalidated `field`, which is part of the gate key, so a caller mints a fresh one-shot review for the same close | MEDIUM | fixed | actionsFromSet now accepts from proposals[] only the actions in PROPOSABLE_ACTIONS, which is ['relabel']. A close is derived only from a fixed verdict, so each close gets one gate key and one review. |
| Between the loser's claim rename and its hand-back the lock path is empty, so a third run acquires it; the hand-back then fails (ENOTEMPTY) and the winner's unc | MEDIUM | fixed | Release now removes the lock only when the owner record at the path is still this run's. A failed hand-back is an isOpError naming the moved .stale-* directory, and the lock is re-read before a claim. Residual: a holder whose lock was moved can still run alongside the new holder until it finishes. T |
| The new public package @adlc/backlog-groom (bin `backlog-groom`) is absent from docs/package-reference.md, README.md's package map, and the `adlc` CLI registry, | MEDIUM | fixed | backlog-groom is now registered in the CLI registry (workspace-resolved like autopilot, with no @adlc/cli dependency or lock change). It has a row in package-reference.md, a command form and group entry, a README package-map link, and a LICENSE in the package. The new guard test checks every publish |

### autopilot and fleet: vanished-record guards on every post-await update, stale-lock reclaim identity checks, sandbox-absent test skip, marker authorship, timing-free AC87, quartermaster skipped ledger

| Finding | Sev | Status | What changed |
|---|---|---|---|
| The root cause named in #980 — autopilot tests fail with sandbox-unavailable instead of skipping when bwrap is absent — is still present at HEAD; only the CI en | MEDIUM | fixed | The sequence fixture now builds the production context with a gates module that passes runOuterGates the backend its fake bwrap stands for, using the existing buildContext modules override. Production code is unchanged. The new test runs a full fixture run with an empty PATH: it failed with sandbox- |
| round()'s vanished-record guard covers only its entry; a record that vanishes during the fleet dispatch await still makes ctx.records.update at line 172 throw t | MEDIUM | fixed | A new shared helper, records.updateIfPresent, handles every record write in round() that follows an await. If the record vanishes during or before the dispatch, the round returns unchanged/record-vanished and nothing after it runs. The dispatch, pre-dispatch, fast-forward and dep-check tests all fai |
| The oid-mismatch branch of settleCi, two lines above the fixed ci-red branch, still throws over its result when the record vanished during watchCi. | MEDIUM | fixed | mismatch() and block() write through updateIfPresent and skip applyTerminalEffects when the record is gone, so the oid-mismatch or blocked result still reaches the caller. Both tests rejected before the fix. |
| Every post-await records.update in round.mjs and ci.mjs still throws over a meaningful result when the record vanished mid-step; only round()'s entry is guarded | MEDIUM | fixed | Every write after an await is now guarded: attestTail (completion, review, attest), pushAndOpen (pre-check, push, upsert) and watchCi (entry, fix-round charge, post-fix). A null record passed to watchCi returns {outcome:'record-vanished'}, which settleCi maps. Outcomes that are already decided (done |
| The tolerated null at the runIssue ticketCache write lets a run whose record is gone proceed into the ticket write, the coldstart evidence call and the mirror/d | MEDIUM | fixed | runIssue now returns record-vanished straight after the ticketCache write finds no record, so writeTicket, recordEvidence and the mirror/deps build are never called. Before, all four ran. The misleading comment is corrected, and the existing run-init-failure test no longer expects a ticketId. |
| The gates-ctx fixture still hands production a GIT_CONFIG_GLOBAL=/dev/null env, so the nested repos production creates under it (mirror.git, gate.git, gate-deps | MEDIUM | fixed | The gates-ctx git env now sets gc.auto=0 and gc.autoDetach=false through GIT_CONFIG_COUNT/KEY_n/VALUE_n. This needs no temp file and keeps GIT_CONFIG_GLOBAL at /dev/null. Before the fix, the test found gc.auto unset in the worker and gate mirrors that production creates. |
| autopilot's comment idempotence matches its `<!-- adlc-autopilot:… -->` sentinel in any comment body by any author, and the bodies it posts embed model/reviewer | MEDIUM | fixed | A new github.commentBody replaces '<!--' in the body with '&lt;!--', and every sentinel post goes through it. hasComment and ensureComment take an author, and effects, digest and maintain pass ctx.remote.principal. All 4 new tests failed against the old github.mjs and effects.mjs. The triage gh fake |
| AC87 still gives a spawned holder process a fixed 60 ms to start and mkdir the mutex before asserting it holds it — the same bounded-timing-budget class #999 re | MEDIUM | fixed | The holder now prints 'held' and keeps the mutex until the test creates a release file, replacing the 60 ms sleep. With a 400 ms startup delay preloaded into every node process (NODE_OPTIONS --require), the old test failed with 'the other process holds the mutex' and the new one passes. It still fai |
| AC87's mutex-blocking clause sleeps 700 ms then asserts the child waited ≥500 ms, so a child that takes >200 ms to boot and import four autopilot modules false- | MEDIUM | fixed | The writer child prints 'writing' just before it writes, and the test checks the write finished after the mutex was released, replacing the 'elapsed >= 500' check. Under the same 400 ms startup delay the old test failed ('waited 244 ms') and the new one passes. It still fails under the status.noFile |
| autopilot's reclaim renames and removes the lock directory after an earlier staleness read without verifying it is the judged lock, so a losing reclaimer remove | MEDIUM | fixed | reclaimStale now compares the owner token of the directory it moved with the token it judged stale. On a mismatch it renames the directory back and throws LockHeldError naming the holder. The test, driven through the existing fsImpl hook, failed with 'Missing expected exception' before the fix. |
| fleet's stale-lock reclaim renames and removes whatever is at the lock path after the staleness judgment, with no check that it is the lock judged stale — the p | MEDIUM | fixed | fleet acquireLock takes an optional fs override (LOCK_FS). It checks that the directory it moved has the owner metadata it judged stale; if not, it puts it back and refuses. Both race tests failed ('B does not co-own the lock') with only the fs injection in place, and pass with the check. One of the |
| Fleet quartermaster builds priors from the manifest forest but discards `skipped`, so a corrupted ledger silently degrades seat routing with no signal in dry-ru | MEDIUM | fixed | planSeats now returns skippedLedger and adds skippedLedgerNotice to its notices, which fleet already prints to stderr in the dry-run and the live run. The dry-run --json stdout document is unchanged. Fleet README updated; the fleet.mdx mirror has no quartermaster section, so it needed no edit. |

### hollow-test: deleting code is not comment-only, regex scanner desync, --json skip output, flush before exit

| Finding | Sev | Status | What changed |
|---|---|---|---|
| A hunk that deletes a code line and adds only a comment or blank line is classified comment-only, so hollow-test exits 0 with 'no changed behaviour to mutate' w | HIGH | fixed | The comment-only filter in bin/hollow-test.mjs now uses fileChangeIsCommentOnly (lib/targets.mjs). It requires the deleted lines (from the new lib/diff-deletions.mjs) to be comment or blank in the --base blob, the added lines to be comment or blank in the new source, and the two program projections  |
| The #1032 comment-only classification lets a diff that DELETES code and adds one comment line pass the mutation gate with exit 0 and the message "no changed beh | MEDIUM | fixed | Same root-cause fix as F153. The projection comparison also catches a related shape where only comment lines are added: code wrapped in an added /* ... */ (test was red before), and a deleted closing */. A reworded comment and a pure comment deletion still exit 0 and name the file; the pure deletion |
| The stateful scan recognises a regex literal only after an operator/punctuator (REGEX_MAY_FOLLOW), so a keyword-led regex containing a backtick (`return /`/.tes | MEDIUM | fixed | The scanner now tracks whole identifier tokens and treats a / after an expression-leading keyword (return, typeof, throw, case, instanceof, delete, void, yield, else, do, in, of, new, await, default, extends) as a regex start, unless the keyword follows a dot. The two-regex parity case and 13 per-ke |
| With --json, a comment-only diff exits 0 with EMPTY stdout: the skip report is guarded by !useJson and pass(undefined) prints nothing, so JSON consumers get a g | MEDIUM | fixed | With --json, the comment-only early exit now prints buildJsonReport([]) plus skipped.commentOnly and exits 0, where it used to print empty stdout. The normal JSON report also carries skipped when any file was skipped. The test was red before. The README and the docs mirror document the field. |
| Up to 128 KiB is written to process.stderr and then opError calls process.exit(1) immediately; on macOS with a piped stderr the tail of the diagnostic can be cu | MEDIUM | fixed | A failing baseline now writes both diagnostic blocks and the 'error: baseline suite is not green' line in one write through lib/exit.mjs writeThenExit, awaits the flush, then exits 1. The test pipes stderr through a shell (spawnSync alone drains too fast to show the loss). Before the fix only 8192 b |

### review-calibration: fence finding.file, count judge-rejected findings as FP, wire verifyRepro or drop the claim, fail-closed test, atomic signal-safe restore, witness diagnostics

| Finding | Sev | Status | What changed |
|---|---|---|---|
| finding.file is reviewer-authored free text spliced raw into the judge prompt, so a reviewer can still steer its own recall to 1.0 after the #750 fix. | HIGH | fixed | The judge prompt now shows basename(finding.file), which is the value the scorer compared, instead of the raw reviewer text. plant.category is now fenced as PLANT_CATEGORY. Before the fix, all 4 tests in the new file failed, including an end-to-end run where a fake agy judge obeyed the injected path |
| The judge-mode fail-closed wiring (`if (judgeBoundError) opError(...)`) is exercised by no test; every E2E run uses --scorer string or a reviewer that locates n | MEDIUM | fixed | New end-to-end runs push the real bin through judge mode, using a fake agy binary and a finding that locates the plant. A permissive judge gives exit 1 with 'judge self-test FAILED' and nothing on stdout; a discriminating judge gives configuredJudgeBounded true and exit 0. I checked both mutants by  |
| README and --help claim a reviewer-supplied `repro` is verified behaviorally and bypasses the judge, but the bin never passes verifyRepro to scorePlants, so fin | MEDIUM | fixed | I removed the claim rather than wiring the feature, because wiring it would mean running commands written by the reviewer under test. The claim is gone from the README, --help, the bin header and the findings/scorer/verify comments; scorePlants keeps an injectable verifyRepro for library callers. Th |
| Findings that locate a plant but are rejected by the judge are still counted as neither TP nor FP, so precision remains inflated whenever at least one plant is  | MEDIUM | fixed | scorePlants now gets a verdict for every locating finding. A finding that locates a plant but identifies no plant's defect counts as a false positive and is reported as `unsubstantiated` (also in the JSON report, default 0). All 6 new tests failed before the change and pass now. Recall is unchanged. |
| review-calibration has the same #600 defect class untouched: SIGINT-only emergency restore, bare writeFileSync restores of planted mutations, and a README that  | MEDIUM | fixed | New lib/inflight.mjs: every plant and restore write is atomic (temp file plus rename). Before anything is planted, for both the review run and each witness run, a record of the original and planted contents goes to <git-dir>/adlc-review-calibration-inflight.json. The next run restores from it before |
| review-calibration's witness runner discards stdout/stderr, so a witness that fails on the ORIGINAL tree is reported only as an exit code, the same undiagnosabl | MEDIUM | fixed | The witness runner now keeps the last 1200 characters of output. A witness that fails on the original tree includes that output in its reason, and a spawn failure is reported as 'witness could not start (ENOENT …)' rather than a timeout. The CLI prints every excluded plant with its reason, and lists |

### rejection-mining, lesson-foundry, model-ratchet, skill-rot, merge-forecast: honest exit codes and bounded review commands

| Finding | Sev | Status | What changed |
|---|---|---|---|
| rejection-mining's `--limit` uses `parseInt`, so `1e3` becomes 1 and `10abc` becomes 10, the silent-cap-change this PR's validator was written to refuse. | MEDIUM | fixed | --limit and --min now go through lib/int-flag.mjs parsePositiveInt (^[1-9][0-9]*$ plus a safe-integer check). Values like 1e3, 50x, padded or unsafe input exit 1 before any gh call. Tests failed with exit 0 before the fix and pass now; one more test proves the parsed values reach gh and clustering. |
| lesson-foundry --llm has the exact defect #747 fixed in rejection-mining: every LLM call failing still exits 0 with unrefined output and no refined marker. | MEDIUM | fixed | When --llm refines no cluster, lesson-foundry now exits 1 with the rejection-mining message before any write. The JSON output gives refined per cluster, and the human report prints a failed-N-of-M line. toRefinement requires string name, description and rule. All of this is proven through the real b |
| refineCluster accepts any truthy title/charter, so a non-string LLM response crashes the human report and writes '[object Object]' into a Charter that is report | MEDIUM | fixed | lib/llm.mjs toRefinement accepts a reply only when title and charter are non-empty strings, and trims them. Any other shape counts as a failed refinement: no TypeError, no lens written as '[object Object]', and exit 1 when every cluster fails. Before the fix the test reproduced the TypeError and the |
| --write preserves a 0-byte defense artifact as if it were hand-refined, so the crash state #672 describes is now permanently red and the tool cannot repair it w | MEDIUM | fixed | The gate and the --write preserve rule now share lib/artifact-io.mjs hasDefenseContent. A 0-byte or whitespace-only artifact is regenerated ('empty (regenerated)') and left out of writeSkipped, and a non-empty hand edit is still kept. Writes go through writeFileAtomic (temp file then rename). The te |
| runReviewCmd spawns the per-file --review-cmd with no timeout, so one hung review command hangs the whole scheduled ratchet run indefinitely. | MEDIUM | fixed | runReviewCmd passes timeout and killSignal SIGKILL to spawnSync (default 600000 ms, set with the new --timeout-ms flag) and reports timedOut and signal. reviewRunError turns a timeout or signal kill into a per-file operational error; the loop continues and the run exits 1. |
| runReviewCmd spawns the per-file review command with no timeout, so one hung reviewer blocks the whole ratchet run indefinitely. | MEDIUM | fixed | Duplicate of F209. Fixed by the same --timeout-ms change and proven by the same test file. |
| model-ratchet runs the operator-configured review command (an LLM CLI) with spawnSync and no timeout, so a wedged reviewer hangs the ratchet forever. | MEDIUM | fixed | Duplicate of F209. It is also fixed by the same change, and a signal kill is now reported as 'review-cmd was killed by <signal>' instead of a bare exit 1. |
| A skill whose only claims are all unverifiable is still rendered [OK] and counted as clean, while checkSkill reports allOk:false for it and never stamps it. | MEDIUM | fixed | format.mjs now takes status and summary from the checker's allOk. A skill with only unverifiable claims shows as [UNVERIFIED], is counted in a new summary.unverified field and a ', N unverified' table suffix, and gets unverified:true in JSON. It is never counted clean. All 3 tests failed on the old  |
| A symlink in the skills tree whose target lives under node_modules or .git is silently dropped even in strict mode, so the gate exits 0 clean without inspecting | MEDIUM | fixed | A symlink that resolves into node_modules or .git now throws 'symlink into an excluded directory' in strict (explicit-path) mode, so the CLI exits 1. Default discovery still skips it, and the existing non-strict tests stay green. |
| Search roots whose real path contains a node_modules or .git component now yield zero skills (pre-PR they were found), because the canonical-path exclusion is a | MEDIUM | fixed | The exclusion is now checked on the path relative to the realpath of the search root, not on the absolute path. A root under node_modules or .git, or a repo checked out beneath one, is searched again; child directories with those names are still skipped. |
| merge-forecast uses process.cwd() as the repo root, so from a subdirectory the co-change signal (repo-root-relative git paths) never matches walkTree's cwd-rela | MEDIUM | fixed | The bin now uses repoRoot(cwd) as the forecast root inside a git work tree and the cwd outside one. An unresolvable root, such as running from inside .git, exits 1. --tickets and --graph-coupling still resolve from cwd. From a subdirectory the run now exits 2 with the same gateFailures, pairs and wa |

### init gitignore fallback and consensus-fix signal restore

| Finding | Sev | Status | What changed |
|---|---|---|---|
| A valid-object config whose `harnesses` field is not an object still makes `adlc init --harness X` report 'unchanged'/exit 0 without registering the harness or  | MEDIUM | fixed | writeOrReconcileConfig now records a warning ("`harnesses` is not an object; cannot register --harness X"), leaves the file byte-identical and the CLI exits 1 when --harness is given and harnesses is array/string/number/null. The 4 shape tests failed before the change and pass now; without --harness |
| The no-git fallback evaluator under-reports ignored paths versus real git on parent-directory exclusion and `**` semantics, so it fails open. | MEDIUM | fixed | The gitignore contract moved to lib/gitignore-contract.mjs and is re-exported from scaffold.mjs. It asks git in root first, then git in a throwaway repo holding only the .gitignore lines (this covers no repo yet and dubious ownership). The JS matcher is used only when there is no git binary, and it  |
| gitignorePatternMatches builds a RegExp from the raw pattern without escaping regex metacharacters, so a .gitignore line containing `(`, `)` or `+` throws Synta | MEDIUM | fixed | The new glob translator escapes every regex metacharacter and treats an unterminated [ as a literal, so lines like `build(`, `c++/`, `foo)bar`, `x[` or a trailing backslash no longer throw. The corpus also checks that these lines give the same verdicts as git. |
| init's git check-ignore probe inherits GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE and ADLC_MANIFEST_KEY, unlike the two sibling probes that deliberately scrub them. | MEDIUM | fixed | Every git child the probe starts now gets gitProbeEnv(), which drops ADLC_MANIFEST_KEY, GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE, the same way the sibling probes do. One test uses a real foreign GIT_DIR. The other uses a git shim on PATH that dumps its environment, and asserts none of the four vari |
| When `.adlc/*` is missing and negations pre-exist, init appends `.adlc/*` after them (killing them), records `updated`, then warns about the mis-order it just c | MEDIUM | fixed | When the `.adlc/*` anchor is missing, ensureGitignore (via plannedGitignoreLines) now drops stanza lines that are already present and appends the whole canonical stanza in order. The result is committable, and a second run reports unchanged and exits 0. The old test in misordered-gitignore.test.mjs  |
| SIGTERM/SIGHUP received during candidate evaluation is never dispatched: the handler is queued behind the synchronous execFileSync loop and the process runs to  | HIGH | fixed | runCommand is now async and runs sh -c in its own process group with an AbortSignal: SIGTERM, then SIGKILL after 2 s, and it resolves only after the command exits. runConsensusFix takes `signal`, stops the LLM await or the in-flight command, restores its snapshot and throws RunAbortedError. The bin  |
| The three signal tests only prove restore when the signal is dispatched in the idle LLM-await window; none sends a signal while a candidate is under evaluation, | MEDIUM | fixed | Added tests in a new file that signal while a candidate's hunks are on disk, covering both the repro and rails windows, plus unit tests for the runCommand abort (group killed, exit 130, not started when already aborted). The existing signal-restore tests are kept. |
| README, docs/tools and apps/docs now promise that SIGTERM/SIGHUP cancellation 'restores the original files from the snapshot before exit', which is not true dur | MEDIUM | fixed | The README and apps/docs consensus-fix.mdx now describe the guarantee as implemented: the in-flight group gets SIGTERM, then SIGKILL after 2 s, files are restored, nothing is applied, exit 1. They also say that SIGKILL of consensus-fix itself can leave hunks on disk. A guard test checks that the two |

### quartermaster dependency, coldstart --all test, isPlainObject duplicates, gate-fuzzing verdict guard, flail-detector verb regex, planCreateBatch tests

| Finding | Sev | Status | What changed |
|---|---|---|---|
| @adlc/quartermaster imports '@adlc/core' but declares no dependency on it, so the published package cannot be imported standalone. | HIGH | fixed | Added @adlc/core to packages/quartermaster/package.json dependencies and regenerated package-lock.json. The new repo guard, which scans every package's shipped code for undeclared @adlc/* imports, failed on quartermaster before the change and passes after it. |
| @adlc/quartermaster imports @adlc/core (added by #1091) but its package.json declares no dependencies, so a standalone install of the published package cannot l | HIGH | fixed | Same defect as F272, fixed by the same commit (97f4b20b). |
| The deleted test 'coldstart --all when EVERY ticket is completed is an operational error' was not carried into coldstart.test.mjs, leaving the exit-1 branch unt | MEDIUM | fixed | Coverage gap. Added tests for coldstart --all exiting 1 on an all-completed store and on an empty store, plus the matching merge-forecast twins in packages/merge-forecast/test/no-active-tickets.test.mjs. They pass at HEAD. With each guard branch mutated away temporarily, the matching test failed. |
| PR #1091 deleted the only test pinning that `coldstart --all` with every ticket completed is an operational error (exit 1), and did not re-home it; the branch i | MEDIUM | fixed | Same gap as F273, including the 'no tickets found in ticket file' branch. Commit 0303dd62. |
| Local isPlainObject copies remain in @adlc/autopilot (which depends on core) and @adlc/init after the helper was promoted. | MEDIUM | fixed | autopilot/lib/quota.mjs and init/lib/scaffold.mjs now import isPlainObject from @adlc/core. init declares @adlc/core, and the lockfile is updated. The guard failed on both files before the change. packages/autopilot/test/quota-plain-object.test.mjs (class instance rejected as a limits entry) also fa |
| computeVerdict's zero-candidate refusal is opt-in: when candidatesClassified is omitted the guard is skipped and the pre-#640 'clean' path is restored, with no  | MEDIUM | fixed | When no defeat is confirmed, computeVerdict now returns exit 2 inconclusive if candidatesClassified is missing or is not a non-negative safe integer. allowEmpty now forgives only a verified zero, and the three alias fields are removed. Confirmed defeats are still reported as before. The new tests fa |
| Widened verb regex extracts prose words as paths, so real Claude Code transcripts with >=3 Write calls now report FLAIL (edit-churn on path "successfully") and  | HIGH | fixed | VERB_PATTERN in signals.mjs (not frozen) now matches only at the start of a line. It still accepts leading indentation, timestamps, bracketed fields and upper-case level names, and it never crosses a newline. As a result, 'File created successfully at:' and mid-sentence verbs no longer produce paths |
| Four of the nine red tests the ticket mandates for planCreateBatch were never written, leaving the per-ticket guard loop untested. | MEDIUM | fixed | Coverage gap. Added tests for ARCHIVE_COLLISION, RAIL_COVERS_MANIFEST, a STALE_SNAPSHOT apply that leaves the store hash unchanged, and a single store-scoped batch-create evidence entry. They pass at HEAD. Removing each guard, or setting ticketId non-null, made the matching test fail. |

### docs and release surfaces: stale skill claims, phantom flags, enforcement overclaims, operating-stack status, CODEOWNERS, marketplace version drift, breaking-change marker in the changelog generator

| Finding | Sev | Status | What changed |
|---|---|---|---|
| Section 1 rule 3 still claims #905 is live and every packages/* lane needs the 4b ceremony, contradicting section 4b in the same file. | MEDIUM | fixed | Rule 3 of issue-lanes section 1 now names tier.mjs's ENFORCEMENT_PREFIXES, PRODUCER_PREFIXES and TRUST_ROOT_FILES lists plus the rails of active tickets. The grep loop now skips completed tickets (`t.completed===true`). The test failed before the fix and passes after; it also checks that tier.mjs st |
| SKILL.md says only test (18)/(20)/(22) are required and that gate, rails-guard and mutation-gate do not gate the merge button, but all six are required status c | MEDIUM | fixed | The required-checks bullet now names all six contexts, points at docs/ci/required-gates.json as the declaration, and no longer says 'do not describe them as blocking'. The test builds the blocking set from required-gates.json. It failed before and passes now. |
| The repo's issue-lanes skill still states only test (18/20/22) are required and instructs agents not to describe gate/rails-guard/mutation-gate as blocking, whi | MEDIUM | fixed | Same defect as F043, fixed by the same edit and pinned by the same test. |
| The docs-site usage line rewritten by this PR advertises `--archive path`, a flag the CLI does not accept, and the flag table describes `--write` archiving into | MEDIUM | fixed | Removed the phantom --archive flag from the README and the docs-site mirror. --write is now described as a tombstone on the legacy store and a move to .adlc/ticket-archive/ on the sharded store. Added --allow-unsigned (both docs) and --ceremony (mdx) rows, and replaced the mdx example with real rend |
| The cursor and pi `adlc-maintain` prompts instruct agents that `ticket-prune --write` archives into a gitignored `.adlc/tickets.archive.json`, which the tool no | MEDIUM | fixed | The cursor and pi adlc-maintain prompts now use the tombstone/shard-archive wording from the other harnesses. So does the codex adlc-distill skill, which had the same stale claim. The test scans every tracked plugins/**/*.md file and failed before the fix. |
| README Rule 1 says a below-floor ticket triggers exit 2 'regardless of category', but the P3 gate excludes frontier-category tickets, so no exit 2 occurs for th | MEDIUM | fixed | Fixed README Rule 1 (line 68) and the density paragraph (line 105), which made the same 'regardless of category' claim. Both now say a frontier-category ticket below the floor raises no P3 finding and does not exit 2. The test also checks the router.mjs predicate. It failed before the fix. |
| docs/specs/operating-stack.md still says "Status: **proposed, revision 12**" although packages/quartermaster ships and declares itself the implementation of tha | MEDIUM | fixed | The status line of docs/specs/operating-stack.md now reads 'partially shipped', with sections 4-5 built as packages/quartermaster and §9 items 1, 3 and 4 still follow-on work. The test failed before the fix. The check is in the new file rather than the existing docs-truth pair table. |
| CODEOWNERS still claims the rails-guard/tickets subtrees rely on a branch-protection review backstop that the repo's ruleset does not configure. | MEDIUM | fixed | CODEOWNERS now says code-owner review is not required (pullRequestReview 'none'), so these subtrees are held only by the required checks and admin merge. The test is conditioned on required-gates.json and failed before the fix. Partly blocked: the matching sibling comments in packages/rails-guard/li |
| The header claims actionlint lints `.github/actions/**/*.yml`; actionlint only lints workflow files, so the composite action's run block this PR created is outs | MEDIUM | fixed | The actionlint.yml header now says it lints .github/workflows only, and that composite-action run steps get no shellcheck pass. No shellcheck step was added (listed as out of scope in the ticket). The test failed before the fix. |
| CRITIC-release-version-drift | MEDIUM | fixed | hostMarketplacePaths now also returns host-fixed listing paths (.github/plugin/marketplace.json) when they exist and never creates one, so the bumper and findVersionDrift both cover the Copilot listing. The listing is set to 1.11.1. New release.test.mjs cases check coverage of every tracked versione |
| CRITIC-semver-breaking-change-unmarked | MEDIUM | fixed | changelog.mjs now exports isBreaking and parseLog. A commit with `type!:` or a line-initial BREAKING CHANGE/BREAKING-CHANGE footer goes into a top '### Breaking' section whatever its type, with the footer text appended. main now reads subject and body from git log. CHANGELOG.md [Unreleased] gains a  |

### trust root: classify .github/workflows and CODEOWNERS as trust-root tier, harden gate-liveness, fix vacuous/racy rails-guard on push, freeze the fixture guard permanently, and fix the tiered-package findings

| Finding | Sev | Status | What changed |
|---|---|---|---|
| The required checks test/rails-guard/mutation-gate are defined by PR-controlled .github/workflows/ci.yml, and the only base-controlled required check (`gate`, p | CRITICAL | fixed | tier.mjs now puts everything under .github/workflows/ and .github/actions/ in the trust-root tier, with no test-path exemption. The same goes for CODEOWNERS, .github/CODEOWNERS and docs/CODEOWNERS. A new test also requires every workflow listed in required-gates.json to be in the tier. The false cla |
| The --branch regex admits `..` segments and GitHub normalizes them, so a crafted --branch makes the tool evaluate a different repository's ruleset. | MEDIUM | fixed | A new isBranchName check refuses '..', empty segments and segments starting with '.'. It exits 1 without calling gh. Those tests failed before the fix. |
| requiredContexts ignores integration_id, so a live context pinned to no app (or another app) satisfies the check although the committed ruleset pins 15368; no t | MEDIUM | fixed | required-gates.json now declares integrationId 15368. If a declared context is not pinned to that source, the tool exits 2 with a DENY line and lists it in the --json field weakSource. An invalid integrationId exits 1. If the field is absent, sources are not checked; that is a deliberate choice, and |
| CRITIC-racy-vacuous-gate | MEDIUM | fixed | A new 'Resolve diff base' step in ci.yml picks the base: origin/<base_ref> on pull_request, github.event.before on push, HEAD^1 when before is zero or missing (with a warning), and exit 1 when HEAD has no parent. The rail-freeze, findings-ledger and reviewer-directed-comment steps all use it as DIFF |
| The promised follow-up freeze of the guard as a rail was never delivered; no ticket declares it and PR #1146 falsely says the file is 'frozen'. | MEDIUM | fixed | scripts/test/tmp-fixture-boundary.test.mjs was added to REPO_TRUST_ROOTS in scripts/rails-guard-ci.mjs, to CODEOWNERS and to the tier.mjs trust-root files. The test runs the real wrapper and failed before the fix (exit 0). The guard file itself is frozen, so it was not edited. |
| Issue #1055's core ask — declare the guard file as a rail so the detector cannot be softened — was not done; nothing at HEAD freezes the file. | MEDIUM | fixed | Same fix as F166: the guard is now permanently frozen as a repository trust root, which does not expire the way a ticket rail does. |
| Issue #1055's stated action was to declare the guard as a rail so a build cannot weaken it; PR #1146 instead added a self-assertion inside the file (`ALLOWLIST. | MEDIUM | fixed | Same fix as F166. The permanent lock is now enforced outside the file, by REPO_TRUST_ROOTS, CODEOWNERS and the tier. The file's own header could not be softened because the file is frozen. |
| `adlc spend --json` omits `skipped` from the payload and suppresses the stderr warning, the exact shape of the #701 defect fixed in model-router. | MEDIUM | fixed | spend --json now emits { ...aggregate, skipped }, and the stderr warning prints in both modes. The test runs the real binary and failed before the fix. The --json shape in the README is updated. |
| countToolCalls keeps the same `^`-anchored Writing\|Editing\|Created regex, so timestamped or indented prose tool-log lines count 0 toward the depth signal; the | MEDIUM | fixed | A new exported PROSE_TOOL_LINE accepts indentation and a clock or ISO timestamp before the verb. It stays anchored to the line start and needs the target on the same line; negative cases cover mid-sentence mentions and JSON string content. The Codex, Copilot and Claude Code hook copies use the ident |
| With `select.query` configured, raising `--limit` above 1000 defeats the truncation guard because gh's `--search` path silently caps at 1000 results. | MEDIUM | fixed | When select.query is set, listIssues now treats min(limit, SEARCH_RESULT_CAP=1000) rows as truncated and tells the user to narrow the query. The test failed before the fix. The ticket-sync README and ticket-sync.mdx are updated. |
| @adlc/ticket-sync still carries a private mirror of canonicalEntryBytes/signV2 whose stated justification ("zero cross-package coupling") is false at HEAD, the  | MEDIUM | fixed | reassign.mjs now signs through canonicalEntryBytes from @adlc/tickets, with an immutable build of the entry. v1 and anchor-carrying v2 entries are checked through the shared entrySigValid. At HEAD nothing was broken, because the two copies produced the same bytes. So the only test that failed before |

### Integration fixes made while combining the branches

| Change | Why |
|---|---|
| The Codex and Copilot build-gate bypass recorders now refuse to record on a manifest chain that already holds signed entries. | Neither recorder hands its child a signing key. An unsigned entry appended after a signed one makes every later key-aware verification of the chain fail. Refusing leaves the bypass unrecorded, so the gate denies. Tests in both plugins cover signed, unreadable and unsigned chains. |
| The temp-fixture guard now ignores comments and string literals and pins its binding rules with planted tests. It also reports a fixture returned from a helper unless the helper registers its removal, and its header states exactly what it covers. | These four findings were blocked while the guard file was a frozen rail; the rails lifted when the wave-7 tickets completed. The stricter factory rule found 80 real leak sites in 72 more suite files, all now cleaned, including three directories leaked per run by the gate-manifest key-ceremony tests. |
| The Cursor MCP bundle was rebuilt. | It inlines core's agy stdin error handling. |
| New plugin tests route every child process through a bounded helper. Gemini and OpenCode gained their first plugin-test helper, and Cursor's gained `launchHook` for long-running stdio servers. | The widened hook-spawn guard scans every plugin test directory. |

## Appendix: LOW findings (not changed)

Verified LOW findings (213), reported only. Grouped by the reviewer that raised them.

### docs-1

- `.claude/skills/issue-lanes/SKILL.md:234` The skill's TRUST_ROOT_FILES summary lists 3 of 14 entries and then says everything else is untiered.
- `.claude/skills/issue-lanes/SKILL.md:421` The skill says only test (18/20/22) are required checks, but rails-guard, mutation-gate and gate are blocking at HEAD and in the live ruleset.
- `.claude/skills/issue-lanes/SKILL.md:239` scripts/test/rails-guard-workflow-hashes.json is cited as a trust-root file but has not existed since 2026-07-27.
- `.adlc/specs/decompose.md:3` The decompose spec is still PARKED - blocked on #1003 although #1003 closed in-range with planCreateBatch landed.
- `.adlc/specs/backlog-grooming.md:3` The backlog-grooming spec still says draft, P1 in progress, not yet approved, though it is approved and built.

### docs-2

- `packages/backlog-groom/README.md:7` README and the docs-site page state the package is the READ path and writes nothing to GitHub, but the write path (--apply) ships in this same package.
- `packages/backlog-groom/README.md:11` All three backlog-groom docs justify the missing `adlc backlog-groom` verb by a frozen rail of an in-flight ticket that has since completed; no ticket freezes registry.mjs any more, yet the verb is still unregistered and #1021 is still open.
- `README.md:99` backlog-groom is the only packages/* directory absent from the README toolkit table, docs/package-reference.md and docs/toolkit.md, while sibling packages (ticket-prune, rejection-mining, autopilot) are listed.

### docs-3

- `apps/docs/content/docs/toolkit/backlog-groom.mdx:59` The docs-site read-only invocation still omits --threshold while the same page says the default is not a reasonable starting point.
- `apps/docs/content/docs/toolkit/backlog-groom.mdx:160` The mdx says a 'miss rate' is printed with every run; the code deliberately reports only pairsExcluded/excludedRate and refuses to compute a miss rate.

### pr-1000

- `packages/autopilot/lib/run.mjs:113` The site-:79 comment claims continueRun reports `resume-no-ticket-id` after a vanished record; the actual path writes a ticket and ends at `record-vanished`.

### pr-1011

- `packages/review-calibration/test/judge-bounding.test.mjs:50` The pre-fix comment describing the tag as length-carrying was left in place directly above the corrected one.

### pr-1012

- `packages/backlog-groom/lib/report.mjs:112` An issue whose only citations are never-tracked prose paths is counted as 'verified mechanically' in the coverage line even though nothing was checked.

### pr-1014

- `plugins/adlc-cursor/lib/mcp-spawn.mjs:123` The shipped Windows diagnostic tells users to set ADLC_CLI_BIN, but no plugin README, skill, or docs page documents that variable.
- `plugins/adlc-cursor/lib/mcp-roots-proxy.mjs:722` After a bound child exits, every later tool call is refused with 'Roots unresolved or refused' although Roots resolved fine, and the proxy never re-requests roots or respawns.
- `plugins/adlc-claude-code/hooks/adlc-hook.mjs:175` Bare `spawnSync('adlc', ...)` (the Windows .cmd-shim class the Cursor spawn resolver was written to avoid) remains in the CC, Copilot and herdr plugins.

### pr-1015

- `packages/fleet/lib/charters.mjs:56` The fleet builder charter interpolates the unconstrained ticket title raw while fencing the body.
- `packages/premortem/test/prompt-fencing.test.mjs:13` The four 'forged terminator cannot close the fence' tests assert only that the payload sits between the first opener and the last closer, which the old forgeable fence also satisfies.
- `docs/lifecycle-threat-model.md:47` The threat model names coldstart and fleet charters as 'the JS-level call sites' for fencing, omitting the seven other guarded builders at HEAD.

### pr-1016

- `packages/backlog-groom/bin/backlog-groom.mjs:211` A failed `gh api user` silently disables resume detection, so every retry after comment-succeeded/action-failed re-comments (AC15's failure mode) with no diagnostic.
- `packages/backlog-groom/test/floor.test.mjs:149` The AC6 'structural' guard classifies only execute.mjs exports, so a new write entry point in apply.mjs or gh.mjs ships unclassified.
- `packages/backlog-groom/lib/apply.mjs:138` The issue-revision check is skipped when the freshly fetched issue carries no updatedAt, with no test pinning that direction.
- `scripts/gemini-install-smoke.mjs:66` One remaining mkdtempSync in non-test code with no cleanup, the same inode-leak class #1016 fixed in this package.
- `packages/backlog-groom/lib/apply.mjs:248` The --apply consumer never checks the groomed set's schemaVersion, so a shape change yields zero actions silently rather than a refusal.

### pr-1020

- `packages/core/lib/mutate.mjs:420` A const assignment followed by a trailing `//` comment never matches the fallback because the regex requires the line to end at `;`.
- `packages/hollow-test/README.md:207` The hollow-test README operator table and the core README do not list the value-substitute operator that the gate now emits in survivor reports.
- `packages/core/lib/mutate.mjs:422` Ticket says to export FALLBACK_OPERATORS alongside OPERATORS; it is module-private, and three of the five ticket-mandated tests do not go red on revert.

### pr-1023

- `packages/tickets/test/edit.test.mjs:217` The 'unset editor leaves no temp directory' test counts `adlc-ticket-edit-*` in the shared system tmpdir before/after, so a concurrent edit-session test can false-red it.
- `packages/gate-fuzzing/test/isolation.test.mjs:128` The sandbox-isolation test asserts `after <= before` on a shared-tmpdir count of `gf-clone-*`, which is redundant with its direct existsSync check and can false-red under concurrency.
- `packages/backlog-groom/test/apply-e2e.test.mjs:137` The e2e harness spawns the binary with no spawnSync timeout, so a wedged child (now including the shim's blocking `cat`) hangs the CI job instead of failing with a diagnostic.

### pr-1024

- `packages/tickets/index.d.ts:50` index.d.ts declares every TicketService plan method except the new planCreateBatch.
- `packages/tickets/lib/service.mjs:140` A batch element that is not an object, or whose id is not a string, throws a raw TypeError instead of a typed TicketStoreError.
- `packages/tickets/lib/service.mjs:257` planReconciliation is the remaining multi-ticket write path that skips #assertNoManifestRails, so remote tickets with manifest-covering rails land unguarded via ticket-sync.
- `packages/tickets/lib/service.mjs:163` Issue constraint 6 (whether a batch verb accepts `rails` at all) is neither decided in code nor recorded in the PR/ticket.

### pr-1025

- `packages/ticket-prune/README.md:116` Both surviving flag tables document `--archive <path>` but the binary declares no such option and crashes with a raw parseArgs stack trace.
- `apps/docs/content/docs/toolkit/ticket-prune.mdx:27` The docs-site mirror's other flag rows, description, exit-code table and example output still describe the retired flat-file archive and text the tool never prints.
- `packages/ticket-prune/bin/ticket-prune.mjs:84` Under `--json`, a partially-applied directory-store batch prints an undocumented `{ ok:false, error, archived, failedId }` document that the documented shape does not describe and cannot be discriminated from by an `ok` key.
- `packages/ticket-prune/README.md:16` `--allow-unsigned` is accepted by the binary and shown in its USAGE but is absent from the README and docs-site flag tables and usage lines.
- `packages/ticket-prune/test/json-shape-docs.test.mjs:9` The drift guard's header comment still describes three copies and a docs/tools mirror after #1096 removed that mirror and reduced DOCS to two entries.

### pr-1026

- `apps/docs/content/docs/toolkit/model-router.mdx:37` The docs-site prose directly under the corrected --floor row says slack tickets 'start `cheap`', omitting that density below 0.5 starts on `mid`.
- `docs/models-by-phase.md:148` models-by-phase (both mirrors) still reasons as if loosening --floor yields more cheap-tier attempts, the same conflation #700 corrected.

### pr-1027

- `docs/ticket-sync.md:37` `docs/ticket-sync.md` quotes the tool's `--help` usage line verbatim but still lacks `--limit <n>` (and `--allow-unsigned`).
- `packages/ticket-sync/lib/gh.mjs:12` The gh runner spawns `gh` with no timeout, and `--limit` now allows arbitrarily large fetches through it (pre-existing, railed).

### pr-1028

- `apps/docs/content/docs/toolkit/merge-forecast.mdx:55` The docs-site merge-forecast page still documents certifiedWidth as the only width and shows a gate message the binary no longer produces; firstWaveWidth/scheduleWidth are absent.
- `packages/merge-forecast/test/forecast.test.mjs:620` Test name and comments still say certifiedWidth for the gate that now compares against firstWaveWidth.

### pr-1029

- `packages/backlog-groom/bin/backlog-groom.mjs:85` On `--apply --profile <path>` the caller-chosen profile is opened and parsed (bin:82-88) before `validateApplyArgs` refuses the combination (bin:99-100), so a malformed alt profile reports its own parse error instead of the refusal.
- `packages/backlog-groom/lib/cluster.mjs:40` The area-target derivation `unitsForIssue` drops paths that match no unit and `unitFor` takes the first matching unit, so "exactly one unit" can hold for an issue whose verified locations do not uniquely identify a unit (tracked as open issue #1038).

### pr-1030

- `packages/core/README.md:78` Core README still documents fence() as the three-argument, unconditionally tail-biased primitive.
- `packages/autopilot/lib/redact.mjs:102` The autopilot redactor has its own tail-only truncation (no bias) sitting upstream of the now head-biased triage fence; dormant because the sole caller passes no maxChars, and untested.

### pr-1034

- `plugins/adlc-pi/lib/handoff-gate.mjs:2` The pi and opencode handoff-gate.mjs headers still open with 'pi/OpenCode is an ENFORCING tier' with no note that the gate is off by default behind ADLC_CONTEXT_ROT_HANDOFF_ENABLED — the same header drift the PR fixed in the codex twin.
- `packages/hollow-test/README.md:55` The hollow-test README says a comment-only or import-only change 'still only warns', which is false at HEAD in both directions: import-only fails closed (#658, exit 1) and comment-only is now reported as not covered with exit 0 — and the new #1032 classification is not documented anywhere in the README.
- `packages/hollow-test/test/comment-only-diff.test.mjs:180` Two of the ticket's named red tests — 'a diff touching a comment AND one real code line still mutates, and still fails closed if that mutant survives' and 'an import-only diff STILL fails closed' — exist only as predicate-level unit tests; no CLI test drives bin/hollow-test.mjs for either shape.

### pr-1045

- `plugins/adlc-claude-code/hooks/adlc-hook.mjs:787` SIGKILLing `git status --porcelain` on budget exhaustion can leave a stale .git/index.lock in the user's repo because git status takes the optional index lock and SIGKILL cannot be caught.
- `plugins/adlc-claude-code/hooks/adlc-hook.mjs:783` The whole-scan deadline is computed from the wall clock (Date.now()), so a backward clock step during the scan inflates a single git call's timeout by the size of the step.
- `plugins/adlc-claude-code/hooks/adlc-hook.mjs:2172` The recovery-audit adlc spawn is the one bounded spawn in the file without killSignal SIGKILL, contradicting the PR's stated convention that bounded children are SIGKILLed so they are actually reaped.

### pr-1046

- `scripts/test/tmp-fixture-boundary.test.mjs:90` The `drains` gate is file-wide (`after(` and `rmSync(` anywhere), so an undrained registry passes when the file has an unrelated after()+rmSync, and an rmSync on a same-named non-fixture binding launders a fixture root.
- `scripts/test/tmp-fixture-boundary.test.mjs:144` The SELF-exemption comment says the exact-path exemption is 'proven below', but no test exercises a similarly named file being scanned.

### pr-1049

- `packages/context-handoff/adapter-test/no-adapter-threshold-literals.test.mjs:108` findThresholdLiterals recognises only `const|let|var NAME = value;` so a threshold introduced by bare assignment (`let WARN_PCT; WARN_PCT = 60;`) evades checks 1 and 3.

### pr-1052

- `plugins/adlc-copilot/hooks/test/copilot-io-contract.test.mjs:29` AC1 is 68/69: copilot-io-contract.test.mjs still spawns the hook raw with no timeout, exempted because it is a rail of ticket T-01M1P61RGPBWHCPRZX1RE9PPPB, which has not completed at HEAD.

### pr-1053

- `apps/docs/content/docs/toolkit/backlog-groom.mdx:133` The signing paragraph was inserted under 'Stated limits — Two things this design does not defend against', so the docs now list a defense as a non-defense.
- `packages/backlog-groom/lib/gate.mjs:237` An unverifiable entry in a slot is treated as 'no review happened', so a caller who can write the ledger re-rolls a signed demote by corrupting one byte of its `sig`; docs still say a second review 'is REFUSED BY CODE'.
- `packages/backlog-groom/lib/io.mjs:179` The `merge-base --is-ancestor <mergeBase> <remoteSha>` check cannot fail for a value that `merge-base HEAD <remoteSha>` just returned, so the 'reachable, proven rather than assumed' step and its AC8 case exercise only the mock.

### pr-1054

- `.claude/skills/issue-lanes/SKILL.md:421` The issue-lanes skill still says only test (18|20|22) are required checks and that gate/rails-guard/mutation-gate do not gate the merge button, but since #1069 the live ruleset requires all six.

### pr-1060

- `packages/backlog-groom/README.md:75` README profile example still shows `"reviewer": "openai"`, the provider this PR replaced because it needs an API key the operator environment lacks.

### pr-1063

- `scripts/claude-code-plugin-smoke.mjs:662` Two EXCLUDED_DOC_PATHS reason strings now describe content that the PR deleted.
- `docs/specs/adlc-init-hygiene.md:1` Fourteen docs/specs/*.md P1 specs are referenced by nothing in the tree, the same class the PR deleted, but were explicitly scoped out.

### pr-1065

- `scripts/fleet-live-smoke.mjs:1` scripts/fleet-live-smoke.mjs is a caller-less script of the same class the PR deleted: no npm script, workflow, run-tests segment, test or README names it.
- `scripts/router/router-model.mjs:63` router-model.mjs still says 'The consolidation check reads the baseline from here' and carries the unread baselinePath/supersedesBaselineFrontmatter fields, with no follow-up filed.

### pr-1067

- `packages/context-handoff/lib/deny-marker.mjs:361` 21 stacked doc blocks (`*/` directly followed by `/**`) remain across packages/, plugins/ and scripts/, each a doc block separated from the declaration it describes — the exact defect class FACT 1 fixed inside backlog-groom.
- `packages/backlog-groom/test/tidy-contract.test.mjs:418` A test named `parseProfile: …` was appended (by #1091) to tidy-contract.test.mjs, breaking the ticket's normative rule that every test in this file carries one of exactly five prefixes, and nothing enforces that rule.

### pr-1068

- `packages/gate-manifest/lib/forest.mjs:4` Six source comments still justify local re-implementations by citing 'CONVENTIONS rule 2 — core is frozen', a rule that now says the opposite.

### pr-1069

- `packages/autopilot/lib/ci.mjs:24` autopilot BLOCKING_PREFIXES treats `ticket-store-platform (` as merge-blocking while required-gates.json declares it advisory, and the AC8 test only checks the declared->autopilot direction so the disagreement is invisible.
- `scripts/test/gate-liveness.test.mjs:488` AC1's `assert.match(err, /gate/)` is satisfied by the `gate-liveness:` prefix of every stderr line, so the `gate` context being reported missing is never actually asserted.
- `.github/workflows/gate-liveness.yml:9` The workflow header still says the run is EXPECTED to be red until the admin updates the ruleset; the ruleset has been updated and the run is green.
- `docs/ci/required-gates.md:13` The shipped CLI accepts a `--pull-request <mode>` override that is not in the ticket's CLI list and is not mentioned in the admin doc.
- `docs/github-rulesets/main-branch-ruleset.json:1` The committed ruleset omits `require_extra_approval_for_unattributed_changes: true` that the live ruleset carries, so apply.sh would silently revert it, the same silent-revert class the ticket fixed for required_status_checks.
- `AGENTS.md:13` AGENTS.md says CI blocks a PR on three gates (tests, rail-freeze, mutation-gate); the cross-model `gate` job is now a fourth required check.
- `scripts/test/gate-liveness.test.mjs:450` One test spawns the real `gh --version` binary, so the suite fails on any machine or matrix leg without gh installed.

### pr-1070

- `scripts/test/docs-truth.test.mjs:39` The opt-in and Claude-Code wiring detectors key on incidental spellings, so a behaviour-preserving rename or a non-PreToolUse `handoff` verb flips the symmetric assertion and demands the docs delete a true statement.
- `docs/specs/prosecute-coverage-split.md:75` A docs/specs record still hardcodes a maintainer-specific `/home/voodootikigod/...` worktree path, the same class the PR removed from AGENTS.md.

### pr-1072

- `packages/model-ratchet/bin/model-ratchet.mjs:262` With --allow-empty in text mode, the tool prints the identical 'Review Run Summary / Total findings: 0' output that #688 called indistinguishable from a healthy run; selectedCount is surfaced only in --json.
- `packages/model-ratchet/bin/model-ratchet.mjs:147` Plan mode still exits 0 on an empty selection and its JSON omits selectedCount, while the README advertises plan-only mode as a 'CI gate'.
- `packages/model-ratchet/README.md:54` README never states which languages/extensions are supported or that an unsupported-language repo now exits 2, and the docs-site page still says 'Gate: none' next to a gate-failure exit code.

### pr-1073

- `plugins/adlc-claude-code/commands/adlc-maintain.md:22` Host-plugin maintain docs and the CI recipe still equate skill-rot exit 0 with 'skills are fresh', but a run consisting only of NO-CLAIMS skills also exits 0.
- `packages/skill-rot/lib/format.mjs:26` `[NO-CLAIMS]` (11 chars) breaks the fixed-width status column that `[OK]   ` and `[STALE]` (7 chars) were padded to.

### pr-1074

- `plugins/adlc-claude-code/commands/adlc-maintain.md:96` Plugin distill/maintain docs still say every non-zero exit of `adlc lesson-foundry --gate` names unbanked clusters and never mention --allow-missing-ledger.

### pr-1075

- `packages/merge-forecast/lib/forecast.mjs:89` The 'shallow clone or no history' friendly-message branch in the co-change catch can never match real git output, so it is dead code with no test pinning it.

### pr-1076

- `docs/adr/0003-adlc-claude-code-plugin.md:268` The ADR retirement note says pre-ga-gate was "previously required as a status check", but it was never a required check.
- `CODEOWNERS:49` .adlc/config.json is a default immutable trust root present at HEAD with no CODEOWNERS row, the same gap the PR closed for .store.json.

### pr-1077

- `packages/review-calibration/bin/review-calibration.mjs:101` Help text, README step 8 and the docs-site exit-code list describe exit 2 only as 'precision below threshold' and omit the new 'precision could not be measured (null)' cause.

### pr-1078

- `packages/model-router/bin/model-router.mjs:77` Invalid-segment records (line: null, e.g. a symlinked manifest.d/) are counted and reported as "malformed ledger line(s)".
- `packages/model-router/README.md:50` README and docs-site page show `"skippedLedger": []` but never describe the entry shape or that the stderr warning is emitted in --json mode.

### pr-1079

- `packages/init/lib/scaffold.mjs:345` Issue #666's optional recommendation to also flag a config missing `version`/`securityMode` was not adopted, so `{}` passes `adlc init` with exit 0 while rail-freeze/bootstrap reject it.
- `packages/init/lib/scaffold.mjs:298` The rewritten docstring says an unparseable config is left untouched 'without reporting unchanged', but the code records it as 'unchanged' and the new test asserts that.

### pr-1080

- `packages/rejection-mining/lib/report.mjs:56` Human report says N of M refinements failed but the per-lens table and the `wrote:` lines give no indication of which lenses are the unrefined fallbacks.

### pr-1081

- `.adlc/tickets/t-01m32wym1xggp6q6yw4byjnkdc--f31981becc95ea7022474e7a9e4397a233bb007c7d15475ca73ed0512cf4c01e.json:7` The ticket's rails name two files that do not exist, so rails-guard protected nothing during this build; the real stable-id code lives in lib/route.mjs.

### pr-1082

- `packages/model-ratchet/bin/model-ratchet.mjs:113` The new repoRoot(cwd) call is unguarded and throws a raw stack trace when isGitRepo passes but no work tree exists (inside .git/ or a bare repo).
- `packages/model-ratchet/bin/model-ratchet.mjs:110` Error and help text contradict the shipped behaviour: the not-a-repo message still says 'run from repo root', help says review-cmd runs with shell=true, and no doc mentions that the review command now executes with cwd = repo root.

### pr-1083

- `packages/skill-rot/bin/skill-rot.mjs:55` Broken-symlink and unreadable-directory errors are reported under the JSON error label 'explicit search path is not a skills directory or SKILL.md', and the README/mdx do not document the strict-mode symlink error or the node_modules/.git target exclusion.
- `packages/skill-rot/lib/find-skills.mjs:55` realpathSync(dir) at the top of collectSkills is outside the try/catch, so a directory that disappears or cannot be resolved between readdir and recursion throws even in default (best-effort) discovery.
- `packages/skill-rot/lib/find-skills.mjs:91` A SKILL.md reachable both directly and through a file symlink is returned twice, so it is checked and counted twice in the summary and stamped twice with --write.
- `scripts/run-tests.mjs:118` packageSegments filters packages/* with Dirent.isDirectory(), so a symlinked package directory gets no test segment and CI stays green without running its tests.
- `packages/merge-forecast/lib/signals.mjs:44` merge-forecast walkTree dispatches on Dirent.isDirectory()/isFile(), so symlinked directories and files are dropped from the repo file list that feeds the import-radius signal.

### pr-1084

- `packages/fleet/lib/plan.mjs:73` The fleet dispatcher still treats an unscoped ticket as overlapping nothing and admits it in parallel with any in-flight ticket — the same #680 defect class, left in place because the fix bypassed the shared scopesOverlap primitive instead of correcting it.
- `packages/merge-forecast/test/empty-scope-warning.test.mjs:94` The 'Windows path separators' test passes on Linux only by creating a directory literally named `src\sub` that the normalization then rewrites to a different (non-existent) path, so it does not exercise the Windows behaviour it names.
- `packages/merge-forecast/lib/signals.mjs:46` walkTree ignores symlinked files (Dirent.isFile() is false for symlinks), so a ticket whose scope covers only symlinked paths is now flagged 'scope matches 0 files in repo' and forced to SEQUENCE.

### pr-1085

- `packages/gate-manifest/lib/key-ceremony.mjs:286` JSDoc still cites `@adlc/tickets's generation-descriptor.mjs (readAdoptionRecord)` as an example of the pathname-check-then-open gap, but that module no longer exists at HEAD and nothing tracks the cleanup.

### pr-1086

- `scripts/test/tmp-fixture-boundary.test.mjs:151` The tmp-fixture guard only scans test files containing 'mkdtempSync', so lifecycle-hooks.test.mjs's 19 join(tmpdir(), ...) fixtures are never checked while the guard asserts leaking is '100% eradicated'.
- `plugins/adlc-gemini/test/lifecycle-hooks.test.mjs:121` runCases makes every expectation optional, so a table row with a misspelled or omitted expectation key passes without asserting anything.
- `plugins/adlc-gemini/test/lifecycle-hooks.test.mjs:19` setupTempRepo's legacy options-first shim is unreachable and its condition is self-contradictory.

### pr-1087

- `packages/rejection-mining/bin/rejection-mining.mjs:114` `firstError` is only surfaced when skippedPRs === totalPRs; for any partial failure the cause is dropped and there is no threshold, so 49/50 skipped PRs exits 0 with no reason shown.
- `.adlc/tickets/t-01m3339mta05dt2h2a5pg1t3tr--dff67f9eb8c44c8cac3de249637ca86c9f53885dc21f58571744337ca776fa84.json:1` Ticket T-01M3339MTA05DT2H2A5PG1T3TR shipped in #1087 was never marked `completed: true`, so its rails (lib/lens.mjs, lib/cluster.mjs) stay frozen for every subsequent PR.
- `packages/rejection-mining/lib/gh.mjs:14` runGh spawns `gh` with execFileSync and no timeout, so a hung `gh pr view` blocks the tool forever and never reaches the new all-failed error path (pre-existing, same code path).
- `packages/rejection-mining/test/all-prs-skipped.test.mjs:2` all-prs-skipped.test.mjs is a bare re-import of skipped-prs-threshold.test.mjs, so the package glob runs all six CLI-spawning tests twice.

### pr-1088

- `packages/flail-detector/lib/analyzability.mjs:17` Module header still says under-extraction of paths 'is issue #623's domain' although #623 is fixed at HEAD.

### pr-1089

- `.adlc/tickets/t-01m3339p8nxx889wkj2mx8k068--c92e5bf941b981fe8e328c75da95e610ad01d4b7ff391f2124523a718ade4037.json:1` The ticket's rails name packages/model-ratchet/lib/scoring.mjs and lib/graph.mjs, neither of which exists, so the P3 rails check for this lane froze nothing.
- `packages/model-ratchet/lib/walk.mjs:63` walkSourceFiles gained a test-only `_relative` injection parameter — the only DI seam in any packages/*/lib — so the shipped walker carries a hook no production caller uses.
- `packages/model-ratchet/test/windows-path-separators.test.mjs:3` The alias test file re-imports path-separators.test.mjs, so `npm test -w packages/model-ratchet` (glob test/*.test.mjs) runs the same 7 tests twice; it exists only to satisfy the AC's filename.

### pr-1090

- `packages/lesson-foundry/bin/lesson-foundry.mjs:229` The malformed-ledger gate check runs after --llm refinement and --write emission, so a ledger already destined to fail the gate still triggers paid LLM calls and file writes.
- `packages/lesson-foundry/bin/lesson-foundry.mjs:30` `--help` lists `--tolerate-malformed <value>` with no default while the README/mdx document a default of 0.
- `.adlc/tickets/t-01m3339nsaew4eq61tcahk2tbc--cab6c4e877fd6e53dedfd5a494aa603162418aec30c64b65b339d541fa04bbdd.json:1` Ticket T-01M3339NSAEW4EQ61TCAHK2TBC shipped in #1090 but is not marked `completed: true` at HEAD, so its rails stay frozen for every PR.

### pr-1091

- `packages/backlog-groom/lib/usage.mjs:76` Fifteen inline `Object.assign(new Error(msg), { isOpError: true })` constructions remain in core-dependent packages after OpError was promoted.
- `packages/core/README.md:14` The core README's import surface and cli/tickets sections do not list the newly exported activeTickets, isPlainObject and OpError.
- `packages/core/index.d.ts:17` The new OpError/isPlainObject/activeTickets declarations were added to a .d.ts that no gate compiles (type-declarations.test only checks packages/tickets).

### pr-1092

- `packages/gate-fuzzing/lib/loop.mjs:159` Valid candidates from a round that fails the fail-rate check are counted neither as generated/parsed nor as rejected, and candidatesParsed is always identical to candidatesGenerated.
- `packages/gate-fuzzing/bin/gate-fuzzing.mjs:336` The stderr warning keys on candidatesGenerated===0 while the exit-2 verdict keys on candidatesEvaluated===0, and candidatesEvaluated is not in the JSON report, so an all-provisioning-failed run exits 2 'inconclusive' with no warning and no number explaining why.
- `packages/gate-fuzzing/test/unusable-candidates-inconclusive.test.mjs:3` The AC-named verification file is a bare re-import of empty-candidates.test.mjs, so the package glob runs all 13 tests (including three git-init + CLI spawns) twice.
- `.adlc/tickets/t-01m3339na0ebngf7y1fkyg1g3p--84c98e9b9de17f5ed01b65f146093ec9345fae67eba8dfcd36da006af741f959.json:1` Ticket T-01M3339NA0EBNGF7Y1FKYG1G3P is merged and its issue closed but not marked completed at HEAD, so its rails on witness.mjs and oracle.mjs remain frozen for every other PR.

### pr-1093

- `packages/init/lib/scaffold.mjs:361` Only the must-be-committable side is probed; the issue's recommended must-stay-ignored side (`.adlc/manifest.d/.lineage`, `*.lock`) is not checked by init.
- `packages/init/lib/scaffold.mjs:365` The segment probe path `.adlc/manifest.d/seg-1.jsonl` is not a grammar-valid segment name, so the warning names a file that can never exist.
- `packages/init/lib/scaffold.mjs:369` spawnSync('git check-ignore') is run up to five times per init with no timeout.

### pr-1094

- `packages/consensus-fix/bin/consensus-fix.mjs:40` `writeFileAtomic` (line 40) and `applyHunks` (line 41) are imported by the bin but no longer used after the switch to applyWinner.
- `.adlc/tickets/t-01m3339q78k0avh1w5h6g099c1--781ca7e67df650245c4d6d6a8554b889932572e7a137453f457a20d648b270f5.json:1` Ticket T-01M3339Q78K0AVH1W5H6G099C1 shipped in #1094 but has no `completed` marker at HEAD, so its rails (agreement.mjs, region.mjs) remain frozen for every later PR.

### pr-1095

- `packages/gate-fuzzing/lib/witness.mjs:30` gate-fuzzing's witness runner discards stdout/stderr, so an 'inconclusive: baseline trial N failed (exit X)' verdict carries no output to diagnose the red baseline.
- `packages/hollow-test/lib/runner.mjs:41` formatDiagnosticOutput caps by UTF-16 code units while the constant, JSDoc, and marker all say bytes.

### pr-1096

- `packages/backlog-groom/README.md:7` The now-canonical backlog-groom README states the package writes nothing to GitHub, while the bin implements the --apply write path that the deleted docs/tools mirror documented.
- `scripts/claude-code-plugin-smoke.mjs:666` AC2's verify command still prints one match: a `docs/tools/` exclusion entry survives in the smoke test's reviewed EXCLUDED_DOC_PATHS list after the directory was deleted.
- `packages/gate-manifest/README.md:485` The folded `adlc spend --json` contract omits `unmeasuredCalls`, which aggregateSpend returns and the bin emits, and the new regression test pins the incomplete field list.
- `packages/model-router/README.md:1` The model-router README has no pointer to docs/models-by-phase.md, the tier-to-model binding the deleted mirror linked; only docs/toolkit.md links it now.
- `apps/docs/content/docs/toolkit/gate-manifest.mdx:1` The docs-site mirror for gate-manifest carries none of the folded content (enable/migrate/migrate-branch/adopt, key-rotation migration, `adlc spend`), and no spend page exists there, so the 'two hand-maintained docs' rule the PR itself wrote into the issue-lanes skill is unmet for this fold.

### pr-1102

- `packages/review-calibration/README.md:130` The README's documented CI smoke-test `--review-cmd` example is mis-tokenized by the canonical tokenizer and fails with a node SyntaxError.
- `packages/model-ratchet/README.md:39` `--review-cmd` is documented as a "Shell command" in both consumers although it is tokenized shell-free and spawned with shell:false.
- `packages/core/README.md:37` core's README `## cli` section and import-surface block omit `tokenizeCommand` (and the batch-1 promotions `isPlainObject`, `OpError`, `activeTickets`).
- `packages/lesson-foundry/lib/route.mjs:52` lesson-foundry keeps a local `canonicalJson` although it already imports from @adlc/core, which exports `canonicalJson` at ledger.mjs:255.
- `packages/autopilot/lib/quota.mjs:40` autopilot keeps a local `isPlainObject` although it depends on @adlc/core, which exports `isPlainObject` (batch-1 promotion).

### pr-1111

- `packages/tickets/lib/manifest-primitives.mjs:402` The single-sourcing refactor leaves gate-manifest's verifyEntrySig as a copy of entrySigValid and adds a third hand-rolled chain verifier (isChainIntact) beside verifyChain and chainIsIntact.
- `packages/tickets/lib/manifest-primitives.mjs:496` resolveOpenSegment now silently mints an anchor:null segment when root's last line is malformed JSON, where gate-manifest's prior implementation threw; neither direction is pinned by a test.
- `packages/tickets/lib/manifest-primitives.mjs:160` tickets' discoverSegments/forestChainsIntact now silently skip a symlinked `.lineage` (reserved-name check precedes lstat), where the old tickets copy reported it invalid and failed the forest closed.
- `packages/tickets/lib/evidence.mjs:59` canonicalEntryBytes/v2-signing and currentBranch remain hand-copied in evidence.mjs (same package as the new primitives), ticket-sync reassign.mjs, and gate-manifest migrate-branch.mjs.

### pr-1146

- `scripts/test/tmp-fixture-boundary.test.mjs:177` After asserting ALLOWLIST.size === 0, the remaining 'may only shrink' assertion (and the ALLOWLIST.has filter at line 162) can never fail and is now dead logic.

### pr-983

- `scripts/test/preflight.test.mjs:20` No test pins that every workflow step running `npm test` is preceded by the install-bubblewrap composite action; the dedup prevents content drift between copies but not a missing call site, which is the failure class that stranded v1.11.1.
- `packages/autopilot/README.md:96` README says real-bwrap checks 'skip loudly when the host lacks them', and CONTRIBUTING lists only Node as a prerequisite, but the autopilot loop/sequence tests hard-fail without bwrap.

### pr-984

- `packages/fleet/test/git-mirror.test.mjs:34` The fix-site comment attributes the race to auto-gc 'holding files open' and presents gc.auto=0 and gc.autoDetach=false as a pair, but only gc.autoDetach=false prevents the detached writer; gc.auto=0 alone changes nothing.

### pr-985

- `packages/autopilot/lib/round.mjs:284` pushAndOpen dereferences `record().roundsUsed` after three awaits with no null check; a vanished record is reported as `pr-upsert-failed` with a TypeError message instead of `record-vanished`.
- `docs/specs/issue-autopilot-local.md:1740` Spec §9.1c still enumerates the NET_GIT template as core.* + remote.origin.* and "nothing else", but the template now also writes gc.auto and gc.autoDetach.
- `packages/autopilot/lib/init.mjs:56` The "production" gc fix reaches only NET_GIT repositories written after #985: an existing install keeps the old config and phase A accepts it because it verifies against the stored sha, not the template.

### pr-986

- `plugins/adlc-pi/lib/commands.mjs:163` /adlc-init's `ticket store migrate --write` and `adlc --version` execs in the same file still derive success from `code` alone and do not use execFailureReason.
- `plugins/adlc-pi/prompts/adlc-prosecute.md:21` The model-facing /adlc-prosecute prompt still says adlc_prosecute returns only `CLEAN` or `FINDINGS` and gives no handling for INCONCLUSIVE.

### pr-987

- `packages/core/lib/llm.mjs:120` The configured-judge echo control adds N more LLM calls per run, and the HTTP provider paths in core complete() have no request timeout.
- `packages/review-calibration/README.md:98` README exit-code table omits the control/judge self-test as an exit-1 cause and the JSON example lacks the two new scorecard fields.

### pr-988

- `packages/parallax/bin/parallax.mjs:92` `--n` is parsed with parseInt, so non-integer values like `2.5` or `3abc` are silently accepted despite the new 'must be an integer' message.

### pr-989

- `plugins/adlc-pi/prompts/adlc-maintain.md:38` Three harness maintain guides (pi, cursor, codex) still tell operators that `ticket-prune --write` archives into the gitignored `.adlc/tickets.archive.json`, which HEAD never writes.

### pr-998

- `packages/autopilot/test/helpers/recover-fixture.mjs:40` The CI symptom in #990 (clone ENOENT copying a loose object) is not explained by the fixed condition, the issue's alternative direction (stop clones descending into nested .git dirs) was not taken, and the issue was closed anyway.

### pr-999

- `packages/autopilot/test/sequence-fixture-signal.test.mjs:96` Regression tests are titled with the spec-reserved `AC<n>:` prefix (ticket AC numbers) instead of the repo's `#<issue>:` convention.

### sweep-ci-gates

- `.claude/skills/issue-lanes/SKILL.md:421` The issue-lanes skill still tells agents that only test (18/20/22) are REQUIRED and that gate, rails-guard and mutation-gate "do not gate the merge button", but the live ruleset now requires all six contexts.
- `docs/github-rulesets/main-branch-ruleset.json:16` The committed main-branch ruleset that RELEASING.md tells the maintainer to re-apply via apply.sh lacks `require_extra_approval_for_unattributed_changes: true`, which the live ruleset has, so a release-time apply would silently drop that setting; the in-range AC13 test only compares status-check contexts.
- `scripts/test/gate-liveness.test.mjs:673` The bijectivity test does not require job ids to be unique across PR-triggered workflows, and declaredContexts dedups only blocking contexts, so a second PR workflow with a non-blocking job named `gate`, `rails-guard` or `mutation-gate` passes the declaration and would emit a same-named check run that the ruleset (which matches on context name + integration_id only) cannot distinguish.
- `AGENTS.md:130` Every pull_request(_target) workflow is filtered to branches:[main] (verified), which means a PR whose base is another feature branch runs zero checks, but AGENTS.md's "Stacking a PR" section documents only the squash-merge hazard and nowhere in AGENTS.md/CONTRIBUTING.md/docs is the no-CI consequence recorded.

### sweep-plugin-hand-ports

- `apps/docs/scripts/check-links.mjs:50` check-links' usage branch is behind a hand-built file:// comparison, so a no-argument run from a space path exits 0 silently instead of printing usage and exiting 1.
- `plugins/adlc-codex/hooks/adlc-lifecycle.mjs:98` adlc-codex lifecycle hook spawns `adlc gate-manifest verify` and its git scan with no timeout; only the hooks.json per-hook timeout bounds it.
- `plugins/adlc-copilot/hooks/adlc-lifecycle.mjs:96` adlc-copilot lifecycle hook and build-gate bypass recorder spawn children with no timeout; bounded only by hooks.json timeoutSec.
- `plugins/adlc-cursor/hooks/adlc-stop.mjs:26` adlc-cursor stop and preflight hooks spawn git/adlc with no timeout; only Cursor's hooks.json `timeout: 10` bounds them, and cursor's tests are outside the spawn-timeout drift guard.
- `plugins/adlc-opencode/lib/handoff-gate.mjs:2` The opencode handoff-gate header still states 'OpenCode is an ENFORCING tier' although the gate defaults off behind ADLC_CONTEXT_ROT_HANDOFF_ENABLED — the unannotated twin of the codex header #1034 corrected.
- `plugins/adlc-pi/lib/handoff-gate.mjs:2` The pi handoff-gate header still states 'pi is an ENFORCING tier' while the gate is opt-in (off by default since 1.11.1), per the plugin's own README and docs.

### sweep-public-surface

- `CHANGELOG.md:12` `## [Unreleased]` is empty and the release-time generator will silently drop at least two user-visible changes in the range (#1071 typed `bugfix`, #1096 typed `docs`).
- `packages/ticket-prune/README.md:116` ticket-prune's README documents `--archive <path>` but the bin's parseArgs option table has no such option, so passing it crashes with ERR_PARSE_ARGS_UNKNOWN_OPTION (pre-existing, not introduced in this range).
- `packages/gate-manifest/lib/key-ceremony.mjs:286` JSDoc still points readers at `@adlc/tickets's generation-descriptor.mjs (readAdoptionRecord)`, a module and subpath #1085 deleted.
- `scripts/claude-code-plugin-smoke.mjs:666` Two live files still reference paths deleted by #1096/#1065: the smoke script's EXCLUDED_DOC_PATHS keeps a `docs/tools/` entry, and docs/specs/router-consolidation.md's verification commands invoke the deleted scripts/router/check-consolidation.mjs.
- `CONVENTIONS.md:34` CONVENTIONS hard rule 1 and packages/core/README.md still instruct importing core via the relative path `../../core/index.mjs`, while production code imports `@adlc/core` by name (113 files vs 9 test files) — the very style whose missing dependency declaration bit quartermaster.

### sweep-security

- `plugins/adlc-gemini/build-gate-inline.mjs:740` The Gemini build-gate ledger and baseline HMAC checks compare MACs with `!==`/`===` instead of timingSafeEqual, unlike every other verifier in the repo.
- `packages/parallax/lib/prompts.mjs:103` Ticket titles (parallax edge prompt, fleet builder prompt) and the reviewer-supplied finding.file (review-calibration judge) are interpolated outside the fence that their bodies get.
- `packages/rejection-mining/lib/gh.mjs:14` Several gh/git/reviewer spawns still run without a timeout or with Node's default 1 MiB maxBuffer.

### sweep-test-integrity

- `packages/gate-manifest/lib/key-ceremony.mjs:286` A doc comment still points readers at `@adlc/tickets`'s generation-descriptor.mjs (readAdoptionRecord), a module and subpath export PR #1085 deleted.

### sweep-testkit-module

- `packages/core/lib/test-kit.mjs:41` tmp()/gitRepo() silently skip cleanup when the context has no .after — which is exactly what node:test passes to describe() callbacks and before() hooks — so `before((t) => { dir = tmp(t) })` compiles, passes, and leaks on every run with no signal.
- `packages/core/lib/test-kit.mjs:17` GIT_SCRUBBED_ENV strips only six redirection variables; the repo's existing packages/autopilot/lib/git-env.mjs also strips GIT_CONFIG_* (incl. GIT_CONFIG_COUNT/KEY/VALUE tables), GIT_TEMPLATE_DIR, GIT_CEILING_DIRECTORIES, GIT_NAMESPACE, GIT_ALTERNATE_OBJECT_DIRECTORIES and pins GIT_CONFIG_GLOBAL/SYSTEM to /dev/null, so gitRepo() repos still inherit the developer's global config and env-injected config.
- `packages/core/lib/test-kit.mjs:43` The t.after cleanup calls rmSync without maxRetries, so an ENOTEMPTY/EBUSY/EPERM from a still-exiting child (detached `git gc --auto`, Windows handle latency) throws inside the after hook and fails an otherwise-green test; the repo's own recover-fixture helper already uses maxRetries: 10.

### sweep-ticket-store

- `.adlc/tickets/t-01kzrqf2fph8c136xnh2xqcf9k--a74ec9c2749c37b38957034cc372fca5c7c71b3778152acab9bd3014db2b623c.json:8` Pre-existing ticket T-01KZRQF2FPH8C136XNH2XQCF9K had its body, rails, scope, title and edges rewritten in the range (direct push 43fb890d), the one class of ticket-store change the CI freeze exists to forbid; T-01M2DND1F5N336Q3GKXGSXKWFP was likewise amended twice while active.
- `.github/workflows/ci.yml:1` PR #983 edited the immutable trust root .github/workflows/ci.yml with no P0 ticket and merged with rails-guard FAILURE; three further PRs in range (#1014, #1076, #1119) also merged over a red rails-guard.
- `.adlc/tickets/t-01m3339p8nxx889wkj2mx8k068--c92e5bf941b981fe8e328c75da95e610ad01d4b7ff391f2124523a718ade4037.json:7` The seven open T-01M3339* tickets' normative bodies and scope require hand-editing docs/tools/<package>.md mirrors that the docs-tools-collapse (T-01M34DSQYMGM1CRRZAK7EPYGAQ, 8979b2b8) deleted, and two of them describe lib files that do not exist.

### testkit-1

- `packages/tickets/test/bypass-audit.test.mjs:967` The chmod-restore t.after hook is registered after tmp()'s rmSync hook; Node runs after-hooks FIFO and stops at the first throw, so on the failure path rmSync hits EACCES on the 0o000 `.adlc`, the restore never runs, and a read-only fixture leaks while the original assertion error is joined by an EACCES.
- `packages/gate-manifest/test/adopt.test.mjs:35` 257 suite files under packages/ plugins/ scripts/ still hand-roll mkdtempSync fixtures at HEAD, including 39 in this cluster's own packages (gate-manifest 6, tickets 20, adlc-opencode 12, core 6) and 3 files that import the kit but still call mkdtempSync directly.

### testkit-10

- `packages/autopilot/test/loop.test.mjs:186` Same defect class from the earlier autopilot lane: ac136 in loop.test.mjs mints tmp(t, 'ap-dryrun-ssh-') and leaks one dir per AC-gate run when called without a context.
- `scripts/test/tmp-fixture-boundary.test.mjs:21` The allowlist header states 'every fixture leak in the repository has been eradicated' while the measured full test run still leaks 13 fixture dirs.

### testkit-11

- `packages/fleet/test/extensions.test.mjs:551` The wire-proxy test now removes the fixture directory (containing the live proxy.sock) before closing the proxy, reversing the pre-refactor teardown order.
- `packages/fleet/test/git-mirror.test.mjs:66` 11 other packages/fleet test files (258 suite files repo-wide) still use mkdtempSync + try/finally fixtures and no open ticket or issue schedules their conversion.
- `packages/fleet/test/model-plane-sandbox.test.mjs:26` rmSync is still imported but no longer called in model-plane-sandbox.test.mjs and synthetic-home-bwrap.test.mjs after the finally blocks were removed.

### testkit-2

- `packages/prosecute/test/prosecute-tier-check-cli.test.mjs:54` scratchRepo's retained t-less overload (`scratchRepo({...})`) now mints a git repo with no cleanup at all, because the file's `fixtures` registry and `after()` drain were deleted in the same PR.
- `packages/prosecute/test/helpers.mjs:26` helpers.mjs keeps an uncalled `fixture()` and unused `mkdtempSync`/`tmpdir`/`execFileSync` imports after both of its consumers were re-pointed at test-kit; cross-model.test.mjs likewise keeps a zero-caller `fixture(prefix, t)`.
- `packages/gate-manifest/test/adopt.test.mjs:1` 257 suite files across packages/ plugins/ scripts/ still mint fixtures with mkdtempSync and 220 of them still use hand-rolled try/finally + rmSync cleanup, including 44 in the four packages this cluster converted (5 gate-manifest, 18 tickets, 16 prosecute, 5 core).

### testkit-3

- `plugins/adlc-claude-code/hooks/test/rails.test.mjs:52` runRails keeps a `keepDir` option no caller passes; if set it mints via tmp(null, ...) with no cleanup and the dir is still not returned, so it can only leak.
- `packages/merge-forecast/test/forecast.test.mjs:785` The 'mechanical' refactor also changed the dependency-cycle test's committed file from src/a/index.js to src/a.js without disclosure; assertions are unaffected.
- `packages/merge-forecast/test/high-risk-concurrent.test.mjs:10` `gitRepo` is imported from @adlc/core/test-kit but never used; the file still uses its local gitInit helper.

### testkit-4

- `packages/coldstart/test/coldstart-offline.test.mjs:210` Four `it()` callbacks were given a `(t)` parameter they never use, and the file header still says fixtures live 'in mkdtemp'.

### testkit-5

- `packages/runner/test/p0-p1-gates.test.mjs:25` Eleven other test files in the same four packages still hand-roll mkdtempSync fixtures (try/finally or a module-level after() registry) instead of the kit; none leaks.

### testkit-6

- `packages/tickets/test/pointer.test.mjs:49` fixture() gained a string-overload for its `build` argument that no caller uses and that the ticket did not ask for.

### testkit-7

- `plugins/adlc-gemini/test/decide.test.mjs:146` The process.chdir restore is now registered AFTER tmp()'s rmSync hook, so cleanup deletes the current working directory before restoring cwd (reversed from the pre-PR finally order).
- `packages/gate-fuzzing/test/isolation.test.mjs:35` Switching makeSourceRepo to gitRepo() dropped the `-c core.hooksPath=/dev/null` isolation the original fixture applied to every git call.
- `plugins/adlc-gemini/test/decide.test.mjs:15` adlcRepo/projectionRepo keep a compat branch that, when handed the pre-PR call shape, silently allocates a fixture with NO cleanup — and the tmp-fixture guard cannot see it because the file no longer contains mkdtempSync.
- `packages/autopilot/test/init.test.mjs:53` The three new 'standalone execution ... cleans up temporary directories' tests are titled with spec criterion prefixes (AC9:/AC22:/AC73:) although they exercise the test-kit fallback, not those criteria.
- `packages/hollow-test/test/hollow-test.test.mjs:18` `gitRepo` is imported but never used; the file still builds scratch repos with its own initRepo helper despite the ticket/PR body saying repos are allocated via gitRepo(t).

### testkit-8

- `plugins/adlc-cursor/test/mcp-wrapper.test.mjs:234` Two cursor tests now remove the fixture that is the current working directory before the `chdir(prev)` after-hook runs, inverting the previous finally order.

### testkit-9

- `plugins/adlc-pi/test/evidence-custom-tools.test.mjs:102` The chmod-restore t.after hook is registered AFTER tmp(t)'s rmSync hook, so on the failure path rmSync runs against the still-read-only .adlc and the fixture leaks, the opposite of what the comment claims.
- `plugins/adlc-pi/test/prosecutor.test.mjs:54` 26 suite files in the two packages this cluster targets still mint fixtures with raw mkdtempSync (3 in plugins/adlc-pi/test, 23 in packages/context-handoff), although PR #1137's title claims adoption 'across all remaining context-handoff tests'.
