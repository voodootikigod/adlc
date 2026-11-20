# ADLC v1.13.0 Wave 1A (Foundational Security & Containment) Executable Specification

- **Master Roadmap:** [`.adlc/specs/enhancement-resolution-plan.md`](./enhancement-resolution-plan.md) (`Wave 1A` foundational 6-ticket slice: `T-P01`, `T-P02`, `T-P05`, `T-P08`, `T-P09`, `T-P03`; Wave 1B `T-P06`, `T-P07`, `T-P10`, `T-P04`, `T-P11a`, `T-P11b`, `T-P12` follows immediately on top)
- **Target Gate Suite:** `npm run preflight` (`npm test` + `rail-freeze` + `mutation-gate` + ledger & comment checks)

## 1. Frozen Rails & Single Cross-Ticket Edge Contract

1. **Untouchable Paths:** No ticket may edit `.adlc/tickets/**`, `.adlc/config.json`, `CODEOWNERS`, `.github/workflows/ci.yml`, `.github/workflows/adlc-rails-guard.yml`, `scripts/rails-guard-ci.mjs`, `packages/rails-guard/**`, `scripts/preflight.mjs`, `package.json`, `.npmrc`, `packages/fleet/lib/sandbox.mjs`, `packages/fleet/lib/env-scrub.mjs`, `packages/gate-manifest/lib/record.mjs`, `packages/core/lib/inflight.mjs`, or any existing frozen test rail (`packages/core/test/syntax.test.mjs`, `packages/core/test/reason-list.test.mjs`, `packages/core/test/prosecutor-record-finding.test.mjs`, `packages/core/test/core.test.mjs`, `packages/hollow-test/test/inflight.test.mjs`, `packages/review-calibration/test/invalid-plants.test.mjs`, `packages/autopilot/test/spec-coverage.test.mjs`, `packages/gate-manifest/test/reason-lines.test.mjs`, `packages/cli/test/mcp-server-cli-bin.test.mjs`).
2. **Exact Verbatim Edge Contract (`T-P01 -> T-P03`, the ONLY edge in this 6-ticket DAG):**
   - Ticket `T-P01` merges before Ticket `T-P03` starts. Shared files modified by both tickets in sequence: `plugins/adlc-cursor/lib/mcp-build-metadata.mjs` and `plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs`, regenerated deterministically by running `node scripts/build-cursor-mcp.mjs` (zero CLI arguments, exit 0). Pre-existing `@adlc/core` (`packages/core/index.mjs`) exports left untouched by `T-P01` that `T-P03` imports: `resolveTarget(repoRoot: string, relFile: unknown): string | null` (`packages/core/lib/inflight.mjs`), `escapeSeatbeltPath(p: string): string` (`packages/core/lib/primitives.mjs`), `checkSyntax(filePath: string, cwd?: string): 'valid' | 'invalid' | 'unknown'`, `syntaxLanguage(filePath: string): string | null`, `tail(str: string, maxChars: number): string`, and `tokenizeCommand(cmd: string): string[]`. Functions modified inside `T-P01` (`changedFiles(base = 'HEAD', cwd = process.cwd()): string[]` in `packages/core/lib/git.mjs`; `shellHasOpaqueMutation(cmd: string): boolean`, `shellHasWriteOption(cmd: string): boolean`, and `shellIsPositivelyReadOnly(cmd: string): boolean` in `packages/core/lib/shell.mjs`; `untrackedNonIgnoredPaths({ cwd = process.cwd(), ignorePaths = [] } = {}): string[]` in `packages/core/lib/revision.mjs`) preserve their exact parameter lists and return types and are not called by `T-P03`.

---

## 2. Ticket DAG (`6` Tickets)

### `T-P01` — Rename-Proof `changedFiles`, Hardened Shell Classifier & Leaf-Only `ignorePaths` in `@adlc/core`
- **Tier:** `mid`
- **Pool Hint:** `auto`
- **Depends On:** `[]`
- **Edges Out:** `["T-P03"]`
- **Scope:**
  - `packages/core/lib/git.mjs`
  - `packages/core/lib/shell.mjs`
  - `packages/core/lib/revision.mjs`
  - `packages/core/test/git-no-renames.test.mjs`
  - `packages/core/test/shell-classifiers.test.mjs`
  - `packages/core/test/ignore-paths-leaf.test.mjs`
  - `plugins/adlc-codex/hooks/generated-shell.mjs`
  - `plugins/adlc-copilot/hooks/generated-shell.mjs`
  - `plugins/adlc-cursor/lib/mcp-build-metadata.mjs`
  - `plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs`
- **Rails (Read-Only):**
  - `packages/core/test/syntax.test.mjs`
  - `packages/core/test/reason-list.test.mjs`
  - `packages/core/test/prosecutor-record-finding.test.mjs`
