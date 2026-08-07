// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { command, UsageError, Bail } from "../framework";
import { pc, Sym, ok, warn, info, printTable, versionDiff, Spinner, ProgressView } from "../ui";
import { ProgressReporter } from "../../client/core/progress";
import { instanceNames, pluginNames, targetSelectors } from "../completers";
import {
	loadCluster,
	loadLock,
	saveLock,
	saveCluster,
	expandTargets,
	managedInstances,
} from "../../client/core/config";
import * as plugins from "../../client/core/plugins";
import {
	allPluginNames,
	effectiveTargets,
	familyOf,
	entriesOf,
	groupInstances,
	instanceGroupNames,
	setPluginOverride,
	validateGroups,
} from "../../client/core/families";
import {
	ensureAliases,
	instancePluginReport,
	removeInstanceJars,
} from "../../client/core/pluginstate";
import { standardizeNaming } from "../../client/core/standardize";
import type { PluginFamily } from "../../client/core/types";
import { FAMILY_DIRS, SOFTWARE_IDS } from "../../client/core/software";
import { PLUGIN_FAMILIES } from "../../client/core/types";
import * as providers from "../../client/core/services/providers";
import { getAllStatuses } from "../../client/core/instances";
import { ensurePortAllocations } from "../../client/core/ports";
import { parseProvider, printProbe } from "./packs";
import { t } from "../../shared/i18n";

/** Coloured label for a lock entry's source. */
function sourceBadge(source: string): string {
	switch (source) {
		case "modrinth":
			return pc.green("modrinth");

		case "curseforge":
			return pc.redBright("curseforge");

		case "hangar":
			return pc.blue("hangar");

		case "smithed":
			return pc.cyan("smithed");

		case "luna":
			return pc.magenta("luna");

		default:
			return pc.yellow(t("cli.plugins.sourceManual"));
	}
}

/** Split a comma-separated `--to`/`--from`/`--on` value. */
function splitTargets(raw: string): string[] {
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

/**
 * Target list from the flag, or an interactive multiselect when it was omitted.
 * The selection may be empty: a plugin can be pooled without being deployed
 * anywhere, and an addon group can place it later.
 */
async function parseTargets(raw: string | undefined): Promise<string[]> {
	if (raw) {
		return splitTargets(raw);
	}

	const { multiselect, isCancel } = await import("@clack/prompts");
	const names = await instanceNames();

	const picked = await multiselect({
		message: t("cli.plugins.pickTargets"),
		required: false,
		options: [
			// the same wildcards tab-completion offers, so the two agree
			...SOFTWARE_IDS.map((software) => ({
				value: `*${software}`,
				label: t("cli.plugins.allOf", { software }),
			})),
			...names.map((name) => ({ value: name, label: name })),
		],
	});

	if (isCancel(picked)) {
		throw new Bail(t("cli.common.aborted"));
	}

	return picked as string[];
}

command({
	path: ["plugins", "list"],
	desc: t("cli.plugins.list.desc"),

	handler: async () => {
		const lock = await loadLock();

		const rows = Object.entries(lock.plugins).map(([name, entry]) => {
			const extras: string[] = [];

			for (const [target, version] of Object.entries(entry.pins ?? {})) {
				extras.push(`${target}📌${version}`);
			}

			for (const [target, version] of Object.entries(entry.assign ?? {})) {
				extras.push(`${target}→${version}`);
			}

			const version =
				(entry.installed?.versionNumber ?? pc.dim("?")) +
				(extras.length ? pc.yellow(` +${extras.length}v`) : "");

			return [
				entry.autoUpdate ? Sym.ok : Sym.off,
				pc.bold(name),
				sourceBadge(entry.source),
				familyOf(entry),
				version,
				entry.targets.join(",") || pc.red(`(${t("cli.common.none")})`),
			];
		});

		console.log();
		printTable(rows, {
			head: [
				t("cli.head.auto"),
				t("cli.head.addon"),
				t("cli.head.source"),
				t("cli.head.family"),
				t("cli.head.version"),
				t("cli.head.targets"),
			],
		});

		console.log(
			pc.dim(`\n  ${t("cli.plugins.list.legend", { count: rows.length, ok: Sym.ok, off: Sym.off })}\n`),
		);
	},
});

command({
	path: ["plugins", "scan"],
	desc: t("cli.plugins.scan.desc"),

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const spin = new Spinner().start(t("cli.plugins.scan.hashing"));
		const report = await plugins.scan(cfg, lock);

		await saveLock(lock);
		spin.stop();

		if (report.added.length) {
			ok(t("cli.plugins.scan.added", { count: report.added.length }));
		}

		for (const hit of report.identified) {
			console.log(
				`  ${Sym.check} ${pc.bold(hit.name)} ${Sym.arrow} ${pc.green(hit.slug)} ${pc.dim(hit.version)}`,
			);
		}

		for (const name of report.unidentified) {
			console.log(`  ${pc.yellow("?")} ${name} ${pc.dim(t("cli.plugins.scan.notOnModrinth"))}`);
		}

		for (const name of report.luna) {
			console.log(`  ${pc.magenta("◆")} ${name} ${pc.dim(t("cli.plugins.scan.lunaPlugin"))}`);
		}

		if (report.caseMismatches.length) {
			console.log();
			warn(t("cli.plugins.scan.caseMismatches"));

			for (const mismatch of report.caseMismatches) {
				console.log(
					`    ${mismatch.instance}/${mismatch.dir}/${pc.red(mismatch.actual)} ${Sym.arrow} ` +
						`${pc.green(mismatch.expected)} ${pc.dim(t("cli.plugins.scan.fixedOnDeploy"))}`,
				);
			}
		}

		if (report.recognized.length) {
			console.log();
			info(t("cli.plugins.scan.recognized", { count: report.recognized.length }));

			for (const hit of report.recognized) {
				console.log(
					`    ${pc.dim(`${hit.instance}/${hit.dir}/`)}${hit.file} ${Sym.arrow} ${pc.green(hit.entry)}`,
				);
			}
		}

		if (report.unmanaged.length) {
			console.log();
			info(t("cli.plugins.scan.unmanaged", { count: report.unmanaged.length }));

			for (const jar of report.unmanaged) {
				console.log(`    ${pc.dim(`${jar.instance}/${jar.dir}/`)}${jar.file}`);
			}
		}

		if (report.removedEntries.length) {
			warn(t("cli.plugins.scan.removedStale", { names: report.removedEntries.join(", ") }));
		}
	},
});

