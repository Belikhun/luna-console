import { Bail, UsageError, command } from "../framework";
import { pc, Sym, ok, warn, info, printTable, fmtBytes, Spinner } from "../ui";
import { loadCluster, saveCluster, loadLock } from "../../client/core/config";
import { syncVelocityToml, readVelocityServers } from "../../client/core/proxy";
import {
	auditPorts,
	clusterMachines,
	collectPortRows,
	ensurePortAllocations,
	machineLabel,
	poolCatalog,
	poolConsumers,
	portPoolUsage,
	setPoolCatalog,
} from "../../client/core/ports";
import type { ClusterConfig, PortPool } from "../../client/core/types";
import * as cleanup from "../../client/core/cleanup";
import { sendCommand, getStatus } from "../../client/core/instances";
import { ensureConnected } from "../../client/socket";
import { BUILD_AT, buildPlatform, buildVersion } from "../../version";

command({
	path: ["proxy", "sync"],
	desc: "Regenerate velocity.toml [servers]/[forced-hosts] from cluster.json",
	opts: [
		{ flag: "--dry-run", desc: "preview without writing" },
		{ flag: "--reload", desc: "run velocity reload afterwards if the proxy is up" },
	],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();
		const res = await syncVelocityToml(cfg, !!opts["dry-run"]);
		const preview = res.diffPreview
			.split("\n")
			.map((line) => "  " + line)
			.join("\n");

		console.log(pc.dim(`\n${preview}\n`));

		if (!res.changed) {
			ok("velocity.toml already in sync");

			return;
		}

		if (opts["dry-run"]) {
			info("dry run — velocity.toml NOT written");

			return;
		}

		ok(`velocity.toml updated ${pc.dim("(backup: velocity.toml.bak)")}`);

		if (!opts.reload) {
			info("restart the proxy or run with --reload to apply");

			return;
		}

		const status = await getStatus(cfg, "proxy");
		const reloaded =
			status.state !== "stopped" && (await sendCommand(cfg, "proxy", "velocity reload"));

		if (reloaded) {
			ok("sent `velocity reload` to the proxy");
		} else {
			warn("proxy not running — config applies on next start");
		}
	},
});

/**
 * A machine on the command line. The primary's key in the registry is the empty
 * string — nobody can type that, so it answers to "primary" (and to its own
 * daemon name, which is what `luna daemon list` shows).
 */
function machineArg(cfg: ClusterConfig, name: string): string {
	const known = clusterMachines(cfg);
	const machine = known.includes(name) ? name : name === "primary" ? "" : name;

	if (!known.includes(machine)) {
		throw new UsageError(
			`unknown machine "${name}" — known: ${known.map(machineLabel).join(", ")}`,
		);
	}

	return machine;
}

/** Machine names, for shell completion. */
async function machineNames(): Promise<string[]> {
	const cfg = await loadCluster();

	return clusterMachines(cfg).map(machineLabel);
}

/** Pool ids in the catalog, for shell completion. */
async function poolNames(): Promise<string[]> {
	const cfg = await loadCluster();

	return poolCatalog(cfg).map((pool) => pool.id);
}

/** "32560-32599" → bounds, or a UsageError naming the expected shape. */
function parseRange(text: string): [number, number] {
	const bounds = text.split("-").map((part) => parseInt(part.trim()));

	if (bounds.length !== 2 || bounds.some((bound) => !Number.isFinite(bound))) {
		throw new UsageError(`could not read "${text}" as a range — use 32560-32599`);
	}

	return [bounds[0]!, bounds[1]!];
}

command({
	path: ["ports", "list"],
	desc: "Cluster-wide port map (game, plugin, external) with the machine each one binds on",

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const rows = await collectPortRows(cfg, lock);

		console.log();

		printTable(
			rows.map((row) => [
				// a port on an unreachable machine is unknown, not free — the states
				// are distinct and only one of them is a problem. An external server
				// is never probed at all, so it gets neither.
				row.kind === "external"
					? Sym.dot
					: row.listening === null
						? Sym.warn
						: row.listening
							? Sym.ok
							: Sym.off,
				pc.bold(String(row.port)),
				row.protocol,
				row.machine === null ? pc.dim("external") : machineLabel(row.machine),
				row.owner,
				row.kind.startsWith("plugin:") ? pc.cyan(row.kind) : pc.dim(row.kind),
				row.pool ?? pc.dim("—"),
				pc.dim(row.address),
			]),
			{ head: ["", "port", "proto", "machine", "owner", "kind", "pool", "address"] },
		);

		console.log(
			pc.dim(
				`\n  ${Sym.ok} bound now, ${Sym.off} not bound (stopped or drift), ` +
					`${Sym.warn} machine not reachable, ${Sym.dot} external (not probed)\n`,
			),
		);
	},
});

