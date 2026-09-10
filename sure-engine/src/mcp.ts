#!/usr/bin/env node
import { SureEngine } from "./engine.ts";
import { loadPolicy } from "./policy.ts";

interface JsonRpcMessage {
	jsonrpc: string;
	id?: string | number;
	method?: string;
	params?: { name?: string; arguments?: Record<string, unknown> };
}

interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

const TOOLS: ToolDefinition[] = [
	{
		name: "sure_discover",
		description: "List the SURE skills available in the project (command, name, description).",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "sure_run_start",
		description:
			"Start a SURE run for a skill (runs the pre_start gate). Returns runId and the agent invocation prompt.",
		inputSchema: {
			type: "object",
			properties: { skill: { type: "string" }, args: { type: "string" } },
			required: ["skill"],
		},
	},
	{
		name: "sure_run_gate",
		description:
			"Gate a shell operation: call before (point=pre_tool_call) and after (point=post_tool_result) each Bash command. allowed=false means the adapter must block and follow repair.",
		inputSchema: {
			type: "object",
			properties: {
				runId: { type: "string" },
				point: { type: "string", enum: ["pre_tool_call", "post_tool_result"] },
				tool: { type: "string" },
				command: { type: "string" },
				isError: { type: "boolean" },
			},
			required: ["runId", "point"],
		},
	},
	{
		name: "sure_run_finish",
		description:
			"Finish a SURE run: validate the final manifest envelope, then run pre_finish and post_finish. status is success|incomplete|failed.",
		inputSchema: {
			type: "object",
			properties: {
				runId: { type: "string" },
				status: { type: "string", enum: ["success", "incomplete", "failed"] },
				manifestPath: { type: "string" },
				summary: { type: "string" },
			},
			required: ["runId", "status", "manifestPath"],
		},
	},
	{
		name: "sure_run_state",
		description: "Read the checkpoint and display state of a SURE run.",
		inputSchema: {
			type: "object",
			properties: { runId: { type: "string" } },
			required: ["runId"],
		},
	},
	{
		name: "sure_run_resume",
		description: "Resume a resumable SURE run (or the latest one when runId is omitted).",
		inputSchema: { type: "object", properties: { runId: { type: "string" } } },
	},
	{
		name: "sure_run_on_error",
		description: "Run the on_error hook for a SURE run (session shutdown or error).",
		inputSchema: {
			type: "object",
			properties: { runId: { type: "string" }, reason: { type: "string" } },
			required: ["runId"],
		},
	},
];

const cwd = process.env.SURE_REPO_ROOT || process.cwd();
const engine = new SureEngine(cwd, loadPolicy(cwd));

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
	switch (name) {
		case "sure_discover": {
			const result = engine.discover();
			return {
				packages: result.packages.map((p) => ({
					command: p.manifest.command,
					name: p.manifest.name,
					description: p.manifest.description ?? "",
				})),
				diagnostics: result.diagnostics,
			};
		}
		case "sure_run_start": {
			const command = typeof args.skill === "string" ? args.skill : "";
			const skillPackage = engine.findSkill(command);
			if (!skillPackage) {
				return { ok: false, repair: `No Sure skill package found for /${command}.` };
			}
			return engine.start(skillPackage, typeof args.args === "string" ? args.args : "");
		}
		case "sure_run_gate": {
			const runId = typeof args.runId === "string" ? args.runId : "";
			const point = args.point;
			if (!runId || (point !== "pre_tool_call" && point !== "post_tool_result")) {
				return { ok: false, repair: "sure_run_gate requires runId and point pre_tool_call|post_tool_result" };
			}
			const event = {
				toolName: typeof args.tool === "string" ? args.tool : "bash",
				toolCallId: undefined,
				input: typeof args.command === "string" ? { command: args.command } : undefined,
				isError: args.isError === true,
			};
			return engine.gate(runId, point, event);
		}
		case "sure_run_finish": {
			const runId = typeof args.runId === "string" ? args.runId : "";
			const status = args.status;
			const manifestPath = typeof args.manifestPath === "string" ? args.manifestPath : "";
			if (!runId || !manifestPath || (status !== "success" && status !== "incomplete" && status !== "failed")) {
				return {
					ok: false,
					repair: "sure_run_finish requires runId, status success|incomplete|failed, manifestPath",
				};
			}
			return engine.finish(runId, {
				status,
				manifest_path: manifestPath,
				summary: typeof args.summary === "string" ? args.summary : "",
			});
		}
		case "sure_run_state": {
			const runId = typeof args.runId === "string" ? args.runId : "";
			if (!runId) {
				return { ok: false, repair: "sure_run_state requires runId" };
			}
			return engine.state(runId);
		}
		case "sure_run_resume":
			return engine.resume(typeof args.runId === "string" ? args.runId : undefined);
		case "sure_run_on_error": {
			const runId = typeof args.runId === "string" ? args.runId : "";
			if (!runId) {
				return { ok: false, repair: "sure_run_on_error requires runId" };
			}
			return engine.onError(runId, { reason: typeof args.reason === "string" ? args.reason : "session_shutdown" });
		}
		default:
			return { ok: false, repair: `Unknown tool: ${name}` };
	}
}

function write(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isErrorOutcome(outcome: unknown): boolean {
	return typeof outcome === "object" && outcome !== null && (outcome as { ok?: unknown }).ok === false;
}

function handleLine(line: string): void {
	let message: JsonRpcMessage;
	try {
		message = JSON.parse(line) as JsonRpcMessage;
	} catch (error) {
		process.stderr.write(
			`sure-engine-mcp: invalid JSON line: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return;
	}
	if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
		return;
	}
	const id = message.id;
	const respond = (result: unknown): void => {
		if (id !== undefined) {
			write({ jsonrpc: "2.0", id, result });
		}
	};
	const respondError = (code: number, text: string): void => {
		if (id !== undefined) {
			write({ jsonrpc: "2.0", id, error: { code, message: text } });
		}
	};

	switch (message.method) {
		case "initialize":
			respond({
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "sure-engine", version: "0.1.0" },
			});
			return;
		case "notifications/initialized":
			return;
		case "ping":
			respond({});
			return;
		case "tools/list":
			respond({ tools: TOOLS });
			return;
		case "tools/call": {
			const name = message.params?.name;
			const args = message.params?.arguments ?? {};
			if (typeof name !== "string") {
				respondError(-32602, "tools/call requires params.name");
				return;
			}
			callTool(name, args)
				.then((outcome) => {
					respond({
						content: [{ type: "text", text: JSON.stringify(outcome) }],
						isError: isErrorOutcome(outcome),
					});
				})
				.catch((error: unknown) => {
					const text = error instanceof Error ? error.message : String(error);
					respond({ content: [{ type: "text", text }], isError: true });
				});
			return;
		}
		default:
			respondError(-32601, `Method not found: ${message.method}`);
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.trim() !== "") {
			handleLine(line);
		}
		index = buffer.indexOf("\n");
	}
});
process.stdin.on("error", (error) => {
	process.stderr.write(`sure-engine-mcp: stdin error: ${error.message}\n`);
});
