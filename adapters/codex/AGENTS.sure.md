# SURE 控制平面（Codex 适配片段）

> 本段内容追加到 Codex 的 `AGENTS.md`（项目级 `AGENTS.md` 或全局 `~/.codex/AGENTS.md`）即可启用 SURE 技能。它通过 shell 调用 agent 无关的 `sure-engine` CLI 驱动一次 SURE 运行，零额外基础设施。

SURE 是一个"科学任务"控制平面。技能定义在 `sure/skills/<skill>/`，每个技能含 `sure.skill.json`（manifest）、`SKILL.md`（操作手册）、`hooks/`（状态机门控）、`scripts/`（确定性执行）、`schemas/`（产物契约）。引擎只负责运行生命周期与门控；领域逻辑在技能包内。

---

## 1. 引擎与仓库定位

- 引擎可执行文件：`<repo>/sure-engine/dist/cli.js`，统一用 `node <repo>/sure-engine/dist/cli.js` 调用。所有命令都写 JSON 到 stdout，成功/失败靠返回对象里的 `ok` 字段判断（不是靠退出码）。
- `--cwd <repo>` 必须指向一个包含 `sure/skills/` 与 `sure/site/loader.ts` 的目录（引擎启动时加载 `sure/site/loader.ts`）。
- 真实运行还要求站点策略：`config/site.local.yaml`（或 `config/site.bundled.yaml`）。技能 hook 在解析 `output_dir`、模型/数据集/运行时路径、以及 `/sure_approve` `/sure_infer` `/sure_eval` 时会读取它；缺失则 `start` 或相关 gate 返回 `ok:false` 并带 repair。首次可 `cp config/site.example.yaml config/site.local.yaml` 后按需修改。

约定：下文用 `ENGINE` 代表 `node <repo>/sure-engine/dist/cli.js`。注意 **`--cwd <repo>` 必须写在子命令之后**（引擎按前两个位置参数解析 `run <sub>`，`--cwd` 属于后面的选项）。同一轮运行内 `<repo>`、`<runId>` 保持不变。

---

## 2. 技能触发

用户提到以下任一技能意图时触发。触发后**先用 `read` 读取 `sure/skills/<skill>/sure.skill.json` 与 `sure/skills/<skill>/SKILL.md`**，拿到准确的参数表、单元契约（state machine）、红线与完成条件；`run start` 返回的 `prompt` 里也会内嵌完整 `SKILL.md`，以它为准，不要臆造参数或产物字段。

| 技能 | command | 用途（来自 manifest description） | 关键参数要点 |
|------|---------|----------------------------------|--------------|
| `/sure_feed` | `sure_feed` | 把 ModelScope / HuggingFace / GitHub 模型接入 SURE 流水线：发现候选、匹配 SURE 任务族、采集元数据、合成 `MODEL_INPUT`、排序选择，并产出交给 `/sure_onboard` 的 handoff manifest。 | `source`(modelscope/huggingface/github/multi)、`url`、`query`/`filter`、`max_models`、`download`、`handoff`、`handoff_root`。权威产物发布到 `sure/handoffs/<model_name>/model_input.yaml`。 |
| `/sure_onboard` | `sure_onboard` | 接入或修复一个模型、校验其推理契约，并封印（seal）digest 固定的容器，或站点批准的本机 Python Eval 绑定。 | 优先 `model`（handoff 目录名）或 `model_input_path`；无则需 `model_id`+`repo`+`task_type`+`deployment_type`。另有 `preferred_backend`、`package`/`package_profile`、`device`、`weights_source` 等。模型实体产物落在 `sure/models/<model_name>/`。 |
| `/sure_trans` | `sure_trans` | 把已有的 Docker 或锁定本地 Python 运行时、模型路径与推理入口，转换为 SURE Eval 部署 bundle。 | `dockerfile` 与 `python_executable` 二选一；另需 `model`、`inference_entrypoint`、`framework`(pytorch)、`model_framework`、`model_name`、`task_type`；Python 输入还需 `lockfile`。 |
| `/sure_approve` | `sure_approve` | 审计并显式批准一个已完成的 onboard/trans bundle，原子化发布到 SURE Eval。 | 两段式：先 `model_dir=<路径>` 审计产出 `review_packet.json`；再 `mode=approve review_manifest=<path> decision=approve\|reject` 批准。`decision` 只能由用户显式给出，agent 绝不代填。 |
| `/sure_infer` | `sure_infer` | 在选定数据集上运行已批准模型：校验其封印的运行时绑定，在批准的容器或可信宿主 Python 中启动打包好的推理入口，产出 `predictions/`、`protocol.yaml` 与参考投影供 `/sure_eval` 使用。 | `model`（已批准目录名）、`datasets`（逗号分隔）、`datasets_root`、`protocol`、`device`、`max_samples`、`execution`、`metrics`、`output_dir`。 |
| `/sure_eval` | `sure_eval` | 用锁定的 sure-evaluation 引擎，按 metric 或精确 `pipeline_id` 给既有 SURE 预测 bundle 打分，不跑模型推理。 | `model`、`datasets`（`<name>__<version_id>`）、`source`（run id 或绝对目录）、`pipeline_id` 与 `metrics` 二选一、`protocol`、`device`、`output_dir`。 |