command({
	path: ["ports", "pools"],
	desc: "The pool catalog: what consumes each pool, and each machine's range and usage",
	args: [{ name: "machine", complete: async () => await machineNames() }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const [wanted] = args as [string?];
		const machines = wanted ? [machineArg(cfg, wanted)] : clusterMachines(cfg);
		const consumers = poolConsumers(lock);
		const usage = portPoolUsage(cfg, lock, machines);

		// grouped by pool, then machine: the pool is the thing being consumed, and
		// the machines are just where its numbers differ
		for (const pool of poolCatalog(cfg)) {
			const wanting = consumers[pool.id] ?? [];
			const who = wanting.length
				? wanting
						.map((consumer) =>
							consumer.kind === "provision"
								? "every instance provision (game port)"
								: `${consumer.name} (${consumer.protocol}${consumer.portId ? ` ${consumer.portId}` : ""})`,
						)
						.join(", ")
				: "nothing yet — a plugin port declaration names it with `pool`";

			console.log(
				`\n  ${pc.bold(pool.id)} ${pool.label ? pc.dim(`— ${pool.label} `) : ""}${pc.dim(`(${pool.protocol})`)}`,
			);
			console.log(pc.dim(`  consumed by: ${who}`));

			printTable(
				usage
					.filter((view) => view.pool.id === pool.id)
					.map((view) => [
						machineLabel(view.machine),
						`${view.pool.range[0]}-${view.pool.range[1]}`,
						`${view.used.length}/${view.capacity}`,
						view.next === null ? pc.yellow("exhausted") : String(view.next),
						view.overridden
							? pc.cyan("override")
							: view.inherited
								? pc.dim("default")
								: "catalog",
					]),
				{ head: ["machine", "range", "used", "next", "source"] },
			);
		}

		console.log(
			pc.dim(
				"\n  the pool id is the mapping: provisioning takes `game`, a plugin's port spec\n" +
					"  names its pool; every machine serves every pool, only the numbers differ\n",
			),
		);
	},
});

command({
	path: ["ports", "pool", "set"],
	desc: "Define/update a pool cluster-wide, or override its range on one machine",
	args: [
		{ name: "pool", required: true, complete: async () => await poolNames() },
		{ name: "range", desc: "e.g. 32560-32599" },
	],
	opts: [
		{ flag: "--machine", desc: "override the range on this machine only", value: true },
		{ flag: "--protocol", desc: "tcp | udp | both (default tcp)", value: true },
		{ flag: "--label", desc: "what the pool is for", value: true },
		{ flag: "--reserve", desc: "comma-separated ports to hold back", value: true },
		{ flag: "--remove", desc: "drop the pool (or, with --machine, that machine's override)" },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const [id, range] = args as [string, string?];
		const machine = opts.machine !== undefined ? machineArg(cfg, String(opts.machine)) : undefined;

		// edit on top of what is *stored*: pools still on their built-in default stay
		// inherited rather than being frozen into cluster.json as a side effect
		const stored = Array.isArray(cfg.portPools) ? cfg.portPools.map((pool) => pool) : [];
		const catalogEntry = poolCatalog(cfg).find((pool) => pool.id === id);
		const pools = stored.filter((pool) => pool.id !== id);
		const editing = stored.find((pool) => pool.id === id) ?? catalogEntry;

		if (opts.remove && machine === undefined) {
			// dropping the catalog entry reverts a builtin to its default and deletes
			// a custom pool outright — setPoolCatalog warns if something consumed it
		} else {
			if (!editing && !range) {
				throw new UsageError("a new pool needs a range, e.g. 32560-32599");
			}

			const pool: PortPool = editing
				? {
						...editing,
						range: [editing.range[0], editing.range[1]],
						overrides: { ...editing.overrides },
					}
				: { id, protocol: "tcp", range: [0, 0] };

			if (opts.protocol !== undefined) {
				const protocol = String(opts.protocol);

				if (protocol !== "tcp" && protocol !== "udp" && protocol !== "both") {
					throw new UsageError("--protocol must be tcp, udp or both");
				}

				pool.protocol = protocol;
			}

			if (opts.label !== undefined) {
				pool.label = String(opts.label) || undefined;
			}

			const bounds = range ? parseRange(range) : undefined;
			const reserved =
				opts.reserve !== undefined
					? String(opts.reserve)
							.split(/[\s,]+/)
							.filter(Boolean)
							.map((part) => parseInt(part))
					: undefined;

			if (machine === undefined) {
				if (bounds) {
					pool.range = bounds;
				}

				if (reserved !== undefined) {
					pool.reserved = reserved.length ? reserved : undefined;
				}
			} else if (opts.remove) {
				delete pool.overrides?.[machine];
			} else {
				if (!bounds && reserved === undefined) {
					throw new UsageError("a machine override needs a range and/or --reserve");
				}

				pool.overrides ??= {};
				pool.overrides[machine] = {
					...pool.overrides[machine],
					...(bounds ? { range: bounds } : {}),
					...(reserved !== undefined ? { reserved } : {}),
				};
			}

			pools.push(pool);
		}

		const result = setPoolCatalog(cfg, pools, lock);

		if (result.errors.length) {
			for (const problem of result.errors) {
				warn(problem);
			}

			throw new Bail("nothing written — fix the pool definition and try again");
		}

		await saveCluster(cfg);

		if (opts.remove) {
			ok(
				machine === undefined
					? `pool "${id}" dropped from the catalog`
					: `pool "${id}" no longer overridden on ${machineLabel(machine)}`,
			);
		} else {
			ok(
				machine === undefined
					? `pool "${id}" ${range ? `now hands out ${range}` : "updated"} on every machine without an override`
					: `pool "${id}" on ${machineLabel(machine)} ${range ? `now hands out ${range}` : "updated"}`,
			);
		}

		for (const note of result.warnings) {
			warn(note);
		}
	},
});

