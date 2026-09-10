/**
 * SURE hook contract — canonical, agent-agnostic types shared between the
 * skill hooks and any driver that runs them (pi, sure-engine CLI, Claude Code,
 * Codex CLI, ...).
 *
 * This file is the single source of truth for the shape of a hook invocation
 * and its result. It must not import from any specific agent runtime;
 * skill hooks import these types directly.
 */

export type SureRunStatus =
	| "pending"
	| "running"
	| "success"
	| "failed"
	| "incomplete"
	| "cancelled";

export type SureHookPoint =
	| "pre_start"
	| "pre_tool_call"
	| "post_tool_result"
	| "pre_finish"
	| "post_finish"
	| "on_error";

export interface SureHookDeclaration {
	module: string;
	handler?: string;
}

export interface SureArtifactRequirement {
	type?: string;
	path?: string;
	required?: boolean;
	description?: string;
}

export interface SureSkillUiHints {
	primaryCounters?: string[];
	artifactTypes?: string[];
	defaultExpandedSections?: string[];
}

export interface SureSkillManifest {
	name: string;
	command: string;
	description?: string;
	prompt: string;
	hooks?: Partial<Record<SureHookPoint, SureHookDeclaration[]>>;
	artifacts?: SureArtifactRequirement[];
	ui?: SureSkillUiHints;
}

export interface SureRunRecord {
	runId: string;
	skillName: string;
	command: string;
	status: SureRunStatus;
	cwd: string;
	packageDir: string;
	runDir: string;
	args: string;
	outputDir?: string;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
	manifestPath?: string;
	summary?: string;
	errorSummary?: string;
	lastRepair?: string;
	artifacts?: unknown;
}

export interface SureHookContext {
	point: SureHookPoint;
	run: SureRunRecord;
	skill: SureSkillManifest;
	cwd: string;
	packageDir: string;
	runDir: string;
	args: string;
	event?: unknown;
}

export interface SureHookResult {
	ok?: boolean;
	message?: string;
	repair?: string;
	patch?: unknown;
	artifacts?: unknown;
	diagnostics?: unknown;
	state_patch?: unknown;
}
