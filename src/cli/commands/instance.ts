// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { command, UsageError, Bail } from "../framework";
import { pc, Sym, ok, warn, info, printTable, fmtDuration, Spinner, ProgressView } from "../ui";
import { instanceNames, runtimeIds } from "../completers";
import { loadCluster, saveCluster, managedInstances, loadLock, saveLock } from "../../client/core/config";
import type { ClusterConfig } from "../../client/core/types";
import * as inst from "../../client/core/instances";
import * as lifecycle from "../../client/core/lifecycle";
import * as admin from "../../client/core/admin";
import * as screen from "../../client/core/screen";
import { syncVelocityToml } from "../../client/core/proxy";
import { ensurePortAllocations } from "../../client/core/ports";
import { validateRuntimeId } from "../../client/core/runtimes";
import { deploy, compatReport } from "../../client/core/plugins";
import { listVersions } from "../../client/core/services/papermc";
import { ProgressReporter } from "../../client/core/progress";
import { loadPacksLock, savePacksLock } from "../../client/core/packslock";
import * as addons from "../../client/core/addons";
import { applyAddonGroups } from "../../client/core/addons";
import {
	SERVER_SETTINGS,
	SETTING_GROUPS,
	applySettings,
	editableSettingKeys,
	parseJavaArgs,
	readServerProperties,
	settingSpec,
} from "../../client/core/settings";
import { t } from "../../shared/i18n";

/** Coloured state glyph + label for a status table row. */
function stateCell(status: inst.InstanceStatus): string {
	switch (status.state) {
		case "running":
			return `${Sym.ok} ${pc.green(t("cli.instance.stateRunning"))}`;

		case "starting":
			return `${Sym.warn} ${pc.yellow(t("cli.instance.stateStarting"))}`;

		case "auto-restarting":
			return `${Sym.warn} ${pc.yellow(t("cli.instance.stateAutoRestarting"))}`;

		case "stopped":
			return `${Sym.off} ${pc.dim(t("cli.instance.stateStopped"))}`;

		case "unknown":
			return `${Sym.warn} ${pc.yellow(t("cli.instance.stateUnknown"))}`;
	}
}

/**
 * Resolve the instance list a lifecycle command should act on: either every
 * managed instance in dependency order, or the explicitly named ones.
 */
async function resolveNames(
	namesArg: string[],
	all: boolean,
	mode: "start" | "stop",
): Promise<{ cfg: ClusterConfig; names: string[] }> {
	const cfg = await loadCluster();

	if (all) {
		return { cfg, names: inst.orderedNames(cfg, mode) };
	}

	if (namesArg.length === 0) {
		throw new UsageError(t("cli.instance.namesOrAll"));
	}

	for (const name of namesArg) {
		if (!managedInstances(cfg)[name]) {
			throw new UsageError(t("cli.env.unknownInstance", { name }));
		}
	}

	return { cfg, names: namesArg };
}

