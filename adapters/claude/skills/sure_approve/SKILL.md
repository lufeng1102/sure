---
name: sure_approve
description: 当需要审计并显式批准一个已完成的 onboard 或 trans 模型包、使其原子发布给 /sure_infer 时使用。触发条件：用户要 approve/批准/审核/发布模型，或对已完成的模型包做上线审批。
---

# /sure_approve

Audit a completed `/sure_onboard` or `/sure_trans` bundle without mutating it, bind a human decision to the audited candidate, then publish it atomically for `/sure_infer`.

## Parameters

| Parameter | Required | Meaning |
| --- | --- | --- |
| `model_dir` | audit mode | Explicit readable producer bundle. Absolute paths and paths relative to the invocation directory are accepted. |
| `mode` | no | `audit` (default) or `approve`. |
| `repair` | no | `safe` (default) or `none`. Safe repair never changes executable behavior. |
| `review_manifest` | approve mode | `review_packet.json` emitted by a completed audit. |
| `decision` | approve mode | Explicitly `approve` or `reject`. The agent must never infer this value. |
| `replace` | no | Default `false`; an existing destination blocks publication. |
| `max_retries` | no | Gate retry limit; default 3. |

## Workflow

Run audit first:

```text
/sure_approve model_dir=/path/to/completed/model
```

The audit creates an isolated candidate under the run directory, verifies the producer contract and runtime, and ends with `review_packet.json` in `awaiting_approval`. It never writes to the approval root.

Read the review packet, make the decision yourself, then start a separate approval run:

```text
/sure_approve mode=approve review_manifest=/path/to/review_packet.json decision=approve
```

Approval verifies that the packet and candidate are unchanged. A positive decision publishes through a hidden same-filesystem sibling and atomic rename. A rejection records the decision and does not publish.

The publication root is always `storage.approved_models_roots[0]` from the active site policy. `/sure_infer` discovers approved model names below that same root, so the deployment configures it once and no command-level publication-root override exists.

## Boundaries

- Do not mutate the producer directory.
- Reject incomplete, failed, API-ready, and `docker-local` products.
- Accept Docker v1 only with a digest-pinned, pull-verified registry image.
- Accept Python v2 only with a sealed `uv` Model Runtime and site policy enabling local Python.
- Require passing original, adapter, MCP, and equivalence evidence for `/sure_trans`.
- Restrict safe repair to derived paths, publication permissions, and excluded caches. Never repair wrappers, configs, weights, payloads, locks, runtimes, images, provenance, or failed validation.
- Reject source/destination overlap, escaping links, special files, and destination collisions.
- Reject review packets whose destination does not match the active site's configured approved model root.
- Never create the human decision. Require the user-supplied `decision` parameter.

Read [producer-contracts.md](references/producer-contracts.md) when classifying the producer or diagnosing a failed audit. Read [repair-policy.md](references/repair-policy.md) before accepting or describing a repair.

## State Machine

Audit mode runs units 1-8; approve mode resumes from the prior packet and runs units 9-11.

| # | Unit | Product |
| --- | --- | --- |
| 1 | `resolve_input` | `approve_input_resolved.json` |
| 2 | `classify_producer` | `producer_contract_report.json` |
| 3 | `audit_integrity` | `integrity_report.json` |
| 4 | `plan_repairs` | `repair_plan.json` |
| 5 | `apply_repairs` | `repair_report.json` |
| 6 | `seal_candidate` | `approval_manifest.json` |
| 7 | `verify_runtime` | `runtime_verification.json` |
| 8 | `prepare_review` | `review_packet.json` |
| 9 | `verify_decision` | `approval_decision.json` |
| 10 | `publish` | `publication_result.json` |
| 11 | `verify_publication` | `approval_ready.json` |

Run only the current unit's script with Harness Python from this package. Each script accepts `--run-dir` and `--produces`; `resolve_approve_input.py` additionally receives invocation parameters. Do not call producer scripts to manufacture missing evidence.

## 引擎驱动协议（Claude Code 适配层）

