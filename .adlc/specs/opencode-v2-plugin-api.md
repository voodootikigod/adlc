# OpenCode v2: port `@adlc/opencode` to the v2 plugin API

Ticket: `T-01M3V4GJCF4KBMHPJR1XHZSG17`.

## Problem

`@adlc/opencode` does not load in OpenCode 2. With `opencode v2.0.20`, the server reports:

```
Server plugin error — @adlc/opencode
Plugin must export a default definition with an id and an effect or setup function.
```

`plugins/adlc-opencode/index.mjs` default-exports the v1 plugin: an async function
returning string-keyed hooks plus a zod-built `tool` map from `@opencode-ai/plugin`.
OpenCode 2 never calls v1 implementations. While the plugin fails to load, OpenCode 2
runs with no ADLC enforcement at all: no rails deny, no build-gate backstop, no
context injection, no `adlc_gate` / `adlc_prosecute`.

References:
- https://opencode.ai/v2/docs/migrate-v1/
- https://opencode.ai/v2/docs/build/plugins/migrate-v1
- https://opencode.ai/v2/docs/plugins/

## Facts established from the v2 packages (not assumptions)

These were read from `@opencode/plugin@2.0.21`, `@opencode/core@2.0.21` and
`@opencode/client@2.0.21`. Re-verify them against the version CI pins; if any has
changed, the spec is wrong at that point and the change must stop and re-enter P1.

1. **Entrypoint.** `Plugin.define(p)` is the identity function. The host requires a
   default export `{ id: string, setup(ctx) }`, and `setup` may return a cleanup
   function. Because `define` is the identity, `index.mjs` can export the object
   literal without importing `@opencode/plugin` at module load.
2. **Context.** `ctx` has `app` (`{ name, version, channel }`), `location`,
   `options`, `event`, `permission`, `session`, `tool`, `storage`, `rpc` and other
   domains. **It has no toast or log API.** Toasts exist only in the separate TUI
   plugin entrypoint `@opencode/plugin/tui`.
3. **Tool hooks.** In `ctx.tool.hook('execute.before', e => ...)`, the event has
   `{ tool, sessionID, agent, messageID, id, input }`, and `input` is mutable.
   `execute.after` adds `status` plus either `result` or `error`.
4. **Tool registration.** `ctx.tool.transform(editor => ...)` has
   `editor.add(info)`, `editor.update(id, fn)`, `editor.remove(id)`, `list()` and
   `get(id)`. `info` is `{ name, description, input: <JSON Schema>, execute(input, toolCtx) }`,
   and `execute` resolves to a `Tool.Result`.
5. **Built-in tool ids and inputs.** The ids are `shell`, `edit`, `write`, `patch`,
   `read`, `glob`, `grep`, `subagent`, `question`, `skill`, `webfetch` and
   `websearch`. Their inputs:
   - `shell`: `{ command, workdir?, timeout?, background? }`
   - `edit`: `{ path, oldString, newString, replaceAll? }`
   - `write`: `{ path, content }`
   - `patch`: `{ patchText }`, using the `*** Begin Patch` envelope.

   v1's `bash`, `apply_patch`, `task`, `list` and `todowrite` do not exist as v2
   built-ins.
6. **Permission hook.** In `ctx.permission.hook('evaluate', e => ...)`, the event
   has `{ sessionID, agent?, action, resources[], metadata?, source?, effect, message? }`.
   `effect` and `message` are mutable.
7. **Session hooks.** These are `prompt`, `context`, `compaction`, `generate`,
   `title`, `model.request`, `http.request` and `http.response`.
   - The `context` event has a mutable `system: SystemPart[]` and a mutable
     `tools: Record<name, { description, input }>`.
   - The `prompt` event has a mutable `prompt`, plus `metadata` and `delivery`.
