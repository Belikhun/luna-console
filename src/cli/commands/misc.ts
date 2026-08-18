// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { Bail, UsageError, command } from "../framework";
import { pc, Sym, ok, warn, info, printTable, fmtBytes, Spinner } from "../ui";
import { loadCluster, saveCluster, loadLock } from "../../client/core/config";
import { setProxyRegistration, syncVelocityToml, readVelocityServers } from "../../client/core/proxy";
import { instanceNames } from "../completers";
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
import { t } from "../../shared/i18n";

command({
	path: ["proxy", "sync"],
	desc: t("cli.proxy.sync.desc"),
	opts: [
		{ flag: "--dry-run", desc: t("cli.proxy.sync.optDryRun") },
		{ flag: "--reload", desc: t("cli.proxy.sync.optReload") },
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
			ok(t("cli.proxy.sync.inSync"));

			return;
		}

		if (opts["dry-run"]) {
			info(t("cli.proxy.sync.dryRun"));

			return;
		}

		ok(`${t("cli.proxy.sync.updated")} ${pc.dim(t("cli.proxy.sync.backupNote"))}`);

		if (!opts.reload) {
			info(t("cli.proxy.sync.applyHint"));

			return;
		}

		const status = await getStatus(cfg, "proxy");
		const reloaded =
			status.state !== "stopped" && (await sendCommand(cfg, "proxy", "velocity reload"));

		if (reloaded) {
			ok(t("cli.proxy.sync.reloaded"));
		} else {
			warn(t("cli.proxy.sync.proxyDown"));
		}
	},
});