command({
	path: ["status"],
	desc: t("cli.instance.status.desc"),
	args: [{ name: "instance", complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const spin = new Spinner().start(t("cli.instance.status.querying"));

		const statuses = args[0]
			? [await inst.getStatus(cfg, args[0])]
			: await inst.getAllStatuses(cfg);

		spin.stop();

		// the proxy always heads the list, backends follow alphabetically
		const sorted = statuses.sort((a, b) => {
			if (a.name === "proxy") {
				return -1;
			}

			if (b.name === "proxy") {
				return 1;
			}

			return a.name.localeCompare(b.name);
		});

		const rows = sorted.map((status) => [
			stateCell(status),
			pc.bold(status.name),
			status.inst.software + (status.inst.mcVersion ? pc.dim(` ${status.inst.mcVersion}`) : ""),
			pc.dim(`:${status.inst.port}`),
			status.inst.memory,
			status.uptimeMs !== undefined ? fmtDuration(status.uptimeMs) : pc.dim("—"),
			status.players
				? t("cli.instance.status.playersOnline", {
						online: status.players.online,
						max: status.players.max,
					})
				: pc.dim("—"),
		]);

		console.log();
		printTable(rows, {
			head: [
				"",
				t("cli.head.instance"),
				t("cli.head.software"),
				t("cli.head.port"),
				t("cli.head.mem"),
				t("cli.head.uptime"),
				t("cli.head.players"),
			],
		});

		const externals = Object.entries(cfg.instances).filter(([, entry]) => entry.external);

		if (externals.length && !args[0]) {
			console.log();

			printTable(
				externals.map(([name, entry]) => [
					Sym.dot,
					pc.dim(name),
					pc.dim(t("cli.instance.status.external")),
					pc.dim(entry.external!),
				]),
			);
		}

		console.log();
	},
});

command({
	path: ["start"],
	desc: t("cli.instance.start.desc"),
	args: [{ name: "instance", variadic: true, complete: instanceNames }],
	opts: [{ flag: "--all", desc: t("cli.instance.start.optAll") }],

	handler: async (args, opts) => {
		const { cfg, names } = await resolveNames(args, !!opts.all, "start");

		for (const name of names) {
			const progress = new ProgressReporter(`start ${name}`);
			const view = new ProgressView(progress).start();

			try {
				const res = await lifecycle.startInstanceTracked(cfg, name, progress);

				view.stop();

				if (res.outcome === "started") {
					ok(
						`${t("cli.instance.start.started", {
							name: pc.bold(name),
							session: pc.cyan(inst.sessionName(cfg, name)),
						})} ${pc.dim(`(${fmtDuration(res.tookMs)})`)}`,
					);
				} else {
					info(t("cli.instance.start.alreadyRunning", { name: pc.bold(name) }));
				}
			} catch (err) {
				view.stop();

				throw err;
			}
		}
	},
});

command({
	path: ["stop"],
	desc: t("cli.instance.stop.desc"),
	args: [{ name: "instance", variadic: true, complete: instanceNames }],
	opts: [{ flag: "--all", desc: t("cli.instance.stop.optAll") }],

	handler: async (args, opts) => {
		const { cfg, names } = await resolveNames(args, !!opts.all, "stop");

		for (const name of names) {
			const progress = new ProgressReporter(`stop ${name}`);
			const view = new ProgressView(progress).start();

			try {
				const res = await lifecycle.stopInstanceTracked(cfg, name, progress);

				view.stop();

				if (res.outcome === "stopped") {
					ok(
						`${t("cli.instance.stop.stopped", { name: pc.bold(name) })} ${pc.dim(`(${fmtDuration(res.tookMs)})`)}`,
					);
				} else if (res.outcome === "forced") {
					warn(t("cli.instance.stop.forced", { name }));
				} else {
					info(t("cli.instance.stop.notRunning", { name: pc.bold(name) }));
				}
			} catch (err) {
				view.stop();

				throw err;
			}
		}
	},
});

command({
	path: ["restart"],
	desc: t("cli.instance.restart.desc"),
	args: [{ name: "instance", variadic: true, complete: instanceNames }],
	opts: [{ flag: "--all", desc: t("cli.instance.restart.optAll") }],

	handler: async (args, opts) => {
		const { cfg, names } = await resolveNames(args, !!opts.all, "stop");

		for (const name of names) {
			const progress = new ProgressReporter(`restart ${name}`);
			const view = new ProgressView(progress).start();

			try {
				await lifecycle.restartInstanceTracked(cfg, name, progress);

				view.stop();
				ok(t("cli.instance.restart.restarted", { name: pc.bold(name) }));
			} catch (err) {
				view.stop();

				throw err;
			}
		}
	},
});

command({
	path: ["console"],
	desc: t("cli.instance.console.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const name = args[0]!;

		if (!managedInstances(cfg)[name]) {
			throw new UsageError(t("cli.env.unknownInstance", { name }));
		}

		const session = inst.sessionName(cfg, name);

		if (!(await screen.sessionExists(session))) {
			throw new Bail(t("cli.instance.notRunning", { name }));
		}

		info(
			t("cli.instance.console.attaching", {
				session: pc.cyan(session),
				keys: pc.bold("Ctrl+A D"),
			}),
		);
		await screen.attach(session);
	},
});

command({
	path: ["send"],
	desc: t("cli.instance.send.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "command", required: true, variadic: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const [name, ...cmd] = args as [string, ...string[]];

		if (!(await inst.sendCommand(cfg, name, cmd.join(" ")))) {
			throw new Bail(t("cli.instance.notRunning", { name }));
		}

		ok(
			t("cli.instance.send.sent", {
				command: pc.cyan(cmd.join(" ")),
				name: pc.bold(name),
			}),
		);
	},
});

/** Parse `--set key=value,key2=value2` into a settings map. */
function parseSettingPairs(text: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};

	if (!text) {
		return out;
	}

	for (const pair of text.split(",")) {
		const eq = pair.indexOf("=");

		if (eq === -1) {
			throw new UsageError(t("cli.instance.create.badSetPair", { pair }));
		}

		out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
	}

	return out;
}