8. **Events.** The host emits `ctx.event.subscribe({ signal })`, an async
   iterable, with these types:
   - `filesystem.changed` with `data: { file, event: 'add'|'change'|'unlink' }`.
     This replaces v1 `file.edited`, which used `properties.file`.
   - `session.compaction.started`, `session.compaction.ended` and
     `session.compaction.failed`. These replace v1 `session.compacted`.
   - `session.created` and `session.idle`.
9. **No autocontinue control.** No v2 domain exposes an equivalent of
   `experimental.compaction.autocontinue`.

## Decisions

Decisions 1 to 4 were made with the human at P0. Decisions 5 and 6 were made at P1.

1. **v2 only.** Delete the v1 implementation. Don't ship a dual export. Remove
   every `@opencode-ai/plugin` dependency and the `opencode-ai@1.17.13` pin.
   - Add the peer dependency `@opencode/plugin` at `>=2.0.20 <3`, optional.
   - Add the root devDependency `@opencode/plugin` at the CI-pinned version.
2. **Unmapped hooks get the closest equivalent**, or a documented gap with a test
   that pins the fallback.
3. **The scaffold writes the v2 `plugins` key** and migrates an existing v1
   `plugin` entry. Details are under "Scaffold" below.
4. **One ticket.**
5. **Operator notifications go to stderr only.** There will be no toasts and no
   companion TUI plugin.
   - `makeNotify` becomes a stderr writer with a stable prefix: `[adlc] <variant>: <message>`.
   - Denies still reach the model through the thrown error text.
   - Load-time option-weakening warnings, advisories, flail and preflight
     messages go to stderr.
   - The docs must say plainly that advisories are no longer shown in the TUI.
     This is a known v2 regression.
6. **Additive vocabulary changes to the decision layer are allowed.** Each one
   needs a test proving the fail-closed direction still holds. The allowed
   changes are:
   - `extractTargetsKeyed` also parses `args.patchText` as a patch envelope.
     Without this, every v2 `patch` call is treated as a target-less mutation and
     denied whenever rails are active.
   - `subagent` joins `UNGATED_TOOLS`, alongside `task`.
   - The rail-notice tool set (`tool.definition` today) becomes
     `['edit', 'write', 'patch', 'apply_patch']`.
   - A `shell` call with a `workdir` that resolves to anything other than the
     repo root is treated like a `cd`. Today the rule is that a mutating shell
     command which changes cwd is denied because its targets can't be verified,
     and the same rule now covers `workdir`. Without this, a relative write run
     from `workdir: 'src'` would get past a rail on `src/…`.
   - v1 names (`bash`, `apply_patch`, `task`, `filePath`, `patch`, `input`) stay
     in place. Removing them only weakens matching and buys nothing.

   No other semantic change to `rails-checker.mjs` or `lib/*.mjs` decision
   functions is allowed.

## Design

### Entrypoint (`plugins/adlc-opencode/index.mjs`)

```js
export default {
  id: 'adlc',
  async setup(ctx) { /* registrations below */ return cleanup; },
};
```

Keep the named export `optionsToEnv` unchanged. Remove `adlcRailsGuard`. The
repo root is the first non-empty value of:
1. `ctx.location.worktree` (if present)
2. `ctx.location.directory`
3. `ctx.location.project?.worktree`
4. `process.cwd()`

Options come from `ctx.options` and are mapped through `optionsToEnv`. Env still
wins over options. The audited bypasses (`ADLC_RAILS_BYPASS`,
`ADLC_BUILD_GATE_BYPASS`) still cannot be mapped from options.

### Registration map