command({
	path: ["proxy", "register"],
	desc: t("cli.proxy.register.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames }],
	opts: [
		{ flag: "--on", desc: t("cli.proxy.register.optOn") },
		{ flag: "--off", desc: t("cli.proxy.register.optOff") },
		{ flag: "--priority", value: true, desc: t("cli.proxy.register.optPriority") },
		{ flag: "--no-try", desc: t("cli.proxy.register.optNoTry") },
		{ flag: "--hosts", value: true, desc: t("cli.proxy.register.optHosts") },
		{ flag: "--sync", desc: t("cli.proxy.register.optSync") },
		{ flag: "--reload", desc: t("cli.proxy.register.optReload") },
	],

	handler: async (args, opts) => {
		const name = args[0]!;
		const cfg = await loadCluster();
		const inst = cfg.instances[name];

		if (!inst) {
			throw new UsageError(t("cli.proxy.register.unknownInstance", { name }));
		}

		if (opts.on && opts.off) {
			throw new UsageError(t("cli.proxy.register.onOffClash"));
		}

		if (opts.priority !== undefined && opts["no-try"]) {
			throw new UsageError(t("cli.proxy.register.tryClash"));
		}

		const editing =
			opts.on !== undefined ||
			opts.off !== undefined ||
			opts.priority !== undefined ||
			opts["no-try"] !== undefined ||
			opts.hosts !== undefined;

		// with nothing to change, the command answers what is registered today
		if (!editing) {
			const reg = inst.proxy;

			printTable(
				[
					[
						t("cli.proxy.register.stateLabel"),
						reg?.register
							? pc.green(t("cli.proxy.register.registered"))
							: pc.dim(t("cli.proxy.register.notRegistered")),
					],
					[
						t("cli.proxy.register.priorityLabel"),
						reg?.priority !== undefined
							? String(reg.priority)
							: pc.dim(t("cli.proxy.register.notInTry")),
					],
					[
						t("cli.proxy.register.hostsLabel"),
						reg?.forcedHosts?.length ? reg.forcedHosts.join(", ") : pc.dim("—"),
					],
				],
				{ indent: "  " },
			);

			info(t("cli.proxy.register.showHint"));

			return;
		}

		let priority: number | null | undefined;

		if (opts["no-try"]) {
			priority = null;
		} else if (opts.priority !== undefined) {
			priority = parseInt(String(opts.priority));

			if (!Number.isFinite(priority)) {
				throw new UsageError(
					t("cli.proxy.register.badPriority", { value: String(opts.priority) }),
				);
			}
		}

		let result: { changed: string[] };

		try {
			result = setProxyRegistration(cfg, name, {
				register: opts.on ? true : opts.off ? false : undefined,
				priority,
				forcedHosts:
					opts.hosts !== undefined
						? String(opts.hosts)
								.split(",")
								.map((host) => host.trim())
								.filter(Boolean)
						: undefined,
			});
		} catch (err) {
			throw new Bail((err as Error).message);
		}

		if (!result.changed.length) {
			info(t("cli.proxy.register.noChanges", { name }));
		} else {
			await saveCluster(cfg);
			ok(t("cli.proxy.register.saved", { name, fields: result.changed.join(", ") }));
		}

		if (!opts.sync) {
			if (result.changed.length) {
				info(t("cli.proxy.register.syncHint"));
			}

			return;
		}

		const res = await syncVelocityToml(cfg, false);

		if (res.changed) {
			ok(`${t("cli.proxy.sync.updated")} ${pc.dim(t("cli.proxy.sync.backupNote"))}`);
		} else {
			ok(t("cli.proxy.sync.inSync"));
		}

		if (opts.reload) {
			const status = await getStatus(cfg, "proxy");
			const reloaded =
				status.state !== "stopped" && (await sendCommand(cfg, "proxy", "velocity reload"));

			if (reloaded) {
				ok(t("cli.proxy.sync.reloaded"));
			} else {
				warn(t("cli.proxy.sync.proxyDown"));
			}
		} else if (res.changed) {
			info(t("cli.proxy.sync.applyHint"));
		}
	},
});

/**
 * A machine on the command line. The primary's key in the registry is the empty
 * string. Nobody can type that, so it answers to "primary" (and to its own
 * daemon name, which is what `luna daemon list` shows).
 */
function machineArg(cfg: ClusterConfig, name: string): string {
	const known = clusterMachines(cfg);
	const machine = known.includes(name) ? name : name === "primary" ? "" : name;

	if (!known.includes(machine)) {
		throw new UsageError(
			t("cli.machines.unknown", { name, known: known.map(machineLabel).join(", ") }),
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
		throw new UsageError(t("cli.ports.badRange", { text }));
	}

	return [bounds[0]!, bounds[1]!];
}

command({
	path: ["ports", "list"],
	desc: t("cli.ports.list.desc"),

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const rows = await collectPortRows(cfg, lock);

		console.log();

		printTable(
			rows.map((row) => [
				// a port on an unreachable machine is unknown, not free: the states
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
				row.machine === null ? pc.dim(t("cli.ports.list.external")) : machineLabel(row.machine),
				row.owner,
				row.kind.startsWith("plugin:") ? pc.cyan(row.kind) : pc.dim(row.kind),
				row.pool ?? pc.dim("—"),
				pc.dim(row.address),
			]),
			{
				head: [
					"",
					t("cli.head.port"),
					t("cli.head.proto"),
					t("cli.head.machine"),
					t("cli.head.owner"),
					t("cli.head.kind"),
					t("cli.head.pool"),
					t("cli.head.address"),
				],
			},
		);

		console.log(
			pc.dim(
				`\n  ${t("cli.ports.list.legend", { ok: Sym.ok, off: Sym.off, warn: Sym.warn, dot: Sym.dot })}\n`,
			),
		);
	},
});

command({
	path: ["ports", "pools"],
	desc: t("cli.ports.pools.desc"),
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
								? t("cli.ports.pools.provisionConsumer")
								: `${consumer.name} (${consumer.protocol}${consumer.portId ? ` ${consumer.portId}` : ""})`,
						)
						.join(", ")
				: t("cli.ports.pools.noConsumers");

			console.log(
				`\n  ${pc.bold(pool.id)} ${pool.label ? pc.dim(`— ${pool.label} `) : ""}${pc.dim(`(${pool.protocol})`)}`,
			);
			console.log(pc.dim(`  ${t("cli.ports.pools.consumedBy", { who })}`));

			printTable(
				usage
					.filter((view) => view.pool.id === pool.id)
					.map((view) => [
						machineLabel(view.machine),
						`${view.pool.range[0]}-${view.pool.range[1]}`,
						`${view.used.length}/${view.capacity}`,
						view.next === null ? pc.yellow(t("cli.ports.pools.exhausted")) : String(view.next),
						view.overridden
							? pc.cyan(t("cli.ports.pools.sourceOverride"))
							: view.inherited
								? pc.dim(t("cli.ports.pools.sourceDefault"))
								: t("cli.ports.pools.sourceCatalog"),
					]),
				{
					head: [
						t("cli.head.machine"),
						t("cli.head.range"),
						t("cli.head.used"),
						t("cli.head.next"),
						t("cli.head.source"),
					],
				},
			);
		}

		console.log(pc.dim(`\n  ${t("cli.ports.pools.footer").split("\n").join("\n  ")}\n`));
	},
});

command({
	path: ["ports", "pool", "set"],
	desc: t("cli.ports.poolSet.desc"),
	args: [
		{ name: "pool", required: true, complete: async () => await poolNames() },
		{ name: "range", desc: t("cli.ports.poolSet.argRange") },
	],
	opts: [
		{ flag: "--machine", desc: t("cli.ports.poolSet.optMachine"), value: true },
		{ flag: "--protocol", desc: t("cli.ports.poolSet.optProtocol"), value: true },
		{ flag: "--label", desc: t("cli.ports.poolSet.optLabel"), value: true },
		{ flag: "--reserve", desc: t("cli.ports.poolSet.optReserve"), value: true },
		{ flag: "--remove", desc: t("cli.ports.poolSet.optRemove") },
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
			// a custom pool outright; setPoolCatalog warns if something consumed it
		} else {
			if (!editing && !range) {
				throw new UsageError(t("cli.ports.poolSet.needsRange"));
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
					throw new UsageError(t("cli.ports.poolSet.badProtocol"));
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
					throw new UsageError(t("cli.ports.poolSet.overrideNeedsRange"));
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

			throw new Bail(t("cli.ports.poolSet.nothingWritten"));
		}

		await saveCluster(cfg);

		if (opts.remove) {
			ok(
				machine === undefined
					? t("cli.ports.poolSet.droppedCatalog", { id })
					: t("cli.ports.poolSet.droppedOverride", { id, machine: machineLabel(machine) }),
			);
		} else {
			const change = range
				? t("cli.ports.poolSet.changeRange", { range })
				: t("cli.ports.poolSet.changeUpdated");

			ok(
				machine === undefined
					? t("cli.ports.poolSet.updatedEverywhere", { id, change })
					: t("cli.ports.poolSet.updatedMachine", { id, machine: machineLabel(machine), change }),
			);
		}

		for (const note of result.warnings) {
			warn(note);
		}
	},
});

