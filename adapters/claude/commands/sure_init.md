---
description: "初始化 SURE 运行时（站点策略 + Python/引擎/评估引擎体检）"
---

你是 SURE 运行时初始化执行器。执行初始化脚本并报告结果。

1. 确定 SURE 仓库根目录 `<repo>`：读取项目根 `.mcp.json`，取 `mcpServers.sure.env.SURE_REPO_ROOT`（无 `.mcp.json` 时，用 `readlink -f .claude/skills/sure_feed` 上溯 4 层得到）。
2. 执行 `bash <repo>/adapters/claude/bin/sure-init.sh`。
3. 按其输出逐项处理：缺失的 `config/site.local.yaml` 会从示例生成，需用户填写的路径（storage/datasets/execution 等）要提示用户补齐；Python 非 3.11、引擎未构建、评估引擎子模块未初始化等告警，能自动修的修、不能的向用户说明。
4. 完成后报告 `.sure/init.json` 的体检结果与剩余待办。