- **Body & Acceptance Criteria:**
  - **Inter-Ticket Contract (`T-P01 -> T-P03`):** Ticket `T-P01` merges before Ticket `T-P03` starts. Shared files modified by both tickets in sequence: `plugins/adlc-cursor/lib/mcp-build-metadata.mjs` and `plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs`, regenerated deterministically by running `node scripts/build-cursor-mcp.mjs` (zero CLI arguments, exit 0). Pre-existing `@adlc/core` (`packages/core/index.mjs`) exports left untouched by `T-P01` that `T-P03` imports: `resolveTarget(repoRoot: string, relFile: unknown): string | null` (`packages/core/lib/inflight.mjs`), `escapeSeatbeltPath(p: string): string` (`packages/core/lib/primitives.mjs`), `checkSyntax(filePath: string, cwd?: string): 'valid' | 'invalid' | 'unknown'`, `syntaxLanguage(filePath: string): string | null`, `tail(str: string, maxChars: number): string`, and `tokenizeCommand(cmd: string): string[]`. Functions modified inside `T-P01` (`changedFiles(base = 'HEAD', cwd = process.cwd()): string[]` in `packages/core/lib/git.mjs`; `shellHasOpaqueMutation(cmd: string): boolean`, `shellHasWriteOption(cmd: string): boolean`, and `shellIsPositivelyReadOnly(cmd: string): boolean` in `packages/core/lib/shell.mjs`; `untrackedNonIgnoredPaths({ cwd = process.cwd(), ignorePaths = [] } = {}): string[]` in `packages/core/lib/revision.mjs`) preserve their exact parameter lists and return types and are not called by `T-P03`.
  1. In `packages/core/lib/git.mjs:134,147-150` (`export function changedFiles(base = 'HEAD', cwd = process.cwd())`, where `const raw = (args) => git(args, { cwd, encoding: 'buffer' })`), pass `'--no-renames'` in both `raw` calls: `raw(['diff', '--name-only', '--no-renames', '-z', base, '--'])` and `raw(['diff', '--cached', '--name-only', '--no-renames', '-z', base, '--'])`.
  2. In `packages/core/lib/shell.mjs`:
     - In `shellHasOpaqueMutation(cmd)` (`lines 127-132`), keep all existing patterns and also return `true` when `cmd` matches subshell/eval/source wrappers (`\b(?:sh|bash|dash|zsh|ksh)\b[^;&|]*\s-[a-zA-Z]*c\b`, `(?:^|[;&|()\s])(?:eval|exec|source)\s+\S+`, or POSIX dot-source `(?:^|[;&|()\s])\.\s+\S+` requiring whitespace after `.` so `./script.sh` and `../bin/x` return `false`) or inline code interpreters (`\bnode\b[^;&|]*\s(?:-[ep]|--eval|--print|-r|--require|--import|--loader)(?:=|\s|$)`, `\bpython3?\b[^;&|]*\s-c\b`, `\bruby\b[^;&|]*\s-e\b`, `\bperl\b[^;&|]*\s-[a-zA-Z]*[ei]\b`, `\b[gm]?awk\b`, `\blua\b[^;&|]*\s-e\b`, `\bphp\b[^;&|]*\s-r\b`, `\bdeno\s+eval\b`, `\bbun\b[^;&|]*\s-e\b`).
     - In `shellHasWriteOption(cmd)` (`lines 222-231`), add `--pre` and `--pre-glob` to the write-flag alternation (`--output|-o|--out-file|--save|--write|--in-place|--pre|--pre-glob`).
     - In `shellIsPositivelyReadOnly(cmd)` (`lines 205-219`): (a) return `false` if any command segment has a leading `GIT_EXTERNAL_DIFF=` assignment (`/(?:^|[;&|()\s])GIT_EXTERNAL_DIFF=/`); (b) remove `node --test` from the positively read-only allowlist; and (c) replace the `git branch` rule with `isReadOnlyGitBranch(segment)` returning `true` for bare `git branch` (zero args) or when zero mutating flags (`-d`, `-D`, `--delete`, `-m`, `-M`, `--move`, `-c`, `-C`, `--copy`, `-f`, `--force`, `-u`, `--set-upstream-to`, `--unset-upstream`, `--edit-description`, or `--set-upstream-to=*`) appear AND either every token after `git branch` is in `['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--color', '--no-color']` OR at least one of `['-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged']` is present (so `git branch new-name` with a bare positional branch name returns `false`).
  3. In `packages/core/lib/revision.mjs:141-152`, define `const DIRECTORY_IGNORE_PATHS = new Set(['.adlc/tickets', '.adlc/ticket-archive', '.adlc/manifest.d'])`; in `ignoredPathSet(cwd, paths)` (`lines 141-147`), map each `rawPath` in `[...DEFAULT_IGNORED_PATHS, ...paths]` via `const norm = normalizeRelativePath(cwd, rawPath); if (!norm) return null; const hasTrailingSlash = String(rawPath).replaceAll('\\', '/').endsWith('/'); const isKnownDir = DIRECTORY_IGNORE_PATHS.has(norm) || norm.endsWith('/manifest.d'); return (hasTrailingSlash || isKnownDir) ? \`\${norm}/\` : norm;`; and in `isIgnoredPath(relativePath, ignoredPaths)` (`lines 149-152`), return `[...ignoredPaths].some((ig) => ig.endsWith('/') ? (normalized === ig.slice(0, -1) || normalized.startsWith(ig)) : normalized === ig)` so caller-supplied leaf paths in `ignorePaths` match ONLY exact files unless suffixed with `'/'`.
  4. Run `node scripts/ticket-readers/generate.mjs` (updating `plugins/adlc-codex/hooks/generated-shell.mjs` and `plugins/adlc-copilot/hooks/generated-shell.mjs`) and `node scripts/build-cursor-mcp.mjs`.
  5. Create the three new test files with these exact test cases:
     - `packages/core/test/git-no-renames.test.mjs`: `test('changedFiles reports both old and new paths under git mv when diff.renames=true')` and `test('changedFiles reports unstaged rename/delete+add paths with diff.renames=true')`.
     - `packages/core/test/shell-classifiers.test.mjs`: `test('shellHasOpaqueMutation flags subshells, dot-source, and inline interpreters while allowing ./script.sh')`, `test('shellHasWriteOption flags ripgrep --pre and --pre-glob')`, and `test('shellIsPositivelyReadOnly rejects node --test, GIT_EXTERNAL_DIFF, and mutating/creating git branch forms while allowing read-only listing forms')`.
     - `packages/core/test/ignore-paths-leaf.test.mjs`: `test('untrackedNonIgnoredPaths treats unsuffixed ignorePaths as exact leaf matches while preserving trailing-slash directory ignores and DEFAULT_IGNORED_PATHS')`.
  6. Verify: `node --test packages/core/test/git-no-renames.test.mjs packages/core/test/shell-classifiers.test.mjs packages/core/test/ignore-paths-leaf.test.mjs packages/core/test/syntax.test.mjs packages/core/test/reason-list.test.mjs scripts/test/ticket-reader-generation.test.mjs scripts/test/ticket-store-boundary.test.mjs`

