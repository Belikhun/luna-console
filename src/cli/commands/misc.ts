import { command } from "../framework";
import { pc, Sym, ok, warn, info, printTable, fmtBytes, Spinner } from "../ui";
import { loadCluster, saveCluster, loadLock } from "../../client/core/config";
import { syncVelocityToml, readVelocityServers } from "../../client/core/proxy";
import { collectPortRows, auditPorts, ensurePortAllocations } from "../../client/core/ports";
import * as cleanup from "../../client/core/cleanup";
import { sendCommand, getStatus } from "../../client/core/instances";

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

command({
	path: ["ports", "list"],
	desc: "Cluster-wide port map (game, query, plugin ports) with live bind state",

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const rows = await collectPortRows(cfg, lock);

		console.log();

		printTable(
			rows.map((row) => [
				row.listening ? Sym.ok : Sym.off,
				pc.bold(String(row.port)),
				row.protocol,
				row.owner,
				row.kind.startsWith("plugin:") ? pc.cyan(row.kind) : pc.dim(row.kind),
			]),
			{ head: ["", "port", "proto", "owner", "kind"] },
		);

		console.log(
			pc.dim(`\n  ${Sym.ok} bound now, ${Sym.off} not bound (instance stopped or drift)\n`),
		);
	},
});

command({
	path: ["ports", "check"],
	desc: "Audit ports: duplicates, config drift, velocity.toml mismatches",
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

		if (!issues.length) {
			ok("no port issues found");

			return;
		}

		for (const issue of issues) {
			warn(`[${issue.kind}] ${issue.message}`);
		}

		if (!opts.fix) {
			info(
				`fix drift with: ${pc.cyan("mrds ports check --fix")} and ${pc.cyan("mrds proxy sync")}`,
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
