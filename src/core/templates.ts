/**
 * Config templates (DESIGN.md §3.3) — the task-definition half of the design:
 * per-build `config` ops on a lockfile entry, applied whenever the plugin
 * deploys to an instance. `set` ops are surgical single-key edits through
 * confedit (line-preserving, per the state invariants); `write` ops bootstrap
 * a whole file only when it does not exist. Ops that cannot apply yet — the
 * plugin has not booted and generated its config, or a `${VAR}` is undefined —
 * report `pending` and converge on the next apply.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ClusterConfig, ConfigOp, PluginsLock } from "./types";
import { instanceDir, managedInstances } from "./config";
import { getConfValue, setConfValue, type ConfFormat } from "./confedit";
import { effectiveTargets, pluginNameOf } from "./families";
import { loadEnv, resolveVars, substitute } from "./environment";

export interface TemplateResult {
	plugin: string;
	instance: string;
	file: string;
	key?: string;
	outcome: "set" | "unchanged" | "wrote" | "pending-file" | "pending-key" | "missing-var";
	detail?: string;
}

/** Config syntax inferred from a file's extension. */
function formatFor(op: ConfigOp): ConfFormat {
	if (op.format) {
		return op.format;
	}

	if (op.file.endsWith(".properties")) {
		return "properties";
	}

	if (op.file.endsWith(".toml")) {
		return "toml";
	}

	if (op.file.endsWith(".conf")) {
		return "hocon";
	}

	return "yaml";
}

/** Apply one entry's ops to one instance. */
async function applyOps(
	plugin: string,
	instance: string,
	dir: string,
	ops: ConfigOp[],
	vars: Record<string, string>,
): Promise<TemplateResult[]> {
	const results: TemplateResult[] = [];

	for (const op of ops) {
		const path = join(dir, op.file);

		if (op.write !== undefined && !existsSync(path)) {
			const body = substitute(op.write, vars);

			if (body.missing.length) {
				results.push({
					plugin,
					instance,
					file: op.file,
					outcome: "missing-var",
					detail: `undefined: ${body.missing.join(", ")}`,
				});
			} else {
				await mkdir(dirname(path), { recursive: true });
				await Bun.write(path, body.text);

				results.push({ plugin, instance, file: op.file, outcome: "wrote" });
			}
		}

		for (const [key, raw] of Object.entries(op.set ?? {})) {
			const value = substitute(raw, vars);

			if (value.missing.length) {
				results.push({
					plugin,
					instance,
					file: op.file,
					key,
					outcome: "missing-var",
					detail: `undefined: ${value.missing.join(", ")}`,
				});

				continue;
			}

			if (!existsSync(path)) {
				// the plugin has not generated its config yet — first boot will, and
				// the next deploy or `env apply` converges it
				results.push({ plugin, instance, file: op.file, key, outcome: "pending-file" });

				continue;
			}

			const format = formatFor(op);
			const current = await getConfValue(path, format, key);

			if (current === value.text) {
				results.push({ plugin, instance, file: op.file, key, outcome: "unchanged" });

				continue;
			}

			const written = await setConfValue(path, format, key, value.text);

			results.push({
				plugin,
				instance,
				file: op.file,
				key,
				outcome: written ? "set" : "pending-key",
				detail: written ? `${current ?? "(unset)"} → ${value.text}` : undefined,
			});
		}
	}

	return results;
}

/**
 * Apply every config template that reaches `instance` — all entries whose
 * effective targets include it and that carry ops. `plugin` narrows to one
 * entry key.
 */
export async function applyTemplates(
	cfg: ClusterConfig,
	lock: PluginsLock,
	instance: string,
	opts: { entry?: string } = {},
): Promise<TemplateResult[]> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(`unknown instance: ${instance}`);
	}

	const env = await loadEnv();
	const vars = await resolveVars(cfg, env, instance);
	const dir = instanceDir(inst);
	const results: TemplateResult[] = [];

	for (const [key, entry] of Object.entries(lock.plugins)) {
		if (opts.entry && opts.entry !== key) {
			continue;
		}

		if (!entry.config?.length) {
			continue;
		}

		if (!effectiveTargets(cfg, lock, key).includes(instance)) {
			continue;
		}

		results.push(...(await applyOps(pluginNameOf(key, entry), instance, dir, entry.config, vars)));
	}

	return results;
}

/** Outcomes worth telling the operator about (everything except no-ops). */
export function notableTemplateResults(results: TemplateResult[]): TemplateResult[] {
	return results.filter((result) => result.outcome !== "unchanged");
}