触发方式：把用户给的技能名与参数原样放进 `run start --skill <command> --args '<k=v ...>'`（command 用无斜杠名，如 `sure_onboard`）。

---

## 3. 引擎驱动协议（每次 SURE 运行的完整命令序列）

一条硬规则贯穿全程：**run 启动后，agent 的每一次 shell（bash）操作，执行前必须过 `run gate --point pre_tool_call`，执行后必须过 `run gate --point post_tool_result`**。任何一次 gate 返回 `allowed:false`，都必须停下，按返回的 `repair` 修正后再重试，不得硬跑。

### 3.1 发现技能（可选）

```bash
ENGINE discover --cwd <repo>
# → {"packages":[{"manifest":{"command","name","description",...},...}],"diagnostics":[]}
```

用于核对可用技能与 `command` 名。`diagnostics` 非空时先处理（清单损坏会导致对应技能不可用）。

### 3.2 启动

```bash
ENGINE run start --cwd <repo> --skill <command> --args '<k=v ...>'
```

- 成功：`{ok:true, runId, prompt, record, state}`。**记下 `runId`**；`prompt` 内嵌了技能操作手册与调用信封，照做。
- 失败：`{ok:false, runId?, repair}`。按 `repair` 修正参数后重新 `start`（例如 `/sure_onboard` 缺 handoff 时会提示先跑 `/sure_feed`，或改用 `model_input_path`）。

### 3.3 每次 shell 前：pre_tool_call 门控

```bash
ENGINE run gate --cwd <repo> --run <runId> --point pre_tool_call --tool bash --input-json '{"command":"<要执行的完整命令>"}'
```

- `{ok:true, allowed:true, state}`：允许执行，照原命令跑。
- `{ok:false, allowed:false, repair, state}`：**禁止执行**。读 `repair`，修正命令（通常是：越界的脚本调用、错误的 Python 解释器、错误的 cwd、当前 unit 不允许的操作等），修正后重新 gate，直到 `allowed:true`。
- `input-json` 里的 `command` 必须是你**即将执行的完整命令原文**（含 `cd`、环境变量等），不要只传一个缩写。

### 3.4 执行后：post_tool_result 门控

```bash
# 命令成功：
ENGINE run gate --cwd <repo> --run <runId> --point post_tool_result --tool bash
# 命令报错（退出码非 0 或明显失败）：
ENGINE run gate --cwd <repo> --run <runId> --point post_tool_result --tool bash --is-error
```

- `{ok:true, allowed:true, state}`：hook 会读取当前 unit 的 `produces` 产物，校验格式/取值域，gate 单元还会跑语义脚本；通过则**自动推进状态机到下一个 unit**（`state.message` 会显示 `Advanced to unit "..."`）。
- `{ok:false, allowed:false, repair, state}`：当前产物缺失/不合规/被 gate 拒绝。读 `repair` 修产物，再产出、再 post_tool_result，直到通过。
- 命令报错时带 `--is-error`：返回 `ok:true` 但带一条 warning 诊断（不推进、不拦截），据此排查命令与产物。

> 注意：SKILL.md 里的 `sure_update_state` 在引擎驱动下等价于"产出当前 unit 的 artifact 后执行一次 `run gate --point post_tool_result`"。没有单独的 update_state 命令，推进由 post_tool_result 完成。

### 3.5 查看状态

```bash
ENGINE run state --cwd <repo> --run <runId>
# → {ok:true, runId, record, status, state}
```

`state.phase` / `state.checkpoint` / `state.diagnostics` / `state.next_actions` 告诉你当前卡在哪个 unit、block 原因、下一步建议。迷路时先看这里。

### 3.6 结束：finish（含兜底校验）

状态机到达终端 unit、所有 required 产物就绪后，先写 final manifest 再 finish：

```bash
# 1) 写 manifest（JSON），建议写到 .sure/runs/<runId>/manifest.json
# 2) 调用 finish
ENGINE run finish --cwd <repo> --run <runId> --status <success|incomplete|failed> \
  --manifest .sure/runs/<runId>/manifest.json \
  --summary '<一句话总结>'
```

final manifest 是 JSON 对象，必须包含（缺一即被拒）：