### `T-P02` — Fleet Bare-Mirror Containment, `SafeSandbox` Bounded Mounts & Self-Commit Support
- **Tier:** `mid`
- **Pool Hint:** `auto`
- **Depends On:** `[]`
- **Edges Out:** `[]`
- **Scope:**
  - `packages/fleet/lib/git-mirror.mjs`
  - `packages/fleet/lib/live-deps.mjs`
  - `packages/fleet/lib/safe-sandbox.mjs`
  - `packages/fleet/lib/worktrees.mjs`
  - `packages/autopilot/lib/gate-repo.mjs`
  - `packages/fleet/test/mirror-symlink-escape.test.mjs`
  - `packages/fleet/test/bounded-read-mounts.test.mjs`
  - `packages/fleet/test/worker-self-commit.test.mjs`
  - `packages/autopilot/test/gate-repo-symlink.test.mjs`
- **Rails (Read-Only):**
  - `packages/fleet/lib/sandbox.mjs`
  - `packages/fleet/lib/env-scrub.mjs`
  - `packages/autopilot/test/spec-coverage.test.mjs`
- **Body & Acceptance Criteria:**
  1. In `packages/fleet/lib/git-mirror.mjs`, export `assertGitDirTreeSafe(mirrorPath)`: recursively walk `mirrorPath` with `lstatSync` (without following symlinks) and throw `new Error('Unsafe git mirror entry: ' + relPath)` (forward-slash `relPath` relative to `mirrorPath`) if any entry satisfies `st.isSymbolicLink()`, `!st.isFile() && !st.isDirectory()`, `st.isFile() && st.nlink > 1`, or `relPath` is `'objects/info/alternates'`, `'info/grafts'`, or `'shallow'`; invoke `assertGitDirTreeSafe(mirror)` inside `assertMirrorConfigPristine({ mirror, gitAt = defaultGit } = {})` (`git-mirror.mjs:95`, preserving its existing options-bag signature) immediately after `requireArgs(...)`. Remove `'core.logallrefupdates'` from `MIRROR_CONFIG_ALLOWED_KEYS` (`git-mirror.mjs:82`), add `'-c', 'core.logallrefupdates=false'` to `HOST_SAFE_GIT_FLAGS` (`git-mirror.mjs:88`) and `HOST_SAFE_GIT` (`packages/autopilot/lib/gate-repo.mjs:62`), change `gate-repo.mjs:97` so `snapshotGateRepo` checks `existsSync(exclude)` and throws `new GateRepoError('exclude-symlink', exclude)` if `!lstatSync(exclude).isFile()` before reading `exclude` (preserving all `registerSeams(...)` calls), and pass `e.message` (`live-deps.mjs:654-655`) and `fb.detail ?? fb.reason` (`live-deps.mjs:644-645`) through `redactSecrets` (`@adlc/core`).
  2. In `packages/fleet/lib/safe-sandbox.mjs:59-83` (`SafeSandbox.wrap(innerArgv)`), when `this.backend?.name === 'bubblewrap'` and `this.readPolicy === READ_POLICY.BOUNDED`, define `const writeRoots = [this.worktree, this.syntheticHome, ...(this.writablePaths ?? [])].filter(Boolean)`, `const writeBinds = writeRoots.flatMap((rw) => ['--bind', rw, rw])`, and `const roBinds = (this.readOnlyPaths ?? []).flatMap((ro) => ['--ro-bind', ro, ro])`, and return `['bwrap', ...(this.network === NETWORK.DENY ? ['--unshare-net'] : []), '--die-with-parent', '--chdir', this.worktree, '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', ...writeBinds, ...roBinds, '--setenv', 'HOME', this.syntheticHome ?? this.worktree, '--', ...innerArgv]` (leaving frozen `packages/fleet/lib/sandbox.mjs` untouched). In `packages/fleet/lib/live-deps.mjs`, export standalone helper `export function defaultBoundedReadOnlyPaths({ exists = existsSync, execPath = process.execPath, extra = [] } = {})` returning deduplicated paths from `['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', dirname(dirname(execPath)), ...extra].filter((p) => Boolean(p) && exists(p))`, and pass `readOnlyPaths: defaultBoundedReadOnlyPaths({ extra: config.repoCommandReadOnlyPaths ?? [] })` into `new SafeSandbox({ ... })` inside `sandboxFor` (`live-deps.mjs:330`).
  3. Preserve existing signatures and return types in `packages/fleet/lib/worktrees.mjs:172-186`:
     - `export function resetWorktree(worktreePath, git = defaultGit(worktreePath), cutTip = null)`: if `typeof cutTip === 'string' && cutTip.length > 0`, run `git('reset', '--hard', cutTip)` before `git('checkout', '--', '.')` and `git('clean', '-fd')`.
     - `export function commitWorker(worktreePath, ticketId, git = defaultGit(worktreePath), { cutTip = null } = {})`: run `git('add', '-A', '--', ':!.claude', ':!.adlc')`; check `git('status', '--porcelain', '--', ':!.claude', ':!.adlc').trim()`; if non-empty, run `git('commit', '-q', '-m', \`fleet(\${ticketId}): worker output\`)` and return `git('rev-parse', 'HEAD').trim()`; if empty AND `typeof cutTip === 'string' && cutTip.length > 0` AND `Number(git('rev-list', '--count', \`\${cutTip}..HEAD\`).trim()) > 0`, return `git('rev-parse', 'HEAD').trim()`; otherwise throw `new Error('nothing to commit')`.
     - In `packages/fleet/lib/live-deps.mjs`: in `createWorktree` (`line 455`), record `cutTips.set(ticket.id, mirrorMode ? wt.cutTip : io.git(wt.path)(...HOST_SAFE_GIT_FLAGS, 'rev-parse', 'HEAD').trim())` for both mirror and non-mirror modes; in `dispatch` before Strike `>= 2` (`strike >= 2 && existsSync(worktree)`, before copying `workerDeps`), run `assertWorktreeLink({ path: worktree, gitDirRoot: mirrorMode ? config.modelPlaneGitMirror : gitCommonDir(repo, io.git) })`, run `if (mirrorMode) assertMirrorConfigPristine({ mirror: config.modelPlaneGitMirror, gitAt: io.git })`, and call `worktrees.resetWorktree(worktree, (...args) => io.git(worktree)(...HOST_SAFE_GIT_FLAGS, ...args), cutTips.get(ticket.id) ?? null)`; and at `live-deps.mjs:637`, call `worktrees.commitWorker(worktree, ticket.id, (...args) => hostGit(...HOST_SAFE_GIT_FLAGS, ...args), { cutTip: cutTips.get(ticket.id) ?? null })`.
  4. Create the four new test files with these exact test cases:
     - `packages/fleet/test/mirror-symlink-escape.test.mjs`: `test('assertGitDirTreeSafe rejects symlinks, hardlinks, FIFOs, objects/info/alternates, shallow, and core.logallrefupdates')`.
     - `packages/fleet/test/bounded-read-mounts.test.mjs`: `test('SafeSandbox.wrap mounts /dev, /proc, /tmp and readOnlyPaths on Linux bubblewrap BOUNDED policy')` and `test('defaultBoundedReadOnlyPaths populates existing runtime roots and extra paths')`.
     - `packages/fleet/test/worker-self-commit.test.mjs`: `test('commitWorker returns HEAD sha when worker already committed ahead of cutTip and throws when at cutTip with clean tree')` and `test('resetWorktree resets HEAD to cutTip between strikes')`.
     - `packages/autopilot/test/gate-repo-symlink.test.mjs`: `test('HOST_SAFE_GIT disables core.logallrefupdates and snapshotGateRepo rejects symlinked .git/info/exclude')`.
  5. Verify: `node --test packages/fleet/test packages/autopilot/test/gate-repo-symlink.test.mjs && AUTOPILOT_GATE_FULL=1 node --test packages/autopilot/test/spec-coverage.test.mjs`

