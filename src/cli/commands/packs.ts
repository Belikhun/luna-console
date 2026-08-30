// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Resource pack and data pack commands, thin over the client bridge, same as
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
import { t } from "../../shared/i18n";

/**
 * Base64 for an upload payload. `btoa` takes a binary string, and building one
 * from a multi-megabyte pack in a single `String.fromCharCode(...bytes)` call
 * blows the argument limit, so the bytes go in chunks.
 */
function encodeBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";

	for (let index = 0; index < bytes.length; index += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
	}

	return btoa(binary);
}

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
			t("cli.packs.unknownProvider", { name: provider, known: providers.PROVIDER_IDS.join(", ") }),
		);
	}

	return provider as ProviderId;
}

/**
 * A `--channel` value, or undefined when the flag was not passed.
 *
 * Undefined and "release" are different answers to the installers: undefined
 * lets them escalate to beta and then alpha for a project that has never cut a
 * stable release, while an explicit "release" forbids that. So the flag being
 * absent must not become a value here.
 */
export function parseChannel(value: string | undefined): providers.ReleaseChannel | undefined {
	if (value === undefined) {
		return undefined;
	}

	const channel = value.toLowerCase();

	if (!providers.isReleaseChannel(channel)) {
		throw new UsageError(
			t("cli.packs.unknownChannel", {
				name: value,
				known: providers.RELEASE_CHANNELS.join(", "),
			}),
		);
	}

	return channel;
}

/** Resolve a slug or free-text query to one provider project, prompting on search. */
async function resolveProject(
	query: string,
	type: "resourcepack" | "datapack",
	provider: ProviderId,
): Promise<providers.AddonProject | undefined> {
	const label = providers.PROVIDER_IDS.includes(provider) ? provider : "provider";
	const spin = new Spinner().start(t("cli.plugins.add.resolving", { query, provider: label }));

	let project = await providers.getProject(provider, query, type);

	spin.stop();

	if (project) {
		return project;
	}

	const hits = await providers.searchProvider(provider, query, type);

	if (!hits.length) {
		throw new Bail(t("cli.plugins.add.nothingFound", { query }));
	}

	const { select, isCancel } = await import("@clack/prompts");

	const picked = await select({
		message: type === "datapack" ? t("cli.packs.selectDatapack") : t("cli.packs.selectRespack"),
		options: hits.map((hit) => ({
			// smithed slugs are only known after a project lookup, so pick by id
			value: hit.project_id,
			label: hit.title,
			hint: `${t("cli.plugins.add.downloads", { count: hit.downloads.toLocaleString() })} · ${hit.description.slice(0, 60)}`,
		})),
	});

	if (isCancel(picked)) {
		info(t("cli.common.aborted"));

		return undefined;
	}

	return await providers.getProject(provider, picked as string, type);
}

// -- resource packs -----------------------------------------------------------

