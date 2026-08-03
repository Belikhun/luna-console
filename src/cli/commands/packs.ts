/**
 * Resource pack and data pack commands — thin over the client bridge, same as
 * every other command file. Resource packs are the luna-pack proxy plugin's
 * catalog under `<root>/packs`; data packs are a pool under `<root>/datapacks`
 * deployed into instance worlds.
 */

import { command, UsageError, Bail } from "../framework";
import { pc, Sym, ok, info, warn, printTable, Spinner, fmtBytes } from "../ui";
import { instanceNames, targetSelectors } from "../completers";
import { loadCluster, loadLock, saveLock } from "../../client/core/config";
import { pruneAddon } from "../../client/core/families";
import * as datapacks from "../../client/core/datapacks";
import { loadPacksLock, savePacksLock, type PackChannel } from "../../client/core/packslock";
import * as respacks from "../../client/core/respacks";
import * as mr from "../../client/core/services/modrinth";

/** The addon groups pack membership resolves against (plugins.lock.json). */
async function addonGroups(): Promise<Awaited<ReturnType<typeof loadLock>>["groups"]> {
	return (await loadLock()).groups;
}

/** Pack keys for shell completion. */
async function respackKeys(): Promise<string[]> {
	const rows = await respacks.listResourcePacks(
		await loadCluster(),
		await loadPacksLock(),
		await addonGroups(),
	);

	return rows.map((row) => row.key);
}

/** Data pack names for shell completion. */
async function datapackNames(): Promise<string[]> {
	const lock = await loadPacksLock();

	return Object.keys(lock.datapacks);
}

/** Resolve a slug or free-text query to one Modrinth project, prompting on search. */
async function resolveProject(
	query: string,
	type: "resourcepack" | "datapack",
): Promise<mr.MrProject | undefined> {
	const spin = new Spinner().start(`resolving "${query}" on Modrinth...`);

	let project = await mr.getProject(query);

	spin.stop();

	if (project) {
		return project;
	}

	const hits = await mr.searchProjects(query, type);

	if (!hits.length) {
		throw new Bail(`nothing found for "${query}"`);
	}

	const { select, isCancel } = await import("@clack/prompts");

	const picked = await select({
		message: `Select a ${type === "datapack" ? "data pack" : "resource pack"}`,
		options: hits.map((hit) => ({
			value: hit.slug,
			label: hit.title,
			hint: `${hit.downloads.toLocaleString()} downloads — ${hit.description.slice(0, 60)}`,
		})),
	});

	if (isCancel(picked)) {
		info("aborted");

		return undefined;
	}

	return await mr.getProject(picked as string);
}

// -- resource packs -----------------------------------------------------------

command({
	path: ["packs"],
	desc: "List resource packs (luna-pack catalog in <root>/packs)",

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const rows = await respacks.listResourcePacks(cfg, lock, await addonGroups());

		if (!rows.length) {
			info("no resource packs — add one with: luna packs add <slug>");

			return;
		}

		const table = rows.map((row) => [
			row.enabled ? pc.green(Sym.ok) : pc.dim("○"),
			pc.bold(row.key),
			row.defFile ? String(row.priority) : pc.yellow("unregistered"),
			row.required ? "required" : "",
			row.servers.join(","),
			row.present ? fmtBytes(row.sizeBytes) : pc.red("file missing"),
			row.source,
			row.versionNumber ?? "",
		]);

		console.log();
		printTable(table, { head: ["", "pack", "priority", "", "servers", "size", "source", "version"] });
		console.log();
	},
});

