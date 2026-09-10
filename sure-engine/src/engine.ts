import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SureHookRunner } from "./hooks.ts";
import { discoverSureSkillPackages, type SureDiscoveryResult } from "./manifest.ts";
import { validateManifestEnvelope } from "./manifest-validate.ts";
import { type OutputDirPolicy, resolveOutputDir } from "./output-dir.ts";
import { buildInvocationPrompt, buildResumePrompt } from "./prompt.ts";
import { SureRunManager } from "./run-manager.ts";
import { normalizeSureDisplayStatePatch } from "./state.ts";
import type {
	SureDisplayState,
	SureFinishParams,
	SureHookPoint,
	SureRunRecord,
	SureRunStatus,
	SureSkillPackage,
} from "./types.ts";

export interface SureEngineOutcome {
	ok: boolean;
	runId?: string;
	status?: SureRunStatus;
	prompt?: string;
	record?: SureRunRecord;
	state?: SureDisplayState;
	repair?: string;
	diagnostics?: unknown;
	/** For pre_tool_call gates: false means the adapter must block the tool. */
	allowed?: boolean;
}

function isResumable(record: SureRunRecord, state: SureDisplayState | undefined, cwd: string): boolean {
	if (record.cwd !== cwd) {
		return false;
	}
	if (record.status !== "running" && record.status !== "failed") {
		return false;
	}
	return state?.checkpoint?.resumable === true;
}

/**
 * Agent-agnostic SURE control plane. The engine owns run state, gate
 * enforcement, and the six lifecycle points. Adapters (pi, Codex, Claude)
 * drive it and translate the outcomes into their own tool/hook surfaces.
 */
export class SureEngine {
	private runManager: SureRunManager;
	private cwd: string;
	private getPolicy: () => OutputDirPolicy;

	constructor(cwd: string, getPolicy: () => OutputDirPolicy) {
		this.cwd = cwd;
		this.getPolicy = getPolicy;
		this.runManager = new SureRunManager(cwd);
	}

	discover(): SureDiscoveryResult {
		return discoverSureSkillPackages(this.cwd);
	}

	findSkill(command: string): SureSkillPackage | undefined {
		return this.discover().packages.find((pkg) => pkg.manifest.command === command);
	}

	private activeRunFile(): string {
		return join(this.cwd, ".sure", "current-run");
	}

	private setActiveRun(runId: string): void {
		writeFileSync(this.activeRunFile(), `${runId}\n`, "utf-8");
	}

	private clearActiveRun(runId: string): void {
		const file = this.activeRunFile();
		if (existsSync(file) && readFileSync(file, "utf-8").trim() === runId) {
			unlinkSync(file);
		}
	}

	private applyStatePatch(record: SureRunRecord, patchValue: unknown): SureDisplayState | undefined {
		if (patchValue === undefined) {
			return undefined;
		}
		const normalized = normalizeSureDisplayStatePatch(patchValue);
		if (!normalized.ok || !normalized.state) {
			return undefined;
		}
		return this.runManager.updateState(record, normalized.state);
	}

	private hookContext(record: SureRunRecord, skillPackage: SureSkillPackage, event?: unknown) {
		return {
			run: record,
			skill: skillPackage.manifest,
			cwd: this.cwd,
			packageDir: skillPackage.packageDir,
			runDir: record.runDir,
			args: record.args,
			event,
		};
	}

