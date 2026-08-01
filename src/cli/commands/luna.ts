import { command, Bail } from "../framework";
import { pc, Sym, ok, warn, info, fail, printTable, Spinner, fmtDuration, fmtBytes } from "../ui";
import { lunaModules } from "../completers";
import { loadCluster, loadLock, saveLock } from "../../core/config";
import * as luna from "../../core/luna";
import type { LunaState, LunaStatusRow } from "../../core/luna";
import type { LunaSourceConfig } from "../../core/types";
import { runDeploy } from "./plugins";

/** Coloured label for how far a module has travelled from source to instances. */
function stateBadge(state: LunaState): string {
	switch (state) {
		case "in-sync":
			return `${Sym.ok} ${pc.green("in sync")}`;

		case "needs-deploy":
			return `${Sym.warn} ${pc.yellow("needs deploy")}`;

		case "stale-pool":
			return `${Sym.warn} ${pc.yellow("stale pool")}`;

		case "unregistered":
			return `${Sym.off} ${pc.dim("unregistered")}`;

		default:
			return `${Sym.off} ${pc.dim("not built")}`;
	}
}

/** Relative age of a build, or a dim placeholder when the jar is missing. */
function age(builtAt: Date | undefined): string {
	if (!builtAt) {
		return pc.dim("—");
	}

	return pc.dim(`${fmtDuration(Date.now() - builtAt.getTime())} ago`);
}

/** Render the status table plus its one-line summary. */
function printStatus(rows: LunaStatusRow[], stamp: luna.LunaBuildStamp, dir: string): void {
	const table = rows.map((row) => [
		stateBadge(row.state),
		pc.bold(row.module),
		row.platform === "velocity" ? pc.cyan(row.platform) : row.platform,
		row.pooledVersion ?? pc.dim("—"),
		age(row.builtAt),
		row.targets.length ? row.targets.join(",") : pc.red("(none)"),
		row.drifted.length ? pc.yellow(row.drifted.join(",")) : pc.dim("—"),
	]);

	console.log();
	printTable(table, {
		head: ["state", "module", "platform", "pooled version", "built", "targets", "drifted"],
	});

	const counts = new Map<LunaState, number>();

	for (const row of rows) {
		counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
	}

	const summary = [...counts.entries()]
		.map(([state, count]) => `${count} ${state}`)
		.sort()
		.join(", ");

	console.log(
		pc.dim(
			`\n  ${rows.length} modules — ${summary}` +
				`\n  source ${dir} @ ${luna.stampVersion(stamp)}` +
				(stamp.dirty ? pc.yellow(" (uncommitted changes)") : "") +
				"\n",
		),
	);
}

command({
	path: ["luna", "status"],
	desc: "Compare built luna jars against the pool and every instance",

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const source = luna.lunaSource(cfg);
		const spin = new Spinner().start("hashing built, pooled and deployed jars...");

		const rows = await luna.status(cfg, lock, source);
		const stamp = await luna.buildStamp(source);
		const stray = await luna.strayArtifacts(source);

		spin.stop();
		printStatus(rows, stamp, source.dir);

		for (const file of stray) {
			warn(`stray artifact in output/: ${file} (no gradle module produces it)`);
		}
	},
});

/**
 * Run the gradle build, showing the task it is on. Gradle's own progress lines are
 * kept out of the spinner label — only `> Task :x:y` lines advance it — and the
 * tail of the log is printed on failure, since that is where the compiler error is.
 */
async function runBuild(
	source: Required<LunaSourceConfig>,
	modules: string[] | undefined,
): Promise<luna.BuildResult> {
	const label = modules?.length ? modules.join(", ") : "all modules";
	const spin = new Spinner().start(`building ${label}...`);

	const result = await luna.build(source, {
		modules,

		onLine: (line) => {
			const task = /^> Task (\S+)/.exec(line);

			if (task) {
				spin.update(`building ${label} ${pc.dim(task[1]!)}`);
			}
		},
	});

	spin.stop();

	if (!result.ok) {
		for (const line of result.log.slice(-25)) {
			console.error(pc.dim(line));
		}

		throw new Bail(`gradle build failed (exit ${result.exitCode})`);
	}

	ok(`build succeeded in ${fmtDuration(result.tookMs)}`);

	return result;
}

