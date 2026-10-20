@echo off
REM kairos.cmd - the front door.
REM   kairos                 make sure the daemon is up, open the TUI attached
REM   kairos <verb> [...]    kernel CLI passthrough (usage, ontology, llm,
REM                          missions, say, status, ...)
REM "kairos start" is idempotent, so the bare form never double-starts a daemon.
if "%~1"=="" (
  node "%~dp0src\kernel\cli.js" start
  node "%~dp0apps\tui\index.js" --daemon --root "%~dp0."
) else (
  node "%~dp0src\kernel\cli.js" %*
)
