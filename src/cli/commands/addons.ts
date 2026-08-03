/**
 * Addon groups: named sets of plugins, resource packs and data packs applied
 * to instances as a unit. The membership lives in `plugins.lock.json`; what
 * each kind *does* with it is the pack modules' business, reached here through
 * one apply (core/addons) so a group edit lands on every road at once.
 */

import { command, UsageError } from "../framework";
import { pc, ok, warn, info, printTable, ProgressView } from "../ui";
import { ProgressReporter } from "../../client/core/progress";
import { instanceNames } from "../completers";
import { loadCluster, loadLock, saveLock } from "../../client/core/config";
import {
	allPluginNames,
	deleteGroup,
	entriesOf,
	familyOf,
	groupInstances,
	setGroup,
} from "../../client/core/families";
import { applyAddonGroups } from "../../client/core/addons";
import { loadPacksLock, savePacksLock } from "../../client/core/packslock";
import { listResourcePacks } from "../../client/core/respacks";
import { applyGroupRestart, runDeploy } from "./plugins";

/** Group names for shell completion. */
async function groupNames(): Promise<string[]> {
	return Object.keys((await loadLock()).groups ?? {});
}

/** Split a comma-separated option value into trimmed members. */
function parseList(raw: unknown): string[] {
	return String(raw)
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * Push a group's pack membership to the cluster: resource pack rules are
 * rewritten (and the proxy reloaded), data packs are deployed into the worlds
 * the group covers.
 */
export async function runAddonApply(instances?: string[]): Promise<void> {
	const cfg = await loadCluster();
	const lock = await loadLock();
	const packs = await loadPacksLock();

	const progress = new ProgressReporter("apply addon groups");
	const view = new ProgressView(progress).start();

	const result = await applyAddonGroups(cfg, packs, lock.groups, {
		instances,
		reporter: progress,
	});

	view.stop();
	await savePacksLock(packs);

	if (result.respacks.length) {
		ok(
			`resource pack rules rewritten: ${result.respacks.join(", ")} ` +
				pc.dim(result.reloaded ? "(proxy reloaded)" : "(proxy down — applies on its next boot)"),
		);
	}

	for (const action of result.datapacks.filter((entry) => entry.action !== "unchanged")) {
		const line =
			`${pc.bold(action.instance)}: ${action.file} ` +
			pc.dim(`(${action.action}${action.detail ? `, ${action.detail}` : ""})`);

		if (action.action === "error") {
			warn(line);
		} else {
			ok(line);
		}
	}
}

command({
	path: ["addons", "groups"],
	desc: "List addon groups and the instances using them",

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadLock();

		const rows = Object.entries(lock.groups ?? {}).map(([name, group]) => [
			pc.bold(name) + (group.builtin ? pc.dim(" (builtin)") : ""),
			String(group.plugins.length),
			String(group.respacks?.length ?? 0),
			String(group.datapacks?.length ?? 0),
			groupInstances(cfg, name).join(",") || pc.dim("—"),
			pc.dim(group.description ?? ""),
		]);

		console.log();
		printTable(rows, { head: ["group", "plugins", "respacks", "datapacks", "used by", ""] });
		console.log();
	},
});