### `T-P03` — Shared `@adlc/core` Sandboxed Witness Runner & `review-calibration` Containment
- **Tier:** `frontier`
- **Pool Hint:** `auto`
- **Depends On:** `["T-P01"]`
- **Edges Out:** `[]`
- **Scope:**
  - `packages/core/lib/sandbox-runner.mjs`
  - `packages/core/index.mjs`
  - `packages/core/index.d.ts`
  - `packages/gate-fuzzing/lib/sandbox.mjs`
  - `packages/gate-fuzzing/lib/sandbox-masks.mjs`
  - `packages/review-calibration/lib/verify.mjs`
  - `packages/review-calibration/lib/targets.mjs`
  - `packages/review-calibration/lib/runner.mjs`
  - `packages/review-calibration/lib/inflight.mjs`
  - `packages/review-calibration/test/sandbox-containment.test.mjs`
  - `plugins/adlc-cursor/lib/mcp-build-metadata.mjs`
  - `plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs`
- **Rails (Read-Only):**
  - `packages/review-calibration/test/invalid-plants.test.mjs`
  - `packages/hollow-test/test/inflight.test.mjs`
  - `packages/core/test/core.test.mjs`
- **Body & Acceptance Criteria:**
  - **Inter-Ticket Contract (`T-P01 -> T-P03`):** Ticket `T-P01` merges before Ticket `T-P03` starts. Shared files modified by both tickets in sequence: `plugins/adlc-cursor/lib/mcp-build-metadata.mjs` and `plugins/adlc-cursor/bin/adlc-mcp-wrapper.bundle.mjs`, regenerated deterministically by running `node scripts/build-cursor-mcp.mjs` (zero CLI arguments, exit 0). Pre-existing `@adlc/core` (`packages/core/index.mjs`) exports left untouched by `T-P01` that `T-P03` imports: `resolveTarget(repoRoot: string, relFile: unknown): string | null` (`packages/core/lib/inflight.mjs`), `escapeSeatbeltPath(p: string): string` (`packages/core/lib/primitives.mjs`), `checkSyntax(filePath: string, cwd?: string): 'valid' | 'invalid' | 'unknown'`, `syntaxLanguage(filePath: string): string | null`, `tail(str: string, maxChars: number): string`, and `tokenizeCommand(cmd: string): string[]`. Functions modified inside `T-P01` (`changedFiles(base = 'HEAD', cwd = process.cwd()): string[]` in `packages/core/lib/git.mjs`; `shellHasOpaqueMutation(cmd: string): boolean`, `shellHasWriteOption(cmd: string): boolean`, and `shellIsPositivelyReadOnly(cmd: string): boolean` in `packages/core/lib/shell.mjs`; `untrackedNonIgnoredPaths({ cwd = process.cwd(), ignorePaths = [] } = {}): string[]` in `packages/core/lib/revision.mjs`) preserve their exact parameter lists and return types and are not called by `T-P03`.
  1. Promote the synchronous `spawnSync`-based sandbox + masking primitives from `packages/gate-fuzzing/lib/sandbox-masks.mjs` and `packages/gate-fuzzing/lib/sandbox.mjs` into `packages/core/lib/sandbox-runner.mjs` and re-export them from `packages/core/index.mjs` + `packages/core/index.d.ts` (and re-export from `packages/gate-fuzzing/lib/sandbox-masks.mjs` and `packages/gate-fuzzing/lib/sandbox.mjs` so all existing `gate-fuzzing` callers and tests keep identical signatures):
     - `sanitizeCandidateEnv(baseEnv = process.env): Record<string, string>` — strips all existing `CANDIDATE_SECRET_PATTERNS` (`^ADLC_`, `API_KEY$`, `_KEY$`, `_SECRET$`, `_TOKEN$`, `PASSWORD`, `^AWS_`, `^GOOGLE_`, `^GCP_`, `^AZURE_`, `^GH_`, `^GITHUB_TOKEN$`, `CREDENTIAL`, `^NPM_TOKEN$`) PLUS `/^NODE_OPTIONS$/i` and `/^GIT_SSH_COMMAND$/i`.
     - `detectSandbox(opts?: { which?: (cmd: string) => string | null }): 'bwrap' | 'sandbox-exec' | null`
     - `buildSandboxedArgs(sandboxType: 'bwrap' | 'sandbox-exec', cloneDir: string, cmdArgs: string[], opts?: object): string[]`
     - `spawnSandboxed(sandboxType: string, cloneDir: string, cmdArgs: string[], spawnOpts?: object): { exitCode: number, stdout: string, stderr: string, timedOut: boolean }`
     - `spawnCandidateCmd(cmdArgs: string[], cloneDir: string, opts?: object): { exitCode: number, stdout: string, stderr: string, timedOut: boolean }`
  2. In `packages/review-calibration/lib/verify.mjs:35-41` (`defaultRun(cmd, args, cwd)`) and `packages/review-calibration/lib/runner.mjs:73-93` (`runWithPlants`), scrub the child environment with `sanitizeCandidateEnv(process.env)` and, when `detectSandbox()` is non-null (unless `process.env.ADLC_UNSAFE_NO_SANDBOX === '1'`), execute `[cmd, ...args]` / `argv` via `spawnSandboxed(sandboxType, cwd, ...)` with `timeout: 60_000` (in `verify.mjs`) / `timeout: timeoutMs` (in `runner.mjs`), preserving synchronous execution and existing `{ status, timedOut, output, spawnError }` / `{ stdout, stderr, exitCode, timedOut }` return shapes. Also enforce in `loadPlantsFile` (`packages/review-calibration/lib/targets.mjs:158-160`) that `p.witness.cmd` (when provided) has `basename(p.witness.cmd)` in `['node', 'npm', 'npx']` and contains no `'..'` path segments (pushing `${where}: witness.cmd must be node, npm, or npx` to `errors` otherwise).
  3. Enforce `resolveTarget` (imported from `@adlc/core`, returning `string | null`) + `!lstatSync(candidatePath).isSymbolicLink()` (leaving `packages/core/lib/inflight.mjs` untouched):
     - In `packages/review-calibration/lib/targets.mjs:149-151` (`loadPlantsFile`), check `lstatSync(resolve(cwd, p.file))` is not a symlink and `resolveTarget(cwd, p.file) !== null`; if either fails, push `${where}: ${p.file} escapes repository or is a symlink` to `errors` and `continue`.
     - In `packages/review-calibration/lib/runner.mjs:46-58` (`runWithPlants`), validate every `plant.absolutePath` via `const rel = relative(cwd, absPath); if (resolveTarget(cwd, rel) === null || lstatSync(absPath).isSymbolicLink()) throw new Error(\`Refusing to plant outside repository or through symlink: \${absPath}\`)` BEFORE `journal.begin` (protecting `NO_JOURNAL` callers too).
     - In `packages/review-calibration/lib/inflight.mjs:88-90` (`writeRecord(recordPath, ...)`), check `if (existsSync(recordPath) && lstatSync(recordPath).isSymbolicLink()) throw new Error(\`Refusing to write record through symlink: \${recordPath}\`)` before `writeFileAtomic`.
  4. Run `node scripts/build-cursor-mcp.mjs` (zero CLI arguments). Create `packages/review-calibration/test/sandbox-containment.test.mjs` with `test('sanitizeCandidateEnv strips ADLC_MANIFEST_KEY, API keys, NODE_OPTIONS, and GIT_SSH_COMMAND')`, `test('loadPlantsFile rejects ../ traversal, symlinks, and disallowed witness.cmd binaries')`, `test('runWithPlants refuses symlinked or out-of-repo absolutePath even with NO_JOURNAL')`, and `test('writeRecord refuses symlinked recordPath')`.
  5. Verify: `node --test packages/core/test/core.test.mjs packages/hollow-test/test/inflight.test.mjs packages/review-calibration/test/invalid-plants.test.mjs packages/review-calibration/test/sandbox-containment.test.mjs packages/review-calibration/test packages/gate-fuzzing/test scripts/test/ticket-store-boundary.test.mjs`