command({
	path: ["packs"],
	desc: t("cli.packs.list.desc"),

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const { rows, dynamic } = await respacks.listResourcePacksLive(
			cfg,
			lock,
			await addonGroups(),
		);

		if (!rows.length) {
			info(t("cli.packs.list.empty"));

			return;
		}

		const table = rows.map((row) => [
			row.enabled ? pc.green(Sym.ok) : pc.dim("○"),
			pc.bold(row.key),
			registrationCell(row),
			row.required ? t("cli.packs.required") : "",
			row.servers.join(","),
			row.present ? fmtBytes(row.sizeBytes) : pc.red(t("cli.packs.fileMissing")),
			row.registration === "dynamic" ? pc.magenta("plugin") : row.source,
			row.versionNumber ?? "",
		]);

		console.log();
		printTable(table, {
			head: [
				"",
				t("cli.head.pack"),
				t("cli.head.priority"),
				"",
				t("cli.head.servers"),
				t("cli.head.size"),
				t("cli.head.source"),
				t("cli.head.version"),
			],
		});
		console.log();

		const runtime = rows.filter((row) => row.registration === "dynamic");
		const shadowed = rows.filter((row) => row.shadowsDynamic);

		if (runtime.length) {
			info(
				t("cli.packs.list.runtime", {
					count: runtime.length,
					names: runtime.map((row) => row.key).join(", "),
				}),
			);
		}

		for (const row of shadowed) {
			warn(
				t("cli.packs.list.shadowed", {
					key: row.key,
					file: row.defFile ?? "",
					command: `luna packs release ${row.key}`,
				}),
			);
		}

		if (!dynamic.available) {
			info(t("cli.packs.list.dynamicUnknown", { problem: dynamic.problem ?? "" }));
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

	return row.registration === "unknown"
		? pc.dim(t("cli.packs.registrationUnknown"))
		: pc.yellow(t("cli.packs.unregistered"));
}

command({
	path: ["packs", "add"],
	desc: t("cli.packs.add.desc"),
	args: [{ name: "slug-or-query", required: true, variadic: true }],
	opts: [
		{ flag: "--channel", desc: t("cli.packs.optChannel"), value: true },
		{
			flag: "--provider",
			desc: t("cli.packs.add.optProvider"),
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

		const spin = new Spinner().start(t("cli.plugins.add.installing", { name: project.title }));
		const row = await respacks.installResourcePackFromProvider(cfg, lock, provider, project, {
			channel: opts.channel as PackChannel | undefined,
		});

		await savePacksLock(lock);
		spin.stop();

		ok(
			`${t("cli.plugins.add.installed", {
				name: pc.bold(row.key),
				version: pc.green(row.versionNumber ?? ""),
			})} ${pc.dim(`(${fmtBytes(row.sizeBytes)})`)}`,
		);
		info(t("cli.packs.add.startsDisabled", { command: `luna packs set ${row.key} --enable` }));
	},
});

command({
	path: ["packs", "set"],
	desc: t("cli.packs.set.desc"),
	args: [{ name: "pack", required: true, complete: respackKeys }],
	opts: [
		{ flag: "--enable", desc: t("cli.packs.set.optEnable") },
		{ flag: "--disable", desc: t("cli.packs.set.optDisable") },
		{ flag: "--priority", desc: t("cli.packs.set.optPriority"), value: true },
		{ flag: "--required", desc: t("cli.packs.set.optRequired") },
		{ flag: "--optional", desc: t("cli.packs.set.optOptional") },
		{ flag: "--servers", desc: t("cli.packs.set.optServers"), value: true },
		{ flag: "--name", desc: t("cli.packs.set.optName"), value: true },
		{ flag: "--auto", desc: t("cli.packs.set.optAuto"), value: true },
		{ flag: "--channel", desc: t("cli.packs.set.optChannel"), value: true },
	],

	handler: async (args, opts) => {
		if (opts.enable && opts.disable) {
			throw new UsageError(t("cli.packs.set.enableConflict"));
		}

		if (opts.required && opts.optional) {
			throw new UsageError(t("cli.packs.set.requiredConflict"));
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
			`${pc.bold(row.key)}: ${row.enabled ? pc.green(t("cli.packs.enabled")) : pc.dim(t("cli.packs.disabled"))}, ` +
				`${t("cli.head.priority")} ${row.priority}, ${row.required ? t("cli.packs.required") : t("cli.packs.optional")}, ${t("cli.head.servers")} ${row.servers.join(",")}`,
		);
		info(t("cli.packs.reloadHint"));
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
	info(t("cli.packs.probe.project", { title: pc.bold(probe.project.title), slug: probe.project.slug }));

	if (probe.confidence === "exact" && probe.best) {
		ok(
			t("cli.packs.probe.exact", {
				version: pc.green(probe.best.versionNumber),
				basis: probe.best.basis,
			}),
		);

		return;
	}

	if (probe.confidence === "likely" && probe.best) {
		warn(
			t("cli.packs.probe.likely", {
				version: pc.yellow(probe.best.versionNumber),
				basis: probe.best.basis,
			}),
		);
	} else {
		warn(t("cli.packs.probe.noMatch"));
	}

	if (probe.matches.length > 1) {
		info(t("cli.packs.probe.candidates"));

		for (const match of probe.matches) {
			console.log(`   ${match.versionNumber}  ${pc.dim(match.versionId)}  ${pc.dim(match.basis)}`);
		}
	}

	if (probe.newest) {
		info(t("cli.packs.probe.newest", { version: probe.newest.versionNumber }));
	}
}

command({
	path: ["packs", "identify"],
	desc: t("cli.packs.identify.desc"),
	args: [
		{ name: "pack", required: true, complete: respackKeys },
		{ name: "slug-or-id", required: true },
	],
	opts: [
		{ flag: "--provider", desc: t("cli.plugins.identify.optProvider"), value: true },
		{ flag: "--version", desc: t("cli.plugins.identify.optVersion"), value: true },
		{ flag: "--unidentified", desc: t("cli.plugins.identify.optUnidentified") },
		{ flag: "--auto", desc: t("cli.plugins.identify.optAuto"), value: true },
		{ flag: "--yes", desc: t("cli.plugins.identify.optYes") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const key = args[0]!;
		const provider = parseProvider(opts.provider as string | undefined);

		const spin = new Spinner().start(t("cli.plugins.identify.probing", { name: key, provider }));
		const probe = await respacks.probeRespackIdentity(cfg, lock, key, provider, args[1]!);

		spin.stop();
		printProbe(probe);

		// an unproven match is a guess about what the server is running, so it is
		// the operator's call and never a default
		if (probe.confidence !== "exact" && !opts.version && !opts.unidentified && !opts.yes) {
			throw new Bail(t("cli.plugins.identify.unproven"));
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
				`${match ? pc.green(match.versionNumber) : pc.dim(t("cli.plugins.identify.versionUnknown"))}, ` +
				`${t("cli.plugins.info.autoUpdate")} ${row.autoUpdate ? pc.green(t("cli.plugins.info.on")) : pc.dim(t("cli.plugins.info.off"))}`,
		);

		if (!match) {
			info(t("cli.packs.identify.noVersionNote"));
		}
	},
});

command({
	path: ["packs", "forget"],
	desc: t("cli.packs.forget.desc"),
	args: [{ name: "pack", required: true, complete: respackKeys }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const row = await respacks.forgetRespackIdentity(cfg, lock, args[0]!);

		await savePacksLock(lock);

		ok(t("cli.plugins.forget.done", { name: pc.bold(row.key) }));
	},
});

command({
	path: ["packs", "takeover"],
	desc: t("cli.packs.takeover.desc"),
	args: [{ name: "pack", required: true, complete: respackKeys }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const { row, from } = await respacks.takeOverDynamicPack(cfg, lock, args[0]!);

		await savePacksLock(lock);

		ok(t("cli.packs.takeover.wrote", { file: pc.bold(`${row.key}.yml`) }));
		info(
			t("cli.packs.takeover.detail", {
				priority: from.priority,
				required: from.required ? t("cli.packs.required") : t("cli.packs.optional"),
				servers: from.servers.join(","),
			}),
		);
		info(t("cli.packs.reloadHint"));
	},
});

command({
	path: ["packs", "release"],
	desc: t("cli.packs.releaseCmd.desc"),
	args: [{ name: "pack", required: true, complete: respackKeys }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const { removed, dynamic } = await respacks.releaseDynamicPack(cfg, lock, args[0]!);

		await savePacksLock(lock);

		ok(t("cli.packs.releaseCmd.removed", { file: pc.bold(removed) }));

		if (dynamic) {
			info(
				t("cli.packs.releaseCmd.dynamicApplies", {
					priority: dynamic.priority,
					servers: dynamic.servers.join(","),
				}),
			);
		}

		info(t("cli.packs.reloadHint"));
	},
});

command({
	path: ["packs", "serve"],
	desc: t("cli.packs.serve.desc"),
	args: [
		{ name: "pack", required: true, complete: respackKeys },
		{ name: "instance", required: true, variadic: true, complete: instanceNames },
	],
	opts: [{ flag: "--off", desc: t("cli.packs.serve.optOff") }],

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
				`${pc.bold(key)} ${on ? pc.green(t("cli.packs.on")) : pc.dim(t("cli.packs.off"))} ${instance} ` +
					pc.dim(`(${t("cli.head.servers")} ${pack.servers.join(",")})`),
			);

			if (groupConflict) {
				warn(
					t("cli.packs.serve.groupConflict", {
						instance,
						groups: pack.groups.join(", "),
					}),
				);
			}
		}

		await savePacksLock(lock);
		info(t("cli.packs.reloadHint"));
	},
});

command({
	path: ["packs", "info"],
	desc: t("cli.packs.info.desc"),
	args: [{ name: "pack", required: true, complete: respackKeys }],
	opts: [{ flag: "--retest", desc: t("cli.packs.info.optRetest") }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const spin = new Spinner().start(t("cli.packs.info.collecting"));

		const detail = await respackinfo.resourcePackDetail(cfg, lock, args[0]!, await addonGroups(), {
			retest: !!opts.retest,
		});

		spin.stop();

		const { pack, manifest, reachability, traffic, holders, resolution, failures } = detail;

		console.log();
		console.log(
			`  ${pc.bold(pack.key)} ${pc.dim(pack.name)} · ` +
				`${pack.enabled ? pc.green(t("cli.packs.enabled")) : pc.dim(t("cli.packs.disabled"))}, ${t("cli.head.priority")} ${pack.priority}, ` +
				`${pack.required ? t("cli.packs.required") : t("cli.packs.optional")}`,
		);
		console.log();

		printTable(
			[
				[
					t("cli.head.file"),
					`${pack.filename} ${pack.present ? pc.dim(fmtBytes(pack.sizeBytes)) : pc.red(t("cli.packs.info.missing"))}`,
				],
				[
					t("cli.packs.info.contents"),
					manifest.readable
						? t("cli.packs.info.contentsLine", {
								entries: manifest.entries,
								size: fmtBytes(manifest.uncompressedBytes),
							}) + `${manifest.packFormat ? pc.dim(` · pack_format ${manifest.packFormat}`) : ""}`
						: pc.yellow(manifest.problem ?? t("cli.packs.info.unreadable")),
				],
				[t("cli.head.description"), manifest.description ?? pc.dim("—")],
				[
					t("cli.packs.info.rules"),
					`${pack.servers.join(",") || pc.yellow(t("cli.packs.unregistered"))} ${pc.dim(`→ ${pack.matched.join(",") || t("cli.packs.info.nothing")}`)}`,
				],
				["url", detail.url ?? pc.yellow(detail.serve.problem ?? t("cli.packs.info.noBaseUrl"))],
				[
					t("cli.packs.info.reachable"),
					!reachability.checked
						? pc.dim(reachability.problem ?? t("cli.packs.info.notChecked"))
						: (reachability.ok
								? `${pc.green(`HTTP ${reachability.status}`)} ${pc.dim(`${reachability.elapsedMs}ms, ${reachability.sizeMatches === false ? pc.yellow(t("cli.packs.info.sizeDiffers")) : t("cli.packs.info.sizeMatches")}`)}`
								: pc.red(reachability.problem ?? `HTTP ${reachability.status}`)) +
							pc.dim(
								reachability.at
									? ` · ${t("cli.packs.info.measured", { time: new Date(reachability.at).toLocaleTimeString() })}` +
										(reachability.cached ? ` (${t("cli.packs.info.stored")})` : ` (${reachability.trigger})`)
									: "",
							),
				],
				[
					t("cli.packs.info.failedLoads"),
					!failures.available
						? pc.dim(failures.problem ?? t("cli.packs.info.unavailable"))
						: failures.failures.length
							? pc.yellow(t("cli.packs.info.failuresInLog", { count: failures.failures.length })) +
								pc.dim(
									` · ${t("cli.packs.info.lastFailure", {
										player: failures.failures.at(-1)!.player,
										status: failures.failures.at(-1)!.status,
									})}`,
								)
							: pc.dim(t("cli.packs.info.noneInLog")),
				],
				[
					t("cli.packs.info.onProxy"),
					!resolution.available
						? pc.dim(resolution.problem ?? t("cli.packs.info.unavailable"))
						: resolution.resolved
							? resolution.resolved.available
								? `${pc.green(t("cli.packs.info.resolved"))} ${pc.dim(`sha1 ${resolution.resolved.sha1.slice(0, 12)}`)}`
								: pc.red(resolution.resolved.unavailableReason || t("cli.packs.info.unavailable"))
							: pc.yellow(t("cli.packs.info.notInCatalog")),
				],
				[
					t("cli.packs.info.formats"),
					resolution.resolved?.formats
						? (resolution.resolved.formats.min === resolution.resolved.formats.max
								? resolution.resolved.formats.min
								: `${resolution.resolved.formats.min}-${resolution.resolved.formats.max}`) +
							(resolution.resolved.formats.clamped
								? ` ${pc.yellow(t("cli.packs.info.formatsClamped"))}`
								: "")
						: pc.dim("—"),
				],
				[
					t("cli.packs.info.holders"),
					!holders.available
						? pc.dim(holders.problem ?? t("cli.packs.info.unavailable"))
						: t("cli.packs.info.holdersLine", { loaded: holders.loaded, online: holders.online }) +
							(holders.pending
								? pc.dim(`, ${t("cli.packs.info.pending", { count: holders.pending })}`)
								: ""),
				],
				[
					t("cli.packs.info.traffic"),
					!traffic.available
						? pc.dim(traffic.problem ?? t("cli.packs.info.unavailable"))
						: t("cli.packs.info.trafficLine", {
								requests: traffic.requests,
								size: fmtBytes(traffic.bytes),
								clients: traffic.uniqueClients,
							}) +
							`${traffic.lastAt ? pc.dim(` · ${t("cli.packs.info.lastAt", { time: new Date(traffic.lastAt).toLocaleString() })}`) : ""}`,
				],
			],
			{ head: ["", ""] },
		);
		console.log();
	},
});

command({
	path: ["packs", "update"],
	desc: t("cli.packs.update.desc"),
	args: [{ name: "pack", variadic: true, complete: respackKeys }],
	opts: [{ flag: "--apply", desc: t("cli.packs.update.optApply") }],

	handler: async (args, opts) => {
		const lock = await loadPacksLock();
		const spin = new Spinner().start(t("cli.packs.checkingProviders"));
		const { updates, skipped } = await respacks.checkResourcePackUpdates(
			lock,
			args.length ? args : undefined,
		);

		spin.stop();

		for (const entry of skipped.filter((candidate) => args.includes(candidate.key))) {
			warn(`${entry.key}: ${entry.reason}`);
		}

		if (!updates.length) {
			ok(t("cli.packs.update.upToDate"));

			return;
		}

		for (const update of updates) {
			info(`${pc.bold(update.key)}: ${update.from ?? "?"} ${Sym.arrow} ${pc.green(update.to)}`);
		}

		if (!opts.apply) {
			info(
				t("cli.plugins.check.applyHint", {
					command: `luna packs update${args.length ? ` ${args.join(" ")}` : ""} --apply`,
				}),
			);

			return;
		}

		for (const update of updates) {
			await respacks.applyResourcePackUpdate(lock, update);
			ok(`${update.key} ${Sym.arrow} ${update.to}`);
		}

		await savePacksLock(lock);
		info(t("cli.packs.reloadHint"));
	},
});

command({
	path: ["packs", "remove"],
	desc: t("cli.packs.remove.desc"),
	args: [{ name: "pack", required: true, complete: respackKeys }],
	opts: [{ flag: "--keep-file", desc: t("cli.packs.remove.optKeepFile") }],

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
			warn(t("cli.packs.remove.nothing", { name: args[0] ?? "" }));

			return;
		}

		ok(t("cli.packs.remove.done", { name: args[0] ?? "", detail: pc.dim(`(${removed.join(", ")})`) }));
		info(t("cli.packs.reloadHint"));
	},
});

command({
	path: ["packs", "replace"],
	desc: t("cli.packs.replace.desc"),
	args: [
		{ name: "pack", required: true, complete: respackKeys },
		{ name: "zip", required: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const key = args[0]!;
		const source = Bun.file(args[1]!);

		if (!(await source.exists())) {
			throw new UsageError(t("cli.packs.replace.noFile", { file: args[1] ?? "" }));
		}

		const spin = new Spinner().start(t("cli.packs.replace.uploading", { file: args[1] ?? "" }));

		let result: respacks.RespackReplacement;

		try {
			const bytes = new Uint8Array(await source.arrayBuffer());

			result = await respacks.replaceResourcePackFile(cfg, lock, key, encodeBase64(bytes));
		} finally {
			spin.stop();
		}

		await savePacksLock(lock);

		if (result.unchanged) {
			warn(t("cli.packs.replace.unchanged", { file: result.file }));
		} else {
			ok(
				t("cli.packs.replace.done", {
					file: pc.bold(result.file),
					from: fmtBytes(result.sizeBefore),
					to: fmtBytes(result.sizeAfter),
				}),
			);
		}

		if (result.wasProvider) {
			warn(t("cli.packs.replace.nowManual", { provider: result.wasProvider }));
		}

		info(t("cli.packs.reloadHint"));
	},
});

command({
	path: ["packs", "resend"],
	desc: t("cli.packs.resend.desc"),
	args: [{ name: "player", variadic: true }],
	opts: [
		{ flag: "--pack", desc: t("cli.packs.resend.optPack"), value: true, complete: respackKeys },
		{ flag: "--all", desc: t("cli.packs.resend.optAll") },
		{ flag: "--failed", desc: t("cli.packs.resend.optFailed") },
		{ flag: "--missing", desc: t("cli.packs.resend.optMissing") },
	],

	handler: async (args, opts) => {
		const scopes = [
			opts.all ? "all" : undefined,
			opts.failed ? "failed" : undefined,
			opts.missing ? "missing" : undefined,
		].filter((scope) => scope !== undefined) as respacks.RespackResendScope[];

		if (scopes.length > 1) {
			throw new UsageError(t("cli.packs.resend.oneScope"));
		}

		const scope = scopes[0];

		if (!scope && !args.length) {
			throw new UsageError(t("cli.packs.resend.needTarget"));
		}

		const result = await respacks.resendResourcePacks({
			pack: typeof opts.pack === "string" ? opts.pack : undefined,
			players: args,
			scope,
		});

		if (!result.available) {
			throw new Bail(t("cli.packs.resend.unavailable", { problem: result.problem ?? "" }));
		}

		if (!result.targets.length) {
			warn(t("cli.packs.resend.nobody"));

			return;
		}

		for (const target of result.targets) {
			if (target.sent) {
				ok(
					`${pc.bold(target.username)} ` +
						pc.dim(target.server ? `(${target.server})` : t("cli.packs.resend.noBackend")),
				);
			} else {
				warn(`${pc.bold(target.username)} ${pc.dim(`- ${target.problem ?? ""}`)}`);
			}
		}

		info(t("cli.packs.resend.summary", { sent: result.sent, online: result.online }));
		info(t("cli.packs.resend.wholeSet"));
	},
});

command({
	path: ["packs", "reload"],
	desc: t("cli.packs.reload.desc"),

	handler: async () => {
		const cfg = await loadCluster();

		if (await respacks.reloadResourcePacks(cfg)) {
			ok(t("cli.packs.reload.sent"));
		} else {
			warn(t("cli.packs.reload.proxyDown"));
		}
	},
});

// -- data packs ---------------------------------------------------------------

command({
	path: ["datapacks"],
	desc: t("cli.datapacks.list.desc"),

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const rows = await datapacks.listDataPacks(cfg, lock, await addonGroups());

		if (!rows.length) {
			info(t("cli.datapacks.list.empty"));

			return;
		}

		const table = rows.map((row) => [
			pc.bold(row.name),
			row.present ? fmtBytes(row.sizeBytes) : pc.red(t("cli.packs.fileMissing")),
			row.entry.source,
			row.entry.installed?.versionNumber ?? "",
			row.entry.autoUpdate ? t("cli.head.auto") : "",
			row.effectiveTargets.join(",") || pc.dim(t("cli.datapacks.list.nowhere")),
		]);

		console.log();
		printTable(table, {
			head: [
				t("cli.head.pack"),
				t("cli.head.size"),
				t("cli.head.source"),
				t("cli.head.version"),
				"",
				t("cli.head.deploysTo"),
			],
		});
		console.log();
	},
});

command({
	path: ["datapacks", "add"],
	desc: t("cli.datapacks.add.desc"),
	args: [{ name: "slug-or-query", required: true, variadic: true }],
	opts: [
		{ flag: "--to", desc: t("cli.datapacks.add.optTo"), value: true, complete: targetSelectors },
		{ flag: "--channel", desc: t("cli.packs.optChannel"), value: true },
		{
			flag: "--provider",
			desc: t("cli.datapacks.add.optProvider"),
			value: true,
			complete: async () => ["modrinth", "curseforge", "smithed"],
		},
	],

	handler: async (args, opts) => {
		if (!opts.to) {
			throw new UsageError(t("cli.datapacks.add.needsTo"));
		}

		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const provider = parseProvider(opts.provider as string | undefined);
		const project = await resolveProject(args.join(" "), "datapack", provider);

		if (!project) {
			return;
		}

		const targets = String(opts.to).split(",").map((target) => target.trim()).filter(Boolean);
		const spin = new Spinner().start(t("cli.plugins.add.installing", { name: project.title }));
		const res = await datapacks.installDataPackFromProvider(cfg, lock, provider, project, targets, {
			channel: opts.channel as PackChannel | undefined,
		});

		await savePacksLock(lock);
		spin.stop();

		ok(
			t("cli.plugins.add.installed", {
				name: pc.bold(res.name),
				version: pc.green(res.entry.installed?.versionNumber ?? ""),
			}),
		);

		await runDatapackDeploy(undefined, res.name);
	},
});

/** Deploy the pool into worlds and print what changed, shared by add/deploy. */
async function runDatapackDeploy(instances: string[] | undefined, pack?: string): Promise<void> {
	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const spin = new Spinner().start(t("cli.datapacks.deploy.deploying"));
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
		ok(t("cli.datapacks.deploy.inSync"));

		return;
	}

	info(t("cli.datapacks.deploy.restartNote"));
}

