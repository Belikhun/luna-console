import { command, UsageError, Bail } from "../framework";
import { pc, Sym, ok, warn, info, printTable, fmtDuration, Spinner, ProgressView } from "../ui";
import { instanceNames } from "../completers";
import { loadCluster, saveCluster, managedInstances, loadLock, saveLock } from "../../client/core/config";
import type { ClusterConfig } from "../../client/core/types";
import * as inst from "../../client/core/instances";
import * as lifecycle from "../../client/core/lifecycle";
import * as admin from "../../client/core/admin";
import * as screen from "../../client/core/screen";
import { syncVelocityToml } from "../../client/core/proxy";
import { ensurePortAllocations } from "../../client/core/ports";
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

/** Coloured state glyph + label for a status table row. */
function stateCell(status: inst.InstanceStatus): string {
	switch (status.state) {
		case "running":
			return `${Sym.ok} ${pc.green("running")}`;

		case "starting":
			return `${Sym.warn} ${pc.yellow("starting")}`;

		case "stopped":
			return `${Sym.off} ${pc.dim("stopped")}`;

		case "unknown":
			return `${Sym.warn} ${pc.yellow("unknown")}`;
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
		throw new UsageError("give instance name(s) or --all");
	}

	for (const name of namesArg) {
		if (!managedInstances(cfg)[name]) {
			throw new UsageError(`unknown instance: ${name}`);
		}
	}

	return { cfg, names: namesArg };
}

command({
	path: ["status"],
	desc: "Show status of all instances (or one)",
	args: [{ name: "instance", complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const spin = new Spinner().start("querying instances...");

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
			status.players ? `${status.players.online}/${status.players.max} online` : pc.dim("—"),
		]);

		console.log();
		printTable(rows, { head: ["", "instance", "software", "port", "mem", "uptime", "players"] });

		const externals = Object.entries(cfg.instances).filter(([, entry]) => entry.external);

		if (externals.length && !args[0]) {
			console.log();

			printTable(
				externals.map(([name, entry]) => [
					Sym.dot,
					pc.dim(name),
					pc.dim("external"),
					pc.dim(entry.external!),
				]),
			);
		}

		console.log();
	},
});

