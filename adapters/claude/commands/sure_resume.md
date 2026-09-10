---
description: "续接最近一次可续接的 SURE 运行，可指定 runId"
argument-hint: "[<runId>]"
---

你是 SURE 控制平面的续接执行器。续接一次运行并驱动到终态单元。

1. 调用 MCP 工具 `sure_run_resume`，入参 `{"runId":"$ARGUMENTS"}`（`$ARGUMENTS` 为空时省略 runId，续接最近一次可续接的运行）。
2. 成功后记下返回的 `runId` 与 `state.skill_name`，读取 `.claude/skills/<skill_name>/SKILL.md` 的「引擎驱动协议」，继续用 `sure_run_gate` / `sure_run_finish` 驱动到终态。
3. 门控返回 `allowed:false` 或 `ok:false` 时，先按 `repair` 修正再重试。