command({
	path: ["packs", "add"],
	desc: "Install a resource pack from Modrinth (slug, or search query)",
	args: [{ name: "slug-or-query", required: true, variadic: true }],
	opts: [
		{ flag: "--channel", desc: "release channel: release, beta or alpha", value: true },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const project = await resolveProject(args.join(" "), "resourcepack");

		if (!project) {
			return;
		}

		const spin = new Spinner().start(`installing ${project.title}...`);
		const row = await respacks.installResourcePackFromModrinth(cfg, lock, project, {
			channel: opts.channel as PackChannel | undefined,
		});

		await savePacksLock(lock);
		spin.stop();

		ok(`installed ${pc.bold(row.key)} ${pc.green(row.versionNumber ?? "")} ${pc.dim(`(${fmtBytes(row.sizeBytes)})`)}`);
		info(`the pack starts disabled — enable it with: luna packs set ${row.key} --enable`);
	},
});

command({
	path: ["packs", "set"],
	desc: "Edit a pack's registration (priority, required, servers, enabled)",
	args: [{ name: "pack", required: true, complete: respackKeys }],
	opts: [
		{ flag: "--enable", desc: "enable the pack" },
		{ flag: "--disable", desc: "disable the pack" },
		{ flag: "--priority", desc: "stacking priority (higher applies over lower)", value: true },
		{ flag: "--required", desc: "players cannot decline the pack" },
		{ flag: "--optional", desc: "players may decline the pack" },
		{ flag: "--servers", desc: "comma-separated rules: names, *, !name", value: true },
		{ flag: "--name", desc: "display name", value: true },
		{ flag: "--auto", desc: "auto-update: on or off", value: true },
		{ flag: "--channel", desc: "update channel: release, beta or alpha", value: true },
	],

	handler: async (args, opts) => {
		if (opts.enable && opts.disable) {
			throw new UsageError("--enable and --disable are mutually exclusive");
		}

		if (opts.required && opts.optional) {
			throw new UsageError("--required and --optional are mutually exclusive");
		}

		const cfg = await loadCluster();
		const lock = await loadPacksLock();

		const patch: respacks.RespackPatch = {};

		if (opts.enable || opts.disable) {
			patch.enabled = !!opts.enable;
		}

		if (opts.required || opts.optional) {
			patch.required = !!opts.required;
		}

		if (opts.priority !== undefined) {
			patch.priority = Number(opts.priority);
		}

		if (opts.servers) {
			patch.servers = String(opts.servers).split(",").map((rule) => rule.trim()).filter(Boolean);
		}

		if (opts.name) {
			patch.name = String(opts.name);
		}

		if (opts.auto) {
			patch.autoUpdate = opts.auto === "on";
		}

		if (opts.channel) {
			patch.channel = opts.channel as PackChannel;
		}

		const row = await respacks.updateResourcePack(cfg, lock, args[0]!, patch, await addonGroups());

		await savePacksLock(lock);

		ok(
			`${pc.bold(row.key)}: ${row.enabled ? pc.green("enabled") : pc.dim("disabled")}, ` +
				`priority ${row.priority}, ${row.required ? "required" : "optional"}, servers ${row.servers.join(",")}`,
		);
		info("apply live with: luna packs reload");
	},
});

command({
	path: ["packs", "update"],
	desc: "Check resource packs for Modrinth updates (apply with --apply)",
	args: [{ name: "pack", variadic: true, complete: respackKeys }],
	opts: [{ flag: "--apply", desc: "download the updates instead of listing them" }],

	handler: async (args, opts) => {
		const lock = await loadPacksLock();
		const spin = new Spinner().start("checking Modrinth...");
		const { updates, skipped } = await respacks.checkResourcePackUpdates(
			lock,
			args.length ? args : undefined,
		);

		spin.stop();

		for (const entry of skipped.filter((candidate) => args.includes(candidate.key))) {
			warn(`${entry.key}: ${entry.reason}`);
		}

		if (!updates.length) {
			ok("every resource pack is up to date");

			return;
		}

		for (const update of updates) {
			info(`${pc.bold(update.key)}: ${update.from ?? "?"} ${Sym.arrow} ${pc.green(update.to)}`);
		}

		if (!opts.apply) {
			info(`apply with: luna packs update${args.length ? ` ${args.join(" ")}` : ""} --apply`);

			return;
		}

		for (const update of updates) {
			await respacks.applyResourcePackUpdate(lock, update);
			ok(`${update.key} ${Sym.arrow} ${update.to}`);
		}

		await savePacksLock(lock);
		info("apply live with: luna packs reload");
	},
});