/** Turn update candidates into table rows plus the notes that don't fit a table. */
function renderCandidates(candidates: plugins.UpdateCandidate[]): {
	rows: string[][];
	notes: string[];
} {
	const rows: string[][] = [];
	const notes: string[] = [];

	for (const cand of candidates) {
		for (const group of cand.pendingGroups) {
			const current = [
				...new Set(
					group.changedTargets.map(
						(target) => plugins.assignedVersion(cand.entry, target) ?? "?",
					),
				),
			].join("/");

			rows.push([
				pc.bold(cand.name),
				versionDiff(current, group.version.version_number) +
					(group.isPrimary ? "" : pc.dim(` ${t("cli.plugins.variantTag")}`)),
				pc.dim(group.changedTargets.join(",") || group.targets.join(",")),
			]);
		}

		for (const holdback of cand.resolution.holdbacks) {
			notes.push(
				t("cli.plugins.holdback", {
					name: cand.name,
					targets: holdback.targets.join(","),
					version: holdback.current ?? "?",
					reason: holdback.reason,
				}),
			);
		}

		for (const pin of cand.resolution.pinned) {
			notes.push(
				t("cli.plugins.pinnedNote", { name: cand.name, target: pin.target, version: pin.version }),
			);
		}
	}

	return { rows, notes };
}