command({
	path: ["addons", "group"],
	desc: "Show, create or edit an addon group (then apply it + optional restart)",
	args: [{ name: "name", required: true, complete: groupNames }],
	opts: [
		{ flag: "--plugins", desc: "set membership to this comma-separated plugin list", value: true },
		{ flag: "--add", desc: "add plugin(s), comma-separated", value: true },
		{ flag: "--remove", desc: "remove plugin(s), comma-separated", value: true },
		{ flag: "--respacks", desc: "set the resource pack members, comma-separated", value: true },
		{ flag: "--datapacks", desc: "set the data pack members, comma-separated", value: true },
		{ flag: "--description", desc: "set the description", value: true },
		{ flag: "--delete", desc: "delete the group" },
		{ flag: "--restart", desc: 'after a change: "now", "none" (default), or a time', value: true },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;
		const existing = lock.groups?.[name];

		if (opts.delete) {
			deleteGroup(lock, name);
			await saveLock(lock);
			ok(`group ${pc.bold(name)} deleted ${pc.dim("(deployed files stay on disk)")}`);

			await runAddonApply();

			return;
		}

		const editing =
			opts.plugins !== undefined ||
			opts.add !== undefined ||
			opts.remove !== undefined ||
			opts.respacks !== undefined ||
			opts.datapacks !== undefined ||
			opts.description !== undefined;

		if (!editing) {
			if (!existing) {
				throw new UsageError(`unknown group: ${name} — pass --plugins to create it`);
			}

			console.log();
			info(
				`${pc.bold(name)}${existing.builtin ? pc.dim(" (builtin)") : ""} — ` +
					`${existing.description ?? pc.dim("no description")}`,
			);

			const rows = existing.plugins.map((plugin) => {
				const keys = entriesOf(lock, plugin);
				const families = keys.map((key) => familyOf(lock.plugins[key]!)).join(", ");

				return ["plugin", plugin, families || pc.red("not installed")];
			});

			const packs = await loadPacksLock();

			// a hand-registered pack has a yml but no lock entry, so the catalog —
			// not the lockfile — is what says whether it exists
			const respackRows = await listResourcePacks(cfg, packs, lock.groups);

			for (const key of existing.respacks ?? []) {
				const row = respackRows.find((candidate) => candidate.key === key);

				rows.push([
					"respack",
					key,
					row
						? pc.dim(row.enabled ? "enabled" : "registered, disabled")
						: pc.red("not pooled"),
				]);
			}

			for (const key of existing.datapacks ?? []) {
				rows.push([
					"datapack",
					key,
					packs.datapacks[key] ? pc.dim("pooled") : pc.red("not pooled"),
				]);
			}

			printTable(rows, { head: ["kind", "addon", ""] });

			info(`used by: ${groupInstances(cfg, name).join(", ") || pc.dim("nobody yet")}`);
			console.log();

			return;
		}

		const known = new Set(allPluginNames(lock));

		let members =
			opts.plugins !== undefined ? parseList(opts.plugins) : [...(existing?.plugins ?? [])];

		if (opts.add !== undefined) {
			members = [...members, ...parseList(opts.add)];
		}

		if (opts.remove !== undefined) {
			const drop = new Set(parseList(opts.remove));

			members = members.filter((plugin) => !drop.has(plugin));
		}

		for (const plugin of members) {
			if (!known.has(plugin)) {
				warn(`"${plugin}" is not a pooled plugin — it validates as missing until installed`);
			}
		}

		const packs = await loadPacksLock();
		const respackMembers = opts.respacks !== undefined ? parseList(opts.respacks) : undefined;
		const datapackMembers = opts.datapacks !== undefined ? parseList(opts.datapacks) : undefined;

		for (const key of respackMembers ?? []) {
			if (!packs.resourcepacks[key]) {
				warn(`"${key}" is not a registered resource pack — install or upload it first`);
			}
		}

		for (const key of datapackMembers ?? []) {
			if (!packs.datapacks[key]) {
				warn(`"${key}" is not a pooled data pack — install or upload it first`);
			}
		}

		const before = existing ? [...existing.plugins] : [];
		const beforePacks = [
			...(existing?.respacks ?? []),
			...(existing?.datapacks ?? []),
		].join(",");

		setGroup(lock, name, {
			plugins: members,
			...(respackMembers ? { respacks: respackMembers } : {}),
			...(datapackMembers ? { datapacks: datapackMembers } : {}),
			...(opts.description !== undefined ? { description: String(opts.description) } : {}),
		});

		await saveLock(lock);

		const after = lock.groups![name]!;
		const added = after.plugins.filter((plugin) => !before.includes(plugin));
		const removed = before.filter((plugin) => !after.plugins.includes(plugin));
		const afterPacks = [...(after.respacks ?? []), ...(after.datapacks ?? [])].join(",");

		ok(
			`group ${pc.bold(name)} saved — ${after.plugins.length} plugin(s), ` +
				`${after.respacks?.length ?? 0} resource pack(s), ${after.datapacks?.length ?? 0} data pack(s)` +
				(added.length ? pc.green(` +${added.join(",")}`) : "") +
				(removed.length ? pc.red(` -${removed.join(",")}`) : ""),
		);

		if (removed.length) {
			info(
				`removed plugins stay deployed — clean them with ` +
					pc.cyan("plugins remove <name> --from <inst>"),
			);
		}

		const affected = groupInstances(cfg, name);
		const pluginsChanged = added.length > 0 || removed.length > 0;
		const packsChanged = afterPacks !== beforePacks;

		if (affected.length && pluginsChanged) {
			await runDeploy(affected, undefined);
		}

		if (packsChanged || pluginsChanged) {
			await runAddonApply(affected.length ? affected : undefined);
		}

		if (affected.length && (pluginsChanged || packsChanged)) {
			await applyGroupRestart(cfg, name, opts.restart as string | undefined);
		}
	},
});

command({
	path: ["addons", "apply"],
	desc: "Re-apply every group's packs: rewrite pack rules and deploy data packs",
	args: [{ name: "instance", variadic: true, complete: instanceNames }],

	handler: async (args) => {
		await runAddonApply(args.length ? args : undefined);
	},
});
