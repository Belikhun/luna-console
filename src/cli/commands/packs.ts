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
import * as respackinfo from "../../client/core/respackinfo";
import * as respacks from "../../client/core/respacks";
import * as providers from "../../client/core/services/providers";
import type { ProviderId } from "../../client/core/types";

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

/** The provider a `--provider` flag selects, defaulting to Modrinth. */
export function parseProvider(value: string | undefined): ProviderId {
	const provider = (value ?? "modrinth").toLowerCase();

	if (!(providers.PROVIDER_IDS as string[]).includes(provider)) {
		throw new UsageError(
			`unknown provider: ${provider} (expected ${providers.PROVIDER_IDS.join(", ")})`,
		);
	}

	return provider as ProviderId;
}

/** Resolve a slug or free-text query to one provider project, prompting on search. */
async function resolveProject(
	query: string,
	type: "resourcepack" | "datapack",
	provider: ProviderId,
): Promise<providers.AddonProject | undefined> {
	const label = providers.PROVIDER_IDS.includes(provider) ? provider : "provider";
	const spin = new Spinner().start(`resolving "${query}" on ${label}...`);

	let project = await providers.getProject(provider, query, type);

	spin.stop();

	if (project) {
		return project;
	}

	const hits = await providers.searchProvider(provider, query, type);

	if (!hits.length) {
		throw new Bail(`nothing found for "${query}"`);
	}

	const { select, isCancel } = await import("@clack/prompts");

	const picked = await select({
		message: `Select a ${type === "datapack" ? "data pack" : "resource pack"}`,
		options: hits.map((hit) => ({
			// smithed slugs are only known after a project lookup — pick by id
			value: hit.project_id,
			label: hit.title,
			hint: `${hit.downloads.toLocaleString()} downloads — ${hit.description.slice(0, 60)}`,
		})),
	});

	if (isCancel(picked)) {
		info("aborted");

		return undefined;
	}

	return await providers.getProject(provider, picked as string, type);
}

// -- resource packs -----------------------------------------------------------

command({
	path: ["packs"],
	desc: "List resource packs (luna-pack catalog in <root>/packs)",

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const { rows, dynamic } = await respacks.listResourcePacksLive(
			cfg,
			lock,
			await addonGroups(),
		);

		if (!rows.length) {
			info("no resource packs — add one with: luna packs add <slug>");

			return;
		}

		const table = rows.map((row) => [
			row.enabled ? pc.green(Sym.ok) : pc.dim("○"),
			pc.bold(row.key),
			registrationCell(row),
			row.required ? "required" : "",
			row.servers.join(","),
			row.present ? fmtBytes(row.sizeBytes) : pc.red("file missing"),
			row.registration === "dynamic" ? pc.magenta("plugin") : row.source,
			row.versionNumber ?? "",
		]);

		console.log();
		printTable(table, { head: ["", "pack", "priority", "", "servers", "size", "source", "version"] });
		console.log();

		const runtime = rows.filter((row) => row.registration === "dynamic");
		const shadowed = rows.filter((row) => row.shadowsDynamic);

		if (runtime.length) {
			info(
				`${runtime.length} pack(s) registered by a plugin at runtime: ${runtime
					.map((row) => row.key)
					.join(", ")} — luna has no definition for them`,
			);
		}

		for (const row of shadowed) {
			warn(
				`${row.key}: your ${row.defFile} overrides the plugin that also registers it — ` +
					`release it with: luna packs release ${row.key}`,
			);
		}

		if (!dynamic.available) {
			info(`runtime registrations unknown: ${dynamic.problem}`);
		}
	},
});

/**
 * The priority cell, which is also where a pack's registration is reported: a
 * number is a real stacking order, anything else says why there is none.
 */
function registrationCell(row: respacks.RespackRow): string {
	if (row.registration === "dynamic") {
		return `${row.priority} ${pc.magenta("(plugin)")}`;
	}

	if (row.defFile) {
		return String(row.priority);
	}

	return row.registration === "unknown" ? pc.dim("registration unknown") : pc.yellow("unregistered");
}