command({
	path: ["plugins", "check"],
	desc: t("cli.plugins.check.desc"),
	args: [{ name: "plugin", variadic: true, complete: pluginNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadLock();

		const progress = new ProgressReporter(t("cli.plugins.checkProgress"));
		const view = new ProgressView(progress).start();

		const { candidates, skipped } = await plugins.checkUpdates(
			cfg,
			lock,
			args.length ? args : undefined,
			{ reporter: progress },
		);

		view.stop();
		await saveLock(lock); // persist backfilled game-version metadata

		const { rows, notes } = renderCandidates(candidates);

		if (!rows.length && !notes.length) {
			ok(t("cli.plugins.upToDate"));

			return;
		}

		if (rows.length) {
			console.log();
			printTable(rows, {
				head: [t("cli.head.plugin"), t("cli.head.update"), t("cli.head.targets")],
			});
			console.log();
			info(t("cli.plugins.check.applyHint", { command: pc.cyan("luna plugins update") }));
		}

		for (const note of notes) {
			warn(note);
		}

		if (args.length) {
			for (const entry of skipped.filter((entry) => args.includes(entry.name))) {
				info(`${entry.name}: ${entry.reason}`);
			}
		}
	},
});

command({
	path: ["plugins", "update"],
	desc: t("cli.plugins.update.desc"),
	args: [{ name: "plugin", variadic: true, complete: pluginNames }],
	opts: [{ flag: "--deploy", desc: t("cli.plugins.update.optDeploy") }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();

		const progress = new ProgressReporter(t("cli.plugins.checkProgress"));
		const view = new ProgressView(progress).start();

		const { candidates } = await plugins.checkUpdates(cfg, lock, args.length ? args : undefined, {
			reporter: progress,
		});

		view.stop();

		const updatable = candidates.filter((cand) => cand.pendingGroups.length);

		if (!updatable.length) {
			ok(t("cli.plugins.upToDate"));

			return;
		}

		const spin = new Spinner().start(t("cli.plugins.update.downloading"));

		for (const cand of updatable) {
			spin.update(t("cli.plugins.update.downloadingOne", { name: cand.name }));
			await plugins.applyUpdate(lock, cand);
		}

		await saveLock(lock);
		spin.stop();

		for (const cand of updatable) {
			for (const group of cand.pendingGroups) {
				const variant = group.isPrimary ? "" : pc.dim(` ${t("cli.plugins.variantTag")}`);

				ok(
					`${pc.bold(cand.name)} ${pc.green(group.version.version_number)}${variant} ` +
						`${Sym.arrow} ${group.targets.join(",")}`,
				);
			}
		}

		for (const note of renderCandidates(updatable).notes) {
			warn(note);
		}

		if (opts.deploy) {
			await runDeploy(undefined);
		} else {
			info(t("cli.plugins.update.deployHint", { command: pc.cyan("luna plugins deploy") }));
		}
	},
});

/**
 * Push pool jars to the instances, then reconcile plugin port allocations. Shared
 * by `plugins deploy` and by every command that changes the pool.
 */
export async function runDeploy(instances: string[] | undefined, plugin?: string): Promise<void> {
	const cfg = await loadCluster();
	const lock = await loadLock();
	const spin = new Spinner().start(t("cli.plugins.deploy.deploying"));
	const actions = await plugins.deploy(cfg, lock, { instances, plugin });
	const ports = await ensurePortAllocations(cfg, lock);

	await saveCluster(cfg);
	// deploy may auto-assign an MC-fit variant to an instance; persist it
	await saveLock(lock);
	spin.stop();

	for (const action of actions.filter((action) => action.action === "missing-variant")) {
		warn(`${action.instance}: ${action.file} · ${action.detail}`);
	}

	const changed = actions.filter(
		(action) => action.action !== "unchanged" && action.action !== "missing-variant",
	);

	for (const action of changed) {
		const detail = `${action.action}${action.detail ? `, ${action.detail}` : ""}`;

		ok(`${pc.bold(action.instance)}: ${action.file} ${pc.dim(`(${detail})`)}`);
	}

	for (const port of ports.filter((port) => !port.written)) {
		info(
			`${t("cli.plugins.deploy.portReserved", {
				instance: port.instance,
				port: port.port,
				key: port.key,
			})} ${pc.dim(t("cli.plugins.deploy.portNote"))}`,
		);
	}

	if (!changed.length) {
		ok(t("cli.plugins.deploy.inSync"));

		return;
	}

	const statuses = await getAllStatuses(cfg);

	const needRestart = [...new Set(changed.map((action) => action.instance))].filter(
		(name) => statuses.find((status) => status.name === name)?.state !== "stopped",
	);

	if (needRestart.length) {
		warn(t("cli.plugins.deploy.needRestart", { names: needRestart.join(", ") }));
	}
}

command({
	path: ["plugins", "deploy"],
	desc: t("cli.plugins.deploy.desc"),
	args: [{ name: "instance", variadic: true, complete: instanceNames }],
	opts: [
		{ flag: "--plugin", desc: t("cli.plugins.deploy.optPlugin"), value: true, complete: pluginNames },
	],

	handler: async (args, opts) => {
		await runDeploy(args.length ? args : undefined, opts.plugin as string | undefined);
	},
});

command({
	path: ["plugins", "add"],
	desc: t("cli.plugins.add.desc"),
	args: [{ name: "slug-or-query", required: true, variadic: true }],
	opts: [
		{ flag: "--to", desc: t("cli.plugins.add.optTo"), value: true, complete: targetSelectors },
		{ flag: "--pool", desc: t("cli.plugins.add.optPool") },
		{
			flag: "--family",
			desc: t("cli.plugins.add.optFamily"),
			value: true,
			complete: async () => [...PLUGIN_FAMILIES],
		},
		{ flag: "--velocity", desc: t("cli.plugins.add.optVelocity") },
		{ flag: "--neoforge", desc: t("cli.plugins.add.optNeoforge") },
		{
			flag: "--provider",
			desc: t("cli.plugins.add.optProvider"),
			value: true,
			complete: async () => ["modrinth", "curseforge", "hangar"],
		},
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const query = args.join(" ");

		if (opts.velocity && opts.neoforge) {
			throw new UsageError(t("cli.plugins.add.platformConflict"));
		}

		// --velocity and --neoforge predate --family and stay as aliases for it;
		// a flag per ecosystem does not scale past the two that already existed
		const named = (opts.family as string | undefined)
			?? (opts.neoforge ? "neoforge" : opts.velocity ? "velocity" : "paper");

		if (!PLUGIN_FAMILIES.includes(named as PluginFamily) || named === "universal") {
			throw new UsageError(t("cli.plugins.add.badFamily", { family: named }));
		}

		const family = named as Exclude<PluginFamily, "universal">;

		const provider = parseProvider(opts.provider as string | undefined);
		const type = plugins.projectTypeFor(family);
		const spin = new Spinner().start(t("cli.plugins.add.resolving", { query, provider }));

		let project = await providers.getProject(provider, query, type);

		spin.stop();

		// not a slug; fall back to search and let the user pick
		if (!project) {
			const hits = await providers.searchProvider(
				provider,
				query,
				type,
				plugins.loadersFor(family),
			);

			if (!hits.length) {
				throw new Bail(t("cli.plugins.add.nothingFound", { query }));
			}

			const { select, isCancel } = await import("@clack/prompts");

			const picked = await select({
				message: FAMILY_DIRS[family] === "mods" ? t("cli.plugins.add.selectMod") : t("cli.plugins.add.selectPlugin"),
				options: hits.map((hit) => ({
					value: hit.project_id,
					label: hit.title,
					hint: `${t("cli.plugins.add.downloads", { count: hit.downloads.toLocaleString() })} · ${hit.description.slice(0, 60)}`,
				})),
			});

			if (isCancel(picked)) {
				info(t("cli.common.aborted"));

				return;
			}

			project = (await providers.getProject(provider, picked as string, type))!;
		}

		const targets = opts.pool ? [] : await parseTargets(opts.to as string | undefined);

		expandTargets(cfg, targets); // validate

		const installSpinner = new Spinner().start(t("cli.plugins.add.installing", { name: project.title }));
		const res = await plugins.installFromProvider(cfg, lock, provider, project, family, targets);

		await saveLock(lock);
		installSpinner.stop();

		for (const group of res.resolution.groups) {
			const variant = group.isPrimary ? "" : pc.dim(` ${t("cli.plugins.variantTag")}`);
			const where = group.targets.length
				? `${Sym.arrow} ${group.targets.join(",")}`
				: pc.dim(t("cli.plugins.add.pooledOnly"));

			ok(
				`${t("cli.plugins.add.installed", {
					name: pc.bold(res.name),
					version: pc.green(group.version.version_number),
				})}${variant} ${where}`,
			);
		}

		for (const holdback of res.resolution.holdbacks) {
			warn(
				t("cli.plugins.add.holdback", {
					name: res.name,
					targets: holdback.targets.join(","),
					reason: holdback.reason,
				}),
			);
		}

		await runDeploy(undefined, res.name);
	},
});

command({
	path: ["plugins", "apply"],
	desc: t("cli.plugins.apply.desc"),
	args: [{ name: "plugin", required: true, complete: pluginNames }],
	opts: [
		{ flag: "--to", desc: t("cli.plugins.apply.optTo"), value: true, complete: targetSelectors },
		{ flag: "--replace", desc: t("cli.plugins.apply.optReplace") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;
		const entry = lock.plugins[name];

		if (!entry) {
			throw new UsageError(t("cli.plugins.unknown", { name }));
		}

		const add = await parseTargets(opts.to as string | undefined);
		const before = expandTargets(cfg, entry.targets);

		expandTargets(cfg, add); // validate

		entry.targets = opts.replace
			? [...new Set(add)].sort()
			: [...new Set([...entry.targets, ...add])].sort();

		// replacing can narrow the list, which would leave the dropped instances
		// running a jar nothing manages any more; deploy never deletes
		const dropped = before.filter((target) => !expandTargets(cfg, entry.targets).includes(target));

		if (dropped.length) {
			warn(
				t("cli.plugins.apply.dropped", {
					names: dropped.join(", "),
					command: `plugins remove ${name} --from ${dropped.join(",")}`,
				}),
			);
		}

		await saveLock(lock);
		ok(t("cli.plugins.apply.saved", { name: pc.bold(name), targets: entry.targets.join(",") }));
		await runDeploy(undefined, name);
	},
});

command({
	path: ["plugins", "remove"],
	desc: t("cli.plugins.remove.desc"),
	args: [{ name: "plugin", required: true, complete: pluginNames }],
	opts: [
		{ flag: "--from", desc: t("cli.plugins.remove.optFrom"), value: true, complete: targetSelectors },
		{ flag: "--yes", desc: t("cli.common.optYes") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;

		if (!lock.plugins[name]) {
			throw new UsageError(t("cli.plugins.unknown", { name }));
		}

		const from = opts.from ? splitTargets(opts.from as string) : undefined;

		if (!from && !opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const sure = await confirm({
				message: t("cli.plugins.remove.confirm", { name }),
			});

			if (isCancel(sure) || !sure) {
				info(t("cli.common.aborted"));

				return;
			}
		}

		const res = await plugins.removePlugin(cfg, lock, name, from);

		await saveLock(lock);

		const where = res.deletedFrom.join(", ") || t("cli.plugins.remove.noJars");
		const pool = res.entryRemoved ? `; ${t("cli.plugins.remove.poolDeleted")}` : "";

		ok(t("cli.plugins.remove.done", { name: pc.bold(name), where }) + pool);
		warn(t("cli.plugins.remove.restartNote"));
	},
});

command({
	path: ["plugins", "adopt"],
	desc: t("cli.plugins.adopt.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "jar", required: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const [instance, jar] = args as [string, string];
		const entry = await plugins.adopt(cfg, lock, instance, jar);

		await saveLock(lock);

		ok(
			`${t("cli.plugins.adopt.done", { name: pc.bold(jar) })} ` +
				pc.dim(`(${t("cli.head.source")}: ${entry.source}, ${t("cli.head.targets")}: ${entry.targets.join(",")})`),
		);

		info(t("cli.plugins.adopt.identifyHint", { command: pc.cyan("luna plugins scan") }));
	},
});

command({
	path: ["plugins", "upload"],
	desc: t("cli.plugins.upload.desc"),
	args: [{ name: "jar-path", required: true }],
	opts: [
		{ flag: "--name", desc: t("cli.plugins.upload.optName"), value: true },
		{
			flag: "--family",
			desc: t("cli.plugins.upload.optFamily"),
			value: true,
			complete: async () => [...PLUGIN_FAMILIES],
		},
		{ flag: "--to", desc: t("cli.plugins.upload.optTo"), value: true, complete: targetSelectors },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const path = args[0]!;
		const file = Bun.file(path);

		if (!(await file.exists())) {
			throw new UsageError(t("cli.plugins.upload.noSuchFile", { path }));
		}

		const family = ((opts.family as string | undefined) ?? "paper") as PluginFamily;

		if (!PLUGIN_FAMILIES.includes(family)) {
			throw new UsageError(t("cli.plugins.upload.badFamily"));
		}

		const plugin =
			(opts.name as string | undefined) ??
			path
				.split("/")
				.at(-1)!
				.replace(/\.jar$/i, "")
				.replace(/[@_].*$/, "")
				.toLowerCase();

		const targets = opts.to ? splitTargets(String(opts.to)) : [];
		const spin = new Spinner().start(t("cli.plugins.upload.pooling", { name: plugin }));

		const res = await plugins.uploadJar(cfg, lock, {
			plugin,
			family,
			targets,
			dataBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
		});

		await ensureAliases(lock);
		await saveLock(lock);
		spin.stop();

		ok(
			`${t("cli.plugins.upload.pooled", { name: pc.bold(res.name) })} ` +
				pc.dim(
					targets.length
						? `(${t("cli.head.targets")}: ${res.entry.targets.join(",")})`
						: t("cli.plugins.upload.notDeployed"),
				),
		);

		if (targets.length) {
			await runDeploy(undefined, res.name);
		}
	},
});

command({
	path: ["plugins", "info"],
	desc: t("cli.plugins.info.desc"),
	args: [{ name: "plugin", required: true, complete: pluginNames }],

	handler: async (args) => {
		const lock = await loadLock();
		const name = args[0]!;
		const entry = lock.plugins[name];

		if (!entry) {
			throw new UsageError(t("cli.plugins.unknown", { name }));
		}

		console.log();

		printTable([
			[t("cli.head.file"), entry.file],
			[t("cli.head.source"), sourceBadge(entry.source)],
			[t("cli.head.family"), familyOf(entry)],
			[
				t("cli.plugins.info.autoUpdate"),
				entry.autoUpdate ? pc.green(t("cli.plugins.info.on")) : pc.yellow(t("cli.plugins.info.off")),
			],
			[t("cli.head.channel"), entry.channel ?? "release"],
			[t("cli.head.targets"), entry.targets.join(",")],
			...(entry.remote
				? [[
						entry.remote.provider,
						providers.projectUrl(entry.remote, plugins.projectTypeFor(familyOf(entry))),
					]]
				: []),
		]);

		const rows: string[][] = [];

		if (entry.installed) {
			rows.push([
				pc.green(t("cli.plugins.info.primary")),
				entry.installed.versionNumber ?? "?",
				pc.dim((entry.installed.gameVersions ?? []).join(", ") || t("cli.plugins.info.unknownMc")),
			]);
		}

		for (const variant of Object.values(entry.variants ?? {})) {
			rows.push([
				pc.yellow(t("cli.plugins.info.variant")),
				variant.versionNumber,
				pc.dim((variant.gameVersions ?? []).join(", ") || t("cli.plugins.info.unknownMc")),
			]);
		}

		if (rows.length) {
			console.log();
			printTable(rows, {
				head: [t("cli.head.kind"), t("cli.head.version"), t("cli.head.supportsMc")],
			});
		}

		const assigns = Object.entries({ ...entry.assign, ...entry.pins });

		if (assigns.length) {
			console.log();

			printTable(
				assigns.map(([target, version]) => [
					target,
					version,
					entry.pins?.[target]
						? pc.magenta(t("cli.plugins.info.pinned"))
						: pc.dim(t("cli.plugins.info.auto")),
				]),
				{ head: [t("cli.head.instance"), t("cli.head.runsVersion"), t("cli.head.why")] },
			);
		}

		console.log();
	},
});

command({
	path: ["plugins", "pin"],
	desc: t("cli.plugins.pin.desc"),
	args: [
		{ name: "plugin", required: true, complete: pluginNames },
		{ name: "version", required: true },
	],
	opts: [
		{ flag: "--on", desc: t("cli.plugins.pin.optOn"), value: true, complete: targetSelectors },
		{ flag: "--force", desc: t("cli.plugins.pin.optForce") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const [name, version] = args as [string, string];

		const targets = opts.on
			? splitTargets(opts.on as string)
			: (lock.plugins[name]?.targets ?? []);

		const spin = new Spinner().start(t("cli.plugins.pin.pinning", { name, version }));

		try {
			const res = await plugins.pinVersion(cfg, lock, name, version, targets, !!opts.force);

			await saveLock(lock);
			spin.stop();

			const pinnedOn = Object.keys(lock.plugins[name]!.pins ?? {}).join(", ");

			ok(
				t("cli.plugins.pin.done", {
					name: pc.bold(name),
					version: pc.green(res.version.version_number),
					targets: pinnedOn,
				}),
			);

			if (res.incompatible.length) {
				warn(t("cli.plugins.pin.forced", { names: res.incompatible.join(", ") }));
			}
		} catch (err) {
			spin.stop();

			throw new Bail((err as Error).message);
		}

		await runDeploy(undefined, name);
	},
});

command({
	path: ["plugins", "unpin"],
	desc: t("cli.plugins.unpin.desc"),
	args: [{ name: "plugin", required: true, complete: pluginNames }],
	opts: [
		{ flag: "--on", desc: t("cli.plugins.unpin.optOn"), value: true, complete: targetSelectors },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;
		const targets = opts.on ? splitTargets(opts.on as string) : undefined;
		const removed = plugins.unpinVersion(cfg, lock, name, targets);

		await saveLock(lock);

		if (!removed.length) {
			info(t("cli.plugins.unpin.nothing"));

			return;
		}

		ok(t("cli.plugins.unpin.done", { name: pc.bold(name), targets: removed.join(", ") }));
		info(t("cli.plugins.unpin.hint", { command: pc.cyan(`luna plugins update ${name}`) }));
	},
});

command({
	path: ["plugins", "compat"],
	desc: t("cli.plugins.compat.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "mc-version", desc: t("cli.plugins.compat.argMc") },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;
		const instance = managedInstances(cfg)[name];

		if (!instance) {
			throw new UsageError(t("cli.env.unknownInstance", { name }));
		}

		const mc = args[1] ?? instance.mcVersion;

		if (!mc) {
			throw new Bail(t("cli.plugins.compat.noVersion"));
		}

		const rows = plugins.compatReport(cfg, lock, name, mc);

		if (!rows.length) {
			info(t("cli.plugins.compat.noPlugins"));

			return;
		}

		console.log(
			`\n  ${t("cli.plugins.compat.heading", { name: pc.bold(name), mc: pc.cyan(mc) })}\n`,
		);

		printTable(
			rows.map((row) => {
				const glyph =
					row.status === "ok"
						? Sym.ok
						: row.status === "incompatible"
							? Sym.bad
							: Sym.warn;

				const status =
					row.status === "unknown"
						? pc.yellow(t("cli.plugins.compat.unknown"))
						: row.status === "ok"
							? pc.green(t("cli.plugins.compat.ok"))
							: pc.red(t("cli.plugins.compat.incompatible"));

				return [
					glyph,
					row.plugin + (row.pinned ? pc.magenta(" 📌") : ""),
					row.version ?? pc.dim("?"),
					status,
				];
			}),
			{ head: ["", t("cli.head.plugin"), t("cli.head.version"), t("cli.head.status")] },
		);

		const bad = rows.filter((row) => row.status === "incompatible");

		console.log();

		if (bad.length) {
			warn(
				t("cli.plugins.compat.needDifferent", {
					count: bad.length,
					command: pc.cyan("luna plugins update"),
				}),
			);

			return;
		}

		const unknown = rows.some((row) => row.status === "unknown")
			? pc.dim(` ${t("cli.plugins.compat.someUnknown")}`)
			: "";

		ok(t("cli.plugins.compat.noneKnown") + unknown);
	},
});

for (const [verb, value] of [
	["enable", true],
	["disable", false],
] as const) {
	command({
		path: ["plugins", verb],
		desc: t(verb === "enable" ? "cli.plugins.enable.desc" : "cli.plugins.disable.desc"),
		args: [{ name: "plugin", required: true, variadic: true, complete: pluginNames }],

		handler: async (args) => {
			const lock = await loadLock();

			for (const name of args) {
				const entry = lock.plugins[name];

				if (!entry) {
					throw new UsageError(t("cli.plugins.unknown", { name }));
				}

				entry.autoUpdate = value;

				const state = value
					? pc.green(t("cli.plugins.enable.state"))
					: pc.yellow(t("cli.plugins.disable.state"));

				ok(`${pc.bold(name)}: ${t("cli.plugins.info.autoUpdate")} ${state}`);
			}

			await saveLock(lock);
		},
	});
}

/** Restart choice shared by group edits: now, a one-shot schedule, or nothing.
 *  Lives here beside the deploy helper; the group commands are in addons.ts. */
export async function applyGroupRestart(
	cfg: Awaited<ReturnType<typeof loadCluster>>,
	group: string,
	restart: string | undefined,
): Promise<void> {
	if (!restart || restart === "none") {
		info(t("cli.plugins.groupRestart.onNextRestart", { name: pc.bold(group) }));

		return;
	}

	const affected = groupInstances(cfg, group);

	if (restart === "now") {
		const inst = await import("../../client/core/instances");
		const statuses = await getAllStatuses(cfg);

		for (const name of affected) {
			if (statuses.find((status) => status.name === name)?.state === "stopped") {
				info(t("cli.luna.deploy.leftDown", { name }));

				continue;
			}

			const spin = new Spinner().start(t("cli.luna.deploy.restarting", { name }));

			await inst.stopInstance(cfg, name);
			await inst.startInstance(cfg, name);
			spin.stop();
			ok(t("cli.luna.deploy.restarted", { name: pc.bold(name) }));
		}

		return;
	}

	// anything else is a time for a one-shot restart schedule
	const { loadSchedules, saveSchedules, createSchedule } = await import("../../client/core/schedule");
	const store = await loadSchedules();

	const schedule = createSchedule(cfg, store, {
		name: t("cli.plugins.groupRestart.scheduleName", { name: group }),
		action: "restart",
		instances: affected,
		trigger: { kind: "at", at: new Date(restart).toISOString() },
	});

	await saveSchedules(store);
	ok(
		t("cli.plugins.groupRestart.scheduled", {
			time: pc.cyan(schedule.nextRun ?? "?"),
			names: affected.join(", "),
		}),
	);
}

command({
	path: ["plugins", "validate"],
	desc: t("cli.plugins.validate.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames }],
	opts: [{ flag: "--groups", desc: t("cli.plugins.validate.optGroups"), value: true }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;
		const inst = managedInstances(cfg)[name];

		if (!inst) {
			throw new UsageError(t("cli.env.unknownInstance", { name }));
		}

		const groups = opts.groups
			? String(opts.groups).split(",").map((entry) => entry.trim()).filter(Boolean)
			: instanceGroupNames(inst).filter((group) => group !== "default");

		const rows = validateGroups(cfg, lock, {
			software: inst.software,
			mcVersion: inst.mcVersion,
			groups,
			instance: name,
		});

		const glyph = (status: string): string =>
			status === "ok"
				? Sym.ok
				: status === "unverified"
					? Sym.dot
					: status === "skipped"
						? Sym.off
						: Sym.warn;

		console.log();

		printTable(
			rows.map((row) => [
				glyph(row.status),
				row.plugin,
				row.family ?? pc.dim("—"),
				row.status + (row.downloadable ? pc.cyan(` ${t("cli.plugins.validate.downloadable")}`) : ""),
				row.version ?? pc.dim("—"),
				pc.dim(row.groups.join(",")),
			]),
			{
				head: [
					"",
					t("cli.head.plugin"),
					t("cli.head.family"),
					t("cli.head.status"),
					t("cli.head.version"),
					t("cli.head.groups"),
				],
			},
		);

		console.log();

		const fetchable = rows.filter((row) => row.downloadable);

		if (fetchable.length) {
			info(
				t("cli.plugins.validate.fetchHint", {
					command: pc.cyan(`luna plugins fetch <plugin> --mc ${inst.mcVersion}`),
				}),
			);
		}
	},
});

command({
	path: ["plugins", "fetch"],
	desc: t("cli.plugins.fetch.desc"),
	args: [{ name: "plugin", required: true, complete: pluginNames }],
	opts: [{ flag: "--mc", desc: t("cli.plugins.fetch.optMc"), value: true }],

	handler: async (args, opts) => {
		const lock = await loadLock();
		const name = args[0]!;
		const mc = opts.mc as string | undefined;

		if (!mc) {
			throw new UsageError(t("cli.plugins.fetch.needsMc"));
		}

		const spin = new Spinner().start(t("cli.plugins.fetch.resolving", { name, mc }));
		const result = await plugins.ensureVariantForMc(lock, name, mc);

		await saveLock(lock);
		spin.stop();

		if (result.downloaded) {
			ok(t("cli.plugins.fetch.pooled", { name: pc.bold(name), version: pc.cyan(result.version), mc }));
		} else {
			info(t("cli.plugins.fetch.alreadyCovers", { name: pc.bold(name), version: result.version, mc }));
		}
	},
});

command({
	path: ["plugins", "config"],
	desc: t("cli.plugins.config.desc"),
	args: [
		{ name: "what", required: true, complete: async () => ["show", "apply"] },
		{ name: "target", required: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const [what, target] = args as [string, string];

		if (what === "show") {
			const entry = lock.plugins[target];

			if (!entry) {
				throw new UsageError(t("cli.plugins.config.unknownEntry", { name: target }));
			}

			if (!entry.config?.length) {
				info(t("cli.plugins.config.noTemplate", { name: target }));

				return;
			}

			console.log(JSON.stringify(entry.config, null, 2));

			return;
		}

		if (what !== "apply") {
			throw new UsageError(t("cli.plugins.config.badWhat"));
		}

		const { applyTemplates, notableTemplateResults } = await import("../../client/core/templates");
		const results = await applyTemplates(cfg, lock, target);
		const notable = notableTemplateResults(results);

		if (!notable.length) {
			ok(t("cli.env.apply.templatesInPlace", { name: target, count: results.length }));

			return;
		}

		for (const result of notable) {
			const line = `${result.plugin} ${pc.dim(result.file)} ${result.key ?? ""} ${result.outcome}` +
				(result.detail ? pc.dim(` ${result.detail}`) : "");

			if (result.outcome === "set" || result.outcome === "wrote") {
				ok(line);
			} else {
				warn(line);
			}
		}
	},
});

command({
	path: ["plugins", "override"],
	desc: t("cli.plugins.override.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{
			name: "plugin",
			required: true,
			complete: async () => allPluginNames(await loadLock()),
		},
	],
	opts: [
		{ flag: "--enable", desc: t("cli.plugins.override.optEnable") },
		{ flag: "--disable", desc: t("cli.plugins.override.optDisable") },
		{ flag: "--clear", desc: t("cli.plugins.override.optClear") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const [instance, plugin] = args as [string, string];

		const picked = [opts.enable, opts.disable, opts.clear].filter(Boolean).length;

		if (picked !== 1) {
			throw new UsageError(t("cli.plugins.override.pickOne"));
		}

		const state = opts.enable ? true : opts.disable ? false : null;

		setPluginOverride(cfg, lock, instance, plugin, state);
		await saveCluster(cfg);

		// "wanted" must include explicit lockfile targets, not just groups/overrides:
		// clearing an override on an explicitly targeted plugin re-deploys it
		const wanted = entriesOf(lock, plugin).some((key) =>
			effectiveTargets(cfg, lock, key).includes(instance),
		);

		if (wanted) {
			ok(
				t("cli.plugins.override.deploying", {
					name: pc.bold(plugin),
					what:
						state === null
							? t("cli.plugins.override.cleared")
							: t("cli.plugins.override.forceAdded"),
					instance,
				}),
			);
			await runDeploy([instance], undefined);

			return;
		}

		const removed = await removeInstanceJars(cfg, lock, instance, plugin);

		await saveLock(lock);

		if (state === null) {
			ok(t("cli.plugins.override.clearedOn", { name: pc.bold(plugin), instance }));
		} else {
			ok(t("cli.plugins.override.disabledOn", { name: pc.bold(plugin), instance }));
		}

		if (removed.length) {
			info(
				`${t("cli.plugins.override.removedJars", { instance, names: removed.join(", ") })} ${pc.dim(t("cli.plugins.override.loadedNote"))}`,
			);
		}
	},
});

command({
	path: ["plugins", "state"],
	desc: t("cli.plugins.state.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const instance = args[0]!;

		const spin = new Spinner().start(t("cli.plugins.state.reading", { name: instance }));

		if (await ensureAliases(lock)) {
			await saveLock(lock);
		}

		const { rows, session } = await instancePluginReport(cfg, lock, instance);

		spin.stop();

		// "disabled" is the override, not a phase: it says why there is nothing to
		// report rather than what the log saw, so it is shown in place of the state
		const stateGlyph = (state: string, disabled: boolean): string =>
			disabled
				? pc.dim(t("cli.plugins.state.disabled"))
				: state === "running"
					? pc.green(state)
					: state === "errored"
						? pc.red(state)
						: state === "loading"
							? pc.yellow(state)
							: pc.dim(state);

		console.log();

		printTable(
			rows.map((row) => [
				row.plugin,
				pc.dim(row.displayName),
				stateGlyph(row.state, row.disabled),
				row.version ?? pc.dim("—"),
				row.warnings ? pc.yellow(String(row.warnings)) : pc.dim("0"),
				row.errors ? pc.red(String(row.errors)) : pc.dim("0"),
				row.origin === "manual" ? pc.cyan(row.origin) : pc.dim(row.groups.join(",") || row.origin),
			]),
			{
				head: [
					t("cli.head.plugin"),
					t("cli.head.logName"),
					t("cli.head.state"),
					t("cli.head.version"),
					t("cli.head.warn"),
					t("cli.head.err"),
					t("cli.head.from"),
				],
			},
		);

		console.log();

		if (!session.complete) {
			warn(t("cli.plugins.state.incompleteSession"));
		}

		const troubled = rows.filter((row) => row.state === "errored" || row.errors > 0);

		if (troubled.length) {
			warn(t("cli.plugins.state.troubled", { count: troubled.length, name: instance }));
		}
	},
});

command({
	path: ["plugins", "standardize"],
	desc: t("cli.plugins.standardize.desc"),
	opts: [{ flag: "--yes", desc: t("cli.common.optYes") }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();

		if (!opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");

			const sure = await confirm({
				message: t("cli.plugins.standardize.confirm"),
			});

			if (isCancel(sure) || !sure) {
				throw new Bail(t("cli.common.aborted"));
			}
		}

		const spin = new Spinner().start(t("cli.plugins.standardize.working"));
		const report = await standardizeNaming(cfg, lock);

		await saveCluster(cfg);
		await saveLock(lock);
		spin.stop();

		for (const step of report.renamed) {
			ok(`${step.oldKey} ${Sym.arrow} ${pc.bold(step.newKey)}`);
		}

		for (const port of report.portKeys) {
			info(t("cli.plugins.standardize.portKey", { name: port }));
		}

		for (const member of report.groupMembers) {
			info(t("cli.plugins.standardize.groupMember", { name: member }));
		}

		info(
			t("cli.plugins.standardize.summary", {
				deployed: report.deployed,
				removed: report.removed.length,
			}),
		);

		if (report.mismatches.length) {
			for (const mismatch of report.mismatches) {
				warn(t("cli.plugins.standardize.mismatch", { detail: mismatch }));
			}
		} else {
			ok(t("cli.plugins.standardize.parityOk"));
		}
	},
});

command({
	path: ["plugins", "identify"],
	desc: t("cli.plugins.identify.desc"),
	args: [
		{ name: "plugin", required: true, complete: pluginNames },
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
		const lock = await loadLock();
		const name = args[0]!;
		const provider = parseProvider(opts.provider as string | undefined);

		const spin = new Spinner().start(t("cli.plugins.identify.probing", { name, provider }));
		const probe = await plugins.probePluginIdentity(lock, name, provider, args[1]!);

		spin.stop();
		info(t("cli.plugins.identify.localFile", { path: pc.dim(probe.local.file) }));
		printProbe(probe);

		// mapping an unproven file is the operator's judgement, never a default:
		// the recorded version is what the downgrade guard compares against
		if (probe.confidence !== "exact" && !opts.version && !opts.unidentified && !opts.yes) {
			throw new Bail(t("cli.plugins.identify.unproven"));
		}

		const { entry, match } = await plugins.identifyPlugin(cfg, lock, name, {
			provider,
			project: args[1]!,
			versionId: opts.version as string | undefined,
			unidentified: opts.unidentified as boolean | undefined,
			autoUpdate: opts.auto === undefined ? undefined : opts.auto === "on",
		});

		await saveLock(lock);

		ok(
			`${pc.bold(name)} → ${provider}:${probe.project.slug} ` +
				`${match ? pc.green(match.versionNumber) : pc.dim(t("cli.plugins.identify.versionUnknown"))}, ` +
				`${t("cli.plugins.info.autoUpdate")} ${entry.autoUpdate ? pc.green(t("cli.plugins.info.on")) : pc.dim(t("cli.plugins.info.off"))}`,
		);
		info(t("cli.plugins.identify.checkHint", { command: `luna plugins check ${name}` }));
	},
});

command({
	path: ["plugins", "forget"],
	desc: t("cli.plugins.forget.desc"),
	args: [{ name: "plugin", required: true, complete: pluginNames }],

	handler: async (args) => {
		const lock = await loadLock();

		await plugins.forgetPluginIdentity(lock, args[0]!);
		await saveLock(lock);

		ok(t("cli.plugins.forget.done", { name: pc.bold(args[0]!) }));
	},
});