command({
	path: ["ports", "check"],
	desc: t("cli.ports.check.desc"),
	opts: [{ flag: "--fix", desc: t("cli.ports.check.optFix") }],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();
		const lock = await loadLock();

		if (opts.fix) {
			const allocations = await ensurePortAllocations(cfg, lock);

			await saveCluster(cfg);
			ok(t("cli.ports.check.ensured", { count: allocations.length }));
		}

		// compare against what's actually in velocity.toml on disk
		const onDisk = await readVelocityServers(cfg);
		const issues = await auditPorts(cfg, lock, onDisk);

		// an offline machine is not a finding, it is a gap in coverage: said out
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
			ok(t("cli.ports.check.noIssues"));

			return;
		}

		if (!opts.fix) {
			info(
				t("cli.ports.check.fixHint", {
					fix: pc.cyan("luna ports check --fix"),
					sync: pc.cyan("luna proxy sync"),
				}),
			);
		}

		process.exitCode = 1;
	},
});

command({
	path: ["cleanup"],
	desc: t("cli.cleanup.desc"),
	opts: [
		{ flag: "--dry-run", desc: t("cli.cleanup.optDryRun") },
		{ flag: "--yes", desc: t("cli.common.optYes") },
	],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();
		const scanSpinner = new Spinner().start(t("cli.cleanup.scanning"));
		const plan = await cleanup.buildPlan(cfg);

		scanSpinner.stop();

		if (!plan.junk.length && !plan.logs.length) {
			ok(t("cli.cleanup.nothing"));

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
			{ head: [t("cli.head.kind"), t("cli.head.items"), t("cli.head.size")] },
		);

		const logBytes = plan.logs.reduce((total, log) => total + log.bytes, 0);

		if (plan.logs.length) {
			console.log(
				`\n  ${pc.cyan("logs")}: ${t("cli.cleanup.logsLine", { count: plan.logs.length, size: fmtBytes(logBytes) })} → ` +
					pc.dim("logs/<instance>/<YYYY-MM>.log.gz"),
			);
		}

		for (const note of plan.notes) {
			console.log(pc.dim(`  ${t("cli.cleanup.note", { note })}`));
		}

		console.log(
			`\n  ${t("cli.cleanup.totalToFree", { size: pc.bold(pc.green(fmtBytes(plan.totalBytes))) })}\n`,
		);

		if (opts["dry-run"]) {
			for (const item of plan.junk) {
				console.log(pc.dim(`  rm ${item.path} (${fmtBytes(item.bytes)})`));
			}

			info(t("cli.cleanup.dryRun"));

			return;
		}

		if (!opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const sure = await confirm({ message: t("cli.cleanup.confirm") });

			if (isCancel(sure) || !sure) {
				info(t("cli.common.aborted"));

				return;
			}
		}

		const cleanSpinner = new Spinner().start(t("cli.cleanup.cleaning"));
		const res = await cleanup.execute(plan);

		cleanSpinner.stop();
		ok(
			t("cli.cleanup.deleted", {
				count: res.deleted,
				size: pc.bold(fmtBytes(res.freedBytes)),
			}),
		);

		if (res.archivedLogs) {
			ok(t("cli.cleanup.archived", { count: res.archivedLogs, archives: res.archives.length }));
		}
	},
});

command({
	path: ["version"],
	desc: t("cli.version.desc"),

	handler: async () => {
		console.log(`luna ${buildVersion()} (${buildPlatform()})`);

		if (BUILD_AT) {
			info(`${t("cli.version.builtLabel").padEnd(9)} ${new Date(BUILD_AT).toLocaleString()}`);
		}

		// the binary and the running daemon are two different builds whenever an
		// upgrade has happened but the service has not restarted yet
		try {
			const d = await ensureConnected();

			info(
				`${t("cli.version.daemonLabel").padEnd(9)} ${t("cli.version.daemonLine", { name: d.name, version: d.version, protocol: d.protocol })}`,
			);
		} catch {
			info(pc.dim(`${t("cli.version.daemonLabel").padEnd(9)} ${t("cli.version.daemonDown")}`));
		}
	},
});