### `T-P05` — Prosecutor Truncation Chain Walk, Multi-Vendor Family Provenance & Input Path Guard
- **Tier:** `frontier`
- **Pool Hint:** `auto`
- **Depends On:** `[]`
- **Edges Out:** `[]`
- **Scope:**
  - `packages/prosecute/lib/attestation-store.mjs`
  - `packages/prosecute/lib/cross-model.mjs`
  - `packages/prosecute/lib/run.mjs`
  - `packages/prosecute/bin/adlc-prosecute.mjs`
  - `.github/workflows/cross-model-gate.yml`
  - `packages/autopilot/lib/review.mjs`
  - `packages/prosecute/test/carry-forward-truncation.test.mjs`
  - `packages/prosecute/test/vendor-family-provenance.test.mjs`
  - `packages/prosecute/test/prosecute-input-path.test.mjs`
- **Rails (Read-Only):**
  - `packages/autopilot/test/spec-coverage.test.mjs`
- **Body & Acceptance Criteria:**
  1. Preserve `assertNoTruncation({ prEntries, observedEntries, revision, key })`'s exact `{ ok: true } | { ok: false, missing: string[] }` return contract in `packages/prosecute/lib/attestation-store.mjs:86-95` while extending its check: collect `relevantRevisions = new Set([revision])`, walk `carriedFrom` (`entry?.data?.carriedFrom`) iteratively across `prEntries` and `observedEntries` starting from `revision` to add every ancestor revision to `relevantRevisions`, and ALSO include any signature-verified entry in `observedEntries` whose `changeSetDigest(entry?.data?.revision)` equals `changeSetDigest(revision)` (when `revision` is `git-change:<base>:<digest>`). Every signature-verified `observedEntries` entry matching `relevantRevisions` (or same `changeSetDigest` with `verdict === 'needs-attention'`) whose `entry.sig` is absent from `prEntries`'s verified signatures is pushed into `missing` so `{ ok: false, missing }` is returned. In `packages/prosecute/lib/cross-model.mjs:159` (`export function carryForwardCrossModelReview({ ticket, fromRevision, revision, dir, key, observedEntries } = {})`), when `observedEntries` is provided, throw `new Error('cannot carry forward: prior or same-digest attestation was truncated or revoked in attestation store')` if `assertNoTruncation({ prEntries: entries, observedEntries, revision: fromRevision, key }).ok` is `false` or any entry in `observedEntries` for `ticket` with matching `changeSetDigest` has `verdict === 'needs-attention'`; wire `--attestation-store <path>` into `carryForwardCrossModelReview` in `packages/prosecute/bin/adlc-prosecute.mjs:833-845` (`observedEntries: values['attestation-store'] ? readObservedAttestations(values['attestation-store'], { key: getKey() }) : undefined`).
  2. In `packages/prosecute/lib/cross-model.mjs:62-66` (`normalizeProvider(value)`), export `normalizeProvider` and map NFKC-normalized whitespace-stripped lowercase strings to canonical vendor families: `'claude'`, `'anthropic'`, or `/^claude[-.]/` -> `'anthropic'`; `'codex'`, `'openai'`, or `/^(?:gpt|o1|o3|o4)(?:[-.]|$)/` -> `'openai'`; `'gemini'`, `'agy'`, `'antigravity'`, `'google'`, or `/^gemini[-.]/` -> `'google'`; all other non-empty strings return their NFKC-lowercased form. In `.github/workflows/cross-model-gate.yml:174`, change `ADLC_AUTHOR_PROVIDER: anthropic` to `ADLC_AUTHOR_PROVIDER: ${{ vars.ADLC_AUTHOR_PROVIDER || '' }}`. In `candidateReview` (`cross-model.mjs:344-352`) and `scopeObservedEntriesToAuthor` (`cross-model.mjs:534-537`), when `runAuthor === ''` (unconfigured author), `scopeObservedEntriesToAuthor` returns `observedEntries` unfiltered (so truncation checks cover all authors) and `candidateReview` requires `provider !== '' && entryAuthor !== '' && provider !== entryAuthor` (while keeping `provider !== runAuthor && entryAuthor === runAuthor` whenever `runAuthor !== ''`). In `packages/autopilot/lib/review.mjs:195-210`, derive `--author-provider` from the builder seat's provider/harness and `--provider` from the reviewer seat's provider/harness via `normalizeProvider` instead of hardcoding `'anthropic'`/`'openai'` (preserving all `registerSeams(...)` calls).
  3. In `packages/prosecute/lib/run.mjs:52-60` (`revisionIgnorePaths(cwd, dir, input, inputPath)`), include `inputPath`, `input?.provenance?.transcript`, `input?.review_packet?.prompt`, and `input?.review_packet?.inputs` ONLY when `!isInsideCwd(cwd, resolved)` OR `isEvidencePath(cwd, resolved)` (so in-tree source paths outside `.adlc/` and `.omo/evidence/` are never added to `ignorePaths`). In `packages/prosecute/bin/adlc-prosecute.mjs` at BOTH `lines 793-799` (`record-cross-model`) and `lines 1138-1143` (default `prosecute` mode), validate `values.input` and `input?.provenance?.transcript` via helper `assertSafeEvidencePath(rawPath, process.cwd())`: resolve `const abs = resolve(cwd, rawPath)`: if `existsSync(abs)` and `lstatSync(abs).isSymbolicLink()`, call `opError(\`evidence path must not be a symlink: \${rawPath}\`)` (exit code `1`); if `abs` resolves inside `realpathSync(cwd)` and its relative path does NOT start with `'.adlc/'` or `'.omo/evidence/'`, call `opError(\`in-repository evidence path must live under .adlc/ or .omo/evidence/: \${rawPath}\`)` (exit code `1`).
  4. Create the three new test files with these exact test cases:
     - `packages/prosecute/test/carry-forward-truncation.test.mjs`: `test('assertNoTruncation and hasCrossModelApproveForRevision fail closed when carriedFrom ancestor or same-digest needs-attention entry is truncated from PR manifest')` and `test('carryForwardCrossModelReview throws when observedEntries contains revoked or truncated ancestor')`.
     - `packages/prosecute/test/vendor-family-provenance.test.mjs`: `test('normalizeProvider collapses claude/anthropic, codex/gpt/openai, and gemini/agy/google families and blocks intra-family review')` and `test('hasCrossModelApproveForRevision accepts distinct-family signed attestation when authorProvider is empty and scopes strictly when set')`.
     - `packages/prosecute/test/prosecute-input-path.test.mjs`: `test('revisionIgnorePaths and adlc-prosecute reject in-tree --input and provenance.transcript paths outside .adlc/ or .omo/evidence/ with exit 1 while allowing .adlc/ regular files and external temp files')`.
  5. Verify: `node --test packages/prosecute/test/carry-forward-truncation.test.mjs packages/prosecute/test/vendor-family-provenance.test.mjs packages/prosecute/test/prosecute-input-path.test.mjs packages/prosecute/test && AUTOPILOT_GATE_FULL=1 node --test packages/autopilot/test/spec-coverage.test.mjs`

