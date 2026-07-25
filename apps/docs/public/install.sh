#!/bin/sh
set -eu
{ # <- truncation guard opens on line 3; see the note at the top of the body.

# ADLC installer — https://www.agenticlifecycle.ai
#
#   curl -fsSL https://www.agenticlifecycle.ai/install.sh | sh
#
# Installs the @adlc/cli gate toolkit, then installs the native ADLC
# integration for every agent harness it finds on this machine. Harnesses that
# are not present are left alone: nothing is installed speculatively, and no
# harness's user-global config is touched unless that harness is installed.
#
# This script is a supply-chain trust root (see ADR-0010 in the ADLC repo). It
# is content-pinned by scripts/test/install-digests.json — editing it without
# updating that digest fails the repo's test suite.
#
# POSIX sh only: no bashisms, no arrays, no `local`, no `[[`.
#
# Environment:
#   ADLC_SKIP_HARNESSES=1   install the toolkit only, skip harness detection
#   ADLC_CLI_TAG=next       install a dist-tag other than latest
#
# THE BRACE ON LINE 3 is the `curl … | sh` truncation defense, and it opens that
# early on purpose. sh reads a pipe incrementally and executes as it goes, so a
# dropped connection runs whatever prefix arrived. EVERYTHING — constants,
# helpers, and the run sequence — is inside the group, which closes on the final
# line, so any truncation leaves the brace unclosed and sh refuses the file.
#
# Two weaker shapes were tried and rejected. Wrapping only the run sequence lets
# a cut between two complete function definitions parse fine, so sh exits 0
# having silently done nothing. Wrapping the body in a FUNCTION and calling it on
# the last line still leaves a window: a transfer ending after the closing brace
# but before the call is a complete, valid, no-op script that also exits 0.
#
# The header used to sit ABOVE the brace, leaving ~1.7KB of comments outside the
# guard — a drop anywhere in that prefix produced a valid no-op that exited 0.
# Moving the brace to line 3 shrinks that window to the shebang and `set -eu`.

CLI_PACKAGE="@adlc/cli"
CLI_TAG="${ADLC_CLI_TAG:-latest}"

# PINNED, unlike every documented `npx plugins add` a human types. ADR-0009
# Decision 3 refuses to version-pin the installer in docs, and that still holds
# there — a stale pinned instruction in a README is worse than an unpinned one.
# This call is different in kind: it runs UNATTENDED inside a `curl | sh`, so the
# user never chooses which version executes. Two independent cross-model reviews
# (codex, gemini) flagged the unpinned automated call; ADR-0010 Decision 8
# records why the narrower rule applies only here. Bump deliberately, with a
# review, when `plugins` releases.
PLUGINS_VERSION="1.3.4"
SITE="https://www.agenticlifecycle.ai"
MIN_NODE_MAJOR=18

INSTALLED=""
MANUAL=""
FAILED=""

log()  { printf '  \033[36m>\033[0m %s\n' "$1"; }
ok()   { printf '  \033[32m+\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
err()  { printf '  \033[31mx\033[0m %s\n' "$1" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

banner() {
    printf '\n'
    printf '   ADLC — the Agentic Development Lifecycle\n'
    printf '   %s\n\n' "$SITE"
}

# The toolkit is Node, not a static binary, so Node is a hard prerequisite.
# We explain and stop rather than fetching and running a Node installer:
# silently installing a language runtime is not something an install script
# should decide on a user's behalf.
# Native Windows (Git Bash / MSYS / Cygwin) has a POSIX shell, so this script
# WOULD run there and report success — while installing a toolkit that passes
# 6 of 28 core gate suites on that platform. WSL reports "Linux" from uname and
# is a supported path, so it is deliberately not caught here.
# ALLOWLIST, not a denylist. An earlier version only rejected Windows
# identifiers, so FreeBSD, OpenBSD, Solaris — and an absent or spoofed `uname`,
# which fell through as "unknown" — all proceeded to install globally on a
# platform this project does not claim to support.
require_supported_platform() {
    platform="$(uname -s 2>/dev/null || echo unknown)"
    case "$platform" in
        Linux|Darwin)
            ;;
        MINGW*|MSYS*|CYGWIN*|Windows_NT)
            err "native Windows is not supported yet."
            err "The toolkit passes only 6 of 28 core gate suites on Windows"
            err "(see ${SITE} and github.com/voodootikigod/adlc/issues/352)."
            err "Use WSL: install a Linux distro, then re-run this from inside it."
            exit 1
            ;;
        *)
            err "unsupported platform: ${platform}"
            err "This installer supports macOS (Darwin) and Linux. The toolkit is"
            err "Node and may well work elsewhere — but it is untested there, so"
            err "this script will not install it for you. Install manually with:"
            err "    npm install -g ${CLI_PACKAGE}"
            exit 1
            ;;
    esac
}