command({
	path: ["datapacks", "deploy"],
	desc: t("cli.datapacks.deploy.desc"),
	args: [{ name: "instance", variadic: true, complete: instanceNames }],
	opts: [{ flag: "--pack", desc: t("cli.datapacks.deploy.optPack"), value: true, complete: datapackNames }],

	handler: async (args, opts) => {
		await runDatapackDeploy(args.length ? args : undefined, opts.pack as string | undefined);
	},
});

command({
	path: ["datapacks", "set"],
	desc: t("cli.datapacks.set.desc"),
	args: [{ name: "pack", required: true, complete: datapackNames }],
	opts: [
		{ flag: "--auto", desc: t("cli.datapacks.set.optAuto"), value: true },
		{
			flag: "--channel",
			desc: t("cli.packs.set.optChannel"),
			value: true,
			complete: async () => [...providers.RELEASE_CHANNELS],
		},
	],

	handler: async (args, opts) => {
		const [name] = args as [string];
		const lock = await loadPacksLock();
		const channel = parseChannel(opts.channel as string | undefined);
		const auto = opts.auto === undefined ? undefined : opts.auto === "true";

		if (channel === undefined && auto === undefined) {
			throw new UsageError(t("cli.datapacks.set.nothingToSet"));
		}

		const entry = datapacks.updateDataPack(lock, name, {
			...(auto === undefined ? {} : { autoUpdate: auto }),
			...(channel ? { channel } : {}),
		});

		await savePacksLock(lock);

		ok(
			`${pc.bold(name)}: ${t("cli.head.channel")} ${entry.channel ?? "release"} · ` +
				`${t("cli.head.auto")} ${entry.autoUpdate ? Sym.ok : Sym.off}`,
		);

		if (channel) {
			info(
				t("cli.datapacks.set.applyHint", {
					command: pc.cyan(`luna datapacks update ${name} --apply`),
				}),
			);
		}
	},
});

