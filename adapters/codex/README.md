# Codex CLI 适配器：让 Codex 运行 SURE 技能

本目录让 OpenAI Codex CLI 通过 shell 驱动 SURE 控制平面，运行 6 个科学任务技能：`sure_feed`、`sure_onboard`、`sure_trans`、`sure_approve`、`sure_infer`、`sure_eval`。

## 原理

SURE 已经有一个 **agent 无关的引擎 CLI**（`sure-engine`）。任何 agent 都能通过 shell 调用它来驱动一次技能运行。Codex 没有"文件级技能发现"机制，因此采用 **AGENTS.md + shell** 方式：把一段自包含的协议注入 Codex 的 `AGENTS.md`，让 Codex 按协议调用引擎。这是零额外基础设施、最快可用的路径。

- 引擎负责：运行生命周期、状态持久化、hook 门控、final manifest 校验。
- 技能包负责：领域提示词、状态机、确定性脚本、schema 与校验规则。

## 目录

- `AGENTS.sure.md` — 追加到 Codex `AGENTS.md` 的片段：6 个技能触发描述 + 完整引擎驱动协议。
- `config.example.toml` — 可选加固：把 `sure-engine` 包装成 MCP 服务器注册到 Codex。
- `README.md` — 本文件。

## 安装

### 1. 注入 AGENTS 片段

把 `adapters/codex/AGENTS.sure.md` 的内容追加到 Codex 的 `AGENTS.md`：

```bash
cat adapters/codex/AGENTS.sure.md >> AGENTS.md            # 项目级
# 或
cat adapters/codex/AGENTS.sure.md >> ~/.codex/AGENTS.md   # 全局，所有项目生效
```

项目级 `AGENTS.md` 只影响该仓库；全局 `~/.codex/AGENTS.md` 影响所有会话。二选一即可，通常项目级更可控。

### 2. 安装 sure-engine

`--cwd` 指向的仓库必须已构建出 `sure-engine/dist/cli.js`，且包含 `sure/skills/` 与 `sure/site/loader.ts`。三种方式任选：

```bash
# 方式 A：从源码构建（推荐，输出到 sure-engine/dist/cli.js）
npm run build --workspace sure-engine   # 或进入 sure-engine/ 后 npm run build

# 方式 B：直接用已构建产物（无需安装）
node <repo>/sure-engine/dist/cli.js discover --cwd <repo>

# 方式 C：npm link 成全局命令
cd sure-engine && npm link
sure-engine discover --cwd <repo>
```

> 方式 A/B 最省事，不污染全局环境；文档下文统一用 `node <repo>/sure-engine/dist/cli.js`。

### 3. 准备站点策略（真实运行必需）

真实运行需要站点策略文件：

```bash
cp config/site.example.yaml config/site.local.yaml   # 按需修改 model/dataset/runtime 路径
```

引擎启动加载 `sure/site/loader.ts`；`output_dir`、模型/数据集/运行时路径解析，以及 `sure_approve`/`sure_infer`/`sure_eval` 都会读取站点策略。没有它，`start` 或相关 gate 会返回 `ok:false` + repair。

## 运行纪律（关键）

引擎驱动的一次 SURE 运行是以下循环（详见 `AGENTS.sure.md` 第 3 节）：

```text
1. run start --cwd <repo> --skill <command> --args '<k=v ...>'   → 拿到 runId + prompt
2. 每个 shell 操作前：
   run gate --cwd <repo> --run <runId> --point pre_tool_call --tool bash --input-json '{"command":"<完整命令>"}'
   → allowed:false 时按 repair 修正，禁止硬跑
3. 执行 shell 命令
4. 操作后：
   run gate --cwd <repo> --run <runId> --point post_tool_result --tool bash [--is-error]
   → 通过则状态机自动推进到下一个 unit
5. 结束时：
   run finish --cwd <repo> --run <runId> --status <success|incomplete|failed> --manifest <path> --summary '...'
   → manifest 校验失败按 repair 修，再 finish
```

> 以上均省略了 `node <repo>/sure-engine/dist/cli.js` 前缀；注意 `--cwd <repo>` 必须写在子命令（`run start`/`run gate`/`run finish` 等）之后。

核心纪律：

- **每次 shell 前先 pre gate、后 post gate**。post gate 是状态机推进的唯一入口；漏掉它 run 不会前进。
- **`allowed:false` 必须停下修正**，不得绕过 gate 硬跑被拒命令。
- **finish 是最终兜底**：它校验 manifest 信封字段 + `success` 所需全部 required artifact 路径。

## 局限与兜底

**Codex 没有 hook 硬拦截。** 中间的门控（pre/post gate）依赖 agent 自觉调用引擎——Codex 无法像内置 hook 那样强制拦截每个工具调用。这意味着一个不守纪律的 agent 可以跳过中间 gate。

但**引擎的 `finish` 门做最终校验兜底**：

- 校验 final manifest 的 `run_id`/`skill_name`/`status`/`created_at`/`inputs`/`outputs`/`validation`；
- `status=success` 时逐个校验技能 `sure.skill.json` 里 `required:true` 的 artifact 路径真实存在；
- 而中间产物只有通过 `post_tool_result` 才能推进产出。

因此"跳过中间 gate 也无法伪造成功 finish"：你可以省中间步骤，但省不出一个能通过 `finish --status success` 的 manifest。成功 finish 等价于真的跑完了状态机。

## 可选加固：MCP 服务器

若希望把"agent 自觉调用 shell"升级为"结构化工具调用"，把 `sure-engine` 的 `run start/gate/finish/state/resume` 暴露为 MCP tools 注册到 Codex，见 `config.example.toml`。这是加固路径，非必需；`AGENTS.sure.md` 的 shell 方式始终可用。
