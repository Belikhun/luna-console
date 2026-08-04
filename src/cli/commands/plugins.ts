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
import * as providers from "../../client/core/services/providers";
import { getAllStatuses } from "../../client/core/instances";
import { ensurePortAllocations } from "../../client/core/ports";
import { parseProvider, printProbe } from "./packs";

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
		message: "Deploy to which instances?",
		required: false,
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
				familyOf(entry),
				version,
				entry.targets.join(",") || pc.red("(none)"),
			];
		});

		console.log();
		printTable(rows, { head: ["auto", "addon", "source", "family", "version", "targets"] });

		console.log(
			pc.dim(
				`\n  ${rows.length} addons — ${Sym.ok} auto-update on, ${Sym.off} off, ` +
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
					`    ${mismatch.instance}/${mismatch.dir}/${pc.red(mismatch.actual)} ${Sym.arrow} ` +
						`${pc.green(mismatch.expected)} ${pc.dim("(fixed on next deploy)")}`,
				);
			}
		}

		if (report.recognized.length) {
			console.log();
			info(
				`${report.recognized.length} instance file(s) are a pooled build under another name ` +
					"(register with: luna instance adopt-addons <instance>)",
			);

			for (const hit of report.recognized) {
				console.log(
					`    ${pc.dim(`${hit.instance}/${hit.dir}/`)}${hit.file} ${Sym.arrow} ${pc.green(hit.entry)}`,
				);
			}
		}

		if (report.unmanaged.length) {
			console.log();
			info(
				`${report.unmanaged.length} instance-only jars not in the pool — left where they are ` +
					"(adopt with: luna plugins adopt <instance> <jar>)",
			);

			for (const jar of report.unmanaged) {
				console.log(`    ${pc.dim(`${jar.instance}/${jar.dir}/`)}${jar.file}`);
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
	desc: "Check providers for updates (per-instance version resolution)",
	args: [{ name: "plugin", variadic: true, complete: pluginNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const spin = new Spinner().start("checking providers for updates...");

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
			info(`apply with: ${pc.cyan("luna plugins update")}`);
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
		const spin = new Spinner().start("checking providers for updates...");

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
			info(`pool updated — push to instances with: ${pc.cyan("luna plugins deploy")}`);
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
	const spin = new Spinner().start("deploying plugins...");
	const actions = await plugins.deploy(cfg, lock, { instances, plugin });
	const ports = await ensurePortAllocations(cfg, lock);

	await saveCluster(cfg);
	// deploy may auto-assign an MC-fit variant to an instance — persist it
	await saveLock(lock);
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
	desc: "Install a plugin or mod from a provider (slug, or search query)",
	args: [{ name: "slug-or-query", required: true, variadic: true }],
	opts: [
		{
			flag: "--to",
			desc: "targets: *, *paper, *velocity, *neoforge, or names",
			value: true,
			complete: targetSelectors,
		},
		{ flag: "--pool", desc: "pool the jar only — deploy it nowhere yet" },
		{ flag: "--velocity", desc: "install the velocity variant" },
		{ flag: "--neoforge", desc: "install the neoforge mod (searches mods, not plugins)" },
		{
			flag: "--provider",
			desc: "where to install from: modrinth (default), curseforge or hangar",
			value: true,
			complete: async () => ["modrinth", "curseforge", "hangar"],
		},
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const query = args.join(" ");

		if (opts.velocity && opts.neoforge) {
			throw new UsageError("--velocity and --neoforge are different platforms — pick one");
		}

		const family: "paper" | "velocity" | "neoforge" = opts.neoforge
			? "neoforge"
			: opts.velocity
				? "velocity"
				: "paper";

		const provider = parseProvider(opts.provider as string | undefined);
		const type = plugins.projectTypeFor(family);
		const spin = new Spinner().start(`resolving "${query}" on ${provider}...`);

		let project = await providers.getProject(provider, query, type);

		spin.stop();

		// not a slug — fall back to search and let the user pick
		if (!project) {
			const hits = await providers.searchProvider(
				provider,
				query,
				type,
				plugins.loadersFor(family),
			);

			if (!hits.length) {
				throw new Bail(`nothing found for "${query}"`);
			}

			const { select, isCancel } = await import("@clack/prompts");

			const picked = await select({
				message: family === "neoforge" ? "Select a mod" : "Select a plugin",
				options: hits.map((hit) => ({
					value: hit.project_id,
					label: hit.title,
					hint: `${hit.downloads.toLocaleString()} downloads — ${hit.description.slice(0, 60)}`,
				})),
			});

			if (isCancel(picked)) {
				info("aborted");

				return;
			}

			project = (await providers.getProject(provider, picked as string, type))!;
		}

		const targets = opts.pool ? [] : await parseTargets(opts.to as string | undefined);

		expandTargets(cfg, targets); // validate

		const installSpinner = new Spinner().start(`installing ${project.title}...`);
		const res = await plugins.installFromProvider(cfg, lock, provider, project, family, targets);

		await saveLock(lock);
		installSpinner.stop();

		for (const group of res.resolution.groups) {
			const variant = group.isPrimary ? "" : pc.dim(" (variant)");
			const where = group.targets.length
				? `${Sym.arrow} ${group.targets.join(",")}`
				: pc.dim("(pooled — not deployed anywhere yet)");

			ok(
				`installed ${pc.bold(res.name)} ${pc.green(group.version.version_number)}${variant} ` +
					where,
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
	opts: [
		{ flag: "--to", desc: "targets to add", value: true, complete: targetSelectors },
		{
			flag: "--replace",
			desc: "set the target list to exactly --to (e.g. collapse names into *paper)",
		},
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;
		const entry = lock.plugins[name];

		if (!entry) {
			throw new UsageError(`unknown plugin: ${name}`);
		}

		const add = await parseTargets(opts.to as string | undefined);
		const before = expandTargets(cfg, entry.targets);

		expandTargets(cfg, add); // validate

		entry.targets = opts.replace
			? [...new Set(add)].sort()
			: [...new Set([...entry.targets, ...add])].sort();

		// replacing can narrow the list, which would leave the dropped instances
		// running a jar nothing manages any more — deploy never deletes
		const dropped = before.filter((target) => !expandTargets(cfg, entry.targets).includes(target));

		if (dropped.length) {
			warn(
				`no longer targeted: ${dropped.join(", ")} — their copies stay on disk, ` +
					`remove them with "plugins remove ${name} --from ${dropped.join(",")}"`,
			);
		}

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

		info(`identify it on modrinth with: ${pc.cyan("luna plugins scan")}`);
	},
});

command({
	path: ["plugins", "upload"],
	desc: "Pool a jar from this machine (deploys to --to, or nowhere)",
	args: [{ name: "jar-path", required: true }],
	opts: [
		{ flag: "--name", desc: "plugin name (default: the jar's basename)", value: true },
		{
			flag: "--family",
			desc: "paper (default), velocity, universal or neoforge",
			value: true,
			complete: async () => ["paper", "velocity", "universal", "neoforge"],
		},
		{
			flag: "--to",
			desc: "targets: *, *paper, *velocity, or names (default: none)",
			value: true,
			complete: targetSelectors,
		},
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const path = args[0]!;
		const file = Bun.file(path);

		if (!(await file.exists())) {
			throw new UsageError(`no such file: ${path}`);
		}

		const family = (opts.family as string | undefined) ?? "paper";

		if (family !== "paper" && family !== "velocity" && family !== "universal" && family !== "neoforge") {
			throw new UsageError("--family must be paper, velocity, universal or neoforge");
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
		const spin = new Spinner().start(`pooling ${plugin}...`);

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
			`pooled ${pc.bold(res.name)} ` +
				pc.dim(
					targets.length
						? `(targets: ${res.entry.targets.join(",")})`
						: "(not deployed anywhere yet)",
				),
		);

		if (targets.length) {
			await runDeploy(undefined, res.name);
		}
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
			["family", familyOf(entry)],
			["auto-update", entry.autoUpdate ? pc.green("on") : pc.yellow("off")],
			["channel", entry.channel ?? "release"],
			["targets", entry.targets.join(",")],
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
		info(`run ${pc.cyan(`luna plugins update ${name}`)} to re-resolve, then deploy`);
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
					`${pc.cyan("luna plugins update")} after switching`,
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

/** Restart choice shared by group edits: now, a one-shot schedule, or nothing.
 *  Lives here beside the deploy helper; the group commands are in addons.ts. */
export async function applyGroupRestart(
	cfg: Awaited<ReturnType<typeof loadCluster>>,
	group: string,
	restart: string | undefined,
): Promise<void> {
	if (!restart || restart === "none") {
		info(`instances using ${pc.bold(group)} pick the change up on their next restart`);

		return;
	}

	const affected = groupInstances(cfg, group);

	if (restart === "now") {
		const inst = await import("../../client/core/instances");
		const statuses = await getAllStatuses(cfg);

		for (const name of affected) {
			if (statuses.find((status) => status.name === name)?.state === "stopped") {
				info(`${name} is stopped — leaving it down`);

				continue;
			}

			const spin = new Spinner().start(`restarting ${name}...`);

			await inst.stopInstance(cfg, name);
			await inst.startInstance(cfg, name);
			spin.stop();
			ok(`${pc.bold(name)} restarted`);
		}

		return;
	}

	// anything else is a time for a one-shot restart schedule
	const { loadSchedules, saveSchedules, createSchedule } = await import("../../client/core/schedule");
	const store = await loadSchedules();

	const schedule = createSchedule(cfg, store, {
		name: `group ${group} update reboot`,
		action: "restart",
		instances: affected,
		trigger: { kind: "at", at: new Date(restart).toISOString() },
	});

	await saveSchedules(store);
	ok(`restart scheduled ${pc.cyan(schedule.nextRun ?? "?")} for ${affected.join(", ")}`);
}

command({
	path: ["plugins", "validate"],
	desc: "How a group selection lands on an instance (OK / no version / skipped)",
	args: [{ name: "instance", required: true, complete: instanceNames }],
	opts: [{ flag: "--groups", desc: "extra groups beside default, comma-separated", value: true }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;
		const inst = managedInstances(cfg)[name];

		if (!inst) {
			throw new UsageError(`unknown instance: ${name}`);
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
				row.status + (row.downloadable ? pc.cyan(" (downloadable)") : ""),
				row.version ?? pc.dim("—"),
				pc.dim(row.groups.join(",")),
			]),
			{ head: ["", "plugin", "family", "status", "version", "groups"] },
		);

		console.log();

		const fetchable = rows.filter((row) => row.downloadable);

		if (fetchable.length) {
			info(`fetch compatible builds with: ${pc.cyan(`luna plugins fetch <plugin> --mc ${inst.mcVersion}`)}`);
		}
	},
});

command({
	path: ["plugins", "fetch"],
	desc: "Download a build compatible with an MC version into the pool",
	args: [{ name: "plugin", required: true, complete: pluginNames }],
	opts: [{ flag: "--mc", desc: "MC version the build must support", value: true }],

	handler: async (args, opts) => {
		const lock = await loadLock();
		const name = args[0]!;
		const mc = opts.mc as string | undefined;

		if (!mc) {
			throw new UsageError("--mc <version> is required");
		}

		const spin = new Spinner().start(`resolving ${name} for MC ${mc}...`);
		const result = await plugins.ensureVariantForMc(lock, name, mc);

		await saveLock(lock);
		spin.stop();

		if (result.downloaded) {
			ok(`${pc.bold(name)} ${pc.cyan(result.version)} pooled for MC ${mc}`);
		} else {
			info(`${pc.bold(name)} ${result.version} already covers MC ${mc}`);
		}
	},
});

command({
	path: ["plugins", "config"],
	desc: "Show a plugin's config template, or apply all templates to an instance",
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
				throw new UsageError(`unknown plugin entry: ${target}`);
			}

			if (!entry.config?.length) {
				info(`${target} has no config template`);

				return;
			}

			console.log(JSON.stringify(entry.config, null, 2));

			return;
		}

		if (what !== "apply") {
			throw new UsageError('expected "show <entry>" or "apply <instance>"');
		}

		const { applyTemplates, notableTemplateResults } = await import("../../client/core/templates");
		const results = await applyTemplates(cfg, lock, target);
		const notable = notableTemplateResults(results);

		if (!notable.length) {
			ok(`${target}: every templated value already in place (${results.length} checked)`);

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
	desc: "Force-add, disable or clear a plugin on one instance (wins over its groups)",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{
			name: "plugin",
			required: true,
			complete: async () => allPluginNames(await loadLock()),
		},
	],
	opts: [
		{ flag: "--enable", desc: "force-add the plugin, regardless of groups" },
		{ flag: "--disable", desc: "disable the plugin, even when a group provides it" },
		{ flag: "--clear", desc: "drop the override — groups decide again" },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const [instance, plugin] = args as [string, string];

		const picked = [opts.enable, opts.disable, opts.clear].filter(Boolean).length;

		if (picked !== 1) {
			throw new UsageError("pass exactly one of --enable, --disable or --clear");
		}

		const state = opts.enable ? true : opts.disable ? false : null;

		setPluginOverride(cfg, lock, instance, plugin, state);
		await saveCluster(cfg);

		// "wanted" must include explicit lockfile targets, not just groups/overrides —
		// clearing an override on an explicitly targeted plugin re-deploys it
		const wanted = entriesOf(lock, plugin).some((key) =>
			effectiveTargets(cfg, lock, key).includes(instance),
		);

		if (wanted) {
			ok(`${pc.bold(plugin)} ${state === null ? "override cleared" : "force-added"} on ${instance} — deploying`);
			await runDeploy([instance], undefined);

			return;
		}

		const removed = await removeInstanceJars(cfg, lock, instance, plugin);

		await saveLock(lock);

		if (state === null) {
			ok(`${pc.bold(plugin)} override cleared on ${instance}`);
		} else {
			ok(`${pc.bold(plugin)} disabled on ${instance}`);
		}

		if (removed.length) {
			info(`removed from ${instance}/plugins: ${removed.join(", ")} ${pc.dim("(a running server keeps it loaded until restart)")}`);
		}
	},
});

command({
	path: ["plugins", "state"],
	desc: "Runtime state of every plugin on an instance, with log warn/error counts",
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const instance = args[0]!;

		const spin = new Spinner().start(`reading ${instance}'s boot session...`);

		if (await ensureAliases(lock)) {
			await saveLock(lock);
		}

		const { rows, session } = await instancePluginReport(cfg, lock, instance);

		spin.stop();

		// "disabled" is the override, not a phase — it says why there is nothing to
		// report rather than what the log saw, so it is shown in place of the state
		const stateGlyph = (state: string, disabled: boolean): string =>
			disabled
				? pc.dim("disabled")
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
			{ head: ["plugin", "log name", "state", "version", "warn", "err", "from"] },
		);

		console.log();

		if (!session.complete) {
			warn("boot marker not found within the log-rotation window — load states past the window read as unknown");
		}

		const troubled = rows.filter((row) => row.state === "errored" || row.errors > 0);

		if (troubled.length) {
			warn(`${troubled.length} plugin(s) reported errors — inspect with: luna logs ${instance}`);
		}
	},
});

command({
	path: ["plugins", "standardize"],
	desc: "Migrate every entry to the <plugin>@<family> naming scheme (pool, lockfile, ports, instances)",
	opts: [{ flag: "--yes", desc: "skip the confirmation" }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();

		if (!opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");

			const sure = await confirm({
				message:
					"Rename pool jars + lockfile keys + port allocations, redeploy everywhere and " +
					"remove the old-name jars?",
			});

			if (isCancel(sure) || !sure) {
				throw new Bail("aborted");
			}
		}

		const spin = new Spinner().start("standardizing plugin naming...");
		const report = await standardizeNaming(cfg, lock);

		await saveCluster(cfg);
		await saveLock(lock);
		spin.stop();

		for (const step of report.renamed) {
			ok(`${step.oldKey} ${Sym.arrow} ${pc.bold(step.newKey)}`);
		}

		for (const port of report.portKeys) {
			info(`port allocation ${port}`);
		}

		for (const member of report.groupMembers) {
			info(`group member ${member}`);
		}

		info(`${report.deployed} deploy change(s), ${report.removed.length} old jar(s) removed`);

		if (report.mismatches.length) {
			for (const mismatch of report.mismatches) {
				warn(`PARITY MISMATCH — ${mismatch}`);
			}
		} else {
			ok("parity verified: every instance runs the same plugin set as before");
		}
	},
});

command({
	path: ["plugins", "identify"],
	desc: "Map an existing plugin/mod to a provider project (so updates apply)",
	args: [
		{ name: "plugin", required: true, complete: pluginNames },
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
		const lock = await loadLock();
		const name = args[0]!;
		const provider = parseProvider(opts.provider as string | undefined);

		const spin = new Spinner().start(`identifying ${name} at ${provider}…`);
		const probe = await plugins.probePluginIdentity(lock, name, provider, args[1]!);

		spin.stop();
		info(`local file: ${pc.dim(probe.local.file)}`);
		printProbe(probe);

		// mapping an unproven file is the operator's judgement, never a default:
		// the recorded version is what the downgrade guard compares against
		if (probe.confidence !== "exact" && !opts.version && !opts.unidentified && !opts.yes) {
			throw new Bail(
				"nothing proved which version this is — re-run with --version <id>, --unidentified, or --yes",
			);
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
				`${match ? pc.green(match.versionNumber) : pc.dim("version unknown")}, ` +
				`auto-update ${entry.autoUpdate ? pc.green("on") : pc.dim("off")}`,
		);
		info(`check it with: luna plugins check ${name}`);
	},
});

command({
	path: ["plugins", "forget"],
	desc: "Drop a plugin's provider mapping (keeps the jar and its deployments)",
	args: [{ name: "plugin", required: true, complete: pluginNames }],

	handler: async (args) => {
		const lock = await loadLock();

		await plugins.forgetPluginIdentity(lock, args[0]!);
		await saveLock(lock);

		ok(`${pc.bold(args[0]!)} is no longer mapped to a provider — updates will not be checked`);
	},
});