本技能由 agent 无关的 `sure-engine` MCP 服务器驱动（结构化工具调用，而非手写 bash）。启动、门控、结束都通过 MCP 工具完成；未装 MCP 时用文末的 bash 兜底。

### 命令序列（MCP 工具）

1. 启动运行（执行 pre_start 门控）：调用 `sure_run_start`，入参
   `{ "skill": "sure_approve", "args": "<用户参数>" }`。若用户以 `/sure_approve <参数>` 带入参数就用它；否则用手册 args 示例（如 `model_dir=/path/to/completed/model`）补齐，或先向用户索取必需参数。
   成功返回 `{ ok:true, runId, prompt, record, state }`，**记下 runId**；失败返回 `{ ok:false, repair }`，按 repair 修正后重试。

2. 每次 Bash 操作**前**：调用 `sure_run_gate`，入参
   `{ "runId": "<runId>", "point": "pre_tool_call", "tool": "bash", "command": "<实际命令>" }`。
   返回 `allowed:false` 时**不得执行**该命令，按 `repair` 修正后重新门控。

3. 执行 shell 命令。

4. 每次 Bash 操作**后**：调用 `sure_run_gate`，入参
   `{ "runId": "<runId>", "point": "post_tool_result", "tool": "bash", "isError": <true|false> }`。
   这是状态机推进点；`allowed:false` 表示当前单元产物未通过门控，按 `repair` 修产物后再次 post 门控，不跳单元。

5. 重复 2–4，直到状态机到达终态单元。

6. 结束运行：先写最终 manifest（见下），再调用 `sure_run_finish`，入参
   `{ "runId": "<runId>", "status": "success", "manifestPath": ".sure/runs/<runId>/manifest.json", "summary": "<摘要>" }`。
   manifest 校验或 pre_finish 门控失败返回 `{ ok:false, repair }`，按 repair 修 manifest/产物后再 finish。

其它工具：`sure_run_state`（查状态，`{runId}`）、`sure_run_resume`（续接，`{runId}` 可省）、`sure_run_on_error`（出错收尾，`{runId, reason}`）。

### 门控纪律（必须）

- run 启动后，**每次** Bash 操作都必须先 `sure_run_gate`（pre_tool_call）、后 `sure_run_gate`（post_tool_result），不许跳过。
- pre 门控 `allowed:false`：不执行该命令，先修。
- post 门控 `allowed:false`：当前单元未通过，先修产物，不跳单元、不盲跑。
- 状态机只在 post 门控通过时推进；不要手动改 `.sure/runs/<runId>/state.json` 或 checkpoint。
- 若安装了 `install.sh --with-hooks` 硬拦截，中间门控由 Claude hooks 自动执行，agent 只需 start/finish。

### 无 MCP 时 bash 兜底

`node <repo>/sure-engine/dist/cli.js run start|gate|finish|state|resume|on-error ...`，与上述 MCP 工具一一对应（参数与工具入参一致，`--cwd <repo>` 指向含 `sure/skills/` 的目录）。

### 最终 manifest

最终 manifest 是 JSON，必须含 `schema_version`、`run_id`、`skill_name`、`status`、`created_at`、`inputs`、`outputs`、`validation`，且 `run_id`/`skill_name`/`status` 与实际一致；`status=success` 时还必须列齐本技能 required 产物（写进 `outputs`，path 指向真实存在的文件）。

```json
{
  "schema_version": "1.0",
  "run_id": "<runId>",
  "skill_name": "sure_approve",
  "status": "success",
  "created_at": "<ISO时间戳>",
  "inputs": { "args": "model_dir=/path/to/completed/model" },
  "outputs": {
    "<artifact_type>": { "type": "<artifact_type>", "path": ".sure/runs/<runId>/artifacts/<file>" }
  },
  "validation": { "state_machine_complete": true }
}
```

本技能 required 产物：无（本技能 `sure.skill.json` 未声明 `required: true` 产物，但 `pre_finish` 仍校验终态单元产物）。审计模式终态单元为 `prepare_review`（`review_packet.json`）；批准模式终态单元为 `verify_publication`（`approval_ready.json`）。完成时必须 `--status success`。

