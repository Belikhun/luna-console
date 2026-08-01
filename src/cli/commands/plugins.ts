import { command, UsageError, Bail } from "../framework";
import { pc, Sym, ok, warn, info, printTable, versionDiff, Spinner } from "../ui";
import { instanceNames, pluginNames, targetSelectors } from "../completers";
import {
	loadCluster,
	loadLock,
	saveLock,
	saveCluster,
	expandTargets,
	managedInstances,
} from "../../core/config";
import * as plugins from "../../core/plugins";
import * as mr from "../../core/services/modrinth";
import { getAllStatuses } from "../../core/instances";
import { ensurePortAllocations } from "../../core/ports";

/** Coloured label for a lock entry's source. */
function sourceBadge(source: string): string {
	switch (source) {
		case "modrinth":
			return pc.green("modrinth");

		case "luna":
			return pc.magenta("luna");

		default:
			return pc.yellow("manual");
	}
}

/** Split a comma-separated `--to`/`--from`/`--on` value. */
function splitTargets(raw: string): string[] {
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

/** Target list from the flag, or an interactive multiselect when it was omitted. */
async function parseTargets(raw: string | undefined): Promise<string[]> {
	if (raw) {
		return splitTargets(raw);
	}

	const { multiselect, isCancel } = await import("@clack/prompts");
	const names = await instanceNames();

	const picked = await multiselect({
		message: "Deploy to which instances?",
		options: [
			{ value: "*paper", label: "*paper (all paper instances)" },
			{ value: "*velocity", label: "*velocity (the proxy)" },
			...names.map((name) => ({ value: name, label: name })),
		],
	});

	if (isCancel(picked)) {
		throw new Bail("aborted");
	}

	return picked as string[];
}

command({
	path: ["plugins", "list"],
	desc: "List managed plugins, versions and targets",

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
				entry.loader,
				version,
				entry.targets.join(",") || pc.red("(none)"),
			];
		});

		console.log();
		printTable(rows, { head: ["auto", "plugin", "source", "loader", "version", "targets"] });

		console.log(
			pc.dim(
				`\n  ${rows.length} plugins — ${Sym.ok} auto-update on, ${Sym.off} off, ` +
					"+Nv = per-instance variants/pins (see plugins info)\n",
			),
		);
	},
});

command({
	path: ["plugins", "scan"],
	desc: "Scan pool + instances, identify jars on Modrinth, rebuild lockfile",

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const spin = new Spinner().start("hashing jars and querying Modrinth...");
		const report = await plugins.scan(cfg, lock);

		await saveLock(lock);
		spin.stop();

		if (report.added.length) {
			ok(`added ${report.added.length} lockfile entries`);
		}

		for (const hit of report.identified) {
			console.log(
				`  ${Sym.check} ${pc.bold(hit.name)} ${Sym.arrow} ${pc.green(hit.slug)} ${pc.dim(hit.version)}`,
			);
		}

		for (const name of report.unidentified) {
			console.log(`  ${pc.yellow("?")} ${name} ${pc.dim("not on modrinth (manual)")}`);
		}

		for (const name of report.luna) {
			console.log(`  ${pc.magenta("◆")} ${name} ${pc.dim("luna plugin")}`);
		}

		if (report.caseMismatches.length) {
			console.log();
			warn("filename case mismatches (these NEVER received updates from the old sync script):");

			for (const mismatch of report.caseMismatches) {
				console.log(
					`    ${mismatch.instance}/plugins/${pc.red(mismatch.actual)} ${Sym.arrow} ` +
						`${pc.green(mismatch.expected)} ${pc.dim("(fixed on next deploy)")}`,
				);
			}
		}

		if (report.unmanaged.length) {
			console.log();
			info(
				`${report.unmanaged.length} instance-only jars not in the pool ` +
					"(adopt with: mrds plugins adopt <instance> <jar>)",
			);

			for (const jar of report.unmanaged) {
				console.log(`    ${pc.dim(`${jar.instance}/plugins/`)}${jar.file}`);
			}
		}

		if (report.removedEntries.length) {
			warn(`removed stale entries: ${report.removedEntries.join(", ")}`);
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
					(group.isPrimary ? "" : pc.dim(" (variant)")),
				pc.dim(group.changedTargets.join(",") || group.targets.join(",")),
			]);
		}

		for (const holdback of cand.resolution.holdbacks) {
			notes.push(
				`${cand.name}: ${holdback.targets.join(",")} stays on ${holdback.current ?? "?"} — ` +
					holdback.reason,
			);
		}

		for (const pin of cand.resolution.pinned) {
			notes.push(`${cand.name}: ${pin.target} pinned to ${pin.version}`);
		}
	}

	return { rows, notes };
}