| Behaviour today | v2 registration |
| --- | --- |
| rails-guard / handoff / build-gate deny (`tool.execute.before`) | `ctx.tool.hook('execute.before', e => …)` reading `e.tool` and `e.input`. A deny **throws**. |
| `tracker.recordToolCall` | same hook, before any decision |
| flail churn (`tool.execute.after`) | `ctx.tool.hook('execute.after', e => …)` reading `e.input` |
| `adlc_gate`, `adlc_prosecute` | `ctx.tool.transform(ed => ed.add(...))`. The zod args become JSON Schema with `additionalProperties: false`, and `execute` returns `{ content }`. The callback is synchronous with no side effects. |
| rail notice in tool descriptions (`tool.definition`) | `ctx.tool.transform(ed => ed.update(id, t => { t.description += notice }))` for each id in the rail-notice set. The notice is computed when the edit is registered. `ctx.tool.reload()` is not wired to ticket changes; this is a documented limitation. |
| system-prompt context block (`experimental.chat.system.transform`) | `ctx.session.hook('context', e => e.system.push({ type: 'text', text: block }))` |
| compaction context (`experimental.session.compacting`) | `ctx.session.hook('compaction', e => e.system.push(...))` for every line from `buildCompactionContext` |
| `session.compacted` → `tracker.markCompacted` | event `session.compaction.ended` → `tracker.markCompacted(sessionID)` |
| `file.edited` watcher | event `filesystem.changed` → `handleFileEdited({ file: event.data.file, … })`. Skip `unlink`. |
| `session.created` status line and preflight | event `session.created` |
| `session.idle` audits and flail eviction | event `session.idle` |
| `permission.ask` (dormant) | `ctx.permission.hook('evaluate', e => …)`. Set `e.effect = 'deny'` and `e.message` using the same predicates as today, reading `e.action` and `e.resources`. It must never throw. Whether the host actually dispatches it is settled by AC 4, and the code comment must state the observed result. |
| `command.execute.before` (order and tamper advisories) | `ctx.session.hook('prompt', e => …)`. When the prompt text starts with `/adlc-<name>`, run `checkCommandOrder` and `checkCommandTamper` for that command. Advisory only: write to stderr, never block, never mutate the prompt. |
| `experimental.compaction.autocontinue` | **Gap.** Not ported. Documented in `docs/integrations/opencode.md`. AC 7 pins the fallback, which is the build-gate deny on the next structured mutation. |

Each hook and transform registration is **awaited** before `setup` resolves, so
no tool call can run before the deny hook exists.

The event loop runs as
`for await (const ev of ctx.event.subscribe({ signal }))` inside a detached async
task.
- The whole body is wrapped in try/catch so that one bad event never ends the loop.
- When the iterator ends or throws, the task resubscribes with bounded backoff
  (100 ms doubling, capped at 5 s) until the signal aborts.
- An event whose `location.directory` is present and differs from the plugin
  root is ignored, because the stream is server-wide.
- Session ids are read from `ev.data.sessionID`, the v2 shape.
- The cleanup function returned by `setup` aborts the controller.

### Native tools

`lib/gate-tool.mjs` and `lib/prosecute-tool.mjs` currently receive `tool.schema`
(zod). Change their builders so they take no schema argument and return v2
`Info` objects with JSON Schema `input`. Keep the existing argument names,
descriptions and execute bodies. Wrap each execute's string output as
`{ content: <string> }`. Remove the lazy `import('@opencode-ai/plugin')`. If a
builder throws, the tools are not registered, a `[adlc] native tools NOT
registered: …` line goes to stderr, and the tool-hook registrations still happen.

### Keyless bridge (`lib/keyless-bridge.mjs`)

The bridge currently creates isolated child sessions through v1
`client.session.create` / `client.session.prompt`. Port it to the v2 session API
exposed on `ctx.session` (a `SessionApi`). Thread `ctx` into `buildProsecuteTool`
the same way `client` is threaded today. AC 5 proves the result.

### Scaffold (`lib/scaffold.mjs`)

`ensurePluginRegistered` writes `config.plugins`, the v2 key.

- A v2 entry is either a string or `{ package, options }`.
- Each entry in an existing `config.plugin` (v1) array that `isOwnPluginEntry`
  recognises is removed and replaced by one canonical ADLC entry in `plugins`. A
  v1 tuple `[name, opts]` becomes `{ package: name, options: opts }`, and an
  options object that is present but empty is dropped.
- Non-ADLC entries in `plugin` stay in `plugin`. This changes as little as
  possible, and v2 reads both keys.
