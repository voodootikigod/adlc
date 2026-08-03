# adlc-gemini

Embrace the ADLC inside Google Gemini (Antigravity `agy` and JetSki `jetski`): a phase-router plus doctrine skills and a `PreToolUse` rails-guard that freezes ADLC rails. Requires the `@adlc/cli` gate toolkit (`npm i -g @adlc/cli`).

## Install

**One-liner via npx (recommended):**

```sh
(cd "$(mktemp -d)" && npx @adlc/gemini@latest install)
```

**Global npm install:**

```sh
npm install -g @adlc/gemini
adlc-gemini install
```

**Local project install:**

```sh
npm install @adlc/gemini
./node_modules/.bin/adlc-gemini install
```

**From local checkout:**

```sh
node /abs/path/to/adlc/plugins/adlc-gemini/bin/cli.mjs install
```

Never hand the plugin directory to the agent CLI yourself. The CLI resolves its target as `plugin@marketplace` before deciding whether it is a filesystem path, so the `@` in `.../@adlc/gemini` is read as that separator and the install fails. The helper stages the plugin under an `@`-free path and installs from there.

The `@latest` above is load-bearing too: `npx @adlc/gemini` resolves a bare name against the current project first, so a repo shipping a workspace or dependency named `@adlc/gemini` would have its binary run instead. A version spec forces registry resolution.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADLC_AGY_TIMEOUT_MS` | `120000` | Wall-clock bound on each agent subprocess, in **milliseconds**. Must be a positive, finite number — anything else (including `0` and `Infinity`, both of which would disable the bound) is refused rather than silently ignored. Raise it if the agent CLI is legitimately slow: a cold cache or network-mounted storage can exceed 120s. |
| `ADLC_P4_ENFORCEMENT` | unset | Set to `1`, with an active ticket, to arm in-session rail enforcement. |

If an install fails with `timed out after 120000ms`, that is this bound — retry with a larger `ADLC_AGY_TIMEOUT_MS`.

## Manifest: `version` and `adlcContract`

`plugin.json` is the authoritative manifest. The installer copies the whole plugin directory (including `plugin.json`) to `~/.gemini/config/plugins/adlc-gemini/`, so consumers can read these fields directly from the installed source — no build step.

- **`version`** — `plugin.json`'s own manifest version, independent of `package.json`'s npm lockstep release version.
- **`adlcContract`** — a positive integer that versions the runtime contract between this plugin and its consumers. It exists so a consumer's manifest handshake can read it from the installed `plugin.json` to detect drift. The booster handshake uses it this way.

### When to bump `adlcContract`

`adlcContract` versions three interfaces. **Any breaking change to any one of them bumps the integer by 1.** Additive, backward-compatible changes do NOT bump it.

1. **The `tickets.json` schema accepted by `core-inline.mjs`.**
2. **The hook stdin payload shape.**
3. **The hook decision output shape.**

If you change one of these three interfaces in a backward-incompatible way, bump `adlcContract` in `plugin.json` and update this list.

## Tests

```bash
node --test plugins/adlc-gemini/test/*.test.mjs
```
