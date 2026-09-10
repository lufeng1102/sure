import { existsSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import type { OutputDirPolicy } from "./output-dir.ts";

/**
 * Lazy site-policy loader. Returns a getter that resolves the policy only on
 * first call (fail-closed when the loader or policy file is missing), so
 * `discover`/`state`/`resume`/`on-error` work even without `sure/site/loader.ts`,
 * while `output_dir` resolution still fails closed when the policy is absent.
 */
export function loadPolicy(cwd: string): () => OutputDirPolicy {
	const loaderPath = join(cwd, "sure/site/loader.ts");
	let resolved = false;
	let policy: OutputDirPolicy | undefined;
	return () => {
		if (resolved) {
			return policy as OutputDirPolicy;
		}
		resolved = true;
		if (!existsSync(loaderPath)) {
			throw new Error(
				`Site policy loader not found under ${cwd}: ${loaderPath} (required for output_dir resolution)`,
			);
		}
		const jiti = createJiti(import.meta.url, { moduleCache: false });
		const mod = jiti(loaderPath) as {
			requireSitePolicy: (opts?: { repositoryRoot?: string }) => { policy: { storage: OutputDirPolicy } };
		};
		policy = mod.requireSitePolicy({ repositoryRoot: cwd }).policy.storage;
		return policy;
	};
}
