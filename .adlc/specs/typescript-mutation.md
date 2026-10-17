# T-01M4XY1NVDJ5VB0JBHPFGS02WG — Mutate TypeScript/JSX in hollow-test and syntax-check TypeScript plants in review-calibration

Tier: architectural. Issues: [#312](https://github.com/voodootikigod/adlc/issues/312), [#313](https://github.com/voodootikigod/adlc/issues/313).

## Intent

Make `hollow-test` mutate TypeScript, TSX and JSX files (#313, path A), with a TypeScript parser in place of `node --check` for them. #312 landed in #1218, for JavaScript only; this change gives its checker the TypeScript family, so both mutation consumers discard an unparseable TypeScript mutant.

## Acceptance criteria

1. `@adlc/core` exports one syntax check for both tools. It returns `valid`, `invalid` or `unknown` for JavaScript and the TypeScript family, and `unknown`, not `invalid`, when the check itself fails. It uses the nearest `typescript` with the JavaScript parser API, skipping TypeScript 7. Verify: `node --test packages/core/test/syntax.test.mjs`
2. `review-calibration` syntax-checks TypeScript-family plants with the core check and discards one that does not parse as `unparseable`, as #1218 does for JavaScript. An undetermined check still passes the plant through with syntax `unknown`. Verify: `node --test packages/review-calibration/test/invalid-plants.test.mjs`
3. `hollow-test` mutates `.ts`, `.mts`, `.cts`, `.tsx` and `.jsx` source. It refuses declaration and test files. Before it changes a file, it exits 1 with a message when `typescript` is not resolvable from a target or a target does not parse unmutated. Verify: `node --test packages/hollow-test/test/typescript.test.mjs`
4. At a budget of one mutant, a TypeScript or JSX diff whose only mutant does not parse exits 1. A valid TypeScript mutant that the tests kill exits 0, and one they miss exits 2. Verify: `node --test packages/hollow-test/test/typescript.test.mjs`
5. A mutant that does not parse does not use a file's budget. `hollow-test` tries the next one, up to 8 tries for each budget slot. An undetermined check still exits 1. Verify: `node --test packages/hollow-test/test/invalid-refill.test.mjs`
6. `scripts/mutation-gate.mjs` and `hollow-test` agree on what source is, and a TypeScript-only diff reaches the gate. Verify: `node --test scripts/test/mutation-gate.test.mjs`
7. The existing suites stay green. Verify: `node --test packages/core/test/*.test.mjs packages/hollow-test/test/*.test.mjs packages/review-calibration/test/*.test.mjs scripts/test/mutation-gate.test.mjs`
8. The READMEs and docs site describe TypeScript support, the `typescript` requirement, the budget rule and TypeScript plants. Verify: `grep -c -e 'npm i -D typescript' -e '8 tries' packages/hollow-test/README.md apps/docs/content/docs/toolkit/hollow-test.mdx && grep -c -i typescript packages/review-calibration/README.md apps/docs/content/docs/toolkit/review-calibration.mdx`
9. The mutation gate passes on this change. Verify: `node scripts/mutation-gate.mjs <merge-base> --max 20`

## Decisions

- decided: a TypeScript diff without `typescript` exits 1 with an install message over a skip: a skip looks like a pass (AC 3)
- decided: a diff with no mutable source keeps `nothing to mutate` over a new failure: only the TypeScript part of #313's open question changes (AC 6)
- decided: CI here mutates `apps/docs` TSX over a declared exclusion: the wrapper must use the tool's predicate (AC 6)

## Design alternatives

1. **Parser.** Chosen: the `typescript` package of the repository under test, found from the mutated file, in a child process. Rejected: Node's `module.stripTypeScriptTypes` (Node 22.13 and later; no JSX; CI also runs Node 18 and 20). Rejected: a parser dependency (CONVENTIONS rule 1).
2. **Budget.** Chosen: an unparseable mutant does not use a budget slot, up to 8 tries for each slot. Rejected: path A alone, since 43–45% of measured TypeScript files have an unparseable first mutant.
3. **Scope.** Chosen: build on #1218's contract and extend only its checker. Rejected: a second #312 contract (exit 1 on spawn failures and undetermined checks).

## Out of scope

- Syntax-aware operators (#313 path B); `mutate.mjs` does not change.
- Type checking: a mutant that only breaks types counts as valid.
- A diff that changes only TypeScript types gives no mutant and exits 1, as an import-only change does today (#1031).
- JSX in plain `.js` files (still `node --check`).
- Python (#292).

---

## Change

- `packages/core/lib/syntax.mjs` (new): `syntaxLanguage(file)`, `resolveTypeScript(filePath)`, `checkSyntax(filePath, cwd, execPath)` and `syntaxCheckProblem(filePath)`. They are exported from `index.mjs` and declared in `index.d.ts`. JavaScript (`.js`, `.mjs`, `.cjs`) runs `node --check`, as today. The TypeScript family (`.ts`, `.mts`, `.cts`, `.tsx`, `.jsx`) runs `node packages/core/lib/syntax-check-typescript.mjs <file>`. That worker uses `resolveTypeScript`: from the file's directory up to the root, the first `<dir>/node_modules/typescript` (resolved with `createRequire`) whose module has `createSourceFile` and `createProgram`. A package without them (TypeScript 7 is native, with `main: null`) is skipped and named in `syntaxCheckProblem`. The worker parses with `createSourceFile` and `createProgram` (`allowJs: true`, `jsx: preserve`, `noLib`, `noResolve`) over an in-memory host, exits 3 when the program does not hold the file, and exits 0 when `getSyntacticDiagnostics` is empty and 65 when it is not. Every other exit, a signal, a timeout or a spawn error is `unknown`. The worker catches every error and exits 3, so a crash (Node exits 1) can never read as `invalid`.
- `packages/hollow-test/lib/targets.mjs`: `SOURCE_EXT_RE` adds `ts|mts|cts|tsx|jsx`. A new `DECLARATION_RE` (`.d.ts`, `.d.mts`, `.d.cts`) is refused by `isSupportedSourceExtension` and `isMutableSource`.
- `packages/hollow-test/lib/runner.mjs`: imports `checkSyntax` from `@adlc/core` and re-exports it.
- `packages/hollow-test/bin/hollow-test.mjs`: after target selection, before the first write, it calls `syntaxCheckProblem` and then `checkSyntax` on the unmutated content of each target. It exits 1 on the first problem or on a result that is not `valid`, naming the file and, for the TypeScript family, the `typescript` version and path. It prints that version and path once when a TypeScript-family target runs. Its mutation loop generates every candidate on the target lines and runs them in order. It stops a file at `quota` valid results or `quota * 8` tries. The `not a supported source language` messages stay for other extensions.
- `packages/review-calibration/lib/verify.mjs`: #1218's `checkPlantSyntax` keeps its journal, discard kinds and `unknown` pass-through; its extension set becomes core's `syntaxLanguage`, and its default checker becomes core's `checkSyntax`. `classifySyntaxResult` stays exported. Nothing in `bin/` or `lib/report.mjs` changes.
- `scripts/test/mutation-gate.test.mjs`: the source-set tests change to the new contract. `scripts/mutation-gate.mjs` changes only its comments.
- Docs: `packages/{core,hollow-test,review-calibration}/README.md` and `apps/docs/content/docs/toolkit/{core,hollow-test,review-calibration}.mdx`.

## Engineering decisions

- decided: exit 65 for invalid and exit 3 for every worker error over the default exit 1: an uncaught Node error also exits 1, so 1 cannot mean invalid (AC 1)
- decided: `createProgram` with `getSyntacticDiagnostics` over `transpileModule`: TypeScript 6.0.3 throws `Debug Failure. Output generation failed` from `transpileModule` on some mm-js files, while the program API is the public way to read syntax errors in both 5.9 and 6.0 (AC 1)
- decided: resolve `typescript` from the mutated file over the package or the current directory: pnpm and nested workspaces put it next to the code, and an @adlc package must not depend on it (AC 1, AC 3)
- decided: a TypeScript plant with no usable `typescript` passes through as `unknown` over exit 1: it is #1218's rule for every unchecked plant (AC 2)
- decided: keep `checkSyntax` exported from `packages/hollow-test/lib/runner.mjs` over a breaking removal: the existing `unit.test.mjs` imports it from there (AC 7)
- decided: keep the candidate order and a cap of 8 tries for each slot over spreading by line: on the measured files in line order, 8 tries leave 13.4% of mm-js files and 3.9% of this repository's with no valid mutant at one slot, against floors of 12.5% and 3.9% (AC 5)
- decided: one checker process per candidate over a batched worker: a check costs one `node` start and one parse, small next to a test run (AC 5)
- decided: keep the `scripts/*.mjs` test mapping in the wrapper over adding `.ts`: no `scripts/*.ts` exists, and an unmapped file takes the slow path, which under-claims (AC 6)

## Test plan

| Criterion | Case | Test | In the RED run |
| --- | --- | --- | --- |
| AC 1 | language of each extension | `packages/core/test/syntax.test.mjs` › `syntaxLanguage maps each extension` | fails |
| AC 1 | JavaScript valid and invalid | `packages/core/test/syntax.test.mjs` › `JavaScript keeps node --check` | fails |
| AC 1 | each TypeScript-family extension valid | `packages/core/test/syntax.test.mjs` › `each TypeScript-family extension parses` | fails |
| AC 1 | `.jsx`, `.mts`, `.cts` invalid | `packages/core/test/syntax.test.mjs` › `an unparseable file is invalid for each TypeScript-family extension` | fails |
| AC 1 | nearer TypeScript 7 skipped | `packages/core/test/syntax.test.mjs` › `skips a typescript package without the parser API` | fails |
| AC 1 | `Promise>=unknown>` invalid | `packages/core/test/syntax.test.mjs` › `a mutated generic is invalid` | fails |
| AC 1 | `>=Button>` invalid | `packages/core/test/syntax.test.mjs` › `a mutated JSX element is invalid` | fails |
| AC 1 | stranded `return null;` invalid | `packages/core/test/syntax.test.mjs` › `a stranded multiline return is invalid` | fails |
| AC 1 | typescript not resolvable | `packages/core/test/syntax.test.mjs` › `unknown when typescript cannot be resolved` | fails |
| AC 1 | checker crash | `packages/core/test/syntax.test.mjs` › `unknown when the checker crashes` | fails |
| AC 1 | extension with no checker | `packages/core/test/syntax.test.mjs` › `unknown for an extension with no checker` | fails |
| AC 1 | problem message | `packages/core/test/syntax.test.mjs` › `syntaxCheckProblem names the file and the install command` | fails |
| AC 2 | `.ts` generic plant | `packages/review-calibration/test/invalid-plants.test.mjs` › `a mutated generic in a .ts plant is discarded as unparseable` | fails |
| AC 2 | `.tsx` JSX plant | `packages/review-calibration/test/invalid-plants.test.mjs` › `a mutated JSX element in a .tsx plant is discarded as unparseable` | fails |
| AC 2 | stranded return and a valid `.ts` plant | `packages/review-calibration/test/invalid-plants.test.mjs` › `a stranded multiline return in a .ts plant is discarded, a parseable one is valid` | fails |
| AC 2 | report count | `packages/review-calibration/test/invalid-plants.test.mjs` › `CLI --json: a TypeScript plant that does not parse is counted as discarded` | fails |
| AC 2 | no typescript | `packages/review-calibration/test/invalid-plants.test.mjs` › `a TypeScript plant without typescript in reach passes through with syntax unknown` | passes (characterization) |
| AC 2 | JavaScript unchanged | `packages/review-calibration/test/invalid-plants.test.mjs` › `a JavaScript plant that does not parse is still discarded` | passes (characterization) |
| AC 2 | language with no checker | `packages/review-calibration/test/invalid-plants.test.mjs` › `a plant with no checker is not syntax-checked` | passes (characterization) |
| AC 3 | TypeScript family admitted | `packages/hollow-test/test/typescript.test.mjs` › `the source set admits the TypeScript family` | fails |
| AC 3 | declaration and test files refused | `packages/hollow-test/test/typescript.test.mjs` › `declaration and test files are not source` | fails |
| AC 3 | `--target x.tsx` | `packages/hollow-test/test/typescript.test.mjs` › `--target accepts a .tsx file` | fails |
| AC 3 | Python still refused | `packages/hollow-test/test/typescript.test.mjs` › `Python is still refused` | passes (characterization) |
| AC 3 | target does not parse unmutated | `packages/hollow-test/test/typescript.test.mjs` › `refuses a target that does not parse before mutating` | fails |
| AC 3 | no typescript | `packages/hollow-test/test/typescript.test.mjs` › `refuses before mutating when typescript cannot be resolved` | fails |
| AC 4 | `Promise<unknown>` only candidate | `packages/hollow-test/test/typescript.test.mjs` › `quota one: a mutated generic never passes` | fails |
| AC 4 | JSX `<Button>` only candidate | `packages/hollow-test/test/typescript.test.mjs` › `quota one: a mutated JSX element never passes` | fails |
| AC 4 | killed TypeScript mutant | `packages/hollow-test/test/typescript.test.mjs` › `a killed TypeScript mutant passes` | fails |
| AC 4 | surviving TypeScript mutant | `packages/hollow-test/test/typescript.test.mjs` › `a surviving TypeScript mutant fails the gate` | fails |
| AC 5 | next candidate after an invalid one | `packages/hollow-test/test/invalid-refill.test.mjs` › `an invalid first candidate does not use the budget` | fails |
| AC 5 | undetermined candidate | `packages/hollow-test/test/invalid-refill.test.mjs` › `an undetermined candidate still exits 1` | passes (characterization) |
| AC 5 | cap at 8 tries for each slot | `packages/hollow-test/test/invalid-refill.test.mjs` › `tries stop at 8 for each budget slot` | fails |
| AC 6 | TypeScript family through the wrapper | `scripts/test/mutation-gate.test.mjs` › `the allow-list admits JavaScript and the TypeScript family` | fails |
| AC 6 | wrapper and tool agree | `scripts/test/mutation-gate.test.mjs` › `the wrapper and hollow-test agree on what source is` | passes (characterization) |
| AC 6 | TypeScript-only diff reaches the gate | `scripts/test/mutation-gate.test.mjs` › `a TypeScript-only diff reaches the mutation gate` | fails |
| AC 7 | existing suites | existing tests of `packages/core`, `packages/hollow-test`, `packages/review-calibration` | passes (characterization) |
| AC 8 | docs | the AC 8 `grep` | fails |
| AC 9 | mutation gate | `node scripts/mutation-gate.mjs <merge-base> --max 20` | not runnable before the build |