command({
	path: ["packs", "remove"],
	desc: "Remove a resource pack (definition, zip and lock entry)",
	args: [{ name: "pack", required: true, complete: respackKeys }],
	opts: [{ flag: "--keep-file", desc: "remove the registration but keep the zip" }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const { removed } = await respacks.removeResourcePack(cfg, lock, args[0]!, {
			keepFile: !!opts["keep-file"],
		});

		await savePacksLock(lock);

		const groups = await loadLock();

		if (pruneAddon(groups, "respacks", args[0]!)) {
			await saveLock(groups);
		}

		if (!removed.length) {
			warn(`${args[0]}: nothing to remove`);

			return;
		}

		ok(`removed ${args[0]} ${pc.dim(`(${removed.join(", ")})`)}`);
		info("apply live with: luna packs reload");
	},
});

command({
	path: ["packs", "reload"],
	desc: "Ask the running proxy to re-read the packs directory (lunapack reload)",

	handler: async () => {
		const cfg = await loadCluster();

		if (await respacks.reloadResourcePacks(cfg)) {
			ok("reload sent to the proxy");
		} else {
			warn("the proxy is not running — packs load on its next boot");
		}
	},
});

// -- data packs ---------------------------------------------------------------

command({
	path: ["datapacks"],
	desc: "List pooled data packs and where they deploy",

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const rows = await datapacks.listDataPacks(cfg, lock, await addonGroups());

		if (!rows.length) {
			info("no data packs — add one with: luna datapacks add <slug> --to <instance>");

			return;
		}

		const table = rows.map((row) => [
			pc.bold(row.name),
			row.present ? fmtBytes(row.sizeBytes) : pc.red("file missing"),
			row.entry.source,
			row.entry.installed?.versionNumber ?? "",
			row.entry.autoUpdate ? "auto" : "",
			row.effectiveTargets.join(",") || pc.dim("nowhere"),
		]);

		console.log();
		printTable(table, { head: ["pack", "size", "source", "version", "", "deploys to"] });
		console.log();
	},
});

command({
	path: ["datapacks", "add"],
	desc: "Install a data pack from Modrinth (slug, or search query)",
	args: [{ name: "slug-or-query", required: true, variadic: true }],
	opts: [
		{
			flag: "--to",
			desc: "targets: *, *paper, or instance names",
			value: true,
			complete: targetSelectors,
		},
		{ flag: "--channel", desc: "release channel: release, beta or alpha", value: true },
	],

	handler: async (args, opts) => {
		if (!opts.to) {
			throw new UsageError("--to is required (which instances' worlds get the pack)");
		}

		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const project = await resolveProject(args.join(" "), "datapack");

		if (!project) {
			return;
		}

		const targets = String(opts.to).split(",").map((target) => target.trim()).filter(Boolean);
		const spin = new Spinner().start(`installing ${project.title}...`);
		const res = await datapacks.installDataPackFromModrinth(cfg, lock, project, targets, {
			channel: opts.channel as PackChannel | undefined,
		});

		await savePacksLock(lock);
		spin.stop();

		ok(`installed ${pc.bold(res.name)} ${pc.green(res.entry.installed?.versionNumber ?? "")}`);

		await runDatapackDeploy(undefined, res.name);
	},
});