- `plugin` is deleted if it is empty afterwards.
- If both keys contain ADLC entries, the result has exactly one ADLC entry, in
  `plugins`.
- An unparseable `opencode.json` still fails closed, and the file is left
  byte-identical.

## Acceptance criteria

Each criterion is a single item and ends with the command that verifies it. The
fake ctx used by the unit tests lives in
`plugins/adlc-opencode/test/helpers/fake-ctx.mjs`. It records hook, transform and
event-subscribe registrations, and builds events in the shapes from
`@opencode/client`'s generated types (`data.sessionID`, `data.file`), never from
hand-written shapes.

1. **v2 shape:** the default export of `index.mjs` has `id === 'adlc'` and a `setup` function, and the module has no `adlcRailsGuard` export. Verify: `node --test plugins/adlc-opencode/test/entry-shape.test.mjs`
2. **Published package loads in v2:** the live-deny script installs the `npm pack` tarball of `plugins/adlc-opencode` into its temp project, registers it by package name under the v2 `plugins` key, points a v2 `providers` entry at its mock OpenAI-compatible server, and fails if the opencode server log contains `Server plugin error`. Verify: `node scripts/opencode-live-deny.mjs --require`
3. **Live deny (write) on v2:** in the CONTROL run (enforcement off) a model-requested `write` to the rail file lands; in the TREATMENT run (`ADLC_P4_ENFORCEMENT=1`) the rail file is byte-identical afterwards and the mock's follow-up request contains `ADLC rails-guard: blocked`. Verify: `node scripts/opencode-live-deny.mjs --require`
4. **Live deny (patch) on v2:** a third run repeats TREATMENT with a `patch` call whose `patchText` envelope updates the rail file; the rail is byte-identical afterwards and the deny text reaches the mock. Verify: `node scripts/opencode-live-deny.mjs --require`
5. **Permission hook status is observed, not assumed:** the live-deny script prints `permission.evaluate invoked: yes` or `permission.evaluate invoked: no` for the TREATMENT run, and both the comment on that hook in `index.mjs` and `docs/integrations/opencode.md` contain the literal `permission.evaluate: dispatched` or `permission.evaluate: not dispatched`, matching what the script printed. Verify: `node scripts/opencode-live-deny.mjs --require && rg -n "permission\.evaluate: (dispatched|not dispatched)" plugins/adlc-opencode/index.mjs && rg -n "permission\.evaluate: (dispatched|not dispatched)" docs/integrations/opencode.md`
6. **Live native tool on v2:** the mock model calls `adlc_gate` and the follow-up request it receives contains the gate's output text, not a tool error. Verify: `node scripts/opencode-live-tool.mjs --require`
7. **Compaction and prosecute proofs ported:** both scripts pass, and neither imports `@opencode-ai/plugin`. Verify: `node scripts/opencode-live-compaction.mjs && node scripts/opencode-live-prosecute.mjs`
8. **Unit tests drive the v2 export:** no plugin test calls `adlcRailsGuard` or invokes a hook by its v1 string key; every one goes through `setup(fakeCtx)`. Verify: `node --test plugins/adlc-opencode/test/*.test.mjs && ! rg -n "adlcRailsGuard|'tool\.execute\.(before|after)'" plugins/adlc-opencode/test`
9. **Rails deny throws by default:** a rails hit in `execute.before` rejects with `ADLC rails-guard: blocked`. Verify: `node --test plugins/adlc-opencode/test/v2-registration.test.mjs`
10. **Advisory downgrade only via the option:** with `ctx.options.advisoryHooks === true` the same rails hit resolves and stderr contains `[ADVISORY`. Verify: `node --test plugins/adlc-opencode/test/v2-registration.test.mjs`
11. **Handoff deny ignores the downgrade:** with `ADLC_CONTEXT_ROT_HANDOFF_ENABLED=1` and `advisoryHooks: true`, a handoff deny still rejects. Verify: `node --test plugins/adlc-opencode/test/v2-registration.test.mjs`
12. **Advisory paths never throw into the host:** with an internal error injected, each of `execute.after`, the `context`, `compaction` and `prompt` session hooks, and every event branch resolves without throwing. Verify: `node --test plugins/adlc-opencode/test/v2-registration.test.mjs`
13. **Tool-builder failure keeps enforcement:** when the native-tool builder throws, `execute.before` is still registered and stderr contains `[adlc] native tools NOT registered`. Verify: `node --test plugins/adlc-opencode/test/v2-registration.test.mjs`
14. **Autocontinue fallback:** after a `session.compaction.ended` event for a session working a high-risk ticket, that session's next `edit` in `execute.before` rejects with `ADLC build-gate: blocked`. Verify: `node --test plugins/adlc-opencode/test/v2-registration.test.mjs`
15. **No unguarded window:** when the fake ctx acknowledges registrations late, the promise from `setup` resolves only after `execute.before` is registered. Verify: `node --test plugins/adlc-opencode/test/v2-registration.test.mjs`
16. **Event loop survives:** an event iterator that ends causes a resubscribe, and aborting the signal from the cleanup function stops the loop. Verify: `node --test plugins/adlc-opencode/test/v2-registration.test.mjs`
17. **Foreign-project events ignored:** a `filesystem.changed` event whose `location.directory` differs from the plugin root produces no watcher action. Verify: `node --test plugins/adlc-opencode/test/v2-registration.test.mjs`
18. **patchText targets a rail:** `checkToolCall` on tool `patch` with a `patchText` envelope updating a railed file returns `deny`, and the reason names the rail. Verify: `node --test plugins/adlc-opencode/test/rails-checker.test.mjs`
19. **patchText off-rail is allowed:** the same envelope updating a non-railed file returns `allow`. Verify: `node --test plugins/adlc-opencode/test/rails-checker.test.mjs`
20. **Unparseable patchText fails closed:** `{ patchText: 'garbage' }` on `patch` with rails active returns `deny`. Verify: `node --test plugins/adlc-opencode/test/rails-checker.test.mjs`
21. **subagent is ungated:** `checkToolCall` on tool `subagent` with rails active returns `allow`. Verify: `node --test plugins/adlc-opencode/test/rails-checker.test.mjs`
22. **shell workdir counts as a cwd change:** `shell` with `{ command: 'echo x > frozen.mjs', workdir: 'src' }` and rail `src/frozen.mjs` returns `deny`, while the same command with `workdir` equal to the root and a non-railed target returns `allow`. Verify: `node --test plugins/adlc-opencode/test/rails-checker.test.mjs`
23. **Rail notice reaches v2 patch:** with rails active, the registered tool transform appends the rail notice to the `patch`, `edit` and `write` descriptions. Verify: `node --test plugins/adlc-opencode/test/context-inject.test.mjs`
24. **Fresh scaffold writes v2 config:** scaffolding an empty project yields `.opencode/opencode.json` with exactly one ADLC entry under `plugins` and no `plugin` key. Verify: `node --test plugins/adlc-opencode/test/scaffold.test.mjs`
25. **v1 config is migrated:** given `{ "plugin": [["@adlc/opencode", {"advisoryHooks": true}], "other-plugin"] }`, the result is `"plugins": [{ "package": "@adlc/opencode", "options": { "advisoryHooks": true } }]` and `"plugin": ["other-plugin"]`. Verify: `node --test plugins/adlc-opencode/test/scaffold.test.mjs`
26. **Scaffold is idempotent:** running it twice leaves a byte-identical file. Verify: `node --test plugins/adlc-opencode/test/scaffold.test.mjs`
27. **Unparseable config fails closed:** for a syntactically invalid `opencode.json`, the scaffold throws and the file is byte-identical afterwards. Verify: `node --test plugins/adlc-opencode/test/scaffold.test.mjs`
28. **No v1 API remains:** the search for v1 API names prints nothing. Verify: `! rg -n "@opencode-ai/plugin|opencode-ai@1\.|tool\.schema|client\.tui|client\.app\.log" plugins/adlc-opencode scripts .github package.json`
29. **CI pins v2:** the pinned opencode job installs one exact 2.x version with the documented v2 installer, the `opencode-live-latest` canary installs the v2 latest, and no `opencode-ai@1.17.13` remains; if PR #1168 has made workflow files a trust root by then, follow its ceremony. Verify: `rg -n "opencode[^ ]*[@ v=]2\.[0-9]+\.[0-9]+" .github/workflows/ci.yml && ! rg -n "opencode-ai@1\." .github/workflows/ci.yml`
30. **Docs state the v2 requirement and gaps:** `docs/integrations/opencode.md` and `plugins/adlc-opencode/README.md` state that OpenCode >= 2.0.20 is required, show the `plugins` config, and list the known gaps (no TUI toasts, autocontinue not ported, rail notice fixed at load, observed `permission.evaluate` status). They also name where stderr lands (`opencode debug paths`). Verify: `for f in docs/integrations/opencode.md plugins/adlc-opencode/README.md; do for t in '2\.0\.20' '"plugins"' 'toast' 'autocontinue' 'opencode debug paths' 'permission\.evaluate'; do rg -q "$t" "$f" || { echo "$f missing $t"; exit 1; }; done; done`
31. **Docs truth and records:** `apps/docs/lib/integration-facts.mjs` matches the docs, ADR 0004 has a v2-only addendum, and CHANGELOG records the breaking change. Verify: `node --test scripts/test/docs-truth.test.mjs && rg -n "v2-only" docs/adr/0004-adlc-opencode-integration.md && git diff origin/main -- CHANGELOG.md | rg -n "^\+.*@opencode/plugin"`
32. **All gates pass:** tests, rail-freeze and mutation-gate pass against a freshly fetched base. Verify: `npm run preflight`

