#!/bin/sh
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

set -eu

CLI_PACKAGE="@adlc/cli"
CLI_TAG="${ADLC_CLI_TAG:-latest}"
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
        ok "gate toolkit installed — 'adlc --version'"
    else
        err "npm install -g ${CLI_PACKAGE}@${CLI_TAG} failed."
        err "If this is a permissions error, either fix your npm prefix"
        err "(npm config set prefix ~/.local) or re-run with sudo."
        exit 1
    fi
}

# Each harness records its own outcome. A harness whose install fails must not
# abort the run: the other harnesses on the machine are still worth installing,
# and the summary reports every failure at the end.
record_installed() { INSTALLED="${INSTALLED}${INSTALLED:+, }$1"; }
record_manual()    { MANUAL="${MANUAL}${MANUAL:+, }$1"; }
record_failed()    { FAILED="${FAILED}${FAILED:+, }$1"; }

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
    try "Claude Code" npx --yes plugins add voodootikigod/adlc
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

install_opencode() {
    have opencode || return 0
    log "OpenCode detected"
    try "OpenCode" npx --yes @adlc/opencode init
}

install_pi() {
    have pi || return 0
    log "pi detected"
    try "pi" pi install -l npm:@adlc/pi
}

install_antigravity() {
    have agy || return 0
    log "Google Antigravity detected"
    # `agy plugin install` only accepts a filesystem path, so the plugin has to
    # land on disk first.
    if npm install -g @adlc/antigravity && agy plugin install "$(npm root -g)/@adlc/antigravity"; then
        ok "Google Antigravity"
        record_installed "Google Antigravity"
    else
        warn "Google Antigravity: install command failed — see ${SITE}/integrations/antigravity"
        record_failed "Google Antigravity"
    fi
}

install_herdr() {
    have herdr || return 0
    log "herdr detected"
    try "herdr" herdr plugin install voodootikigod/adlc/plugins/adlc-herdr
}

# Cursor installs plugins through its in-app marketplace UI; there is no
# supported shell command, so we tell the user rather than guessing.
install_cursor() {
    if ! have cursor && [ ! -d "${HOME}/.cursor" ]; then
        return 0
    fi
    log "Cursor detected"
    record_manual "Cursor"
}

# @adlc/copilot is not published to npm yet. Detecting Copilot and printing the
# current path is honest; pretending there is an automated one is not.
install_copilot() {
    have copilot || return 0
    log "GitHub Copilot CLI detected"
    record_manual "GitHub Copilot"
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
    if [ -n "$MANUAL" ]; then
        warn "manual step needed for: ${MANUAL}"
        printf '      Cursor:  Settings -> Plugins -> Add marketplace -> https://github.com/voodootikigod/adlc, then install adlc-cursor\n'
        printf '      Copilot: adlc init --harness copilot   (the plugin package is not yet on npm)\n'
    fi
    if [ -z "$INSTALLED" ] && [ -z "$FAILED" ] && [ -z "$MANUAL" ]; then
        warn "no agent harness detected — the gate toolkit works standalone"
        printf '      Native integrations: %s/integrations\n' "$SITE"
    fi

    printf '\n'
    printf '  Next: bootstrap a repository\n\n'
    printf '      cd /path/to/your/repo\n'
    printf '      adlc init\n\n'
    printf '  Then wire the CI rail control (the unbypassable one):\n'
    printf '      %s/docs/reference/adlc-runtime\n\n' "$SITE"
}

banner
require_node
install_toolkit
install_harnesses
summary
