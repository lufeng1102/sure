#!/usr/bin/env bash
# SURE gate helper for Claude Code hooks.
#
# Usage (called from Claude Code hooks, see hooks.example.json):
#   sure-gate.sh pre_tool_call       # read the PreToolUse payload from stdin
#   sure-gate.sh post_tool_result    # read the PostToolUse payload from stdin
#
# Behaviour:
#   1. Resolve the repository root from $SURE_REPO_ROOT, else the hook payload's
#      `cwd`, else $CLAUDE_PROJECT_DIR, else the current working directory.
#   2. Resolve the active run id from <repo>/.sure/current-run (a plain text
#      file holding one run id). sure-engine writes it on `run start`/`run resume`
#      and removes it on `run finish`/`run on-error`.
#   3. Call `sure-engine run gate` for the given gate point.
#   4. When the gate returns allowed=false, print the repair to stderr and exit 2,
#      which is how a Claude PreToolUse hook blocks a tool call. Exit 0 otherwise.
#
# When there is no active run (.sure/current-run absent), every tool call is
# allowed: the hook is a no-op outside a SURE run.

set -u

point="${1:-}"
if [ "$point" != "pre_tool_call" ] && [ "$point" != "post_tool_result" ]; then
  echo "usage: sure-gate.sh <pre_tool_call|post_tool_result>" >&2
  exit 0
fi

# --- 1. repository root -------------------------------------------------------
REPO="${SURE_REPO_ROOT:-}"
if [ -z "$REPO" ]; then
  # Extract cwd from the hook payload (best-effort; empty when not JSON).
  REPO="$(node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => {
      try { process.stdout.write(JSON.parse(s || "{}").cwd || ""); }
      catch { process.stdout.write(""); }
    });
  ')"
fi
[ -z "$REPO" ] && REPO="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# --- 2. resolve the active run id ---------------------------------------------
RUN_ID=""
if [ -f "$REPO/.sure/current-run" ]; then
  RUN_ID="$(tr -d '[:space:]' < "$REPO/.sure/current-run" 2>/dev/null)"
fi
if [ -z "${RUN_ID:-}" ]; then
  # No active SURE run in this project: nothing to gate, allow the tool call.
  exit 0
fi

# --- 3. read the hook payload -------------------------------------------------
PAYLOAD="$(cat)"

# Extract tool / command / is_error in one node pass, tab-delimited.
read -r TOOL COMMAND IS_ERROR < <(printf '%s' "$PAYLOAD" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c));
  process.stdin.on("end", () => {
    let j = {};
    try { j = JSON.parse(s || "{}"); } catch {}
    const tool = j.tool_name || "bash";
    const cmd = (j.tool_input && typeof j.tool_input.command === "string") ? j.tool_input.command : "";
    const err = (j.tool_response && j.tool_response.is_error === true) ? "1" : "";
    process.stdout.write(tool + "\t" + cmd + "\t" + err);
  });
')
[ -z "${TOOL:-}" ] && TOOL="bash"

# --- 4. build the gate invocation ---------------------------------------------
ARGS=()
if [ "$point" = "pre_tool_call" ]; then
  if [ -z "$COMMAND" ]; then exit 0; fi
  INPUT_JSON="$(printf '%s' "$COMMAND" | node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => process.stdout.write(JSON.stringify({ command: s.trim() })));
  ')"
  ARGS=(--input-json "$INPUT_JSON")
else
  [ -n "$IS_ERROR" ] && ARGS+=(--is-error)
fi

RESULT="$(node "$REPO/sure-engine/dist/cli.js" run gate \
  --cwd "$REPO" \
  --run "$RUN_ID" \
  --point "$point" \
  --tool "$TOOL" \
  "${ARGS[@]}" 2>&1)"

# --- 5. block (exit 2) when the gate says allowed=false ------------------------
printf '%s' "$RESULT" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c));
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(s);
      if (j.allowed === false || j.ok === false) {
        process.stderr.write("SURE gate blocked: " + (j.repair || "see gate output") + "\n");
        process.exit(2);
      }
    } catch {}
  });
'