command({
	path: ["datapacks", "update"],
	desc: t("cli.datapacks.update.desc"),
	args: [{ name: "pack", variadic: true, complete: datapackNames }],
	opts: [{ flag: "--apply", desc: t("cli.datapacks.update.optApply") }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const spin = new Spinner().start(t("cli.packs.checkingProviders"));
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
			ok(t("cli.datapacks.update.upToDate"));

			return;
		}

		for (const update of updates) {
			info(`${pc.bold(update.name)}: ${update.from ?? "?"} ${Sym.arrow} ${pc.green(update.to)}`);
		}

		if (!opts.apply) {
			info(
				t("cli.plugins.check.applyHint", {
					command: `luna datapacks update${args.length ? ` ${args.join(" ")}` : ""} --apply`,
				}),
			);

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
	desc: t("cli.datapacks.adopt.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const res = await datapacks.adoptDataPack(cfg, lock, args[0]!, args[1]!);

		await savePacksLock(lock);

		ok(
			t("cli.datapacks.adopt.done", {
				name: pc.bold(res.name),
				file: `datapacks/${res.entry.file}`,
				targets: args[0] ?? "",
			}),
		);
	},
});

command({
	path: ["datapacks", "remove"],
	desc: t("cli.datapacks.remove.desc"),
	args: [{ name: "pack", required: true, complete: datapackNames }],
	opts: [
		{ flag: "--from", desc: t("cli.datapacks.remove.optFrom"), value: true, complete: targetSelectors },
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

		const where = res.deletedFrom.length
			? res.deletedFrom.join(", ")
			: t("cli.datapacks.remove.noWorlds");

		ok(
			t("cli.datapacks.remove.done", {
				name: pc.bold(args[0]!),
				detail: pc.dim(
					`(${where}${res.entryRemoved ? `; ${t("cli.datapacks.remove.poolDropped")}` : ""})`,
				),
			}),
		);
	},
});

command({
	path: ["datapacks", "identify"],
	desc: t("cli.datapacks.identify.desc"),
	args: [
		{ name: "pack", required: true, complete: datapackNames },
		{ name: "slug-or-id", required: true },
	],
	opts: [
		{ flag: "--provider", desc: t("cli.plugins.identify.optProvider"), value: true },
		{ flag: "--version", desc: t("cli.plugins.identify.optVersion"), value: true },
		{ flag: "--unidentified", desc: t("cli.plugins.identify.optUnidentified") },
		{ flag: "--auto", desc: t("cli.plugins.identify.optAuto"), value: true },
		{ flag: "--yes", desc: t("cli.plugins.identify.optYes") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const name = args[0]!;
		const provider = parseProvider(opts.provider as string | undefined);

		const spin = new Spinner().start(t("cli.plugins.identify.probing", { name, provider }));
		const probe = await datapacks.probeDataPackIdentity(lock, name, provider, args[1]!);

		spin.stop();
		printProbe(probe);

		if (probe.confidence !== "exact" && !opts.version && !opts.unidentified && !opts.yes) {
			throw new Bail(t("cli.plugins.identify.unproven"));
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
				`${match ? pc.green(match.versionNumber) : pc.dim(t("cli.plugins.identify.versionUnknown"))}, ` +
				`${t("cli.plugins.info.autoUpdate")} ${entry.autoUpdate ? pc.green(t("cli.plugins.info.on")) : pc.dim(t("cli.plugins.info.off"))}`,
		);
	},
});

command({
	path: ["datapacks", "forget"],
	desc: t("cli.datapacks.forget.desc"),
	args: [{ name: "pack", required: true, complete: datapackNames }],

	handler: async (args) => {
		const lock = await loadPacksLock();

		await datapacks.forgetDataPackIdentity(lock, args[0]!);
		await savePacksLock(lock);

		ok(t("cli.plugins.forget.done", { name: pc.bold(args[0]!) }));
	},
});