	async start(skillPackage: SureSkillPackage, args: string): Promise<SureEngineOutcome> {
		let outputDir: string | undefined;
		try {
			const resolved = resolveOutputDir(args, this.getPolicy);
			if (!resolved.ok) {
				return { ok: false, repair: resolved.error };
			}
			outputDir = resolved.dir;
		} catch (error) {
			return { ok: false, repair: error instanceof Error ? error.message : String(error) };
		}

		let record = this.runManager.createRun(skillPackage, args, outputDir);
		const hooks = new SureHookRunner(skillPackage);

		const preStart = await hooks.run("pre_start", this.hookContext(record, skillPackage));
		this.applyStatePatch(record, preStart.state_patch);
		if (!preStart.ok) {
			record = this.runManager.updateRun(
				record,
				{ status: "failed", finishedAt: new Date().toISOString(), lastRepair: preStart.repair ?? preStart.message },
				"pre_start_repair",
				preStart,
			);
			return {
				ok: false,
				runId: record.runId,
				record,
				repair: preStart.repair ?? preStart.message,
				diagnostics: preStart.diagnostics,
			};
		}

		record = this.runManager.setStatus(record, "running", "started");
		this.setActiveRun(record.runId);
		return {
			ok: true,
			runId: record.runId,
			record,
			prompt: buildInvocationPrompt(skillPackage, record),
			state: this.runManager.readState(record),
		};
	}

	async resume(runId?: string): Promise<SureEngineOutcome> {
		const candidates = runId ? [runId] : this.runManager.listRunIds().reverse();
		let resumed: { record: SureRunRecord; state: SureDisplayState | undefined } | undefined;
		for (const candidate of candidates) {
			const record = this.runManager.readRun(candidate);
			if (!record) {
				continue;
			}
			const state = this.runManager.readState(record);
			if (isResumable(record, state, this.cwd)) {
				resumed = { record, state };
				break;
			}
		}
		if (!resumed) {
			return {
				ok: false,
				repair: runId
					? `Sure run ${runId} cannot be resumed: no resumable checkpoint for this project.`
					: "No resumable Sure run in this project.",
			};
		}

		const skillPackage = this.findSkill(resumed.record.command);
		if (!skillPackage) {
			return { ok: false, repair: `No Sure skill package found for /${resumed.record.command}.` };
		}

		// pre_start is deliberately not re-run: it resets the checkpoint.
		const record = this.runManager.updateRun(resumed.record, { status: "running", finishedAt: undefined }, "resumed");
		this.setActiveRun(record.runId);
		return {
			ok: true,
			runId: record.runId,
			record,
			prompt: buildResumePrompt(skillPackage, record, resumed.state),
			state: resumed.state,
		};
	}

	async gate(runId: string, point: "pre_tool_call" | "post_tool_result", event: unknown): Promise<SureEngineOutcome> {
		const record = this.runManager.readRun(runId);
		if (!record) {
			return { ok: false, repair: `No Sure run ${runId}.` };
		}
		const skillPackage = this.findSkill(record.command);
		if (!skillPackage) {
			return { ok: false, repair: `No Sure skill package found for /${record.command}.` };
		}

		const hooks = new SureHookRunner(skillPackage);
		const isToolCall = point === "pre_tool_call";
		const refreshed = this.runManager.updateRun(
			record,
			isToolCall ? { staleSince: undefined } : {},
			isToolCall ? "tool_call" : "tool_result",
			event,
		);
		const gate = await hooks.run(point, this.hookContext(refreshed, skillPackage, event));
		this.applyStatePatch(refreshed, gate.state_patch);
		if (!gate.ok) {
			const repair = gate.repair ?? gate.message ?? "Repair the action and retry.";
			this.runManager.updateRun(refreshed, { lastRepair: repair }, `${point}_repair`, gate);
			return {
				ok: false,
				allowed: false,
				repair,
				diagnostics: gate.diagnostics,
				state: this.runManager.readState(refreshed),
			};
		}
		return { ok: true, allowed: true, state: this.runManager.readState(refreshed) };
	}