```json
{
  "schema_version": "sure.manifest.v1",
  "run_id": "<runId>",
  "skill_name": "<技能名，如 sure_eval>",
  "status": "<与 finish 的 --status 一致>",
  "created_at": "<ISO8601 时间，如 2026-09-10T03:00:00.000Z>",
  "inputs": { "model": "...", "datasets": "..." },
  "outputs": { "...": "..." },
  "validation": { "...": "..." },
  "artifacts": [
    { "type": "runtime_binding", "path": ".sure/runs/<runId>/artifacts/runtime_binding.json" }
  ]
}
```

规则：

- `run_id` 必须等于当前 `runId`；`skill_name` 必须等于技能名；`status` 必须与 `--status` 一致；`created_at` 必须是可解析的 ISO 时间；`inputs`/`outputs`/`validation` 必须是 JSON 对象。
- `status=success` 时，`artifacts`（或 `outputs` 里的字符串值）必须**逐个列全该技能 `sure.skill.json` 中 `required:true` 的 artifact，且路径真实存在**（相对路径按项目根或 `<runDir>` 解析）。漏列或路径不存在 → `ok:false` + repair。
- `finish` 返回 `ok:false` 时读 `repair`，修 manifest / 补产物后重新 `finish`（可反复调用，直到 `ok:true`）。
- `status` 语义：全部完成且 required 产物齐全 → `success`；中途放弃但有保留价值 → `incomplete`；明确失败 → `failed`（`failed`/`incomplete` 也要如实写 manifest 与 `summary`，必要时用 `--error-summary`）。

### 3.7 恢复与异常

```bash
ENGINE run resume --cwd <repo> --run <runId>      # 恢复指定 run；不带 --run 则恢复最近一个可恢复 run
# → {ok:true, runId, prompt, state}（prompt 提示从 checkpoint 继续，先读已有产物，不重做已完成 unit）
ENGINE run on-error --cwd <repo> --run <runId> --reason '<会话中断/用户中止等>'   # 运行被中止时的收尾
```

`resume` 只对 `running`/`failed` 且 checkpoint `resumable:true` 的 run 生效；返回 `ok:false` 说明没有可恢复的 run。

---

## 4. 门控纪律（硬性要求）

1. **启动后每个 bash 都双 gate**：pre 前、post 后。漏一次，状态机就不会推进（post 负责推进）。
2. **`allowed:false` 一律停下**，按 `repair` 修正后重新 gate；绝不绕过 gate 直接执行被拒命令。同一 gate 连续拦截超过技能默认重试上限（通常 3 次）时，停止 agent 侧修复，向用户确认输入/环境，而不是硬凑字段逃避 gate。
3. **只跑当前 unit 允许的脚本**：pre_tool_call 有脚本白名单；越界脚本（后置 unit 的脚本、错误 Python 解释器、错误 cwd）会被拦。SKILL.md 的"Per-unit contract"里写明了每个 unit 该跑什么。
4. **产物由脚本生成、agent 不过度手写**：`execution_surface.json`/`execution_result.json`/`eval_run_report.json` 等标注"generated, not authored"的产物，禁止手写。
5. **`read`/`write` 等非 bash 工具不受 pre_tool_call 白名单拦截**，但产物推进仍依赖 post_tool_result；如需产出 artifact，用 bash 跑脚本（或写文件后仍以 bash 完成），再 post_tool_result。

## 5. finish 兜底（为什么无法伪造成功）

Codex 没有 hook 硬拦截：中间的门控靠 agent 自觉调用引擎。但**引擎的 `finish` 门是最终校验兜底**——它校验 final manifest 的信封字段（`run_id`/`skill_name`/`status`/`created_at` 等）与 `success` 所需的全部 required artifact 路径。跳过中间 gate 不会直接失败，但你也拿不到通过 `post_tool_result` 才能推进出的中间产物与 terminal 状态，因此无法凑出能让 `finish --status success` 通过的 manifest。**结论：可以省中间步骤，但省不出一个成功的 finish；成功 finish 等价于跑完了状态机。**

## 6. 工具名映射（SKILL.md 是 pi 工具视角，需翻译为引擎命令）

SKILL.md 文本中出现的 pi 侧工具名，在 Codex 引擎驱动下对应如下：

| SKILL.md 里的写法 | Codex 下的等价动作 |
|------------------|-------------------|
| `sure_start` / 启动命令 | `ENGINE run start --cwd <repo> --skill ... --args ...` |
| `sure_update_state` | 产出当前 unit artifact 后执行 `ENGINE run gate --cwd <repo> --point post_tool_result` |
| `sure_finish`（"standalone final tool call"） | 写 manifest 后执行 `ENGINE run finish --cwd <repo> --status ... --manifest ...` |
| `sure_gate` / 每次 shell 的 hook 拦截 | `run gate --cwd <repo> --point pre_tool_call` + `run gate --cwd <repo> --point post_tool_result` |
| 恢复运行 | `ENGINE run resume --cwd <repo> [--run <runId>]` |
