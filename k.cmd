@echo off
REM k.cmd - short alias for the Kairos kernel CLI.
REM   k usage                    k ontology history
REM   k llm check mini54         k ontology verify btoshop --model mini54
node "%~dp0src\kernel\cli.js" %*