	async finish(runId: string, params: SureFinishParams): Promise<SureEngineOutcome> {
		const record = this.runManager.readRun(runId);
		if (!record) {
			return { ok: false, repair: `No Sure run ${runId}.` };
		}
		const skillPackage = this.findSkill(record.command);
		if (!skillPackage) {
			return { ok: false, repair: `No Sure skill package found for /${record.command}.` };
		}

		const hooks = new SureHookRunner(skillPackage);
		const manifestPath = this.runManager.resolveRunPath(record, params.manifest_path);
		if (!manifestPath || !existsSync(manifestPath)) {
			const repair = `Create the final manifest at ${params.manifest_path} inside the project or run workspace, then finish again.`;
			this.runManager.updateRun(record, { lastRepair: repair }, "finish_repair", { repair });
			return { ok: false, repair };
		}

		let manifest: unknown;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		} catch (error) {
			const repair = `Final manifest must be valid JSON: ${error instanceof Error ? error.message : String(error)}`;
			this.runManager.updateRun(record, { lastRepair: repair }, "finish_repair", { repair });
			return { ok: false, repair };
		}

		const envelopeError = validateManifestEnvelope(manifest, record, params, this.runManager, skillPackage);
		if (envelopeError) {
			const repair = `${envelopeError} Repair the manifest and finish again.`;
			this.runManager.updateRun(record, { lastRepair: repair }, "finish_repair", { repair });
			return { ok: false, repair };
		}

		const preFinishEvent = { finish: params, manifest, manifestPath };
		const gate = await hooks.run("pre_finish", this.hookContext(record, skillPackage, preFinishEvent));
		this.applyStatePatch(record, gate.state_patch);
		if (!gate.ok) {
			const repair = gate.repair ?? gate.message ?? "Repair the Sure artifacts and finish again.";
			this.runManager.updateRun(record, { lastRepair: repair }, "finish_repair", gate);
			return { ok: false, repair, diagnostics: gate.diagnostics };
		}

		const finished = this.runManager.updateRun(
			record,
			{
				status: params.status,
				manifestPath,
				summary: params.summary,
				errorSummary: params.error_summary,
				artifacts: params.artifacts,
				finishedAt: new Date().toISOString(),
				lastRepair: undefined,
			},
			"finished",
			{ finish: params, manifestPath },
		);

		this.clearActiveRun(finished.runId);
		const postFinish = await hooks.run("post_finish", this.hookContext(finished, skillPackage, preFinishEvent));
		this.applyStatePatch(finished, postFinish.state_patch);
		if (!postFinish.ok) {
			// post_finish failure is a warning, not a rejection (matches pi).
			return {
				ok: true,
				runId: finished.runId,
				status: finished.status,
				record: finished,
				state: this.runManager.readState(finished),
				repair: postFinish.message ?? postFinish.repair ?? "Sure post-finish hook failed.",
				diagnostics: postFinish.diagnostics,
			};
		}
		return {
			ok: true,
			runId: finished.runId,
			status: finished.status,
			record: finished,
			state: this.runManager.readState(finished),
		};
	}

	state(runId: string): SureEngineOutcome {
		const record = this.runManager.readRun(runId);
		if (!record) {
			return { ok: false, repair: `No Sure run ${runId}.` };
		}
		return { ok: true, runId, record, status: record.status, state: this.runManager.readState(record) };
	}

	async onError(runId: string, event: unknown): Promise<SureEngineOutcome> {
		const record = this.runManager.readRun(runId);
		if (!record) {
			return { ok: false, repair: `No Sure run ${runId}.` };
		}
		const skillPackage = this.findSkill(record.command);
		if (!skillPackage) {
			return { ok: false, repair: `No Sure skill package found for /${record.command}.` };
		}
		const hooks = new SureHookRunner(skillPackage);
		const gate = await hooks.run("on_error", this.hookContext(record, skillPackage, event));
		this.applyStatePatch(record, gate.state_patch);
		this.clearActiveRun(record.runId);
		return { ok: true, runId, record, state: this.runManager.readState(record) };
	}

	/** Hook points that gate tool execution. */
	static readonly GATE_POINTS: SureHookPoint[] = ["pre_tool_call", "post_tool_result"];
}