/** Pool the built artifacts and report what moved. */
async function runSync(
	source: Required<LunaSourceConfig>,
	stamp: luna.LunaBuildStamp,
	modules: string[] | undefined,
): Promise<luna.SyncEntry[]> {
	const lock = await loadLock();
	const spin = new Spinner().start("pooling artifacts...");

	const all = await luna.artifacts(source);
	const built = modules?.length
		? all.filter((artifact) => modules.includes(artifact.module))
		: all;

	const results = await luna.sync(lock, built, stamp);

	await saveLock(lock);
	spin.stop();

	if (built.length === 0) {
		warn("no built artifacts found — run mrds luna build first");

		return results;
	}

	for (const entry of results.filter((entry) => entry.action === "registered")) {
		info(
			`registered ${pc.bold(entry.name)} in the lockfile — ` +
				`assign targets with ${pc.cyan(`mrds plugins apply ${entry.name} --to <targets>`)}`,
		);
	}

	const moved = results.filter((entry) => entry.action !== "unchanged");

	for (const entry of moved) {
		ok(`${pc.bold(entry.file)} ${pc.dim(`(${entry.action}, ${entry.version})`)}`);
	}

	if (!moved.length) {
		ok("pool already matches the built jars");
	}

	const unassigned = results.filter((entry) => entry.unassigned);

	if (unassigned.length) {
		warn(
			`no targets set (will not deploy): ${unassigned.map((entry) => entry.name).join(", ")}`,
		);
	}

	return results;
}

command({
	path: ["luna", "build"],
	desc: "Build the luna-plugins workspace (all modules, or the ones named)",
	args: [{ name: "module", variadic: true, complete: lunaModules }],
	opts: [{ flag: "--sync", desc: "also copy the built jars into the pool" }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const source = luna.lunaSource(cfg);
		const result = await runBuild(source, args);

		const artifacts = await luna.artifacts(source);
		const total = artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);

		info(`${artifacts.length} deployable jars in output/ ${pc.dim(`(${fmtBytes(total)})`)}`);

		if (result.stamp.dirty) {
			warn(`source tree has uncommitted changes — jars stamped ${luna.stampVersion(result.stamp)}`);
		}

		if (opts.sync) {
			await runSync(source, result.stamp, args);
		} else {
			info(`pool the result with: ${pc.cyan("mrds luna deploy")}`);
		}
	},
});

command({
	path: ["luna", "sync"],
	desc: "Copy already-built luna jars into the pool and update the lockfile",
	args: [{ name: "module", variadic: true, complete: lunaModules }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const source = luna.lunaSource(cfg);

		await runSync(source, await luna.buildStamp(source), args);

		info(`push to instances with: ${pc.cyan("mrds plugins deploy")}`);
	},
});

command({
	path: ["luna", "deploy"],
	desc: "Build luna plugins, pool them, and push to their target instances",
	args: [{ name: "module", variadic: true, complete: lunaModules }],
	opts: [
		{ flag: "--no-build", desc: "deploy what is already in output/ without rebuilding" },
		{ flag: "--restart", desc: "restart the instances that received a new jar" },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const source = luna.lunaSource(cfg);
		const modules = args.length ? args : undefined;

		const stamp = opts["no-build"]
			? await luna.buildStamp(source)
			: (await runBuild(source, modules)).stamp;

		const synced = await runSync(source, stamp, modules);
		const changed = synced.filter((entry) => entry.action !== "unchanged" && !entry.unassigned);

		if (!changed.length) {
			ok("nothing to deploy — instances already run these jars");

			return;
		}

		// One deploy pass per plugin: core/plugins.deploy() scopes to a single entry.
		for (const entry of changed) {
			await runDeploy(undefined, entry.name);
		}

		if (!opts.restart) {
			return;
		}

		const lock = await loadLock();

		const affected = new Set<string>();

		for (const entry of changed) {
			const { effectiveTargets } = await import("../../core/families");

			for (const target of effectiveTargets(cfg, lock, entry.name)) {
				affected.add(target);
			}
		}

		const instances = await import("../../core/instances");
		const statuses = await instances.getAllStatuses(cfg);

		// Restart backends before the proxy so players are never routed at a dead backend.
		const order = [...affected].sort((a, b) => (a === "proxy" ? 1 : b === "proxy" ? -1 : 0));

		for (const name of order) {
			if (statuses.find((status) => status.name === name)?.state === "stopped") {
				info(`${name} is stopped — leaving it down`);

				continue;
			}

			const spin = new Spinner().start(`restarting ${name}...`);
			const stopped = await instances.stopInstance(cfg, name);

			if (stopped.outcome === "forced") {
				spin.stop();
				fail(`${name} did not stop gracefully — forced`);
			} else {
				spin.stop();
			}

			await instances.startInstance(cfg, name);
			ok(`${pc.bold(name)} restarted`);
		}
	},
});
