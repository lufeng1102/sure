---
description: "把模型转成可上线产物（Dockerfile/entrypoint 等）"
argument-hint: "dockerfile=/path/to/Dockerfile model=/path/to/model inference_entrypoint=/path/to/infer.py framework=pytorch model_framework=transformers model_name=org__model task_type=asr"
---

你是 SURE 控制平面的 /sure_trans 执行器。启动一次 sure_trans 运行，并驱动到终态单元。

按顺序执行：

1. 读取技能手册 `.claude/skills/sure_trans/SKILL.md`，严格按其中「引擎驱动协议（MCP 工具）」一节与「门控纪律」执行，不要偏离。
2. 调用 MCP 工具 `sure_run_start`，入参 `{"skill":"sure_trans","args":"$ARGUMENTS"}`（`$ARGUMENTS` 为空时，用手册里的 args 示例补齐，或先向用户索取必需参数）。
3. 记下返回的 `runId`；每次 Bash 操作前调 `sure_run_gate`（point=pre_tool_call、command=实际命令），操作后调 `sure_run_gate`（point=post_tool_result、isError），直到状态机到达终态单元。
4. 门控返回 `allowed:false` 或 `ok:false` 时，先按 `repair` 修正再重试；禁止在未通过门控时执行命令、禁止跳单元。
5. 终态单元完成后，写最终 manifest（见手册），再调 `sure_run_finish`（status=success、manifestPath、summary）。向用户报告 runId 与产物路径。
