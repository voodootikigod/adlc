# ADLC installer for Windows — https://www.agenticlifecycle.ai
#
#   irm https://www.agenticlifecycle.ai/install.ps1 | iex
#
# STATUS: beta. The gate toolkit is Node and zero-dependency, so the core gates
# run on Windows and are covered by a windows-latest CI job. Two limits are
# real and are not worked around here:
#
#   * `adlc fleet` is POSIX-only. It shells out through /bin/sh and uses POSIX
#     sandbox backends, so parallel ticket orchestration is not available on
#     Windows. Every other gate is.
#   * Harness coverage is narrower than on macOS/Linux, because several agent
#     harnesses ship no Windows CLI. Only harnesses actually found are touched.
#
# Report Windows issues at https://github.com/voodootikigod/adlc/issues.
#
# This script is a supply-chain trust root (see ADR-0010 in the ADLC repo). It
# is content-pinned by scripts/test/install-digests.json.
#
# Environment:
#   $env:ADLC_SKIP_HARNESSES = '1'   install the toolkit only
#   $env:ADLC_CLI_TAG = 'next'       install a dist-tag other than latest

$ErrorActionPreference = 'Stop'

$CliPackage   = '@adlc/cli'
$CliTag       = if ($env:ADLC_CLI_TAG) { $env:ADLC_CLI_TAG } else { 'latest' }
$Site         = 'https://www.agenticlifecycle.ai'
$MinNodeMajor = 18

$Installed = New-Object System.Collections.Generic.List[string]
$Manual    = New-Object System.Collections.Generic.List[string]
$Failed    = New-Object System.Collections.Generic.List[string]

function Write-Log  { param([string]$Message) Write-Host "  > $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "  + $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }
function Write-Err  { param([string]$Message) Write-Host "  x $Message" -ForegroundColor Red }

function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Show-Banner {
    Write-Host ''
    Write-Host '   ADLC - the Agentic Development Lifecycle'
    Write-Host "   $Site"
    Write-Host '   Windows support is beta.'
    Write-Host ''
}

# Node is a hard prerequisite. We explain and stop rather than downloading and
# running a Node installer: silently installing a language runtime is not a
# decision an install script should make on a user's behalf.
function Assert-Node {
    if (-not (Test-Command 'node')) {
        Write-Err "Node.js $MinNodeMajor+ is required and was not found on PATH."
        Write-Err 'Install it from https://nodejs.org, then re-run this script.'
        exit 1
    }
    if (-not (Test-Command 'npm')) {
        Write-Err 'npm is required and was not found on PATH.'
        Write-Err 'It ships with Node.js - check your Node installation, then re-run this script.'
        exit 1
    }

    $nodeVersion = (& node -v) 2>$null
    if ($nodeVersion -notmatch '^v(\d+)\.') {
        Write-Err "Could not determine the Node.js version from '$nodeVersion'."
        Write-Err "Node.js $MinNodeMajor+ is required."
        exit 1
    }

    $major = [int]$Matches[1]
    if ($major -lt $MinNodeMajor) {
        Write-Err "Node.js $MinNodeMajor+ is required, found $nodeVersion."
        Write-Err 'Upgrade Node, then re-run this script. Nothing was installed.'
        exit 1
    }

    Write-Log "Node $nodeVersion"
}

function Install-Toolkit {
    Write-Log "installing $CliPackage@$CliTag"
    & npm install -g "$CliPackage@$CliTag"
    if ($LASTEXITCODE -ne 0) {
        Write-Err "npm install -g $CliPackage@$CliTag failed."
        Write-Err 'If this is a permissions error, re-run in an elevated shell.'
        exit 1
    }
    Write-Ok "gate toolkit installed - 'adlc --version'"
}

# A harness whose install fails must not abort the run: the others on the
# machine are still worth installing, and the summary reports every failure.
function Install-Harness {
    param([string]$Label, [scriptblock]$Action)
    try {
        & $Action
        if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" }
        Write-Ok $Label
        $Installed.Add($Label)
    } catch {
        Write-Warn "${Label}: install command failed - see $Site/integrations"
        $Failed.Add($Label)
    }
}

function Install-Harnesses {
    if ($env:ADLC_SKIP_HARNESSES -eq '1') {
        Write-Log 'ADLC_SKIP_HARNESSES=1 - skipping harness detection'
        return
    }

    Write-Host ''
    Write-Log 'looking for agent harnesses'

    if (Test-Command 'claude') {
        Write-Log 'Claude Code detected'
        Install-Harness 'Claude Code' { & npx --yes plugins add voodootikigod/adlc }
    }

    if (Test-Command 'codex') {
        Write-Log 'Codex detected'
        Install-Harness 'Codex' {
            & codex plugin marketplace add voodootikigod/adlc --ref main
            if ($LASTEXITCODE -ne 0) { return }
            & codex plugin add adlc-codex@adlc
        }
    }

    if (Test-Command 'opencode') {
        Write-Log 'OpenCode detected'
        Install-Harness 'OpenCode' { & npx --yes @adlc/opencode init }
    }

    if (Test-Command 'pi') {
        Write-Log 'pi detected'
        Install-Harness 'pi' { & pi install -l npm:@adlc/pi }
    }

    # Cursor installs plugins through its in-app marketplace UI; there is no
    # supported shell command, so we tell the user rather than guessing.
    if ((Test-Command 'cursor') -or (Test-Path (Join-Path $HOME '.cursor'))) {
        Write-Log 'Cursor detected'
        $Manual.Add('Cursor')
    }

    # @adlc/copilot is not published to npm yet.
    if (Test-Command 'copilot') {
        Write-Log 'GitHub Copilot CLI detected'
        $Manual.Add('GitHub Copilot')
    }
}

function Show-Summary {
    Write-Host ''
    if ($Installed.Count -gt 0) { Write-Ok  ("installed for: " + ($Installed -join ', ')) }
    if ($Failed.Count    -gt 0) { Write-Warn ("failed for: " + ($Failed -join ', ') + " - see $Site/integrations") }
    if ($Manual.Count    -gt 0) {
        Write-Warn ("manual step needed for: " + ($Manual -join ', '))
        Write-Host '      Cursor:  Settings -> Plugins -> Add marketplace -> https://github.com/voodootikigod/adlc, then install adlc-cursor'
        Write-Host '      Copilot: adlc init --harness copilot   (the plugin package is not yet on npm)'
    }
    if ($Installed.Count -eq 0 -and $Failed.Count -eq 0 -and $Manual.Count -eq 0) {
        Write-Warn 'no agent harness detected - the gate toolkit works standalone'
        Write-Host "      Native integrations: $Site/integrations"
    }

    Write-Host ''
    Write-Host '  Next: bootstrap a repository'
    Write-Host ''
    Write-Host '      cd C:\path\to\your\repo'
    Write-Host '      adlc init'
    Write-Host ''
    Write-Host '  Note: adlc fleet is POSIX-only and is not available on Windows.'
    Write-Host '  Every other gate runs. Report Windows issues at'
    Write-Host '      https://github.com/voodootikigod/adlc/issues'
    Write-Host ''
}

Show-Banner
Assert-Node
Install-Toolkit
Install-Harnesses
Show-Summary
