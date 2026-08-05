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
import { t } from "../../shared/i18n";

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

	const progress = new ProgressReporter(t("cli.addons.apply.progressName"));
	const view = new ProgressView(progress).start();

	const result = await applyAddonGroups(cfg, packs, lock.groups, {
		instances,
		reporter: progress,
	});

	view.stop();
	await savePacksLock(packs);

	if (result.respacks.length) {
		ok(
			`${t("cli.addons.apply.respacksRewritten", { names: result.respacks.join(", ") })} ` +
				pc.dim(
					result.reloaded
						? t("cli.addons.apply.proxyReloaded")
						: t("cli.addons.apply.proxyDown"),
				),
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
	desc: t("cli.addons.groups.desc"),

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadLock();

		const rows = Object.entries(lock.groups ?? {}).map(([name, group]) => [
			pc.bold(name) + (group.builtin ? pc.dim(` ${t("cli.addons.builtinTag")}`) : ""),
			String(group.plugins.length),
			String(group.respacks?.length ?? 0),
			String(group.datapacks?.length ?? 0),
			groupInstances(cfg, name).join(",") || pc.dim("—"),
			pc.dim(group.description ?? ""),
		]);

		console.log();
		printTable(rows, {
			head: [
				t("cli.head.group"),
				t("cli.head.plugins"),
				t("cli.head.respacks"),
				t("cli.head.datapacks"),
				t("cli.head.usedBy"),
				"",
			],
		});
		console.log();
	},
});

command({
	path: ["addons", "group"],
	desc: t("cli.addons.group.desc"),
	args: [{ name: "name", required: true, complete: groupNames }],
	opts: [
		{ flag: "--plugins", desc: t("cli.addons.group.optPlugins"), value: true },
		{ flag: "--add", desc: t("cli.addons.group.optAdd"), value: true },
		{ flag: "--remove", desc: t("cli.addons.group.optRemove"), value: true },
		{ flag: "--respacks", desc: t("cli.addons.group.optRespacks"), value: true },
		{ flag: "--datapacks", desc: t("cli.addons.group.optDatapacks"), value: true },
		{ flag: "--description", desc: t("cli.addons.group.optDescription"), value: true },
		{ flag: "--delete", desc: t("cli.addons.group.optDelete") },
		{ flag: "--restart", desc: t("cli.addons.group.optRestart"), value: true },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;
		const existing = lock.groups?.[name];

		if (opts.delete) {
			deleteGroup(lock, name);
			await saveLock(lock);
			ok(
				`${t("cli.addons.group.deleted", { name: pc.bold(name) })} ${pc.dim(t("cli.addons.group.deletedNote"))}`,
			);

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
				throw new UsageError(t("cli.addons.group.unknown", { name }));
			}

			console.log();
			info(
				`${pc.bold(name)}${existing.builtin ? pc.dim(` ${t("cli.addons.builtinTag")}`) : ""} · ` +
					`${existing.description ?? pc.dim(t("cli.addons.group.noDescription"))}`,
			);

			const rows = existing.plugins.map((plugin) => {
				const keys = entriesOf(lock, plugin);
				const families = keys.map((key) => familyOf(lock.plugins[key]!)).join(", ");

				return ["plugin", plugin, families || pc.red(t("cli.addons.group.notInstalled"))];
			});

			const packs = await loadPacksLock();

			// a hand-registered pack has a yml but no lock entry, so the catalog,
			// not the lockfile, is what says whether it exists
			const respackRows = await listResourcePacks(cfg, packs, lock.groups);

			for (const key of existing.respacks ?? []) {
				const row = respackRows.find((candidate) => candidate.key === key);

				rows.push([
					"respack",
					key,
					row
						? pc.dim(
								row.enabled
									? t("cli.addons.group.packEnabled")
									: t("cli.addons.group.packDisabled"),
							)
						: pc.red(t("cli.addons.group.notPooled")),
				]);
			}

			for (const key of existing.datapacks ?? []) {
				rows.push([
					"datapack",
					key,
					packs.datapacks[key]
						? pc.dim(t("cli.addons.group.packPooled"))
						: pc.red(t("cli.addons.group.notPooled")),
				]);
			}

			printTable(rows, { head: [t("cli.head.kind"), t("cli.head.addon"), ""] });

			info(
				t("cli.addons.group.usedBy", {
					names: groupInstances(cfg, name).join(", ") || pc.dim(t("cli.addons.group.nobodyYet")),
				}),
			);
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
				warn(t("cli.addons.group.notPooledPlugin", { name: plugin }));
			}
		}

		const packs = await loadPacksLock();
		const respackMembers = opts.respacks !== undefined ? parseList(opts.respacks) : undefined;
		const datapackMembers = opts.datapacks !== undefined ? parseList(opts.datapacks) : undefined;

		for (const key of respackMembers ?? []) {
			if (!packs.resourcepacks[key]) {
				warn(t("cli.addons.group.notRegisteredRespack", { name: key }));
			}
		}

		for (const key of datapackMembers ?? []) {
			if (!packs.datapacks[key]) {
				warn(t("cli.addons.group.notPooledDatapack", { name: key }));
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
			t("cli.addons.group.saved", {
				name: pc.bold(name),
				plugins: after.plugins.length,
				respacks: after.respacks?.length ?? 0,
				datapacks: after.datapacks?.length ?? 0,
			}) +
				(added.length ? pc.green(` +${added.join(",")}`) : "") +
				(removed.length ? pc.red(` -${removed.join(",")}`) : ""),
		);

		if (removed.length) {
			info(
				t("cli.addons.group.removedStay", {
					command: pc.cyan("plugins remove <name> --from <inst>"),
				}),
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
	desc: t("cli.addons.apply.desc"),
	args: [{ name: "instance", variadic: true, complete: instanceNames }],

	handler: async (args) => {
		await runAddonApply(args.length ? args : undefined);
	},
});