command({
	path: ["instance", "create"],
	desc: t("cli.instance.create.desc"),
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--version", desc: t("cli.instance.create.optVersion"), value: true },
		{ flag: "--port", desc: t("cli.instance.create.optPort"), value: true },
		{ flag: "--memory", desc: t("cli.instance.create.optMemory"), value: true },
		{ flag: "--profile", desc: t("cli.instance.create.optProfile"), value: true },
		{ flag: "--set", desc: t("cli.instance.create.optSet"), value: true },
		{ flag: "--java-args", desc: t("cli.instance.create.optJavaArgs"), value: true },
		{
			flag: "--runtime",
			desc: t("cli.instance.create.optRuntime"),
			value: true,
			complete: runtimeIds,
		},
		{ flag: "--groups", desc: t("cli.instance.create.optGroups"), value: true },
		{ flag: "--no-register", desc: t("cli.instance.create.optNoRegister") },
		{ flag: "--daemon", desc: t("cli.instance.create.optDaemon"), value: true },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;
		const settings = parseSettingPairs(opts.set as string | undefined);
		const javaArgs = parseJavaArgs((opts["java-args"] as string) ?? "");

		const groups = opts.groups
			? String(opts.groups)
					.split(",")
					.map((entry) => entry.trim())
					.filter(Boolean)
			: undefined;

		for (const group of groups ?? []) {
			if (!lock.groups?.[group]) {
				throw new UsageError(t("cli.instance.create.unknownGroup", { name: group }));
			}
		}

		let version = opts.version as string | undefined;

		if (!version) {
			const spin = new Spinner().start(t("cli.instance.create.resolvingVersion"));

			// plain x.y / x.y.z only; the list also carries snapshots and pre-releases
			const versions = await listVersions("paper");

			version = versions
				.filter((candidate) => /^\d+\.\d+(\.\d+)?$/.test(candidate))
				.sort()
				.at(-1)!;

			spin.stop();
		}

		// one node per phase, weighted by how long each actually takes, so the
		// roll-up moves at a believable rate (the jar download dominates)
		const progress = new ProgressReporter(`create ${name}`).weighOwn(0);
		const files = progress.child(t("cli.instance.create.phaseFiles"), 6);
		const plugins = progress.child(t("cli.instance.create.phasePlugins"), 2);
		const packs = progress.child(t("cli.instance.create.phasePacks"), 1);
		const ports = progress.child(t("cli.instance.create.phasePorts"), 1);
		const proxy = progress.child(t("cli.instance.create.phaseProxy"), 1);

		const view = new ProgressView(progress).start();

		try {
			const res = await admin.createInstance(cfg, name, {
				mcVersion: version,
				port: opts.port ? parseInt(opts.port as string) : undefined,
				memory: opts.memory as string | undefined,
				profile: opts.profile as string | undefined,
				register: !opts["no-register"],
				settings,
				javaArgs,
				runtime: opts.runtime as string | undefined,
				addonGroups: groups,
				daemon: opts.daemon as string | undefined,
				reporter: files,
			});

			await saveCluster(cfg);

			const deployed = await plugins.task(
				{
					start: t("cli.instance.create.deployingPlugins"),
					done: t("cli.instance.create.pluginsDeployed"),
				},
				(step) => deploy(cfg, lock, { instances: [name], reporter: step }),
			);

			plugins.complete(t("cli.instance.create.pluginCount", { count: deployed.length }));

			// the group's other kinds: pack rules for the proxy, data packs for the world
			await packs.task({ start: t("cli.instance.create.applyingPacks") }, async (step) => {
				const packsLock = await loadPacksLock();
				const applied = await applyAddonGroups(cfg, packsLock, lock.groups, {
					instances: [name],
				});

				await savePacksLock(packsLock);

				const installed = applied.datapacks.filter(
					(action) => action.action !== "unchanged",
				).length;

				step.report(
					1,
					"okay",
					applied.respacks.length || installed
						? t("cli.instance.create.packCounts", {
								rules: applied.respacks.length,
								datapacks: installed,
							})
						: t("cli.instance.create.noPacks"),
				);
			});

			await ports.task(
				{
					start: t("cli.instance.create.allocatingPorts"),
					done: t("cli.instance.create.portsAllocated"),
				},
				async () => {
					await ensurePortAllocations(cfg, lock);
					await saveCluster(cfg);
					await saveLock(lock);
				},
			);

			if (opts["no-register"]) {
				proxy.complete(t("cli.instance.create.registerSkipped"));
			} else {
				await proxy.task({ start: t("cli.instance.create.registering") }, async (step) => {
					const sync = await syncVelocityToml(cfg);

					step.report(
						1,
						"okay",
						sync.changed
							? t("cli.instance.create.velocityUpdated")
							: t("cli.instance.create.velocityUpToDate"),
					);
				});
			}

			view.stop();

			ok(
				t("cli.instance.create.created", {
					name: pc.bold(name),
					version: version,
					build: res.build.build,
					port: pc.cyan(String(res.port)),
				}),
			);

			if (javaArgs.length) {
				info(t("cli.instance.create.jvmFlags", { flags: pc.cyan(javaArgs.join(" ")) }));
			}

			info(t("cli.instance.startHint", { command: pc.cyan(`luna start ${name}`) }));
		} catch (err) {
			view.stop();

			throw err;
		}
	},
});

