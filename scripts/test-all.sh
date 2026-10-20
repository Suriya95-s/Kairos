#!/usr/bin/env bash
# test-all.sh — the one-command "test everything" harness for the Kairos agent loop.
#
#   ./scripts/test-all.sh
#
# Runs the full unit/integration suite TWICE (proving determinism), the stress/load
# pass, a network-free end-to-end smoke of both renderers, and a syntax check of the
# hot entrypoints — then prints a clear PASS/FAIL summary. Exits non-zero on any
# failure so it is CI-friendly. No network, no live LLM required.
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
hr()   { printf '%.0s─' {1..72}; echo; }

# Extract "ℹ <key> <n>" counts from a `node --test` log.
count() { grep -E "^ℹ $2" "$1" | awk '{print $3}' | head -1; }

LOG1=$(mktemp); LOG2=$(mktemp); LOGS=$(mktemp)
trap 'rm -f "$LOG1" "$LOG2" "$LOGS"' EXIT

hr; echo "1/5  Full suite — run 1 (correctness)"; hr
node --test tests/*.test.js >"$LOG1" 2>&1
T1=$(count "$LOG1" tests); P1=$(count "$LOG1" pass); F1=$(count "$LOG1" fail)
echo "     tests=$T1 pass=$P1 fail=$F1"
[ "${F1:-1}" = "0" ] && ok "run 1 green ($P1/$T1)" || { bad "run 1 had $F1 failure(s)"; grep -E "^✖|not ok" "$LOG1" | head -20; }

hr; echo "2/5  Full suite — run 2 (determinism)"; hr
node --test tests/*.test.js >"$LOG2" 2>&1
T2=$(count "$LOG2" tests); P2=$(count "$LOG2" pass); F2=$(count "$LOG2" fail)
echo "     tests=$T2 pass=$P2 fail=$F2"
[ "${F2:-1}" = "0" ] && ok "run 2 green ($P2/$T2)" || bad "run 2 had $F2 failure(s)"
[ "${T1:-0}" = "${T2:-1}" ] && [ "${P1:-0}" = "${P2:-1}" ] && ok "deterministic (identical counts across runs)" || bad "non-deterministic: counts differ ($T1/$P1 vs $T2/$P2)"

hr; echo "3/5  Stress / load pass"; hr
node --test tests/stress.test.js >"$LOGS" 2>&1
SP=$(count "$LOGS" pass); SF=$(count "$LOGS" fail); SD=$(count "$LOGS" duration_ms)
echo "     pass=$SP fail=$SF duration_ms=${SD%.*}"
[ "${SF:-1}" = "0" ] && ok "stress green ($SP)" || { bad "stress had $SF failure(s)"; grep -E "^✖|not ok" "$LOGS" | head -20; }

hr; echo "4/5  End-to-end smoke (network-free: line mode + cockpit frame)"; hr
SMOKE=$(node --input-type=module -e '
import { formatEvent } from "./src/observability/lineRenderer.js";
import { state, setState } from "./apps/tui/src/state.js";
import { composeFrame } from "./apps/tui/src/app.js";
import { stripAnsi } from "./apps/tui/src/render.js";
const line = formatEvent({ type:"step", step:1, stage:"execution", tool:"run_command", arg:"node --test", thought:"go" });
setState({ showSplash:false, view:"live", status:"running", task:"smoke", step:1, stage:"execution",
  steps:[{step:1,tool:"run_command",arg:"x",thought:"t",result:"",error:false,startMs:1}],
  stepLatenciesMs:[], pendingApprovals:[], focusChain:[{text:"do it",state:"current"}] });
const frame = composeFrame(90,14).map(stripAnsi).join("\n");
const okLine  = /STEP 1 \[execution\] run_command/.test(line);
const okNow   = /NOW/.test(frame);
const okFocus = /focus:/.test(frame);
console.log((okLine && okNow && okFocus) ? "SMOKE_OK" : "SMOKE_FAIL line="+okLine+" now="+okNow+" focus="+okFocus);
' 2>&1)
echo "$SMOKE" | grep -q "SMOKE_OK" && ok "renderers compose end-to-end (line + NOW band + focus strip)" || { bad "smoke failed"; echo "     $SMOKE"; }

hr; echo "5/5  Syntax check (hot entrypoints)"; hr
SYN=0
for f in src/loop.js src/cli.js apps/tui/src/app.js src/agents/conductor.js; do
  node --check "$f" 2>/dev/null && echo "     ok  $f" || { echo "     ERR $f"; SYN=1; }
done
[ "$SYN" = "0" ] && ok "entrypoints parse" || bad "a hot entrypoint failed to parse"

hr; echo "SUMMARY:  PASS $PASS   FAIL $FAIL"; hr
[ "$FAIL" = "0" ] && { echo "✓ everything green"; exit 0; } || { echo "✗ failures above"; exit 1; }
