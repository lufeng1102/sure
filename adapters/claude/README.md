# Claude Code 适配器（SURE）

让 Claude Code 运行 SURE 技能（`sure_feed` / `sure_onboard` / `sure_trans` / `sure_approve` / `sure_infer` / `sure_eval`）。

SURE 是一个「科学任务」控制平面。每个技能在 `sure/skills/<skill>/` 下定义，包含 `sure.skill.json`（manifest）、`SKILL.md`（agent 操作手册）、`hooks/`（TypeScript 状态机门控）、`scripts/`、`schemas/`。本适配器让 Claude Code 通过 agent 无关的 `sure-engine` CLI 驱动一次技能运行：`start → gate → ... → finish`。

## 快速开始（一键安装，小白向）

在 Claude Code 项目根目录执行一条命令：

```bash
bash <repo>/adapters/claude/install.sh
```

这一个命令会：构建 `sure-engine`（含 MCP 服务器）、把 6 个技能软链到 `.claude/skills/`、把 8 个斜杠命令软链到 `.claude/commands/`、生成 `config/site.local.yaml`（站点策略）、把 `sure-engine` MCP 服务器注册进 `.mcp.json`（结构化工具调用）。

然后：

1. 首次运行 `claude` 时用 `/mcp` 批准 `sure` 服务器（每用户一次性），或用 `claude mcp list` 验证已注册。
2. 敲 `/sure_init` 做运行时体检（生成/校验 `site.local.yaml`、Python 3.11、引擎、评估引擎子模块）。
3. 直接敲斜杠命令或用自然语言：
   - 直接敲：`/sure_feed` `/sure_onboard` `/sure_trans` `/sure_approve` `/sure_infer` `/sure_eval` `/sure_resume`（命令名与 pi 一致）。
   - 自然语言：如「把这个模型上线」「给这批预测打分」，技能自动发现。
   - 两种方式最终都由 agent 通过 MCP 工具 `sure_run_start` / `sure_run_gate` / `sure_run_finish` 结构化驱动（不再手写 bash+JSON）。

`install.sh` 选项：`--project <dir>`（装到别的项目目录）、`--no-mcp`（跳过 MCP 注册）、`--with-hooks`（额外装 Bash 硬门控 hooks，加固用）、`--rebuild`（强制重建引擎）。

> 前置依赖：Node（跑 `sure-engine`）与 Python 3.11（Harness Runtime 锁定版本；本机是 3.12 时会报 `HARNESS_RUNTIME_NOT_READY`）。

## 1. 前置条件：安装 sure-engine

`sure-engine` 已构建在仓库里（`sure-engine/dist/cli.js`），任选一种方式使用：

- **直接用已构建产物（零安装）**：
  ```bash
  node <repo>/sure-engine/dist/cli.js <子命令>
  ```
  其中 `<repo>` 是仓库根目录（本文档后面用 `<repo>` 代指，例如 `/Users/lufeng/Workspace/aispeech/sure-harness`）。

- **从源码重新构建**（改过 `sure-engine/src/` 后）：
  ```bash
  cd <repo>/sure-engine && npm install --ignore-scripts && npm run build
  ```
  （构建脚本是 `tsgo -p tsconfig.build.json && chmod +x dist/cli.js`，产物即 `dist/cli.js`。）

- **npm link 成全局命令**：
  ```bash
  cd <repo>/sure-engine && npm link
  sure-engine discover --cwd <repo>
  ```
  link 之后可直接用 `sure-engine` 替换下文所有 `node <repo>/sure-engine/dist/cli.js`。

`--cwd <repo>` 必须是同时含 `sure/skills/` 与 `config/site.*.yaml` 的目录（本仓库根，或任何部署了 SURE 技能与站点策略的用户项目目录）。

## 2. 安装技能到 Claude Code

把 `adapters/claude/skills/<skill>/` 复制或软链到用户项目的 `.claude/skills/<name>/`。六个技能逐一执行：

```bash
# 在用户项目根目录（不是本仓库根）
mkdir -p .claude/skills

# 方式 A：软链（推荐，仓库更新即生效）
for s in sure_feed sure_onboard sure_trans sure_approve sure_infer sure_eval; do
  ln -sfn "<repo>/adapters/claude/skills/$s" ".claude/skills/$s"
done

# 方式 B：复制
for s in sure_feed sure_onboard sure_trans sure_approve sure_infer sure_eval; do
  cp -R "<repo>/adapters/claude/skills/$s" ".claude/skills/$s"
done
```