/**
 * Account for the addons an instance already holds, and print the outcome.
 *
 * Everything the server brought stays where it is; only files that are already
 * in the pool (same bytes, or the standardized pool file name) are registered
 * as deployments of that addon. Shared by `instance adopt` (which runs it once,
 * on registration) and `instance adopt-addons` (which re-runs it after the pool
 * has grown).
 */
async function adoptAddons(cfg: ClusterConfig, name: string): Promise<void> {
	const lock = await loadLock();
	const packs = await loadPacksLock();
	const adoption = await addons.adoptInstanceAddons(cfg, lock, packs, name);
	const registered = addons.applyAddonAdoption(cfg, lock, packs, name, adoption);

	if (registered.length) {
		await saveLock(lock);
		await savePacksLock(packs);
	}

	if (adoption.adopted.length) {
		ok(
			t("cli.instance.adopt.recognised", { count: adoption.adopted.length }) +
				(registered.length
					? t("cli.instance.adopt.newlyRegistered", { count: registered.length })
					: ` ${t("cli.instance.adopt.alreadyRegistered")}`),
		);

		for (const item of adoption.adopted) {
			const renamed = item.renamedTo ? pc.dim(` → ${item.renamedTo}`) : "";
			const pinned = item.version ? pc.yellow(` @${item.version}`) : "";

			console.log(`    ${Sym.check} ${item.file}${renamed} ${pc.dim(item.addon)}${pinned}`);
		}
	}

	if (adoption.unmanaged.length) {
		info(t("cli.instance.adopt.unmanaged", { count: adoption.unmanaged.length }));

		for (const item of adoption.unmanaged.slice(0, 10)) {
			console.log(`    ${pc.dim(item.path)}`);
		}

		if (adoption.unmanaged.length > 10) {
			console.log(pc.dim(`    ${t("cli.instance.adopt.andMore", { count: adoption.unmanaged.length - 10 })}`));
		}
	}
}