command({
	path: ["ports", "check"],
	desc: "Audit ports: per-machine duplicates, pool coverage, config drift, velocity.toml",
	opts: [{ flag: "--fix", desc: "rewrite plugin configs from the registry" }],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();

		if (opts.fix) {
			const allocations = await ensurePortAllocations(cfg, lock);

			await saveCluster(cfg);
			ok(`ensured ${allocations.length} port allocation(s)`);
		}

		// compare against what's actually in velocity.toml on disk
		const onDisk = await readVelocityServers(cfg);
		const issues = await auditPorts(cfg, lock, onDisk);

		// an offline machine is not a finding, it is a gap in coverage — said out
		// loud so "no issues" never means "we only looked at half the cluster",
		// but not counted as a failure either
		const unchecked = issues.filter((issue) => issue.kind === "unchecked");
		const problems = issues.filter((issue) => issue.kind !== "unchecked");

		for (const issue of problems) {
			warn(`[${issue.kind}] ${issue.message}`);
		}

		for (const issue of unchecked) {
			info(issue.message);
		}

		if (!problems.length) {
			ok("no port issues found");

			return;
		}

		if (!opts.fix) {
			info(
				`fix drift with: ${pc.cyan("luna ports check --fix")} and ${pc.cyan("luna proxy sync")}`,
			);
		}

		process.exitCode = 1;
	},
});

command({
	path: ["cleanup"],
	desc: "Delete junk (cache, old versions, crash reports) + archive rotated logs centrally",
	opts: [
		{ flag: "--dry-run", desc: "show what would be removed" },
		{ flag: "--yes", desc: "skip confirmation" },
	],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();
		const scanSpinner = new Spinner().start("scanning for junk...");
		const plan = await cleanup.buildPlan(cfg);

		scanSpinner.stop();

		if (!plan.junk.length && !plan.logs.length) {
			ok("nothing to clean");

			return;
		}

		const byKind = new Map<string, { count: number; bytes: number }>();

		for (const item of plan.junk) {
			const cur = byKind.get(item.kind) ?? { count: 0, bytes: 0 };

			byKind.set(item.kind, { count: cur.count + 1, bytes: cur.bytes + item.bytes });
		}

		console.log();

		printTable(
			[...byKind.entries()].map(([kind, sum]) => [kind, String(sum.count), fmtBytes(sum.bytes)]),
			{ head: ["kind", "items", "size"] },
		);

		const logBytes = plan.logs.reduce((total, log) => total + log.bytes, 0);

		if (plan.logs.length) {
			console.log(
				`\n  ${pc.cyan("logs")}: ${plan.logs.length} rotated files (${fmtBytes(logBytes)}) → ` +
					pc.dim("logs/<instance>/<YYYY-MM>.log.gz"),
			);
		}

		for (const note of plan.notes) {
			console.log(pc.dim(`  note: ${note}`));
		}

		console.log(`\n  total to free: ${pc.bold(pc.green(fmtBytes(plan.totalBytes)))}\n`);

		if (opts["dry-run"]) {
			for (const item of plan.junk) {
				console.log(pc.dim(`  rm ${item.path} (${fmtBytes(item.bytes)})`));
			}

			info("dry run — nothing deleted");

			return;
		}

		if (!opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const sure = await confirm({ message: "Proceed with cleanup?" });

			if (isCancel(sure) || !sure) {
				info("aborted");

				return;
			}
		}

		const cleanSpinner = new Spinner().start("cleaning...");
		const res = await cleanup.execute(plan);

		cleanSpinner.stop();
		ok(`deleted ${res.deleted} items, freed ${pc.bold(fmtBytes(res.freedBytes))}`);

		if (res.archivedLogs) {
			ok(
				`archived ${res.archivedLogs} log files into ${res.archives.length} monthly archive(s)`,
			);
		}
	},
});

command({
	path: ["version"],
	desc: "Build identity of this binary (and the daemon, when one answers)",

	handler: async () => {
		console.log(`luna ${buildVersion()} (${buildPlatform()})`);

		if (BUILD_AT) {
			info(`built     ${new Date(BUILD_AT).toLocaleString()}`);
		}

		// the binary and the running daemon are two different builds whenever an
		// upgrade has happened but the service has not restarted yet
		try {
			const d = await ensureConnected();

			info(`daemon    ${d.name} — ${d.version}, protocol ${d.protocol}`);
		} catch {
			info(pc.dim("daemon    not running on this host"));
		}
	},
});