command({
	path: ["plugins", "check"],
	desc: "Check Modrinth for updates (per-instance version resolution)",
	args: [{ name: "plugin", variadic: true, complete: pluginNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const spin = new Spinner().start("checking Modrinth for updates...");

		const { candidates, skipped } = await plugins.checkUpdates(
			cfg,
			lock,
			args.length ? args : undefined,
		);

		await saveLock(lock); // persist backfilled game-version metadata
		spin.stop();

		const { rows, notes } = renderCandidates(candidates);

		if (!rows.length && !notes.length) {
			ok("everything is up to date");

			return;
		}

		if (rows.length) {
			console.log();
			printTable(rows, { head: ["plugin", "update", "targets"] });
			console.log();
			info(`apply with: ${pc.cyan("mrds plugins update")}`);
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
	desc: "Download updates into the pool (then run plugins deploy)",
	args: [{ name: "plugin", variadic: true, complete: pluginNames }],
	opts: [{ flag: "--deploy", desc: "also deploy to instances immediately" }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const spin = new Spinner().start("checking Modrinth for updates...");

		const { candidates } = await plugins.checkUpdates(cfg, lock, args.length ? args : undefined);
		const updatable = candidates.filter((cand) => cand.pendingGroups.length);

		if (!updatable.length) {
			spin.stop();
			ok("everything is up to date");

			return;
		}

		for (const cand of updatable) {
			spin.update(`downloading ${cand.name}...`);
			await plugins.applyUpdate(lock, cand);
		}

		await saveLock(lock);
		spin.stop();

		for (const cand of updatable) {
			for (const group of cand.pendingGroups) {
				const variant = group.isPrimary ? "" : pc.dim(" (variant)");

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
			info(`pool updated — push to instances with: ${pc.cyan("mrds plugins deploy")}`);
		}
	},
});

/**
 * Push pool jars to the instances, then reconcile plugin port allocations. Shared
 * by `plugins deploy` and by every command that changes the pool.
 */
async function runDeploy(instances: string[] | undefined, plugin?: string): Promise<void> {
	const cfg = await loadCluster();
	const lock = await loadLock();
	const spin = new Spinner().start("deploying plugins...");
	const actions = await plugins.deploy(cfg, lock, { instances, plugin });
	const ports = await ensurePortAllocations(cfg, lock);

	await saveCluster(cfg);
	spin.stop();

	for (const action of actions.filter((action) => action.action === "missing-variant")) {
		warn(`${action.instance}: ${action.file} — ${action.detail}`);
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
			`${port.instance}: port ${port.port} reserved for ${port.key} ` +
				pc.dim("(config appears after first boot — rerun deploy)"),
		);
	}

	if (!changed.length) {
		ok("all instances already in sync");

		return;
	}

	const statuses = await getAllStatuses(cfg);

	const needRestart = [...new Set(changed.map((action) => action.instance))].filter(
		(name) => statuses.find((status) => status.name === name)?.state !== "stopped",
	);

	if (needRestart.length) {
		warn(`running instances with updated jars (restart to apply): ${needRestart.join(", ")}`);
	}
}

command({
	path: ["plugins", "deploy"],
	desc: "Sync pool jars to instances per target lists (fixes case mismatches)",
	args: [{ name: "instance", variadic: true, complete: instanceNames }],
	opts: [
		{ flag: "--plugin", desc: "deploy a single plugin", value: true, complete: pluginNames },
	],

	handler: async (args, opts) => {
		await runDeploy(args.length ? args : undefined, opts.plugin as string | undefined);
	},
});

command({
	path: ["plugins", "add"],
	desc: "Install a plugin from Modrinth (slug, or search query)",
	args: [{ name: "slug-or-query", required: true, variadic: true }],
	opts: [
		{
			flag: "--to",
			desc: "targets: *, *paper, *velocity, or names",
			value: true,
			complete: targetSelectors,
		},
		{ flag: "--velocity", desc: "install the velocity variant" },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const query = args.join(" ");
		const loader: "paper" | "velocity" = opts.velocity ? "velocity" : "paper";
		const spin = new Spinner().start(`resolving "${query}" on Modrinth...`);

		let project = await mr.getProject(query);

		spin.stop();

		// not a slug — fall back to search and let the user pick
		if (!project) {
			const hits = await mr.search(query, plugins.loadersFor(loader));

			if (!hits.length) {
				throw new Bail(`nothing found for "${query}"`);
			}

			const { select, isCancel } = await import("@clack/prompts");

			const picked = await select({
				message: "Select a plugin",
				options: hits.map((hit) => ({
					value: hit.slug,
					label: hit.title,
					hint: `${hit.downloads.toLocaleString()} downloads — ${hit.description.slice(0, 60)}`,
				})),
			});

			if (isCancel(picked)) {
				info("aborted");

				return;
			}

			project = (await mr.getProject(picked as string))!;
		}

		const targets = await parseTargets(opts.to as string | undefined);

		expandTargets(cfg, targets); // validate

		const installSpinner = new Spinner().start(`installing ${project.title}...`);
		const res = await plugins.installFromModrinth(cfg, lock, project, loader, targets);

		await saveLock(lock);
		installSpinner.stop();

		for (const group of res.resolution.groups) {
			const variant = group.isPrimary ? "" : pc.dim(" (variant)");

			ok(
				`installed ${pc.bold(res.name)} ${pc.green(group.version.version_number)}${variant} ` +
					`${Sym.arrow} ${group.targets.join(",")}`,
			);
		}

		for (const holdback of res.resolution.holdbacks) {
			warn(`${res.name}: not installed on ${holdback.targets.join(",")} — ${holdback.reason}`);
		}

		await runDeploy(undefined, res.name);
	},
});

command({
	path: ["plugins", "apply"],
	desc: "Add instances to a plugin's targets and deploy",
	args: [{ name: "plugin", required: true, complete: pluginNames }],
	opts: [{ flag: "--to", desc: "targets to add", value: true, complete: targetSelectors }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;
		const entry = lock.plugins[name];

		if (!entry) {
			throw new UsageError(`unknown plugin: ${name}`);
		}

		const add = await parseTargets(opts.to as string | undefined);

		expandTargets(cfg, add); // validate

		entry.targets = [...new Set([...entry.targets, ...add])].sort();

		await saveLock(lock);
		ok(`${pc.bold(name)} targets: ${entry.targets.join(",")}`);
		await runDeploy(undefined, name);
	},
});

command({
	path: ["plugins", "remove"],
	desc: "Remove a plugin from instances (--from), or everywhere + pool",
	args: [{ name: "plugin", required: true, complete: pluginNames }],
	opts: [
		{
			flag: "--from",
			desc: "only remove from these targets",
			value: true,
			complete: targetSelectors,
		},
		{ flag: "--yes", desc: "skip confirmation" },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;

		if (!lock.plugins[name]) {
			throw new UsageError(`unknown plugin: ${name}`);
		}

		const from = opts.from ? splitTargets(opts.from as string) : undefined;

		if (!from && !opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const sure = await confirm({
				message: `Remove ${name} from ALL instances and the pool?`,
			});

			if (isCancel(sure) || !sure) {
				info("aborted");

				return;
			}
		}

		const res = await plugins.removePlugin(cfg, lock, name, from);

		await saveLock(lock);

		const where = res.deletedFrom.join(", ") || "(no jars present)";
		const pool = res.entryRemoved ? " — pool entry deleted" : "";

		ok(`removed ${pc.bold(name)} from: ${where}${pool}`);
		warn("running instances keep the plugin loaded until restart");
	},
});

command({
	path: ["plugins", "adopt"],
	desc: "Adopt an instance-only jar into the managed pool",
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
			`adopted ${pc.bold(jar)} into the pool ` +
				pc.dim(`(source: ${entry.source}, targets: ${entry.targets.join(",")})`),
		);

		info(`identify it on modrinth with: ${pc.cyan("mrds plugins scan")}`);
	},
});

command({
	path: ["plugins", "info"],
	desc: "Show a plugin's versions, per-instance assignments and requirements",
	args: [{ name: "plugin", required: true, complete: pluginNames }],

	handler: async (args) => {
		const lock = await loadLock();
		const name = args[0]!;
		const entry = lock.plugins[name];

		if (!entry) {
			throw new UsageError(`unknown plugin: ${name}`);
		}

		console.log();

		printTable([
			["file", entry.file],
			["source", sourceBadge(entry.source)],
			["loader", entry.loader],
			["auto-update", entry.autoUpdate ? pc.green("on") : pc.yellow("off")],
			["channel", entry.channel ?? "release"],
			["targets", entry.targets.join(",")],
			...(entry.modrinth
				? [["modrinth", `https://modrinth.com/plugin/${entry.modrinth.slug}`]]
				: []),
		]);

		const rows: string[][] = [];

		if (entry.installed) {
			rows.push([
				pc.green("primary"),
				entry.installed.versionNumber ?? "?",
				pc.dim((entry.installed.gameVersions ?? []).join(", ") || "unknown"),
			]);
		}

		for (const variant of Object.values(entry.variants ?? {})) {
			rows.push([
				pc.yellow("variant"),
				variant.versionNumber,
				pc.dim((variant.gameVersions ?? []).join(", ") || "unknown"),
			]);
		}

		if (rows.length) {
			console.log();
			printTable(rows, { head: ["kind", "version", "supports MC"] });
		}

		const assigns = Object.entries({ ...entry.assign, ...entry.pins });

		if (assigns.length) {
			console.log();

			printTable(
				assigns.map(([target, version]) => [
					target,
					version,
					entry.pins?.[target] ? pc.magenta("pinned") : pc.dim("auto"),
				]),
				{ head: ["instance", "runs version", "why"] },
			);
		}

		console.log();
	},
});

command({
	path: ["plugins", "pin"],
	desc: "Pin instance(s) to a specific plugin version (downloads it as a variant)",
	args: [
		{ name: "plugin", required: true, complete: pluginNames },
		{ name: "version", required: true },
	],
	opts: [
		{
			flag: "--on",
			desc: "targets to pin (default: all of the plugin's targets)",
			value: true,
			complete: targetSelectors,
		},
		{ flag: "--force", desc: "pin even if the version doesn't list the target's MC version" },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const [name, version] = args as [string, string];

		const targets = opts.on
			? splitTargets(opts.on as string)
			: (lock.plugins[name]?.targets ?? []);

		const spin = new Spinner().start(`pinning ${name} to ${version}...`);

		try {
			const res = await plugins.pinVersion(cfg, lock, name, version, targets, !!opts.force);

			await saveLock(lock);
			spin.stop();

			const pinnedOn = Object.keys(lock.plugins[name]!.pins ?? {}).join(", ");

			ok(`${pc.bold(name)} pinned to ${pc.green(res.version.version_number)} on: ${pinnedOn}`);

			if (res.incompatible.length) {
				warn(`forced despite MC mismatch on: ${res.incompatible.join(", ")}`);
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
	desc: "Remove version pins (back to automatic per-instance resolution)",
	args: [{ name: "plugin", required: true, complete: pluginNames }],
	opts: [
		{ flag: "--on", desc: "only unpin these targets", value: true, complete: targetSelectors },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;
		const targets = opts.on ? splitTargets(opts.on as string) : undefined;
		const removed = plugins.unpinVersion(cfg, lock, name, targets);

		await saveLock(lock);

		if (!removed.length) {
			info("nothing was pinned");

			return;
		}

		ok(`unpinned ${pc.bold(name)} on: ${removed.join(", ")}`);
		info(`run ${pc.cyan(`mrds plugins update ${name}`)} to re-resolve, then deploy`);
	},
});

command({
	path: ["plugins", "compat"],
	desc: "Server-version requirement check: can an instance (at a given MC version) run its plugins?",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "mc-version", desc: "defaults to the instance's current version" },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;
		const instance = managedInstances(cfg)[name];

		if (!instance) {
			throw new UsageError(`unknown instance: ${name}`);
		}

		const mc = args[1] ?? instance.mcVersion;

		if (!mc) {
			throw new Bail("no MC version known for this instance — pass one explicitly");
		}

		const rows = plugins.compatReport(cfg, lock, name, mc);

		if (!rows.length) {
			info("no managed paper plugins target this instance");

			return;
		}

		console.log(`\n  plugin compatibility for ${pc.bold(name)} on MC ${pc.cyan(mc)}:\n`);

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
						? pc.yellow("unknown")
						: row.status === "ok"
							? pc.green("ok")
							: pc.red("incompatible");

				return [
					glyph,
					row.plugin + (row.pinned ? pc.magenta(" 📌") : ""),
					row.version ?? pc.dim("?"),
					status,
				];
			}),
			{ head: ["", "plugin", "version", "status"] },
		);

		const bad = rows.filter((row) => row.status === "incompatible");

		console.log();

		if (bad.length) {
			warn(
				`${bad.length} plugin(s) need a different version — run ` +
					`${pc.cyan("mrds plugins update")} after switching`,
			);

			return;
		}

		const unknown = rows.some((row) => row.status === "unknown")
			? pc.dim(" (some requirements unknown — run plugins check to backfill)")
			: "";

		ok("no known incompatibilities" + unknown);
	},
});

for (const [verb, value] of [
	["enable", true],
	["disable", false],
] as const) {
	command({
		path: ["plugins", verb],
		desc: `${verb === "enable" ? "Enable" : "Disable"} auto-update for plugin(s)`,
		args: [{ name: "plugin", required: true, variadic: true, complete: pluginNames }],

		handler: async (args) => {
			const lock = await loadLock();

			for (const name of args) {
				const entry = lock.plugins[name];

				if (!entry) {
					throw new UsageError(`unknown plugin: ${name}`);
				}

				entry.autoUpdate = value;

				const state = value ? pc.green("enabled") : pc.yellow("disabled");

				ok(`${pc.bold(name)}: auto-update ${state}`);
			}

			await saveLock(lock);
		},
	});
}