command({
	path: ["instance", "adopt-addons"],
	desc: t("cli.instance.adoptAddons.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const name = args[0]!;

		if (!managedInstances(cfg)[name]) {
			throw new UsageError(t("cli.env.unknownInstance", { name }));
		}

		await adoptAddons(cfg, name);
	},
});

command({
	path: ["instance", "adopt"],
	desc: t("cli.instance.adopt.desc"),
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--daemon", desc: t("cli.instance.adopt.optDaemon"), value: true },
		{ flag: "--dir", desc: t("cli.instance.adopt.optDir"), value: true },
		{ flag: "--port", desc: t("cli.instance.adopt.optPort"), value: true },
		{ flag: "--memory", desc: t("cli.instance.adopt.optMemory"), value: true },
		{ flag: "--profile", desc: t("cli.instance.create.optProfile"), value: true },
		{ flag: "--java", desc: t("cli.instance.adopt.optJava"), value: true },
		{ flag: "--java-args", desc: t("cli.instance.create.optJavaArgs"), value: true },
		{ flag: "--no-register", desc: t("cli.instance.create.optNoRegister") },
		{ flag: "--dry-run", desc: t("cli.instance.adopt.optDryRun") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const name = args[0]!;
		const daemon = opts.daemon as string | undefined;
		const dir = (opts.dir as string | undefined) ?? cfg.instances[name]?.dir ?? name;

		if (daemon && !cfg.daemons?.[daemon]) {
			throw new UsageError(t("cli.instance.adopt.unknownDaemon", { name: daemon }));
		}

		if (opts["dry-run"]) {
			// a bare name resolves against the executing daemon's own cluster root
			const detected = await admin.inspectInstanceDir(dir, daemon);

			printTable(
				[
					[t("cli.head.software"), detected.software],
					[t("cli.instance.adopt.mcVersion"), detected.mcVersion ?? pc.dim("—")],
					[t("cli.instance.adopt.loader"), detected.loaderVersion ?? pc.dim("—")],
					[t("cli.head.port"), detected.port !== undefined ? String(detected.port) : pc.dim("—")],
					[t("cli.head.mem"), detected.memory ?? pc.dim("—")],
					[
						t("cli.instance.adopt.bindAddress"),
						detected.bindAddress || pc.dim(t("cli.instance.adopt.emptyValue")),
					],
				],
				{ head: ["", `${daemon ?? t("cli.instance.adopt.localDaemon")}:${dir}`] },
			);

			return;
		}

		const javaArgs = parseJavaArgs((opts["java-args"] as string) ?? "");

		const result = await admin.adoptInstance(cfg, name, {
			dir,
			port: opts.port ? parseInt(opts.port as string) : undefined,
			memory: opts.memory as string | undefined,
			profile: opts.profile as string | undefined,
			java: opts.java as string | undefined,
			javaArgs,
			register: !opts["no-register"],
			daemon,
		});

		await saveCluster(cfg);

		const sync = await syncVelocityToml(cfg);
		const version = result.inst.mcVersion ? ` ${result.inst.mcVersion}` : "";
		const loader = result.inst.loaderVersion
			? pc.dim(` (${t("cli.instance.adopt.loaderTag", { version: result.inst.loaderVersion })})`)
			: "";

		ok(
			t("cli.instance.adopt.adopted", {
				name: pc.bold(name),
				software: `${result.inst.software}${version}${loader}`,
				port: pc.cyan(String(result.inst.port)),
				memory: result.inst.memory,
			}) + (daemon ? ` ${t("cli.instance.adopt.onDaemon", { name: pc.cyan(daemon) })}` : ""),
		);

		for (const note of result.notes) {
			warn(note);
		}

		// what the server brought with it: recognised addons join the pool's
		// targets, everything else is reported and left exactly where it is
		await adoptAddons(cfg, name);

		if (sync.changed) {
			info(t("cli.instance.adopt.velocityUpdated"));
		}

		info(t("cli.instance.startHint", { command: pc.cyan(`luna start ${name}`) }));
	},
});

