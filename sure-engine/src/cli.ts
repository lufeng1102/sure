#!/usr/bin/env node
import { resolve } from "node:path";
import { SureEngine, type SureEngineOutcome } from "./engine.ts";
import { loadPolicy } from "./policy.ts";
import type { SureFinishParams } from "./types.ts";

interface CliArgs {
	[key: string]: string | boolean;
}

interface ParsedCli {
	positionals: string[];
	args: CliArgs;
}

function parseCli(argv: string[]): ParsedCli {
	const positionals: string[] = [];
	const args: CliArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const key = token.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			args[key] = true;
		} else {
			args[key] = next;
			i++;
		}
	}
	return { positionals, args };
}

function stringArg(args: CliArgs, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" ? value : undefined;
}

function emit(outcome: SureEngineOutcome): void {
	process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
}

async function main(): Promise<void> {
	const { positionals, args } = parseCli(process.argv.slice(2));
	const [verb, sub] = positionals;
	const cwd = resolve(stringArg(args, "cwd") ?? process.cwd());

	if (verb === "discover") {
		const engine = new SureEngine(cwd, loadPolicy(cwd));
		process.stdout.write(`${JSON.stringify(engine.discover(), null, 2)}\n`);
		return;
	}

	if (verb !== "run" || sub === undefined) {
		emit({
			ok: false,
			repair:
				"Usage: sure-engine run <start|gate|finish|state|resume|on-error> [--cwd <dir>] [options] | sure-engine discover [--cwd <dir>]",
		});
		return;
	}

	const engine = new SureEngine(cwd, loadPolicy(cwd));

	switch (sub) {
		case "start": {
			const command = stringArg(args, "skill");
			if (!command) {
				emit({ ok: false, repair: "start requires --skill <command>" });
				return;
			}
			const skillPackage = engine.findSkill(command);
			if (!skillPackage) {
				emit({ ok: false, repair: `No Sure skill package found for /${command}.` });
				return;
			}
			emit(await engine.start(skillPackage, stringArg(args, "args") ?? ""));
			return;
		}
		case "gate": {
			const runId = stringArg(args, "run");
			const point = stringArg(args, "point");
			if (!runId || (point !== "pre_tool_call" && point !== "post_tool_result")) {
				emit({ ok: false, repair: "gate requires --run <id> and --point pre_tool_call|post_tool_result" });
				return;
			}
			const event = {
				toolName: stringArg(args, "tool") ?? "",
				toolCallId: stringArg(args, "tool-call-id"),
				input: args["input-json"] !== undefined ? JSON.parse(String(args["input-json"])) : undefined,
				isError: args["is-error"] === true,
			};
			emit(await engine.gate(runId, point, event));
			return;
		}
		case "finish": {
			const runId = stringArg(args, "run");
			const status = stringArg(args, "status");
			const manifestPath = stringArg(args, "manifest");
			if (!runId || !manifestPath || (status !== "success" && status !== "incomplete" && status !== "failed")) {
				emit({
					ok: false,
					repair: "finish requires --run <id> --status <success|incomplete|failed> --manifest <path>",
				});
				return;
			}
			const params: SureFinishParams = {
				status,
				manifest_path: manifestPath,
				summary: stringArg(args, "summary") ?? "",
				error_summary: stringArg(args, "error-summary"),
				artifacts: args["artifacts-json"] !== undefined ? JSON.parse(String(args["artifacts-json"])) : undefined,
			};
			emit(await engine.finish(runId, params));
			return;
		}
		case "state": {
			const runId = stringArg(args, "run");
			if (!runId) {
				emit({ ok: false, repair: "state requires --run <id>" });
				return;
			}
			emit(engine.state(runId));
			return;
		}
		case "resume": {
			emit(await engine.resume(stringArg(args, "run")));
			return;
		}
		case "on-error": {
			const runId = stringArg(args, "run");
			if (!runId) {
				emit({ ok: false, repair: "on-error requires --run <id>" });
				return;
			}
			emit(
				await engine.onError(runId, {
					reason: stringArg(args, "reason") ?? "session_shutdown",
					message: stringArg(args, "message"),
				}),
			);
			return;
		}
		default: {
			emit({ ok: false, repair: `Unknown run subcommand: ${sub}` });
		}
	}
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	emit({ ok: false, repair: message });
	process.exitCode = 1;
});