/** Deploy the pool into worlds and print what changed, shared by add/deploy. */
async function runDatapackDeploy(instances: string[] | undefined, pack?: string): Promise<void> {
	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const spin = new Spinner().start("deploying data packs...");
	const actions = await datapacks.deployDataPacks(cfg, lock, {
		instances,
		pack,
		groups: await addonGroups(),
	});

	spin.stop();

	const changed = actions.filter((action) => action.action !== "unchanged");

	for (const action of changed) {
		const line = `${pc.bold(action.instance)}: ${action.file} ` +
			pc.dim(`(${action.action}${action.detail ? `, ${action.detail}` : ""})`);

		if (action.action === "error") {
			warn(line);
		} else {
			ok(line);
		}
	}

	if (!changed.length) {
		ok("every world already in sync");

		return;
	}

	info("running servers load the change on their next restart (or /minecraft:reload)");
}

command({
	path: ["datapacks", "deploy"],
	desc: "Sync pooled data packs into target instances' worlds",
	args: [{ name: "instance", variadic: true, complete: instanceNames }],
	opts: [{ flag: "--pack", desc: "deploy a single pack", value: true, complete: datapackNames }],

	handler: async (args, opts) => {
		await runDatapackDeploy(args.length ? args : undefined, opts.pack as string | undefined);
	},
});

command({
	path: ["datapacks", "update"],
	desc: "Check data packs for Modrinth updates (apply with --apply)",
	args: [{ name: "pack", variadic: true, complete: datapackNames }],
	opts: [{ flag: "--apply", desc: "download the updates and redeploy" }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const spin = new Spinner().start("checking Modrinth...");
		const { updates, skipped } = await datapacks.checkDataPackUpdates(
			cfg,
			lock,
			args.length ? args : undefined,
			await addonGroups(),
		);

		spin.stop();

		for (const entry of skipped.filter((candidate) => args.includes(candidate.name))) {
			warn(`${entry.name}: ${entry.reason}`);
		}

		if (!updates.length) {
			ok("every data pack is up to date");

			return;
		}

		for (const update of updates) {
			info(`${pc.bold(update.name)}: ${update.from ?? "?"} ${Sym.arrow} ${pc.green(update.to)}`);
		}

		if (!opts.apply) {
			info(`apply with: luna datapacks update${args.length ? ` ${args.join(" ")}` : ""} --apply`);

			return;
		}

		for (const update of updates) {
			await datapacks.applyDataPackUpdate(lock, update);
			ok(`${update.name} ${Sym.arrow} ${update.to}`);
		}

		await savePacksLock(lock);

		for (const update of updates) {
			await runDatapackDeploy(undefined, update.name);
		}
	},
});

command({
	path: ["datapacks", "adopt"],
	desc: "Adopt a hand-dropped zip from an instance's world into the pool",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const res = await datapacks.adoptDataPack(cfg, lock, args[0]!, args[1]!);

		await savePacksLock(lock);

		ok(`adopted ${pc.bold(res.name)} ${Sym.arrow} datapacks/${res.entry.file} (targets: ${args[0]})`);
	},
});

command({
	path: ["datapacks", "remove"],
	desc: "Remove a data pack from worlds (and the pool when nothing targets it)",
	args: [{ name: "pack", required: true, complete: datapackNames }],
	opts: [
		{
			flag: "--from",
			desc: "only remove from these instances",
			value: true,
			complete: targetSelectors,
		},
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const from = opts.from
			? String(opts.from).split(",").map((target) => target.trim()).filter(Boolean)
			: undefined;

		const groups = await loadLock();
		const res = await datapacks.removeDataPack(cfg, lock, args[0]!, from, groups.groups);

		await savePacksLock(lock);

		// a pack that is gone must not linger as a phantom group member
		if (res.entryRemoved && pruneAddon(groups, "datapacks", args[0]!)) {
			await saveLock(groups);
		}

		const where = res.deletedFrom.length ? res.deletedFrom.join(", ") : "no worlds held it";

		ok(`removed ${pc.bold(args[0]!)} ${pc.dim(`(${where}${res.entryRemoved ? "; pool entry dropped" : ""})`)}`);
	},
});