command({
	path: ["instance", "set-version"],
	desc: t("cli.instance.setVersion.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "version", required: true },
	],
	opts: [{ flag: "--force", desc: t("cli.instance.setVersion.optForce") }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const [name, version] = args as [string, string];
		const status = await inst.getStatus(cfg, name);

		if (status.state !== "stopped") {
			throw new Bail(t("cli.instance.stopFirst", { name }));
		}

		// Server-version requirement gate: check assigned plugin builds first.
		const report = compatReport(cfg, lock, name, version);
		const bad = report.filter((row) => row.status === "incompatible");
		const unknown = report.filter((row) => row.status === "unknown");

		if (bad.length) {
			for (const row of bad) {
				warn(
					t("cli.instance.setVersion.incompatible", {
						plugin: `${row.plugin} ${row.version ?? ""}`,
						mc: version,
						supported: row.gameVersions?.join(", ") ?? "",
					}),
				);
			}

			if (!opts.force) {
				throw new Bail(t("cli.instance.setVersion.abortIncompatible", { count: bad.length, mc: version }));
			}
		}

		if (unknown.length) {
			info(t("cli.instance.setVersion.unknownReqs", { count: unknown.length }));
		}

		const spin = new Spinner().start(t("cli.instance.setVersion.downloading", { version }));
		const res = await admin.setVersion(cfg, name, version);

		await saveCluster(cfg);
		spin.stop();

		ok(
			`${pc.bold(name)}: ${pc.dim(res.from ?? "?")} ${Sym.arrow} ${pc.green(res.to)} ` +
				`(build ${res.build.build})`,
		);

		info(t("cli.instance.setVersion.jarKept", { path: pc.dim(res.backedUpJar) }));
		info(t("cli.instance.setVersion.updateHint", { command: pc.cyan("luna plugins update --deploy") }));
	},
});

