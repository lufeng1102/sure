import { relative } from "node:path";
import { stripOutputDir } from "./output-dir.ts";
import type { SureDisplayState, SureRunRecord, SureSkillPackage } from "./types.ts";

const FINISH_TOOL_NAME = "sure_finish";

export function buildInvocationPrompt(skillPackage: SureSkillPackage, run: SureRunRecord): string {
	const relativePackage = relative(run.cwd, skillPackage.packageDir) || ".";
	const agentArgs = stripOutputDir(run.args);
	return [
		`<sure_invocation run_id="${run.runId}" skill="${skillPackage.manifest.name}" command="/${skillPackage.manifest.command}">`,
		`Package directory: ${relativePackage}`,
		`Run directory: ${relative(run.cwd, run.runDir)}`,
		`User arguments: ${agentArgs || "(none)"}`,
		"",
		"Run this Sure skill as a scientific task. Produce durable artifacts in the run directory or project workspace.",
		"Use the skill instructions below. References are relative to the package directory.",
		"",
		skillPackage.prompt,
		"",
		"Completion protocol:",
		`- Finish by calling ${FINISH_TOOL_NAME} as a standalone final tool call.`,
		"- Do not emit a normal final answer instead of the finish tool.",
		"- If the finish tool returns repair instructions, fix the artifacts and call it again.",
		"- The final manifest must include schema_version, run_id, skill_name, status, created_at, inputs, outputs, and validation.",
		"</sure_invocation>",
	].join("\n");
}

export function buildResumePrompt(
	skillPackage: SureSkillPackage,
	run: SureRunRecord,
	state: SureDisplayState | undefined,
): string {
	const checkpoint = state?.checkpoint;
	return [
		buildInvocationPrompt(skillPackage, run),
		"",
		`<sure_resume run_id="${run.runId}">`,
		"This run already produced work in its run directory. Pick it back up rather than starting over.",
		`Checkpoint: ${checkpoint?.label ?? checkpoint?.id ?? "(unnamed)"}`,
		`Where it stopped: ${state?.message ?? "(not recorded)"}`,
		`Resume from: ${checkpoint?.resume_hint ?? "(no hint recorded; read the run directory to see what is already done)"}`,
		"Read the existing artifacts before writing anything, and do not redo units that are already complete.",
		"</sure_resume>",
	].join("\n");
}
