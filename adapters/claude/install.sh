#!/usr/bin/env bash
# One-click installer: wire sure-harness into Claude Code for a project.
#
# What it does:
#   1. Builds sure-engine (if dist/cli.js or dist/mcp.js is missing, or with --rebuild).
#   2. Copies the six SURE skills into <project>/.claude/skills/.
#   3. Copies the slash commands (/sure_*) into <project>/.claude/commands/.
#   4. Copies config/site.example.yaml -> config/site.local.yaml (if missing).
#   5. Registers the sure-engine MCP server in <project>/.mcp.json (unless --no-mcp).
#   6. --with-hooks: merges the Bash gate hooks into <project>/.claude/settings.json.
#
# Usage:
#   install.sh [--project <dir>] [--no-mcp] [--with-hooks] [--rebuild]
#
#   --project <dir>   Claude Code project dir (where you run `claude`). Default: cwd.
#   --no-mcp          Skip writing the MCP server config (.mcp.json).
#   --with-hooks      Also install the hard-gating Bash hooks (auto gate every shell).
#   --rebuild         Rebuild sure-engine even if dist/cli.js already exists.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT_DIR="$(pwd)"
WITH_MCP=1
WITH_HOOKS=0
REBUILD=0
SKILLS=(sure_feed sure_onboard sure_trans sure_approve sure_infer sure_eval)

usage() {
  echo "usage: install.sh [--project <dir>] [--no-mcp] [--with-hooks] [--rebuild]" >&2
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT_DIR="${2:?--project requires a directory}"; shift 2 ;;
    --no-mcp) WITH_MCP=0; shift ;;
    --with-hooks) WITH_HOOKS=1; shift ;;
    --rebuild) REBUILD=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

echo "==> sure-harness -> Claude Code installer"
echo "    repo:    $REPO_ROOT"
echo "    project: $PROJECT_DIR"

# 1. engine build (cli + mcp)
if [ ! -x "$REPO_ROOT/sure-engine/dist/cli.js" ] || [ ! -x "$REPO_ROOT/sure-engine/dist/mcp.js" ] || [ "$REBUILD" = 1 ]; then
  echo "==> building sure-engine ..."
  (cd "$REPO_ROOT/sure-engine" && npm run build)
else
  echo "==> sure-engine already built ($REPO_ROOT/sure-engine/dist/)"
fi

# 2. skills (copied, so they live inside the project and Claude Code can read them)
echo "==> installing skills into $PROJECT_DIR/.claude/skills/"
mkdir -p "$PROJECT_DIR/.claude/skills"
for s in "${SKILLS[@]}"; do
  rm -rf "$PROJECT_DIR/.claude/skills/$s"
  cp -R "$REPO_ROOT/adapters/claude/skills/$s" "$PROJECT_DIR/.claude/skills/$s"
done
echo "    copied: ${SKILLS[*]}"

# 3. slash commands (copied, so they live inside the project)
echo "==> installing slash commands into $PROJECT_DIR/.claude/commands/"
mkdir -p "$PROJECT_DIR/.claude/commands"
for c in "$REPO_ROOT"/adapters/claude/commands/*.md; do
  cp "$c" "$PROJECT_DIR/.claude/commands/$(basename "$c")"
done
# remove stale commands no longer shipped (e.g. former per-skill commands now provided by skills)
for f in "$PROJECT_DIR"/.claude/commands/*.md; do
  [ -e "$REPO_ROOT/adapters/claude/commands/$(basename "$f")" ] || rm -f "$f"
done
echo "    copied: $(ls "$PROJECT_DIR/.claude/commands" | tr '\n' ' ')"

# 4. site policy
if [ ! -f "$REPO_ROOT/config/site.local.yaml" ]; then
  if [ -f "$REPO_ROOT/config/site.example.yaml" ]; then
    cp "$REPO_ROOT/config/site.example.yaml" "$REPO_ROOT/config/site.local.yaml"
    echo "==> created $REPO_ROOT/config/site.local.yaml (edit model/dataset/runtime paths)"
  else
    echo "!! warning: no config/site.example.yaml found; create config/site.local.yaml manually"
  fi
else
  echo "==> site policy present ($REPO_ROOT/config/site.local.yaml)"
fi

# 5. MCP server (structured tools; default on)
if [ "$WITH_MCP" = 1 ]; then
  echo "==> registering sure-engine MCP server in $PROJECT_DIR/.mcp.json"
  node - "$REPO_ROOT" "$PROJECT_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [repo, project] = process.argv.slice(2);
const mcpPath = path.join(project, ".mcp.json");
const mcp = fs.existsSync(mcpPath) ? JSON.parse(fs.readFileSync(mcpPath, "utf8")) : {};
mcp.mcpServers = mcp.mcpServers || {};
mcp.mcpServers.sure = {
  command: "node",
  args: [path.join(repo, "sure-engine", "dist", "mcp.js")],
  env: { SURE_REPO_ROOT: repo },
};
fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
console.log("    mcpServers.sure -> node " + path.join(repo, "sure-engine", "dist", "mcp.js"));
NODE
fi

# 6. hooks (optional hard gating)
if [ "$WITH_HOOKS" = 1 ]; then
  echo "==> merging Bash gate hooks into $PROJECT_DIR/.claude/settings.json"
  node - "$REPO_ROOT" "$PROJECT_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [repo, project] = process.argv.slice(2);
const examplePath = path.join(repo, "adapters/claude/hooks.example.json");
const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));
const settingsPath = path.join(project, ".claude", "settings.json");
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
settings.hooks = settings.hooks || {};
for (const [event, groups] of Object.entries(example.hooks)) {
  settings.hooks[event] = settings.hooks[event] || [];
  for (const group of groups) {
    const command = group.hooks[0].command.split("<repo>").join(repo);
    const exists = settings.hooks[event].some((g) => g.hooks.some((h) => h.command === command));
    if (!exists) {
      settings.hooks[event].push({ matcher: group.matcher, hooks: [{ type: "command", command }] });
    }
  }
}
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log("    hooks installed: PreToolUse + PostToolUse (Bash matcher)");
NODE
fi

echo
echo "Done. Next steps:"
echo "  1. Run \`/sure_init\` in Claude Code to check the runtime, or edit"
echo "     $REPO_ROOT/config/site.local.yaml and fill model/dataset/runtime paths."
echo "  2. Describe what you want, e.g. \"把这个模型上线\" / \"给这批预测打分\", or type"
echo "     a slash command directly: /sure_feed /sure_onboard /sure_trans /sure_approve"
echo "     /sure_infer /sure_eval /sure_resume."
if [ "$WITH_MCP" = 1 ]; then
  echo "  3. First run: approve the MCP server in Claude Code via /mcp (one-time per user)."
fi
if [ "$WITH_HOOKS" = 1 ]; then
  echo "  4. Hooks auto-gate every Bash call during a run (belt-and-suspenders on top of MCP)."
fi
echo
echo "Python note: the harness runtime locks Python 3.11; install it if a run reports"
echo "HARNESS_RUNTIME_NOT_READY."