require_node() {
    if ! have node; then
        err "Node.js ${MIN_NODE_MAJOR}+ is required and was not found on PATH."
        err "Install it from https://nodejs.org (or via nvm/fnm/asdf), then re-run this script."
        exit 1
    fi
    if ! have npm; then
        err "npm is required and was not found on PATH."
        err "It ships with Node.js — check your Node installation, then re-run this script."
        exit 1
    fi

    node_version=$(node -v 2>/dev/null || echo "")
    node_major=$(printf '%s' "$node_version" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')
    # Minor matters: @adlc/pi's floor is 22.19, not 22.0.
    node_minor=$(printf '%s' "$node_version" | sed -n 's/^v[0-9][0-9]*\.\([0-9][0-9]*\).*/\1/p')
    [ -n "$node_minor" ] || node_minor=0
    if [ -z "$node_major" ]; then
        err "could not determine the Node.js version from '${node_version}'."
        err "Node.js ${MIN_NODE_MAJOR}+ is required."
        exit 1
    fi
    if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
        err "Node.js ${MIN_NODE_MAJOR}+ is required, found ${node_version}."
        err "Upgrade Node, then re-run this script. Nothing was installed."
        exit 1
    fi

    log "Node ${node_version}"
}

install_toolkit() {
    log "installing ${CLI_PACKAGE}@${CLI_TAG}"
    if npm install -g "${CLI_PACKAGE}@${CLI_TAG}"; then
        # npm exiting 0 proves the package was WRITTEN, not that it is runnable.
        # A custom prefix routinely puts the bin outside PATH, and reporting
        # success then telling the user to run `adlc init` sends them to a
        # command-not-found. Verify by actually running it.
        if adlc_version=$(adlc --version 2>/dev/null); then
            ok "gate toolkit installed — adlc ${adlc_version}"
            # Running `adlc` proves SOMETHING named adlc runs, not that it is the
            # binary npm just wrote. With several Node managers, or a stale
            # user-local copy earlier in PATH, the version reported here can come
            # from an install this script never touched — and the user would then
            # be running gates from a different toolkit than the one they think
            # they installed. Warn rather than fail: a shim on PATH is a
            # legitimate setup, and only the user can judge which they want.
            resolved=$(command -v adlc 2>/dev/null || echo "")
            expected_prefix=$(npm prefix -g 2>/dev/null || echo "")
            if [ -n "$resolved" ] && [ -n "$expected_prefix" ]; then
                case "$resolved" in
                    "${expected_prefix}"/*) ;;
                    *)
                        warn "the 'adlc' on your PATH is ${resolved},"
                        warn "not the one npm installed under ${expected_prefix}."
                        warn "A different toolkit may shadow it — check with 'command -v adlc'."
                        ;;
                esac
            fi
        else
            err "${CLI_PACKAGE} installed, but 'adlc' is not on your PATH."
            err "npm's global bin directory is probably not in PATH. Check:"
            err "    npm prefix -g        # then add its bin/ to PATH"
            err "Nothing else was installed; re-run once 'adlc --version' works."
            exit 1
        fi
    else
        err "npm install -g ${CLI_PACKAGE}@${CLI_TAG} failed."
        err "If this is a permissions (EACCES) error, point npm at a directory"
        err "you own — do NOT re-run this with sudo:"
        err "    npm config set prefix ~/.local"
        err "    export PATH=\"\$HOME/.local/bin:\$PATH\""
        err "Re-running a piped remote script as root escalates every byte this"
        err "site serves to root. A Node version manager (fnm, nvm) works too."
        exit 1
    fi
}

# Each harness records its own outcome. A harness whose install fails must not
# abort the run: the other harnesses on the machine are still worth installing,
# and the summary reports every failure at the end.
record_installed() { INSTALLED="${INSTALLED}${INSTALLED:+, }$1"; }
record_manual()    { MANUAL="${MANUAL}${MANUAL:+, }$1"; }
record_failed()    { FAILED="${FAILED}${FAILED:+, }$1"; }

# Did THIS harness need a manual step? Used so the summary prints instructions
# only for harnesses actually present.
manual_has() {
    case ", ${MANUAL}," in
        *", $1,"*) return 0 ;;
        *) return 1 ;;
    esac
}

try() {
    try_name=$1
    shift
    if "$@"; then
        ok "${try_name}"
        record_installed "$try_name"
    else
        warn "${try_name}: install command failed — see ${SITE}/integrations"
        record_failed "$try_name"
    fi
}

install_claude_code() {
    have claude || return 0
    log "Claude Code detected"
    # The Claude Code marketplace commands are slash commands inside the app,
    # not shell commands. The `plugins` installer is the documented shell path
    # (ADR-0009).
    #
    # Run it from a scratch directory with an explicit @latest tag. npx resolves
    # a BARE package name against the current project first, so a repository
    # containing a workspace or dependency named `plugins` would have its own
    # binary executed instead — and the agent-led flow runs from inside exactly
    # such a repository. A version spec forces registry resolution, and the
    # neutral cwd means there is no local project to resolve against. This is
    # not the version-pinning ADR-0009 Decision 3 rejects: @latest pins nothing,
    # it only refuses local shadowing.
    warn "Claude Code has no first-party shell install — delegating to the"
    warn "third-party 'plugins' npm package (see ADR-0010 Decision 8)."
    # Two --yes flags, and they are NOT redundant. The first belongs to npx
    # (auto-install the package); the trailing one belongs to `plugins` itself
    # (skip its confirmation prompt). npx consumes everything before the package
    # spec, so a single leading --yes never reaches the tool — and under
    # `curl … | sh` stdin is not a terminal, so an unanswered prompt hangs or
    # fails the install.
    npx_dir=$(mktemp -d) || { record_failed "Claude Code"; return 0; }
    # --target claude-code is REQUIRED, not tidiness. `plugins add` defaults to
    # auto-detect, which installs into EVERY agent tool it finds — and discovery
    # resolves this repo's .claude-plugin/marketplace.json, whose payload is the
    # Claude Code plugin. Unscoped, this branch would push the Claude plugin into
    # Codex, Cursor, and anything else present, colliding with the correct native
    # integrations that this same script installs for them.
    if (cd "$npx_dir" && npx --yes "plugins@${PLUGINS_VERSION}" add voodootikigod/adlc --target claude-code --yes); then
        ok "Claude Code"
        record_installed "Claude Code"
    else
        warn "Claude Code: install command failed — see ${SITE}/integrations/claude-code"
        record_failed "Claude Code"
    fi
    rm -rf "$npx_dir"
}

install_codex() {
    have codex || return 0
    log "Codex detected"
    if codex plugin marketplace add voodootikigod/adlc --ref main && codex plugin add adlc-codex@adlc; then
        ok "Codex"
        record_installed "Codex"
    else
        warn "Codex: install command failed — see ${SITE}/integrations/codex"
        record_failed "Codex"
    fi
}

# OpenCode's initializer is PROJECT-scoped: `@adlc/opencode init` defaults its
# root to the current working directory and writes .adlc/ and .opencode/ there.
# This script is machine-level and is normally run from $HOME (the documented
# flow is "install, THEN cd into your repo"), so running it here would scaffold
# the home directory and leave the actual repository untouched. Report it as a
# step to run inside the repo instead.
install_opencode() {
    have opencode || return 0
    log "OpenCode detected"
    record_manual "OpenCode"
}

# `pi install -l` is likewise the PROJECT install. The no-flag form is
# user-global, which is what a machine-level installer should do; the project
# form belongs in the repo, and the summary says so.
#
# @adlc/pi needs a HIGHER Node floor than the toolkit (22.19 vs 18). Installing
# it on Node 18 would "succeed" and then fail at runtime, so it is skipped with
# an explanation rather than installed into a broken state.
install_pi() {
    have pi || return 0
    log "pi detected"
    if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 19 ]; }; then
        warn "pi: @adlc/pi requires Node >= 22.19 (found ${node_version}) — skipped"
        record_manual "pi"
        return 0
    fi
    try "pi" pi install npm:@adlc/pi
}

install_antigravity() {
    have agy || return 0
    log "Google Antigravity detected"
    # `agy plugin install` only accepts a filesystem path, so the plugin has to
    # land on disk first. The path is then VERIFIED rather than assumed: with
    # version managers and custom prefixes, `npm install -g` can write somewhere
    # `npm root -g` does not report, and handing agy a non-existent path produces
    # a confusing downstream error instead of a clear one here.
    if ! npm install -g @adlc/antigravity; then
        warn "Google Antigravity: npm install failed — see ${SITE}/integrations/antigravity"
        record_failed "Google Antigravity"
        return 0
    fi

    agy_root=$(npm root -g 2>/dev/null || echo "")
    agy_plugin="${agy_root}/@adlc/antigravity"
    if [ -z "$agy_root" ] || [ ! -d "$agy_plugin" ]; then
        warn "Google Antigravity: @adlc/antigravity installed, but not found at"
        warn "  ${agy_plugin:-<npm root -g unavailable>}"
        warn "Locate it with 'npm root -g', then: agy plugin install <path>/@adlc/antigravity"
        record_manual "Google Antigravity"
        return 0
    fi

    if agy plugin install "$agy_plugin"; then
        ok "Google Antigravity"
        record_installed "Google Antigravity"
    else
        warn "Google Antigravity: agy plugin install failed — see ${SITE}/integrations/antigravity"
        record_failed "Google Antigravity"
    fi
}

install_herdr() {
    have herdr || return 0
    log "herdr detected"
    # --yes is required, not cosmetic: herdr refuses a remote plugin install
    # without it when stdin is non-interactive, which is exactly the `curl … | sh`
    # case this script is written for.
    try "herdr" herdr plugin install voodootikigod/adlc/plugins/adlc-herdr --yes
}

# Cursor installs plugins through its in-app marketplace UI; there is no
# supported shell command, so we tell the user rather than guessing.
#
# ${HOME:-} is deliberate: `set -u` turns an unset HOME into "unbound variable"
# and kills the whole install with an error that names nothing the user can act
# on. Containers and some CI shells run without HOME.
install_cursor() {
    if ! have cursor && [ ! -d "${HOME:-}/.cursor" ]; then
        return 0
    fi
    log "Cursor detected"
    record_manual "Cursor"
}

# Copilot ships a real native plugin via its Git marketplace (plugins/adlc-copilot:
# rails hook, build-gate, MCP, agents). An earlier version of this script called it
# a manual `adlc init --harness copilot` step because the @adlc/copilot NPM package
# is unpublished — but the marketplace path does not go through npm, so that
# under-delivered the integration that actually exists.
install_copilot() {
    have copilot || return 0
    log "GitHub Copilot CLI detected"
    if copilot plugin marketplace add voodootikigod/adlc && copilot plugin install adlc-copilot@adlc; then
        ok "GitHub Copilot"
        record_installed "GitHub Copilot"
    else
        warn "GitHub Copilot: install command failed — see ${SITE}/integrations"
        record_failed "GitHub Copilot"
    fi
}

install_harnesses() {
    if [ "${ADLC_SKIP_HARNESSES:-}" = "1" ]; then
        log "ADLC_SKIP_HARNESSES=1 — skipping harness detection"
        return 0
    fi
    printf '\n'
    log "looking for agent harnesses"
    install_claude_code
    install_codex
    install_cursor
    install_opencode
    install_pi
    install_antigravity
    install_herdr
    install_copilot
}

summary() {
    printf '\n'
    if [ -n "$INSTALLED" ]; then
        ok "installed for: ${INSTALLED}"
    fi
    if [ -n "$FAILED" ]; then
        warn "failed for: ${FAILED} — see ${SITE}/integrations"
    fi
    # Print ONLY the harnesses that actually need a manual step. Emitting all of
    # them whenever any one triggers hands the user instructions for software
    # they do not have, which is the same dishonesty as installing for absent
    # harnesses — just in prose.
    if [ -n "$MANUAL" ]; then
        warn "manual step needed for: ${MANUAL}"
        manual_has "Cursor" && printf '      Cursor:   Settings -> Plugins -> Add marketplace -> https://github.com/voodootikigod/adlc, then install adlc-cursor\n'
        manual_has "OpenCode" && printf '      OpenCode: run INSIDE your repo -- npx @adlc/opencode init   (it scaffolds the current directory)\n'
        manual_has "pi" && printf '      pi:       needs Node >= 22.19; upgrade Node, then "pi install npm:@adlc/pi"\n'
        manual_has "Google Antigravity" && printf '      Antigravity: @adlc/antigravity is installed but was not found under "npm root -g".\n                   Locate it, then: agy plugin install <path>/@adlc/antigravity\n'
    fi
    if [ -z "$INSTALLED" ] && [ -z "$FAILED" ] && [ -z "$MANUAL" ]; then
        warn "no agent harness detected — the gate toolkit works standalone"
        printf '      Native integrations: %s/integrations\n' "$SITE"
    fi

    # Say plainly when a detected harness was NOT wired up. "installed for: …"
    # alone reads as full coverage, and a machine whose only harness needs a
    # manual step would otherwise see a success banner and nothing installed.
    if [ -z "$INSTALLED" ] && [ -n "$MANUAL" ]; then
        warn "no harness was installed automatically — the step(s) above are still outstanding"
    fi

    printf '\n'
    printf '  Next: bootstrap a repository\n\n'
    printf '      cd /path/to/your/repo\n'
    printf '      adlc init\n\n'
    printf '  Then wire the CI rail control (the unbypassable one):\n'
    printf '      %s/docs/reference/adlc-runtime\n\n' "$SITE"
}

banner
require_supported_platform
require_node
install_toolkit
install_harnesses
summary

# A harness failure must not ABORT the run — the other harnesses on the machine
# are still worth installing — but it must not be reported as success either.
# `curl … | sh` surfaces this exit status to whatever automation invoked it, and
# a partial install that exits 0 is a silent lie to that caller.
if [ -n "$FAILED" ]; then
    exit 1
fi
exit 0

} # end truncation guard — a truncated download never reaches this brace