安装后，Claude Code 会自动发现这些技能：每个 `SKILL.md` 的 frontmatter 里 `description` 带触发条件，Claude 在对话中遇到匹配意图时会渐进发现并加载对应技能。

## 3. 斜杠命令（直接使用）

`install.sh` 会把 `adapters/claude/commands/*.md` 软链到 `.claude/commands/`，用户可直接敲命令（命令名与 pi 一致）：

| 命令 | 作用 |
| --- | --- |
| `/sure_init` | 初始化运行时体检（`site.local.yaml` + Python 3.11 + 引擎 + 评估引擎子模块），写 `.sure/init.json` |
| `/sure_feed <args>` | 录入外部来源到资源池并启动运行 |
| `/sure_onboard <args>` | 模型上线（runtime inventory + 部署就绪） |
| `/sure_trans <args>` | 模型转可上线产物 |
| `/sure_approve <args>` | 审批已完成的模型产物 |
| `/sure_infer <args>` | 推理生成预测 |
| `/sure_eval <args>` | 评估产出指标 |
| `/sure_resume [<runId>]` | 续接最近一次可续接的运行 |

每个命令的 `.md` 正文都是一段「prompt 模板」：`$ARGUMENTS` 透传用户参数，agent 读取对应技能手册并用 MCP 工具 `sure_run_start/gate/finish` 驱动到终态。`/sure_init` 则执行 `adapters/claude/bin/sure-init.sh`（自定位仓库根，幂等、非破坏）。

## 4. 运行方式

用户在 Claude Code 里通过触发词唤起技能（例如「把 MOSS-Transcribe-Diarize 上线」「给这批预测打分」）。agent 按该技能 `SKILL.md` 的操作手册驱动一次运行。

**首选：MCP 工具（结构化调用）**。安装 MCP 后，agent 用 7 个 MCP 工具驱动（对应关系见 `sure-engine/README.md`）：

```
sure_run_start     # 启动运行（pre_start 门控）→ runId + prompt
sure_run_gate      # pre_tool_call / post_tool_result 门控（每次 shell 前后）
sure_run_finish    # 校验最终 manifest + pre_finish/post_finish
sure_run_state / sure_run_resume / sure_run_on_error / sure_discover
```

每个技能 `SKILL.md` 末尾的「引擎驱动协议」都按 MCP 工具写好了完整序列与门控纪律。

**兜底：Bash CLI**（未装 MCP 时）。核心流程与 MCP 工具一一对应：

```bash
# 1) 启动（--skill 用 manifest 的 command，去掉前导斜杠）
node <repo>/sure-engine/dist/cli.js run start --cwd <repo> --skill sure_onboard --args 'model=OpenMOSS-Team__MOSS-Transcribe-Diarize'
# 成功返回 {"ok":true,"runId":"...","prompt":"...","record":{...},"state":{...}}，记下 runId

# 2) 每次 Bash 操作前，先做工具前门控（allowed=false 则拦截）
node <repo>/sure-engine/dist/cli.js run gate --cwd <repo> --run <runId> --point pre_tool_call --tool bash --input-json '{"command":"<实际命令>"}'

# 3) 每次 Bash 操作后，做工具后门控（命令出错加 --is-error；这是状态机推进点）
node <repo>/sure-engine/dist/cli.js run gate --cwd <repo> --run <runId> --point post_tool_result --tool bash [--is-error]

# 4) 终态单元完成后，写最终 manifest 再 finish
node <repo>/sure-engine/dist/cli.js run finish --cwd <repo> --run <runId> --status success --manifest .sure/runs/<runId>/manifest.json --summary '<摘要>'
```

其它子命令：

```bash
node <repo>/sure-engine/dist/cli.js discover --cwd <repo>          # 列出技能
node <repo>/sure-engine/dist/cli.js run state --cwd <repo> --run <runId>   # 查状态
node <repo>/sure-engine/dist/cli.js run resume --cwd <repo> [--run <runId>] # 续接
node <repo>/sure-engine/dist/cli.js run on-error --cwd <repo> --run <runId> --reason '...' # 出错收尾
```

## 5. 运行纪律（关键）