### `T-P08` — Harden `ledger-guard` Against Symlinks/Staged Truncation & Update `enable.mjs` Notice
- **Tier:** `cheap`
- **Pool Hint:** `auto`
- **Depends On:** `[]`
- **Edges Out:** `[]`
- **Scope:**
  - `packages/lesson-foundry/lib/ledger-guard.mjs`
  - `packages/lesson-foundry/test/ledger-guard-staged-symlink.test.mjs`
  - `packages/gate-manifest/lib/enable.mjs`
  - `packages/gate-manifest/test/enable-notice.test.mjs`
- **Rails (Read-Only):**
  - `packages/gate-manifest/lib/record.mjs`
  - `packages/gate-manifest/test/reason-lines.test.mjs`
- **Body & Acceptance Criteria:**
  1. Preserve `scanFindingsLedger` and `guardFindingsLedgerAppendOnly` integer exit-code return contracts (`0` = clean, `1` = operational error, `2` = violation) and variadic `run(...args)` git helper convention (`defaultGit(...args)` at `ledger-guard.mjs:12`) in `packages/lesson-foundry/lib/ledger-guard.mjs`:
     - Update signatures to `export function scanFindingsLedger(ledger = LEDGER, { exists = existsSync, lstat = lstatSync, read = readFileSync } = {})` and `export function guardFindingsLedgerAppendOnly(baseRef, { run = defaultGit, read = readFileSync, exists = existsSync, lstat = lstatSync } = {})`.
     - In BOTH functions, when `exists(targetPath)` is true (`ledger` in `scanFindingsLedger`, `LEDGER` in `guardFindingsLedgerAppendOnly`), call `const st = lstat(targetPath)`: if `st.isSymbolicLink()`, log a symlink violation to `console.error` and return exit code `2`; if `!st.isFile()` (e.g., directory or FIFO), log an operational read error to `console.error` and return exit code `1`.
     - In `guardFindingsLedgerAppendOnly`, read the base text from `baseLedger(baseRef, run)` (`Buffer.from(base.text, 'utf8')`), read working-tree bytes (`exists(LEDGER) ? Buffer.from(read(LEDGER)) : Buffer.alloc(0)`), and require exact byte-prefix preservation (`candidateBuf.length >= baseBuf.length && candidateBuf.subarray(0, baseBuf.length).equals(baseBuf)`) WITHOUT stripping trailing `\n` (in addition to `appendOnlyViolations`). Also inspect the git index via variadic `run('ls-files', '--stage', '--', LEDGER)`: when its trimmed output is non-empty, read the staged blob via `run('show', ':0:.adlc/findings.jsonl')` and enforce the identical byte-prefix check against `Buffer.from(stagedText, 'utf8')` (returning exit code `2` on any staged or working-tree truncation or byte-prefix rewrite, and returning `1` if `run('show', ':0:.adlc/findings.jsonl')` throws).
  2. In `packages/gate-manifest/lib/enable.mjs:38-57`, keep `CI_COVERAGE_WARNING.code === 'ci-cannot-guard-segments'` and `SEGMENTATION_UNDETERMINED_WARNING.code === 'segmentation-undetermined'` unchanged (preserving `packages/gate-manifest/test/enable.test.mjs` contract), and update their human `message` strings to accurately state that `rails-guard` (`packages/rails-guard/lib/ci/manifest.mjs`) validates committed `.adlc/manifest.d/*.jsonl` segment chains and anchors alongside `.adlc/manifest.jsonl`, while uncommitted or `.gitignore`-masked local segments remain outside CI visibility.
  3. Create the two new test files with these exact test cases:
     - `packages/lesson-foundry/test/ledger-guard-staged-symlink.test.mjs`: `test('guardFindingsLedgerAppendOnly and scanFindingsLedger return 2 when .adlc/findings.jsonl is a symlink and 1 when it is a directory')`, `test('guardFindingsLedgerAppendOnly returns 2 on trailing-newline or byte-prefix alteration')`, and `test('guardFindingsLedgerAppendOnly returns 2 when staged index truncates findings.jsonl even if working tree appears intact')`.
     - `packages/gate-manifest/test/enable-notice.test.mjs`: `test('CI_COVERAGE_WARNING and SEGMENTATION_UNDETERMINED_WARNING preserve stable warning codes and describe segment chain CI validation accurately')`.
  4. Verify: `node --test packages/lesson-foundry/test/ledger-guard-staged-symlink.test.mjs packages/lesson-foundry/test packages/gate-manifest/test/enable-notice.test.mjs packages/gate-manifest/test/reason-lines.test.mjs packages/gate-manifest/test`