command({
	path: ["start"],
	desc: "Start instance(s), or --all (proxy first)",
	args: [{ name: "instance", variadic: true, complete: instanceNames }],
	opts: [{ flag: "--all", desc: "start every managed instance" }],

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
						`${pc.bold(name)} started in screen ${pc.cyan(inst.sessionName(cfg, name))} ` +
							pc.dim(`(${fmtDuration(res.tookMs)})`),
					);
				} else {
					info(`${pc.bold(name)} already running`);
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
	desc: "Gracefully stop instance(s), or --all (proxy last)",
	args: [{ name: "instance", variadic: true, complete: instanceNames }],
	opts: [{ flag: "--all", desc: "stop every managed instance" }],

	handler: async (args, opts) => {
		const { cfg, names } = await resolveNames(args, !!opts.all, "stop");

		for (const name of names) {
			const progress = new ProgressReporter(`stop ${name}`);
			const view = new ProgressView(progress).start();

			try {
				const res = await lifecycle.stopInstanceTracked(cfg, name, progress);

				view.stop();

				if (res.outcome === "stopped") {
					ok(`${pc.bold(name)} stopped ${pc.dim(`(${fmtDuration(res.tookMs)})`)}`);
				} else if (res.outcome === "forced") {
					warn(`${name}: graceful stop timed out, sent SIGTERM`);
				} else {
					info(`${pc.bold(name)} not running`);
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
	desc: "Restart instance(s), or --all",
	args: [{ name: "instance", variadic: true, complete: instanceNames }],
	opts: [{ flag: "--all", desc: "restart every managed instance" }],

	handler: async (args, opts) => {
		const { cfg, names } = await resolveNames(args, !!opts.all, "stop");

		for (const name of names) {
			const progress = new ProgressReporter(`restart ${name}`);
			const view = new ProgressView(progress).start();

			try {
				await lifecycle.restartInstanceTracked(cfg, name, progress);

				view.stop();
				ok(`${pc.bold(name)} restarted`);
			} catch (err) {
				view.stop();

				throw err;
			}
		}
	},
});

command({
	path: ["console"],
	desc: "Attach to an instance console (detach: Ctrl+A then D)",
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const name = args[0]!;

		if (!managedInstances(cfg)[name]) {
			throw new UsageError(`unknown instance: ${name}`);
		}

		const session = inst.sessionName(cfg, name);

		if (!(await screen.sessionExists(session))) {
			throw new Bail(`${name} is not running`);
		}

		info(`attaching to ${pc.cyan(session)} — detach with ${pc.bold("Ctrl+A D")}`);
		await screen.attach(session);
	},
});

command({
	path: ["send"],
	desc: "Send a console command to a running instance",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "command", required: true, variadic: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const [name, ...cmd] = args as [string, ...string[]];

		if (!(await inst.sendCommand(cfg, name, cmd.join(" ")))) {
			throw new Bail(`${name} is not running`);
		}

		ok(`sent ${pc.cyan(cmd.join(" "))} to ${pc.bold(name)}`);
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
			throw new UsageError(`--set expects key=value pairs, got "${pair}"`);
		}

		out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
	}

	return out;
}

command({
	path: ["instance", "create"],
	desc: "Create a new paper instance and register it with the proxy",
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--version", desc: "MC version (default: latest paper release)", value: true },
		{ flag: "--port", desc: "game port (default: auto from range)", value: true },
		{ flag: "--memory", desc: "heap size, e.g. 2G (default 2G)", value: true },
		{ flag: "--profile", desc: "java profile (default aikar)", value: true },
		{
			flag: "--set",
			desc: "server settings, e.g. difficulty=hard,max-players=100 (see instance settings)",
			value: true,
		},
		{ flag: "--java-args", desc: 'extra JVM flags, e.g. "-XX:+UseZGC"', value: true },
		{ flag: "--groups", desc: "addon groups beside default, comma-separated", value: true },
		{ flag: "--no-register", desc: "don't register in velocity.toml" },
		{ flag: "--daemon", desc: "follower daemon that will own the instance", value: true },
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
				throw new UsageError(`unknown addon group: ${group}`);
			}
		}

		let version = opts.version as string | undefined;

		if (!version) {
			const spin = new Spinner().start("resolving latest paper version...");

			// plain x.y / x.y.z only — the list also carries snapshots and pre-releases
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
		const files = progress.child("Server files", 6);
		const plugins = progress.child("Plugins", 2);
		const packs = progress.child("Packs", 1);
		const ports = progress.child("Port allocations", 1);
		const proxy = progress.child("Proxy registration", 1);

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
				addonGroups: groups,
				daemon: opts.daemon as string | undefined,
				reporter: files,
			});

			await saveCluster(cfg);

			const deployed = await plugins.task(
				{ start: "deploying wildcard-targeted plugins", done: "plugins deployed" },
				(step) => deploy(cfg, lock, { instances: [name], reporter: step }),
			);

			plugins.complete(`${deployed.length} plugin(s) deployed`);

			// the group's other kinds: pack rules for the proxy, data packs for the world
			await packs.task({ start: "applying addon group packs" }, async (step) => {
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
						? `${applied.respacks.length} pack rule(s), ${installed} data pack(s)`
						: "no packs for this instance",
				);
			});

			await ports.task({ start: "allocating plugin ports", done: "plugin ports allocated" }, async () => {
				await ensurePortAllocations(cfg, lock);
				await saveCluster(cfg);
				await saveLock(lock);
			});

			if (opts["no-register"]) {
				proxy.complete("skipped — --no-register");
			} else {
				await proxy.task(
					{ start: "registering in velocity.toml" },
					async (step) => {
						const sync = await syncVelocityToml(cfg);

						step.report(
							1,
							"okay",
							sync.changed
								? "velocity.toml updated (reload the proxy to apply)"
								: "velocity.toml already up to date",
						);
					},
				);
			}

			view.stop();

			ok(
				`created ${pc.bold(name)} — paper ${version} build ${res.build.build}, ` +
					`port ${pc.cyan(String(res.port))}`,
			);

			if (javaArgs.length) {
				info(`extra JVM flags: ${pc.cyan(javaArgs.join(" "))}`);
			}

			info(`start it with: ${pc.cyan(`luna start ${name}`)}`);
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
 * in the pool — same bytes, or the standardized pool file name — are registered
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
			`${adoption.adopted.length} addon(s) recognised from the pool` +
				(registered.length ? `, ${registered.length} newly registered` : " (already registered)"),
		);

		for (const item of adoption.adopted) {
			const renamed = item.renamedTo ? pc.dim(` → ${item.renamedTo}`) : "";
			const pinned = item.version ? pc.yellow(` @${item.version}`) : "";

			console.log(`    ${Sym.check} ${item.file}${renamed} ${pc.dim(item.addon)}${pinned}`);
		}
	}

	if (adoption.unmanaged.length) {
		info(`${adoption.unmanaged.length} addon(s) left unmanaged — the server keeps its own`);

		for (const item of adoption.unmanaged.slice(0, 10)) {
			console.log(`    ${pc.dim(item.path)}`);
		}

		if (adoption.unmanaged.length > 10) {
			console.log(pc.dim(`    …and ${adoption.unmanaged.length - 10} more`));
		}
	}
}

