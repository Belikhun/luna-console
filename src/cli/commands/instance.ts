import { command, UsageError, Bail } from "../framework";
import { pc, Sym, ok, warn, info, printTable, fmtDuration, Spinner } from "../ui";
import { instanceNames } from "../completers";
import { loadCluster, saveCluster, managedInstances, loadLock, saveLock } from "../../core/config";
import type { ClusterConfig } from "../../core/types";
import * as inst from "../../core/instances";
import * as admin from "../../core/admin";
import * as screen from "../../core/screen";
import { syncVelocityToml } from "../../core/proxy";
import { ensurePortAllocations } from "../../core/ports";
import { deploy, compatReport } from "../../core/plugins";
import { listVersions } from "../../core/services/papermc";

/** Coloured state glyph + label for a status table row. */
function stateCell(status: inst.InstanceStatus): string {
	switch (status.state) {
		case "running":
			return `${Sym.ok} ${pc.green("running")}`;

		case "starting":
			return `${Sym.warn} ${pc.yellow("starting")}`;

		case "stopped":
			return `${Sym.off} ${pc.dim("stopped")}`;
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
			const outcome = await inst.startInstance(cfg, name);

			if (outcome === "started") {
				ok(`${pc.bold(name)} started in screen ${pc.cyan(inst.sessionName(cfg, name))}`);
			} else {
				info(`${pc.bold(name)} already running`);
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
			const spin = new Spinner().start(`stopping ${name}...`);
			const res = await inst.stopInstance(cfg, name);

			spin.stop();

			if (res.outcome === "stopped") {
				ok(`${pc.bold(name)} stopped ${pc.dim(`(${fmtDuration(res.tookMs)})`)}`);
			} else if (res.outcome === "forced") {
				warn(`${name}: graceful stop timed out, sent SIGTERM`);
			} else {
				info(`${pc.bold(name)} not running`);
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
			const spin = new Spinner().start(`stopping ${name}...`);
			const res = await inst.stopInstance(cfg, name);

			spin.stop();

			if (res.outcome === "forced") {
				warn(`${name}: graceful stop timed out, forced`);
			}

			await inst.startInstance(cfg, name);
			ok(`${pc.bold(name)} restarted`);
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

command({
	path: ["instance", "create"],
	desc: "Create a new paper instance and register it with the proxy",
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--version", desc: "MC version (default: latest paper release)", value: true },
		{ flag: "--port", desc: "game port (default: auto from range)", value: true },
		{ flag: "--memory", desc: "heap size, e.g. 2G (default 2G)", value: true },
		{ flag: "--profile", desc: "java profile (default aikar)", value: true },
		{ flag: "--no-register", desc: "don't register in velocity.toml" },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = args[0]!;

		let version = opts.version as string | undefined;

		const spin = new Spinner().start(
			version ? `fetching paper ${version}...` : "resolving latest paper version...",
		);

		if (!version) {
			// plain x.y / x.y.z only — the list also carries snapshots and pre-releases
			const versions = await listVersions("paper");

			version = versions
				.filter((candidate) => /^\d+\.\d+(\.\d+)?$/.test(candidate))
				.sort()
				.at(-1)!;
		}

		spin.update(`downloading paper ${version}...`);

		const res = await admin.createInstance(cfg, name, {
			mcVersion: version,
			port: opts.port ? parseInt(opts.port as string) : undefined,
			memory: opts.memory as string | undefined,
			profile: opts.profile as string | undefined,
			register: !opts["no-register"],
		});

		await saveCluster(cfg);
		spin.stop();

		ok(
			`created ${pc.bold(name)} — paper ${version} build ${res.build.build}, ` +
				`port ${pc.cyan(String(res.port))}`,
		);

		const deployed = await deploy(cfg, lock, { instances: [name] });

		if (deployed.length) {
			ok(`deployed ${deployed.length} wildcard-targeted plugin(s)`);
		}

		await ensurePortAllocations(cfg, lock);
		await saveCluster(cfg);
		await saveLock(lock);

		if (!opts["no-register"]) {
			const sync = await syncVelocityToml(cfg);

			if (sync.changed) {
				ok(`registered in velocity.toml ${pc.dim("(reload proxy to apply)")}`);
			}
		}

		info(`start it with: ${pc.cyan(`mrds start ${name}`)}`);
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
		info(`re-resolve plugin versions for the new MC: ${pc.cyan("mrds plugins update --deploy")}`);
	},
});

/** Settings stored in the registry rather than in server.properties. */
const REGISTRY_KEYS = ["memory", "profile", "java", "port"];

command({
	path: ["instance", "config"],
	desc: "Get/set instance settings (memory, profile, port, or any server.properties key)",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "key", complete: async () => ["memory", "profile", "port", "java"] },
		{ name: "value" },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const [name, key, value] = args as [string, string?, string?];
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
				["mcVersion", instance.mcVersion ?? pc.dim("—")],
				...Object.entries(instance.ports ?? {}).map(([id, port]) => [
					`port:${id}`,
					String(port),
				]),
			]);

			return;
		}

		if (value === undefined) {
			const builtin: Record<string, string | undefined> = {
				memory: instance.memory,
				profile: instance.profile,
				port: String(instance.port),
				java: instance.java,
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

			case "port": {
				await admin.setPort(cfg, name, parseInt(value));

				const sync = await syncVelocityToml(cfg);

				if (sync.changed) {
					ok("velocity.toml updated");
				}

				break;
			}

			default: {
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

		await admin.deleteInstance(cfg, name, !!opts.purge);
		await saveCluster(cfg);

		const sync = await syncVelocityToml(cfg);
		const purged = opts.purge ? " and purged" : ` ${pc.dim("(directory kept)")}`;
		const proxyNote = sync.changed ? ", velocity.toml updated" : "";

		ok(`${pc.bold(name)} deregistered${purged}${proxyNote}`);
	},
});