### `T-P09` — Narrow Fleet Adapter `homeState` Roots & Scrubbed Async MCP Server
- **Tier:** `mid`
- **Pool Hint:** `auto`
- **Depends On:** `[]`
- **Edges Out:** `[]`
- **Scope:**
  - `packages/fleet/lib/adapters/agy.mjs`
  - `packages/fleet/lib/adapters/jetski.mjs`
  - `packages/fleet/lib/adapters/gemini.mjs`
  - `packages/fleet/test/adapter-auth-subpaths.test.mjs`
  - `packages/cli/lib/mcp-server.mjs`
  - `packages/cli/test/mcp-env-scrub.test.mjs`
  - `packages/cli/test/async-mcp.test.mjs`
- **Rails (Read-Only):**
  - `packages/fleet/lib/sandbox.mjs`
  - `packages/fleet/lib/env-scrub.mjs`
  - `packages/fleet/lib/adapters/claude-code.mjs`
  - `packages/cli/test/mcp-server-cli-bin.test.mjs`
- **Body & Acceptance Criteria:**
  1. Mirror `packages/fleet/lib/adapters/claude-code.mjs:37-43` (`homeState` omits root config dir): in `packages/fleet/lib/adapters/agy.mjs:12-15`, replace `'.antigravity'` in `homeState.dirs` with `'.antigravity/logs'`, `'.antigravity/sessions'`, `'.antigravity/tmp'` (keeping `.gemini/tmp`, `.gemini/sessions`, `.cache/gemini` and `homeState.files`); in `packages/fleet/lib/adapters/jetski.mjs:11-14`, replace `'.jetski'` in `homeState.dirs` with `'.jetski/logs'`, `'.jetski/sessions'`, `'.jetski/tmp'`; and in `packages/fleet/lib/adapters/gemini.mjs:49-77` (`detectBinary(targets, env, platform)`), when `platform !== 'win32'`, check `statSync(candidate)` and `statSync(dirname(candidate))` and `continue` to the next candidate whenever `(st.mode & 0o022) !== 0` (group- or world-writable file or parent directory on POSIX).
  2. In `packages/cli/lib/mcp-server.mjs`:
     - Delete `process.env.ADLC_MANIFEST_KEY` at module load, and build an explicit scrubbed environment helper `scrubbedChildEnv(env = process.env)` returning a shallow copy without `ADLC_MANIFEST_KEY` passed as `env: scrubbedChildEnv()` to every child execution.
     - Add `'--lint-command'`, `'--typecheck-command'`, and `'--test-command'` to `FORBIDDEN_FLAGS` (`lines 28-45`).
     - Keep synchronous `callTool(name, input = {})` and `handleRequest(request)` exported with identical synchronous validation and `execFileSync(..., { env: scrubbedChildEnv() })` behavior so `packages/cli/test/mcp-server-cli-bin.test.mjs` passes untouched, AND add exported `executeAsync(args)`, `callToolAsync(name, input = {})` (performing identical argument + `resolveCliBin()` validation before awaiting non-blocking `execFile` with `timeout: EXECUTION_TIMEOUT_MS`, `maxBuffer: 2 * 1024 * 1024`, `shell: false`, `env: scrubbedChildEnv()`), and `handleRequestAsync(request)`.
     - Update `runStdioServer({ input = process.stdin, output = process.stdout } = {})` (`lines 251-268`) to dispatch each incoming line through `handleRequestAsync(request)` without blocking the event loop, tracking in-flight request Promises in a `Set` so the Promise returned by `runStdioServer` resolves on `lines.on('close')` after `await Promise.allSettled([...inflight])`.
  3. Create the three new test files with these exact test cases:
     - `packages/fleet/test/adapter-auth-subpaths.test.mjs`: `test('agy and jetski adapters exclude root .antigravity and .jetski dirs from writable homeState.dirs')` and `test('gemini detectBinary skips group-writable and world-writable candidate binaries and directories on POSIX while preserving win32 lookup')`.
     - `packages/cli/test/mcp-env-scrub.test.mjs`: `test('mcp-server scrubs ADLC_MANIFEST_KEY from child env and rejects --lint-command, --typecheck-command, and --test-command')`.
     - `packages/cli/test/async-mcp.test.mjs`: `test('runStdioServer processes concurrent tools/call and tools/list requests asynchronously via handleRequestAsync without blocking the event loop')`.
  4. Verify: `node --test packages/fleet/test/adapter-auth-subpaths.test.mjs packages/fleet/test packages/cli/test/mcp-server-cli-bin.test.mjs packages/cli/test/mcp-env-scrub.test.mjs packages/cli/test/async-mcp.test.mjs packages/cli/test`

---

## 3. Acceptance Criteria

- [ ] **AC1 — Validated Wave 1A `plan.json`:** `agb validate plan.json` and `agb preflight plan.json --no-coldstart` pass with zero structural, cycle, or scope-overlap errors. Verify: `~/.local/bin/agb validate plan.json && ~/.local/bin/agb preflight plan.json --no-coldstart`
- [ ] **AC2 — Zero Spec-Lint Wishes:** This specification passes `@adlc/spec-lint` with `0` wishes. Verify: `node packages/spec-lint/bin/spec-lint.mjs .adlc/specs/enhancement-wave1-lane-a.md`