command({
	path: ["instance", "adopt-addons"],
	desc: "Re-check an instance's own plugins/mods/data packs against the pool",
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const name = args[0]!;

		if (!managedInstances(cfg)[name]) {
			throw new UsageError(`unknown instance: ${name}`);
		}

		await adoptAddons(cfg, name);
	},
});

command({
	path: ["instance", "adopt"],
	desc: "Register a server directory that already exists as a managed instance",
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--daemon", desc: "daemon whose disk holds the directory", value: true },
		{ flag: "--dir", desc: "directory name under that daemon's root (default: the name)", value: true },
		{ flag: "--port", desc: "override the detected game port", value: true },
		{ flag: "--memory", desc: "override the detected heap size, e.g. 8G", value: true },
		{ flag: "--profile", desc: "java profile (default aikar)", value: true },
		{ flag: "--java", desc: "pin a java binary — modpacks often need an older JDK", value: true },
		{ flag: "--java-args", desc: 'extra JVM flags, e.g. "-XX:+UseZGC"', value: true },
		{ flag: "--no-register", desc: "don't register in velocity.toml" },
		{ flag: "--dry-run", desc: "show what was detected, registering nothing" },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const name = args[0]!;
		const daemon = opts.daemon as string | undefined;
		const dir = (opts.dir as string | undefined) ?? cfg.instances[name]?.dir ?? name;

		if (daemon && !cfg.daemons?.[daemon]) {
			throw new UsageError(`unknown daemon: ${daemon} — see \`luna daemon list\``);
		}

		if (opts["dry-run"]) {
			// a bare name resolves against the executing daemon's own cluster root
			const detected = await admin.inspectInstanceDir(dir, daemon);

			printTable(
				[
					["software", detected.software],
					["mc version", detected.mcVersion ?? pc.dim("—")],
					["loader", detected.loaderVersion ?? pc.dim("—")],
					["port", detected.port !== undefined ? String(detected.port) : pc.dim("—")],
					["memory", detected.memory ?? pc.dim("—")],
					["bind address", detected.bindAddress || pc.dim("(empty)")],
				],
				{ head: ["", `${daemon ?? "local"}:${dir}`] },
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
		const loader = result.inst.loaderVersion ? pc.dim(` (loader ${result.inst.loaderVersion})`) : "";

		ok(
			`adopted ${pc.bold(name)} — ${result.inst.software}${version}${loader}, ` +
				`port ${pc.cyan(String(result.inst.port))}, ${result.inst.memory} heap` +
				(daemon ? ` on ${pc.cyan(daemon)}` : ""),
		);

		for (const note of result.notes) {
			warn(note);
		}

		// what the server brought with it: recognised addons join the pool's
		// targets, everything else is reported and left exactly where it is
		await adoptAddons(cfg, name);

		if (sync.changed) {
			info("velocity.toml updated — reload the proxy to apply");
		}

		info(`start it with: ${pc.cyan(`luna start ${name}`)}`);
	},
});

command({
	path: ["instance", "set-version"],
	desc: "Switch an instance to a different MC version (downloads latest build)",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "version", required: true },
	],
	opts: [{ flag: "--force", desc: "proceed even with known-incompatible plugins" }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const [name, version] = args as [string, string];
		const status = await inst.getStatus(cfg, name);

		if (status.state !== "stopped") {
			throw new Bail(`${name} is running — stop it first`);
		}

		// Server-version requirement gate: check assigned plugin builds first.
		const report = compatReport(cfg, lock, name, version);
		const bad = report.filter((row) => row.status === "incompatible");
		const unknown = report.filter((row) => row.status === "unknown");

		if (bad.length) {
			for (const row of bad) {
				warn(
					`${row.plugin} ${row.version ?? ""} does not support MC ${version} ` +
						`(supports: ${row.gameVersions?.join(", ")})`,
				);
			}

			if (!opts.force) {
				throw new Bail(
					`aborted — ${bad.length} plugin(s) incompatible with ${version}; ` +
						"fix with plugins update/pin after switching, or pass --force",
				);
			}
		}

		if (unknown.length) {
			info(
				`${unknown.length} plugin(s) have unknown MC requirements ` +
					"(luna/manual jars — verify manually)",
			);
		}

		const spin = new Spinner().start(`downloading ${version}...`);
		const res = await admin.setVersion(cfg, name, version);

		await saveCluster(cfg);
		spin.stop();

		ok(
			`${pc.bold(name)}: ${pc.dim(res.from ?? "?")} ${Sym.arrow} ${pc.green(res.to)} ` +
				`(build ${res.build.build})`,
		);

		info(`old jar kept at ${pc.dim(res.backedUpJar)}`);
		info(`re-resolve plugin versions for the new MC: ${pc.cyan("luna plugins update --deploy")}`);
	},
});

