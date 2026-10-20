#!/usr/bin/env pwsh
# ──────────────────────────────────────────────────────────────────────────────
#  kairos.ps1 — the front door (PowerShell).
#
#    .\kairos                 make sure the daemon is up, open the TUI attached
#    .\kairos <verb> [...]    kernel CLI passthrough (usage, ontology, llm,
#                             missions, say, status, ...)
#
#  No model/endpoint/key handling here: credentials live in the encrypted
#  vault and models in the registry — the launcher only launches.
# ──────────────────────────────────────────────────────────────────────────────

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cli       = Join-Path $ScriptDir "src\kernel\cli.js"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node not found. Install Node.js 18+ from https://nodejs.org"
  exit 1
}

if ($args.Count -eq 0) {
  # `start` is idempotent — a running daemon just says so.
  & node $Cli start
  & node (Join-Path $ScriptDir "apps\tui\index.js") --daemon --root $ScriptDir
  exit $LASTEXITCODE
}

& node $Cli @args
exit $LASTEXITCODE