1. **run 启动后，每次 shell 操作前必须先 `run gate --point pre_tool_call`。** 返回 `allowed=false` 时**不执行**该命令，先按返回的 `repair` 修正（改命令、或回到当前单元允许的脚本），再重新门控。
2. **每次 shell 操作后必须 `run gate --point post_tool_result`。** 命令出错时加 `--is-error`。这是状态机的推进点：当前单元的 `produces` 产物合规时，状态机自动推进到下一单元；返回 `allowed=false` 表示当前单元产物未通过门控（位置/格式/取值域或门控脚本），按 `repair` 修复产物后再次调用 post 门控，不要跳单元、不要盲跑。
3. **结束时必须 `run finish`。** 先写最终 manifest（JSON，见下）再 finish；manifest 校验失败或 `pre_finish` 门控失败返回 `{ok:false, repair}`，按 repair 修 manifest/产物后再 finish。
4. 状态机只在 post 门控通过时推进；不要手动改 `.sure/runs/<runId>/state.json` 或 checkpoint。
5. 门控针对 Bash 工具：`--tool` 传 `bash`；pre 门控的 `--input-json` 传 `{"command":"..."}` 让钩子读取实际命令。

### 最终 manifest 模板

manifest 必须是 JSON，包含 `schema_version`、`run_id`、`skill_name`、`status`、`created_at`、`inputs`、`outputs`、`validation`，且 `run_id` / `skill_name` / `status` 必须与实际一致；`status=success` 时还必须列齐该技能 `sure.skill.json` 里 `required: true` 的产物（写进 `outputs`，path 指向真实存在的文件）：

```json
{
  "schema_version": "1.0",
  "run_id": "<runId>",
  "skill_name": "sure_onboard",
  "status": "success",
  "created_at": "2026-01-01T00:00:00.000Z",
  "inputs": { "args": "model=OpenMOSS-Team__MOSS-Transcribe-Diarize" },
  "outputs": {
    "verdict": { "type": "verdict", "path": ".sure/runs/<runId>/artifacts/verdict.json" },
    "runtime_inventory": { "type": "runtime_inventory", "path": ".sure/runs/<runId>/artifacts/runtime_inventory.json" },
    "deployment_ready": { "type": "deployment_ready", "path": ".sure/runs/<runId>/artifacts/deployment_ready.json" }
  },
  "validation": { "state_machine_complete": true }
}
```

## 6. 硬拦截（可选）：Claude hooks

`install.sh --with-hooks` 会自动装好 hooks（合并进 `.claude/settings.json`，幂等、不覆盖已有 hooks）。手动方式：把 `hooks.example.json` 里的 `<repo>` 换成实际仓库根路径，合并进用户项目 `.claude/settings.json` 的 `"hooks"` 字段。

hooks 配 `adapters/claude/bin/sure-gate.sh` 使用：

- 脚本从 `.sure/current-run` 状态文件读取当前 `runId`。`sure-engine` 会在 `run start`/`run resume` 时写入该文件、在 `run finish`/`run on-error` 时删除，因此 **run 生命周期由引擎自动管理**；没有 active run 时 hooks 是 no-op（放行所有 Bash）。
- `PreToolUse` 匹配 Bash，调用 `run gate --point pre_tool_call`，`allowed=false` 时以退出码 2 拦截。
- `PostToolUse` 匹配 Bash，调用 `run gate --point post_tool_result`，出错时加 `--is-error`。

`allowed=false` 时 `sure-gate.sh` 以退出码 2 硬拦截，stderr 上的 repair 文案会展示给 agent。这是单 run 指针设计，多会话并发跑多个 SURE run 时 last-write-wins。

## 7. 注意事项

- **不要**修改 `sure/`、`sure-engine/`、`packages/` 下的现有文件；本适配器只新增 `adapters/claude/` 下的文件。
- 每个技能 `SKILL.md` 的操作手册正文直接复用 `sure/skills/<skill>/SKILL.md`，仅在末尾追加「引擎驱动协议」。正文里出现的 `/sure_init`、`sure_update_state`、`sure_finish` 是引擎内部概念：`sure_finish` 对应 `run finish`，`sure_update_state` 对应 post 门控通过后的自动推进。
- `run start` 返回的 `prompt` 里也内嵌了该技能手册与完成协议；agent 以本适配器 `SKILL.md`（含引擎驱动协议）为准。