command({
	path: ["instance", "settings"],
	desc: "Show or change an instance's server settings (difficulty, max-players, pvp, …)",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "key", complete: async () => editableSettingKeys() },
		{ name: "value", variadic: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const [name, key, ...rest] = args as [string, string?, ...string[]];

		if (!managedInstances(cfg)[name]) {
			throw new UsageError(`unknown instance: ${name}`);
		}

		const current = await readServerProperties(cfg, name);

		if (!key) {
			for (const group of SETTING_GROUPS) {
				const specs = SERVER_SETTINGS.filter((spec) => spec.group === group.id);

				console.log(`\n  ${pc.bold(pc.cyan(group.label))} ${pc.dim(group.hint)}`);

				printTable(
					specs.map((spec) => [
						spec.managed ? pc.dim(spec.key) : spec.key,
						current[spec.key] === undefined
							? pc.dim(`${spec.fallback} (default)`)
							: pc.bold(current[spec.key] || pc.dim("(blank)")),
						spec.managed ? pc.dim("managed by luna") : pc.dim(spec.hint ?? ""),
					]),
					{ indent: "    " },
				);
			}

			console.log();

			return;
		}

		const spec = settingSpec(key);

		if (!spec) {
			throw new UsageError(
				`"${key}" is not a known server setting — run "luna instance settings ${name}" for the list`,
			);
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
			info(`${name}.${key} already ${pc.cyan(value)}`);

			return;
		}

		const change = res.changed[0]!;
		const note = change.appended ? pc.dim(" (key added)") : "";

		ok(
			`${name}.${key}: ${pc.dim(change.from ?? "unset")} ${Sym.arrow} ${pc.cyan(change.to)}` +
				`${note} ${pc.dim("— applies on next restart")}`,
		);
	},
});

/** Settings stored in the registry rather than in server.properties. */
const REGISTRY_KEYS = ["memory", "profile", "java", "javaArgs", "port"];

command({
	path: ["instance", "config"],
	desc: "Get/set instance settings (memory, profile, port, javaArgs, or any server.properties key)",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "key", complete: async () => [...REGISTRY_KEYS, ...editableSettingKeys()] },
		{ name: "value", variadic: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const [name, key, ...rest] = args as [string, string?, ...string[]];
		const instance = managedInstances(cfg)[name];

		if (!instance) {
			throw new UsageError(`unknown instance: ${name}`);
		}

		if (!key) {
			printTable([
				["memory", instance.memory],
				["profile", instance.profile],
				["port", String(instance.port)],
				["java", instance.java ?? pc.dim("(profile default)")],
				["javaArgs", instance.javaArgs?.join(" ") ?? pc.dim("(none)")],
				["mcVersion", instance.mcVersion ?? pc.dim("—")],
				...Object.entries(instance.ports ?? {}).map(([id, port]) => [
					`port:${id}`,
					String(port),
				]),
			]);

			info(`server settings live in server.properties: ${pc.cyan(`luna instance settings ${name}`)}`);

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
				javaArgs: instance.javaArgs?.join(" "),
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
					throw new UsageError(`unknown profile: ${value}`);
				}

				instance.profile = value;
				break;

			case "java":
				instance.java = value;
				break;

			case "javaArgs":
				admin.setJavaArgs(cfg, name, parseJavaArgs(value));
				break;

			case "port": {
				await admin.setPort(cfg, name, parseInt(value));

				const sync = await syncVelocityToml(cfg);

				if (sync.changed) {
					ok("velocity.toml updated");
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
					throw new Bail(`key "${key}" not found in server.properties`);
				}
			}
		}

		await saveCluster(cfg);

		const note = REGISTRY_KEYS.includes(key) ? pc.dim(" (applies on next restart)") : "";

		ok(`${name}.${key} = ${pc.cyan(value)}${note}`);
	},
});

command({
	path: ["instance", "delete"],
	desc: "Deregister an instance (--purge also deletes its directory)",
	args: [{ name: "instance", required: true, complete: instanceNames }],
	opts: [
		{ flag: "--purge", desc: "DELETE the instance directory from disk" },
		{ flag: "--yes", desc: "skip confirmation" },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const name = args[0]!;

		if (!cfg.instances[name]) {
			throw new UsageError(`unknown instance: ${name}`);
		}

		// external instances run elsewhere, so there is no local state to probe
		const status = cfg.instances[name]!.external
			? undefined
			: await inst.getStatus(cfg, name);

		if (status && status.state !== "stopped") {
			throw new Bail(`${name} is running — stop it first`);
		}

		if (opts.purge && !opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const sure = await confirm({
				message: `Really DELETE ${name}'s directory (worlds included)?`,
			});

			if (isCancel(sure) || !sure) {
				info("aborted");

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
		const purged = opts.purge ? " and purged" : ` ${pc.dim("(directory kept)")}`;
		const proxyNote = sync.changed ? ", velocity.toml updated" : "";

		ok(`${pc.bold(name)} deregistered${purged}${proxyNote}`);
	},
});
