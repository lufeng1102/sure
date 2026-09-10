import { existsSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { SureRunManager } from "./run-manager.ts";
import type {
	SureArtifactRequirement,
	SureFinishParams,
	SureManifestEnvelope,
	SureRunRecord,
	SureSkillPackage,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && !Array.isArray(value);
}

function isPathInside(baseDir: string, candidate: string): boolean {
	const rel = relative(baseDir, candidate);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && rel !== "..");
}

function isManifestArtifact(value: unknown): value is { type?: string; path?: string } {
	if (!isStringRecord(value)) {
		return false;
	}
	return (
		(value.type === undefined || typeof value.type === "string") &&
		(value.path === undefined || typeof value.path === "string")
	);
}

function possibleArtifactPaths(runManager: SureRunManager, run: SureRunRecord, pathValue: string): string[] {
	const paths: string[] = [];
	const projectOrAbsolutePath = runManager.resolveRunPath(run, pathValue);
	if (projectOrAbsolutePath) {
		paths.push(projectOrAbsolutePath);
	}
	if (!isAbsolute(pathValue)) {
		const runRelativePath = resolve(run.runDir, pathValue);
		if (isPathInside(run.runDir, runRelativePath)) {
			paths.push(runRelativePath);
		}
	}
	return [...new Set(paths)];
}

function artifactPathExists(runManager: SureRunManager, run: SureRunRecord, pathValue: string): boolean {
	return possibleArtifactPaths(runManager, run, pathValue).some((artifactPath) => existsSync(artifactPath));
}

function artifactPathMatchesRequirement(
	runManager: SureRunManager,
	run: SureRunRecord,
	artifactPath: string | undefined,
	requirementPath: string,
): boolean {
	if (!artifactPath) {
		return false;
	}
	if (artifactPath === requirementPath) {
		return true;
	}
	const artifactPaths = new Set(possibleArtifactPaths(runManager, run, artifactPath));
	return possibleArtifactPaths(runManager, run, requirementPath).some((path) => artifactPaths.has(path));
}

function artifactSatisfiesRequirement(
	runManager: SureRunManager,
	run: SureRunRecord,
	artifact: { type?: string; path?: string },
	requirement: SureArtifactRequirement,
): boolean {
	const requirementPath = requirement.path ?? "";
	if (artifactPathMatchesRequirement(runManager, run, artifact.path, requirementPath)) {
		return true;
	}
	if (!artifact.path || !artifactPathExists(runManager, run, artifact.path)) {
		return false;
	}
	if (requirementPath !== "" && basename(artifact.path) === basename(requirementPath)) {
		return true;
	}
	if (requirement.type && artifact.type !== requirement.type) {
		return false;
	}
	return false;
}

function formatArtifactDescription(artifact: { type?: string; path?: string }, index: number): string {
	if (artifact.type) {
		return `"${artifact.type}"`;
	}
	if (artifact.path) {
		return `"${artifact.path}"`;
	}
	return `at index ${index}`;
}

function validateManifestArtifacts(
	manifest: SureManifestEnvelope,
	runManager: SureRunManager,
	run: SureRunRecord,
): string | undefined {
	for (const [index, artifact] of (manifest.artifacts ?? []).entries()) {
		const description = formatArtifactDescription(artifact, index);
		if (!artifact.path || artifact.path.trim() === "") {
			return `Final manifest artifact ${description} must include a path.`;
		}
		if (!artifactPathExists(runManager, run, artifact.path)) {
			return `Manifest artifact path does not exist: ${artifact.path}.`;
		}
	}
	return undefined;
}

function outputArtifacts(manifest: SureManifestEnvelope): Array<{ type?: string; path?: string }> {
	const artifacts: Array<{ type?: string; path?: string }> = [];
	for (const [key, value] of Object.entries(manifest.outputs ?? {})) {
		if (typeof value === "string" && value.trim() !== "") {
			artifacts.push({ type: key, path: value });
			continue;
		}
		if (isStringRecord(value) && typeof value.path === "string" && value.path.trim() !== "") {
			artifacts.push({
				type: typeof value.type === "string" ? value.type : key,
				path: value.path,
			});
		}
	}
	return artifacts;
}

function validateRequiredArtifact(
	requirement: SureArtifactRequirement,
	manifest: SureManifestEnvelope,
	runManager: SureRunManager,
	run: SureRunRecord,
): string | undefined {
	if (!requirement.required) {
		return undefined;
	}
	if (!requirement.path || requirement.path.trim() === "") {
		const label = requirement.type
			? `"${requirement.type}"`
			: requirement.description
				? `"${requirement.description}"`
				: "";
		return `Required artifact ${label} must declare a path in sure.skill.json.`;
	}

	const artifacts = [...(manifest.artifacts ?? []), ...outputArtifacts(manifest)];
	const candidate = artifacts.find((artifact) => artifactSatisfiesRequirement(runManager, run, artifact, requirement));
	if (!candidate) {
		const description = requirement.description ? ` (${requirement.description})` : "";
		return `Final manifest is missing required artifact${description}.`;
	}
	if (!candidate.path || !artifactPathExists(runManager, run, candidate.path)) {
		return `Required artifact path does not exist: ${candidate.path ?? requirement.path}.`;
	}
	return undefined;
}

export function validateManifestEnvelope(
	value: unknown,
	run: SureRunRecord,
	finish: SureFinishParams,
	runManager: SureRunManager,
	skillPackage: SureSkillPackage,
): string | undefined {
	if (!isRecord(value)) {
		return "Final manifest must be a JSON object.";
	}
	const required = [
		"schema_version",
		"run_id",
		"skill_name",
		"status",
		"created_at",
		"inputs",
		"outputs",
		"validation",
	];
	for (const key of required) {
		if (!(key in value)) {
			return `Final manifest is missing required field "${key}".`;
		}
	}
	if (value.run_id !== run.runId) {
		return `Final manifest run_id must be "${run.runId}".`;
	}
	if (value.skill_name !== run.skillName) {
		return `Final manifest skill_name must be "${run.skillName}".`;
	}
	if (typeof value.schema_version !== "string" || value.schema_version.trim() === "") {
		return 'Final manifest field "schema_version" must be a non-empty string.';
	}
	if (value.status !== finish.status) {
		return `Final manifest status must match sure_finish status "${finish.status}".`;
	}
	if (typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
		return 'Final manifest field "created_at" must be an ISO date string.';
	}
	if (!isStringRecord(value.inputs)) {
		return 'Final manifest field "inputs" must be a JSON object.';
	}
	if (!isStringRecord(value.outputs)) {
		return 'Final manifest field "outputs" must be a JSON object.';
	}
	if (!isStringRecord(value.validation)) {
		return 'Final manifest field "validation" must be a JSON object.';
	}
	if (value.artifacts !== undefined) {
		if (!Array.isArray(value.artifacts) || !value.artifacts.every(isManifestArtifact)) {
			return 'Final manifest field "artifacts" must be an array of objects with optional string type/path fields.';
		}
	}
	const manifest = value as unknown as SureManifestEnvelope;
	const artifactError = validateManifestArtifacts(manifest, runManager, run);
	if (artifactError) {
		return artifactError;
	}
	if (finish.status === "success") {
		for (const requirement of skillPackage.manifest.artifacts ?? []) {
			const requirementError = validateRequiredArtifact(requirement, manifest, runManager, run);
			if (requirementError) {
				return requirementError;
			}
		}
	}
	return undefined;
}