## Approved assumptions (residual after the final parallax pass)

- The CI install method is whatever the v2 install docs specify at build time.
  AC 29 checks only that one exact 2.x version is pinned and no 1.x remains.
- The keyless bridge uses the v2 session methods that `@opencode/client`'s
  `SessionApi` types expose. The builder takes the exact method names from those
  types, not from the v1 bridge.

## Out of scope

- A companion TUI plugin and toasts (rejected at P1).
- Supporting OpenCode v1 (rejected at P0).
- Any change to rails or build-gate semantics beyond decision 6.

## Premortem: failure causes folded in

| # | Failure cause | Where the spec handles it |
| --- | --- | --- |
| 1 | The v2 host logs a throw from `execute.before` without aborting the call, so every deny fails open | AC 3 is the merge gate. If the throw doesn't abort, stop and re-enter P1; don't switch to advisory. |
| 2 | Registrations not awaited, so early tool calls run unguarded | Design (awaited registrations), AC 7g |
| 3 | `shell` `workdir` is a hidden cwd change that gets past rails | Decision 6 (`workdir` treated as `cd`), AC 8 |
| 4 | Events read with the v1 shape (`properties.sessionID`), so the build-gate never sees compaction | Design (`data.sessionID`), AC 7 (typed event factories) |
| 5 | The server-wide event stream drives the watcher for another project | Design (location filter), AC 7i |
| 6 | The event iterator ends on a service reconnect and tracking stops silently | Design (resubscribe with backoff), AC 7h |
| 7 | The workspace-linked plugin works but the published package doesn't load | AC 2 (installed `npm pack` tarball) |
| 8 | stderr-only notifications hide an `advisoryHooks: true` downgrade | Accepted at P1 (decision 5). AC 12 docs name the log location (`opencode debug paths`) and state that CI rail-freeze stays authoritative. |
| 9 | Mismatched `Tool.Result` shape: `adlc_gate` errors at runtime while unit tests pass | Confirm `Tool.Result` against `@opencode/schema` before writing; AC 5 asserts the gate output reaches the mock model |