command({
	path: ["instance", "settings"],
	desc: t("cli.instance.settings.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "key", complete: async () => editableSettingKeys() },
		{ name: "value", variadic: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const [name, key, ...rest] = args as [string, string?, ...string[]];

		if (!managedInstances(cfg)[name]) {
			throw new UsageError(t("cli.env.unknownInstance", { name }));
		}

		const current = await readServerProperties(cfg, name);

		if (!key) {
			for (const group of SETTING_GROUPS) {
				const specs = SERVER_SETTINGS.filter((spec) => spec.group === group.id);

				console.log(`\n  ${pc.bold(pc.cyan(t(group.label)))} ${pc.dim(t(group.hint))}`);

				printTable(
					specs.map((spec) => [
						spec.managed ? pc.dim(spec.key) : spec.key,
						current[spec.key] === undefined
							? pc.dim(t("cli.instance.settings.defaultValue", { value: spec.fallback }))
							: pc.bold(current[spec.key] || pc.dim(t("cli.instance.settings.blank"))),
						spec.managed ? pc.dim(t("cli.instance.settings.managedByLuna")) : pc.dim(spec.hint ? t(spec.hint) : ""),
					]),
					{ indent: "    " },
				);
			}

			console.log();

			return;
		}

		const spec = settingSpec(key);

		if (!spec) {
			throw new UsageError(t("cli.instance.settings.unknownKey", { key, name }));
		}

		// a value may legitimately contain spaces (motd), so the rest of argv is it
		if (rest.length === 0) {
			console.log(current[key] ?? spec.fallback);

			return;
		}

		const value = rest.join(" ");
		const res = await applySettings(cfg, name, { [key]: value });

		for (const problem of res.rejected) {
			throw new Bail(problem.error);
		}

		if (res.unchanged.length) {
			info(t("cli.instance.settings.already", { name, key, value: pc.cyan(value) }));

			return;
		}

		const change = res.changed[0]!;
		const note = change.appended ? pc.dim(` ${t("cli.instance.settings.keyAdded")}`) : "";

		ok(
			`${name}.${key}: ${pc.dim(change.from ?? t("cli.instance.settings.unset"))} ${Sym.arrow} ${pc.cyan(change.to)}` +
				`${note} ${pc.dim(t("cli.instance.settings.appliesOnRestart"))}`,
		);
	},
});

/** Settings stored in the registry rather than in server.properties. */
const REGISTRY_KEYS = [
	"memory",
	"profile",
	"java",
	"runtime",
	"javaArgs",
	"autoRestart",
	"restartDelay",
	"port",
];

command({
	path: ["instance", "config"],
	desc: t("cli.instance.config.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "key", complete: async () => [...REGISTRY_KEYS, ...editableSettingKeys()] },
		{ name: "value", variadic: true },
	],
	opts: [{ flag: "--clear", desc: t("cli.instance.config.optClear") }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const [name, key, ...rest] = args as [string, string?, ...string[]];
		const instance = managedInstances(cfg)[name];

		if (!instance) {
			throw new UsageError(t("cli.env.unknownInstance", { name }));
		}

		// an empty value cannot travel through argv, so unpinning an optional field
		// is its own flag rather than a magic value the shell would eat
		if (opts.clear) {
			if (!key) {
				throw new UsageError(t("cli.instance.config.clearNeedsKey"));
			}

			switch (key) {
				case "java":
					delete instance.java;
					break;

				case "runtime":
					delete instance.runtime;
					break;

				case "javaArgs":
					delete instance.javaArgs;
					break;

				case "autoRestart":
					delete instance.autoRestart;
					break;

				case "restartDelay":
					delete instance.restartDelay;
					break;

				default:
					throw new UsageError(t("cli.instance.config.notClearable", { key }));
			}

			await saveCluster(cfg);
			ok(t("cli.instance.config.cleared", { name: pc.bold(name), key: pc.bold(key) }));

			return;
		}

		if (!key) {
			printTable([
				["memory", instance.memory],
				["profile", instance.profile],
				["port", String(instance.port)],
				["java", instance.java ?? pc.dim(t("cli.instance.config.profileDefault"))],
				["runtime", instance.runtime ?? pc.dim(t("cli.instance.config.profileDefault"))],
				["javaArgs", instance.javaArgs?.join(" ") ?? pc.dim(`(${t("cli.common.none")})`)],
				[
					"autoRestart",
					inst.autoRestartOf(instance)
						? t("cli.instance.config.on")
						: pc.dim(t("cli.instance.config.off")),
				],
				["restartDelay", `${inst.restartDelayOf(instance)}s`],
				["mcVersion", instance.mcVersion ?? pc.dim("—")],
				...Object.entries(instance.ports ?? {}).map(([id, port]) => [
					`port:${id}`,
					String(port),
				]),
			]);

			info(
				t("cli.instance.config.settingsHint", {
					command: pc.cyan(`luna instance settings ${name}`),
				}),
			);

			return;
		}

		// a value can contain spaces (javaArgs, motd), so the rest of argv is the value
		const value = rest.join(" ");

		if (rest.length === 0) {
			const builtin: Record<string, string | undefined> = {
				memory: instance.memory,
				profile: instance.profile,
				port: String(instance.port),
				java: instance.java,
				runtime: instance.runtime,
				javaArgs: instance.javaArgs?.join(" "),
				autoRestart: inst.autoRestartOf(instance) ? "true" : "false",
				restartDelay: String(inst.restartDelayOf(instance)),
			};

			if (key in builtin) {
				console.log(builtin[key] ?? "");

				return;
			}

			console.log((await admin.getServerProperty(cfg, name, key)) ?? "");

			return;
		}

		switch (key) {
			case "memory":
				instance.memory = value;
				break;

			case "profile":
				if (!cfg.javaProfiles[value]) {
					throw new UsageError(t("cli.instance.config.unknownProfile", { name: value }));
				}

				instance.profile = value;
				break;

			case "java":
				instance.java = value;
				break;

			case "runtime": {
				const bad = validateRuntimeId(value);

				if (bad) {
					throw new UsageError(bad);
				}

				instance.runtime = value;
				break;
			}

			case "javaArgs":
				admin.setJavaArgs(cfg, name, parseJavaArgs(value));
				break;

			case "autoRestart": {
				const on = /^(true|on|yes|1)$/i.test(value);

				if (!on && !/^(false|off|no|0)$/i.test(value)) {
					throw new UsageError(t("cli.instance.config.notABoolean", { value }));
				}

				// only stored when it departs from the default, so an untouched
				// instance keeps the registry entry it has always had
				instance.autoRestart = on ? undefined : false;
				break;
			}

			case "restartDelay": {
				const seconds = Number.parseInt(value, 10);
				const bad = inst.validateRestartDelay(seconds);

				if (bad) {
					throw new UsageError(bad);
				}

				instance.restartDelay = seconds === inst.DEFAULT_RESTART_DELAY ? undefined : seconds;
				break;
			}

			case "port": {
				await admin.setPort(cfg, name, parseInt(value));

				const sync = await syncVelocityToml(cfg);

				if (sync.changed) {
					ok(t("cli.proxy.sync.updated"));
				}

				break;
			}

			default: {
				// known settings go through the schema (validated, and added to the file
				// when Paper has not written the key yet); anything else is set verbatim
				if (settingSpec(key)) {
					const res = await applySettings(cfg, name, { [key]: value });

					for (const problem of res.rejected) {
						throw new Bail(problem.error);
					}

					break;
				}

				if (!(await admin.setServerProperty(cfg, name, key, value))) {
					throw new Bail(t("cli.instance.config.keyNotFound", { key }));
				}
			}
		}

		await saveCluster(cfg);

		const note = REGISTRY_KEYS.includes(key)
			? pc.dim(` ${t("cli.instance.config.appliesOnRestart")}`)
			: "";

		ok(`${name}.${key} = ${pc.cyan(value)}${note}`);
	},
});

command({
	path: ["instance", "delete"],
	desc: t("cli.instance.remove.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames }],
	opts: [
		{ flag: "--purge", desc: t("cli.instance.remove.optPurge") },
		{ flag: "--yes", desc: t("cli.common.optYes") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const name = args[0]!;

		if (!cfg.instances[name]) {
			throw new UsageError(t("cli.env.unknownInstance", { name }));
		}

		// external instances run elsewhere, so there is no local state to probe
		const status = cfg.instances[name]!.external
			? undefined
			: await inst.getStatus(cfg, name);

		if (status && status.state !== "stopped") {
			throw new Bail(t("cli.instance.stopFirst", { name }));
		}

		if (opts.purge && !opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const sure = await confirm({
				message: t("cli.instance.remove.confirmPurge", { name }),
			});

			if (isCancel(sure) || !sure) {
				info(t("cli.common.aborted"));

				return;
			}
		}

		const progress = new ProgressReporter(`delete ${name}`);
		const view = new ProgressView(progress).start();

		try {
			await admin.deleteInstance(cfg, name, !!opts.purge, progress);
		} finally {
			view.stop();
		}

		await saveCluster(cfg);

		const sync = await syncVelocityToml(cfg);
		const purged = opts.purge
			? ` ${t("cli.instance.remove.andPurged")}`
			: ` ${pc.dim(t("cli.instance.remove.directoryKept"))}`;
		const proxyNote = sync.changed ? `, ${t("cli.instance.remove.velocityUpdated")}` : "";

		ok(`${t("cli.instance.remove.deregistered", { name: pc.bold(name) })}${purged}${proxyNote}`);
	},
});
