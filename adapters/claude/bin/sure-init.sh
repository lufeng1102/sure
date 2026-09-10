#!/usr/bin/env bash
# Simplified SURE runtime init: site policy + Python/engine/eval-submodule health check.
# Idempotent, non-destructive. Writes .sure/init.json (git-ignored) with the verdicts.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }

say "==> SURE 运行时初始化体检 ($REPO_ROOT)"

# 1. site policy
SITE_OK=1
if [ -f "$REPO_ROOT/config/site.local.yaml" ]; then
  ok "config/site.local.yaml 已存在"
else
  if [ -f "$REPO_ROOT/config/site.example.yaml" ]; then
    cp "$REPO_ROOT/config/site.example.yaml" "$REPO_ROOT/config/site.local.yaml"
    ok "已从 config/site.example.yaml 生成 config/site.local.yaml"
  else
    warn "缺 config/site.example.yaml，无法生成 site.local.yaml"
    SITE_OK=0
  fi
fi
if [ "$SITE_OK" = 1 ]; then
  if grep -qE '/srv/sure|/var/cache/sure|/var/lib/sure|registry\.example\.com' "$REPO_ROOT/config/site.local.yaml" 2>/dev/null; then
    warn "site.local.yaml 仍含示例占位路径（/srv/sure 等），请改为真实路径"
  else
    ok "site.local.yaml 无示例占位路径"
  fi
fi

# 2. python (Harness Runtime locks 3.11)
PY_OK=0
if command -v python3 >/dev/null 2>&1; then
  PYV="$(python3 -c 'import sys;print(".".join(map(str,sys.version_info[:2])))' 2>/dev/null || echo '?')"
  if [ "$PYV" = "3.11" ]; then
    ok "python3 == 3.11（Harness Runtime 锁定版本）"
    PY_OK=1
  else
    warn "python3 == ${PYV}，Harness Runtime 锁 3.11；请安装 python3.11"
  fi
else
  warn "未找到 python3；Harness Runtime 需要 Python 3.11"
fi

# 3. engine build
ENGINE_OK=1
if [ -x "$REPO_ROOT/sure-engine/dist/cli.js" ] && [ -x "$REPO_ROOT/sure-engine/dist/mcp.js" ]; then
  ok "sure-engine 已构建（cli + mcp）"
else
  warn "sure-engine 未构建：cd sure-engine && npm run build"
  ENGINE_OK=0
fi

# 4. evaluation submodule
EVAL_OK=1
if [ -d "$REPO_ROOT/sure/external/sure-evaluation" ] && [ -n "$(ls -A "$REPO_ROOT/sure/external/sure-evaluation" 2>/dev/null)" ]; then
  ok "sure/external/sure-evaluation 已初始化"
elif [ -d "$REPO_ROOT/sure/external/sure-evaluation" ]; then
  warn "sure/external/sure-evaluation 为空：git submodule update --init --recursive"
  EVAL_OK=0
else
  warn "缺 sure/external/sure-evaluation 目录"
  EVAL_OK=0
fi

# 5. skills + write init.json
mkdir -p "$REPO_ROOT/.sure"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node - "$REPO_ROOT" "$NOW" "$SITE_OK" "$PY_OK" "$ENGINE_OK" "$EVAL_OK" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [repo, now, siteOk, pyOk, engineOk, evalOk] = process.argv.slice(2);
const skillsDir = path.join(repo, "sure", "skills");
const skills = fs.readdirSync(skillsDir).filter((d) => fs.existsSync(path.join(skillsDir, d, "sure.skill.json")));
console.log("  [ok]   发现 " + skills.length + " 个技能：" + skills.join(", "));
const manifest = {
  initializedAt: now,
  version: 1,
  pythonOk: pyOk === "1",
  sitePolicy: siteOk === "1",
  engineBuilt: engineOk === "1",
  evalSubmodule: evalOk === "1",
  availableSkills: skills,
};
const out = path.join(repo, ".sure", "init.json");
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log("  体检结果已写入 " + out);
NODE

say "初始化完成。剩余待办见上方 [warn] 项。"