command({
	path: ["packs", "add"],
	desc: "Install a resource pack from a provider (slug, or search query)",
	args: [{ name: "slug-or-query", required: true, variadic: true }],
	opts: [
		{ flag: "--channel", desc: "release channel: release, beta or alpha", value: true },
		{
			flag: "--provider",
			desc: "where to install from: modrinth (default) or curseforge",
			value: true,
			complete: async () => ["modrinth", "curseforge"],
		},
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const provider = parseProvider(opts.provider as string | undefined);
		const project = await resolveProject(args.join(" "), "resourcepack", provider);

		if (!project) {
			return;
		}

		const spin = new Spinner().start(`installing ${project.title}...`);
		const row = await respacks.installResourcePackFromProvider(cfg, lock, provider, project, {
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

/**
 * Print a probe: what luna thinks the local file is, and on what evidence. The
 * CLI shows this instead of guessing whenever the answer is not proven, because
 * recording the wrong version is what makes a later "update" a downgrade.
 */
export function printProbe(probe: {
	confidence: string;
	best?: { versionNumber: string; basis: string; publishedAt: string };
	matches: Array<{ versionId: string; versionNumber: string; basis: string }>;
	newest?: { versionNumber: string };
	project: { title: string; slug: string };
}): void {
	info(`project: ${pc.bold(probe.project.title)} (${probe.project.slug})`);

	if (probe.confidence === "exact" && probe.best) {
		ok(`identified as ${pc.green(probe.best.versionNumber)} — ${probe.best.basis} matches`);

		return;
	}

	if (probe.confidence === "likely" && probe.best) {
		warn(`probably ${pc.yellow(probe.best.versionNumber)} — matched by ${probe.best.basis}, not a hash`);
	} else {
		warn("no published version matches this file");
	}

	if (probe.matches.length > 1) {
		info("candidates:");

		for (const match of probe.matches) {
			console.log(`   ${match.versionNumber}  ${pc.dim(match.versionId)}  ${pc.dim(match.basis)}`);
		}
	}

	if (probe.newest) {
		info(`newest release: ${probe.newest.versionNumber} — what an unidentified mapping would pull`);
	}
}

command({
	path: ["packs", "identify"],
	desc: "Map an existing resource pack to a provider project (so updates apply)",
	args: [
		{ name: "pack", required: true, complete: respackKeys },
		{ name: "slug-or-id", required: true },
	],
	opts: [
		{ flag: "--provider", desc: "provider to map against (default modrinth)", value: true },
		{ flag: "--version", desc: "version id to record as installed", value: true },
		{ flag: "--unidentified", desc: "record the project but no version" },
		{ flag: "--auto", desc: "auto-update: on or off (default on only for a proven match)", value: true },
		{ flag: "--yes", desc: "accept an unproven match without asking" },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const key = args[0]!;
		const provider = parseProvider(opts.provider as string | undefined);

		const spin = new Spinner().start(`identifying ${key} at ${provider}…`);
		const probe = await respacks.probeRespackIdentity(cfg, lock, key, provider, args[1]!);

		spin.stop();
		printProbe(probe);

		// an unproven match is a guess about what the server is running, so it is
		// the operator's call and never a default
		if (probe.confidence !== "exact" && !opts.version && !opts.unidentified && !opts.yes) {
			throw new Bail(
				"nothing proved which version this is — re-run with --version <id>, --unidentified, or --yes",
			);
		}

		const { row, match } = await respacks.identifyResourcePack(cfg, lock, key, {
			provider,
			project: args[1]!,
			versionId: opts.version as string | undefined,
			unidentified: opts.unidentified as boolean | undefined,
			autoUpdate: opts.auto === undefined ? undefined : opts.auto === "on",
		});

		await savePacksLock(lock);

		ok(
			`${pc.bold(row.key)} → ${provider}:${probe.project.slug} ` +
				`${match ? pc.green(match.versionNumber) : pc.dim("version unknown")}, ` +
				`auto-update ${row.autoUpdate ? pc.green("on") : pc.dim("off")}`,
		);

		if (!match) {
			info("with no version recorded, the next check offers the newest compatible release");
		}
	},
});

command({
	path: ["packs", "forget"],
	desc: "Drop a resource pack's provider mapping (keeps the zip and its rules)",
	args: [{ name: "pack", required: true, complete: respackKeys }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const row = await respacks.forgetRespackIdentity(cfg, lock, args[0]!);

		await savePacksLock(lock);

		ok(`${pc.bold(row.key)} is no longer mapped to a provider — updates will not be checked`);
	},
});

command({
	path: ["packs", "takeover"],
	desc: "Take over a plugin-registered pack by writing its definition",
	args: [{ name: "pack", required: true, complete: respackKeys }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const { row, from } = await respacks.takeOverDynamicPack(cfg, lock, args[0]!);

		await savePacksLock(lock);

		ok(`wrote ${pc.bold(`${row.key}.yml`)} from the running registration`);
		info(
			`priority ${from.priority}, ${from.required ? "required" : "optional"}, ` +
				`servers ${from.servers.join(",")} — the plugin no longer decides these`,
		);
		info("apply live with: luna packs reload");
	},
});

command({
	path: ["packs", "release"],
	desc: "Give a taken-over pack back to the plugin that registers it",
	args: [{ name: "pack", required: true, complete: respackKeys }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const { removed, dynamic } = await respacks.releaseDynamicPack(cfg, lock, args[0]!);

		await savePacksLock(lock);

		ok(`removed ${pc.bold(removed)}`);

		if (dynamic) {
			info(
				`the plugin's own registration applies again: priority ${dynamic.priority}, ` +
					`servers ${dynamic.servers.join(",")}`,
			);
		}

		info("apply live with: luna packs reload");
	},
});

command({
	path: ["packs", "serve"],
	desc: "Serve a pack on one or more backends (stop serving with --off)",
	args: [
		{ name: "pack", required: true, complete: respackKeys },
		{ name: "instance", required: true, variadic: true, complete: instanceNames },
	],
	opts: [{ flag: "--off", desc: "stop serving the pack on those backends" }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const key = args[0]!;
		const on = !opts.off;

		for (const instance of args.slice(1)) {
			const { pack, groupConflict } = await respacks.setResourcePackForInstance(
				cfg,
				lock,
				key,
				instance,
				on,
				await addonGroups(),
			);

			ok(
				`${pc.bold(key)} ${on ? pc.green("on") : pc.dim("off")} ${instance} ` +
					pc.dim(`(servers ${pack.servers.join(",")})`),
			);

			if (groupConflict) {
				warn(
					`${instance} is granted by addon group(s) ${pack.groups.join(", ")} — ` +
						"the exclusion overrides the grant, but removing it from the group is cleaner",
				);
			}
		}

		await savePacksLock(lock);
		info("apply live with: luna packs reload");
	},
});

command({
	path: ["packs", "info"],
	desc: "One pack in full: contents, serve URL, reachability, holders and traffic",
	args: [{ name: "pack", required: true, complete: respackKeys }],
	opts: [{ flag: "--retest", desc: "re-measure the pack URL instead of using the stored answer" }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const spin = new Spinner().start("collecting...");

		const detail = await respackinfo.resourcePackDetail(cfg, lock, args[0]!, await addonGroups(), {
			retest: !!opts.retest,
		});

		spin.stop();

		const { pack, manifest, reachability, traffic, holders, resolution, failures } = detail;

		console.log();
		console.log(
			`  ${pc.bold(pack.key)} ${pc.dim(pack.name)} — ` +
				`${pack.enabled ? pc.green("enabled") : pc.dim("disabled")}, priority ${pack.priority}, ` +
				`${pack.required ? "required" : "optional"}`,
		);
		console.log();

		printTable(
			[
				["file", `${pack.filename} ${pack.present ? pc.dim(fmtBytes(pack.sizeBytes)) : pc.red("missing")}`],
				[
					"contents",
					manifest.readable
						? `${manifest.entries} entries, ${fmtBytes(manifest.uncompressedBytes)} unpacked` +
							`${manifest.packFormat ? pc.dim(` — pack_format ${manifest.packFormat}`) : ""}`
						: pc.yellow(manifest.problem ?? "unreadable"),
				],
				["description", manifest.description ?? pc.dim("—")],
				["rules", `${pack.servers.join(",") || pc.yellow("unregistered")} ${pc.dim(`→ ${pack.matched.join(",") || "nothing"}`)}`],
				["url", detail.url ?? pc.yellow(detail.serve.problem ?? "no base URL")],
				[
					"reachable",
					!reachability.checked
						? pc.dim(reachability.problem ?? "not checked")
						: (reachability.ok
								? `${pc.green(`HTTP ${reachability.status}`)} ${pc.dim(`${reachability.elapsedMs}ms, ${reachability.sizeMatches === false ? pc.yellow("size differs from disk") : "size matches"}`)}`
								: pc.red(reachability.problem ?? `HTTP ${reachability.status}`)) +
							pc.dim(
								reachability.at
									? ` — measured ${new Date(reachability.at).toLocaleTimeString()}` +
										(reachability.cached ? " (stored)" : ` (${reachability.trigger})`)
									: "",
							),
				],
				[
					"failed loads",
					!failures.available
						? pc.dim(failures.problem ?? "unavailable")
						: failures.failures.length
							? pc.yellow(`${failures.failures.length} in the live log`) +
								pc.dim(
									` — last ${failures.failures.at(-1)!.player}: ${failures.failures.at(-1)!.status}`,
								)
							: pc.dim("none in the live log"),
				],
				[
					"on the proxy",
					!resolution.available
						? pc.dim(resolution.problem ?? "unavailable")
						: resolution.resolved
							? resolution.resolved.available
								? `${pc.green("resolved")} ${pc.dim(`sha1 ${resolution.resolved.sha1.slice(0, 12)}`)}`
								: pc.red(resolution.resolved.unavailableReason || "unavailable")
							: pc.yellow("not in the running catalog — reload the proxy"),
				],
				[
					"holders",
					!holders.available
						? pc.dim(holders.problem ?? "unavailable")
						: `${holders.loaded}/${holders.online} online player(s) loaded${holders.pending ? pc.dim(`, ${holders.pending} pending`) : ""}`,
				],
				[
					"traffic",
					!traffic.available
						? pc.dim(traffic.problem ?? "unavailable")
						: `${traffic.requests} download(s), ${fmtBytes(traffic.bytes)}, ${traffic.uniqueClients} client(s)` +
							`${traffic.lastAt ? pc.dim(` — last ${new Date(traffic.lastAt).toLocaleString()}`) : ""}`,
				],
			],
			{ head: ["", ""] },
		);
		console.log();
	},
});

command({
	path: ["packs", "update"],
	desc: "Check resource packs for provider updates (apply with --apply)",
	args: [{ name: "pack", variadic: true, complete: respackKeys }],
	opts: [{ flag: "--apply", desc: "download the updates instead of listing them" }],

	handler: async (args, opts) => {
		const lock = await loadPacksLock();
		const spin = new Spinner().start("checking providers...");
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
	desc: "Install a data pack from a provider (slug, or search query)",
	args: [{ name: "slug-or-query", required: true, variadic: true }],
	opts: [
		{
			flag: "--to",
			desc: "targets: *, *paper, or instance names",
			value: true,
			complete: targetSelectors,
		},
		{ flag: "--channel", desc: "release channel: release, beta or alpha", value: true },
		{
			flag: "--provider",
			desc: "where to install from: modrinth (default), curseforge or smithed",
			value: true,
			complete: async () => ["modrinth", "curseforge", "smithed"],
		},
	],

	handler: async (args, opts) => {
		if (!opts.to) {
			throw new UsageError("--to is required (which instances' worlds get the pack)");
		}

		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const provider = parseProvider(opts.provider as string | undefined);
		const project = await resolveProject(args.join(" "), "datapack", provider);

		if (!project) {
			return;
		}

		const targets = String(opts.to).split(",").map((target) => target.trim()).filter(Boolean);
		const spin = new Spinner().start(`installing ${project.title}...`);
		const res = await datapacks.installDataPackFromProvider(cfg, lock, provider, project, targets, {
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
	desc: "Check data packs for provider updates (apply with --apply)",
	args: [{ name: "pack", variadic: true, complete: datapackNames }],
	opts: [{ flag: "--apply", desc: "download the updates and redeploy" }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const spin = new Spinner().start("checking providers...");
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

command({
	path: ["datapacks", "identify"],
	desc: "Map an existing data pack to a provider project (so updates apply)",
	args: [
		{ name: "pack", required: true, complete: datapackNames },
		{ name: "slug-or-id", required: true },
	],
	opts: [
		{ flag: "--provider", desc: "provider to map against (default modrinth)", value: true },
		{ flag: "--version", desc: "version id to record as installed", value: true },
		{ flag: "--unidentified", desc: "record the project but no version" },
		{ flag: "--auto", desc: "auto-update: on or off (default on only for a proven match)", value: true },
		{ flag: "--yes", desc: "accept an unproven match without asking" },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const name = args[0]!;
		const provider = parseProvider(opts.provider as string | undefined);

		const spin = new Spinner().start(`identifying ${name} at ${provider}…`);
		const probe = await datapacks.probeDataPackIdentity(lock, name, provider, args[1]!);

		spin.stop();
		printProbe(probe);

		if (probe.confidence !== "exact" && !opts.version && !opts.unidentified && !opts.yes) {
			throw new Bail(
				"nothing proved which version this is — re-run with --version <id>, --unidentified, or --yes",
			);
		}

		const { entry, match } = await datapacks.identifyDataPack(cfg, lock, name, {
			provider,
			project: args[1]!,
			versionId: opts.version as string | undefined,
			unidentified: opts.unidentified as boolean | undefined,
			autoUpdate: opts.auto === undefined ? undefined : opts.auto === "on",
		});

		await savePacksLock(lock);

		ok(
			`${pc.bold(name)} → ${provider}:${probe.project.slug} ` +
				`${match ? pc.green(match.versionNumber) : pc.dim("version unknown")}, ` +
				`auto-update ${entry.autoUpdate ? pc.green("on") : pc.dim("off")}`,
		);
	},
});

command({
	path: ["datapacks", "forget"],
	desc: "Drop a data pack's provider mapping (keeps the zip and its targets)",
	args: [{ name: "pack", required: true, complete: datapackNames }],

	handler: async (args) => {
		const lock = await loadPacksLock();

		await datapacks.forgetDataPackIdentity(lock, args[0]!);
		await savePacksLock(lock);

		ok(`${pc.bold(args[0]!)} is no longer mapped to a provider — updates will not be checked`);
	},
});
