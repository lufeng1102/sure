# sure-engine

Agent-agnostic SURE control plane. `sure-engine` owns the run lifecycle, the
six hook points, gate enforcement, and `.sure/runs/<runId>` state for the SURE
skill packages (`sure/skills/*`). Any coding agent — pi, Claude Code, Codex
CLI, or a plain script — drives it through the CLI and translates the JSON
outcomes into its own tool/hook surface.

It has no dependency on `@earendil-works/pi-*`; it loads the skill hooks and the
`yaml`-only `sure/runtime`/`sure/site` modules via jiti at runtime, resolved
relative to the working directory.

## Build

```bash
npm run build        # tsgo → dist/ (dist is git-ignored)
node dist/cli.js ... # or: npm link, then `sure-engine ...`
node dist/mcp.js     # MCP server (stdio); or `sure-engine-mcp`
```

The working directory (`--cwd`, default `process.cwd()`) must be a checkout that
contains `sure/skills/` and, for output-directory resolution, the site policy
(`config/site.bundled.yaml` / `config/site.local.yaml`). The MCP server reads the
same directory from the `SURE_REPO_ROOT` env var (default `process.cwd()`).

## MCP server (structured tool calls)

`dist/mcp.js` is a stdio MCP server (newline-delimited JSON-RPC, no external
deps) exposing the same verbs as structured tools. Register it with a client
(e.g. Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "sure": {
      "command": "node",
      "args": ["/abs/path/sure-engine/dist/mcp.js"],
      "env": { "SURE_REPO_ROOT": "/abs/path" }
    }
  }
}
```

| Tool | Purpose |
| --- | --- |
| `sure_discover` | list skills |
| `sure_run_start` | start a run (skill, args) → runId + prompt |
| `sure_run_gate` | gate a shell op (runId, point, tool, command, isError) |
| `sure_run_finish` | validate manifest + pre_finish/post_finish (runId, status, manifestPath, summary) |
| `sure_run_state` | read checkpoint/display state (runId) |
| `sure_run_resume` | resume a resumable run (runId?) |
| `sure_run_on_error` | on_error hook (runId, reason) |

## CLI

Every command writes a JSON object to stdout.

### Discover

```bash
sure-engine discover --cwd <dir>
# {"packages":[{"manifest":{"command","name","description"},...}],"diagnostics":[]}
```

### run

```bash
sure-engine run start --cwd <dir> --skill sure_onboard --args 'model=...'
# {ok, runId, prompt, record, state}   (prompt is the agent invocation text)
# {ok:false, repair}                    on pre_start gate failure

sure-engine run gate --cwd <dir> --run <id> --point pre_tool_call --tool bash --input-json '{"command":"..."}'
sure-engine run gate --cwd <dir> --run <id> --point post_tool_result --tool bash --is-error
# {ok, allowed, repair, state}   allowed:false ⇒ block the tool and follow `repair`

sure-engine run finish --cwd <dir> --run <id> --status success --manifest <path> --summary '...'
# status: success | incomplete | failed
# validates the manifest envelope + pre_finish + post_finish

sure-engine run state --cwd <dir> --run <id>      # {ok, record, state}
sure-engine run resume --cwd <dir> [--run <id>]   # reactivate a resumable run
sure-engine run on-error --cwd <dir> --run <id> --reason '...'
```

## Driver discipline (what an adapter must enforce)

1. `start` a run; feed `prompt` to the agent.
2. Before every shell operation: `run gate --point pre_tool_call`. On
   `allowed:false`, stop and follow `repair`.
3. After every shell operation: `run gate --point post_tool_result`.
4. On completion: `run finish`. The engine re-validates the state machine and
   manifest, so skipping intermediate gates cannot produce a false success.

The engine maintains an **active-run pointer** at `<cwd>/.sure/current-run`:
`start`/`resume` write the run id, `finish`/`on-error` remove it. Adapter hooks
(Claude PreToolUse/PostToolUse, Codex MCP tools) can read it to know which run
to gate; its absence means "no active run, allow everything".

## Layout

```text
src/types.ts             engine data contract (no agent-runtime imports)
src/manifest.ts          skill discovery (.sure/skills + sure/skills)
src/run-manager.ts       .sure/runs/<runId> persistence
src/state.ts             display-state merge + validation
src/output-dir.ts        output_dir resolution (site policy injected)
src/hooks.ts             hook loading + gate execution (jiti)
src/prompt.ts            <sure_invocation> / <sure_resume> prompts
src/manifest-validate.ts final manifest envelope validation
src/engine.ts            SureEngine (start/resume/gate/finish/state/onError)
src/policy.ts            lazy site-policy loader (loadPolicy)
src/cli.ts               CLI entry
src/mcp.ts               MCP server entry (stdio JSON-RPC)
```
