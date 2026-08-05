import { command, Bail } from "../framework";
import { pc, Sym, ok, warn, info, fail, printTable, Spinner, fmtDuration, fmtBytes } from "../ui";
import { lunaModules } from "../completers";
import { loadCluster, loadLock, saveLock } from "../../client/core/config";
import * as luna from "../../client/core/luna";
import { ProgressReporter } from "../../client/core/progress";
import type { LunaState, LunaStatusRow } from "../../client/core/luna";
import type { LunaSourceConfig } from "../../client/core/types";
import { runDeploy } from "./plugins";
import { t } from "../../shared/i18n";

/** Coloured label for how far a module has travelled from source to instances. */
function stateBadge(state: LunaState): string {
	switch (state) {
		case "in-sync":
			return `${Sym.ok} ${pc.green(t("cli.luna.stateInSync"))}`;

		case "needs-deploy":
			return `${Sym.warn} ${pc.yellow(t("cli.luna.stateNeedsDeploy"))}`;

		case "stale-pool":
			return `${Sym.warn} ${pc.yellow(t("cli.luna.stateStalePool"))}`;

		case "unregistered":
			return `${Sym.off} ${pc.dim(t("cli.luna.stateUnregistered"))}`;

		default:
			return `${Sym.off} ${pc.dim(t("cli.luna.stateNotBuilt"))}`;
	}
}

/** Relative age of a build, or a dim placeholder when the jar is missing. */
function age(builtAt: Date | string | undefined): string {
	if (!builtAt) {
		return pc.dim("—");
	}

	// dates cross the daemon socket as ISO strings; normalize before math
	return pc.dim(t("cli.luna.ago", { duration: fmtDuration(Date.now() - new Date(builtAt).getTime()) }));
}

/** Render the status table plus its one-line summary. */
function printStatus(rows: LunaStatusRow[], stamp: luna.LunaBuildStamp, dir: string): void {
	const table = rows.map((row) => [
		stateBadge(row.state),
		pc.bold(row.module),
		row.platform === "velocity" ? pc.cyan(row.platform) : row.platform,
		row.pooledVersion ?? pc.dim("—"),
		age(row.builtAt),
		row.targets.length ? row.targets.join(",") : pc.red(`(${t("cli.common.none")})`),
		row.drifted.length ? pc.yellow(row.drifted.join(",")) : pc.dim("—"),
	]);

	console.log();
	printTable(table, {
		head: [
			t("cli.head.state"),
			t("cli.head.module"),
			t("cli.head.platform"),
			t("cli.head.pooledVersion"),
			t("cli.head.built"),
			t("cli.head.targets"),
			t("cli.head.drifted"),
		],
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
			`\n  ${t("cli.luna.modulesSummary", { count: rows.length, summary })}` +
				`\n  ${t("cli.luna.sourceLine", { dir, version: luna.stampVersion(stamp) })}` +
				(stamp.dirty ? pc.yellow(` ${t("cli.luna.dirtyTag")}`) : "") +
				"\n",
		),
	);
}

command({
	path: ["luna", "status"],
	desc: t("cli.luna.status.desc"),

	handler: async () => {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const source = luna.lunaSource(cfg);
		const spin = new Spinner().start(t("cli.luna.status.hashing"));

		const rows = await luna.status(cfg, lock, source);
		const stamp = await luna.buildStamp(source);
		const stray = await luna.strayArtifacts(source);

		spin.stop();
		printStatus(rows, stamp, source.dir);

		for (const file of stray) {
			warn(t("cli.luna.status.stray", { file }));
		}
	},
});

/**
 * Run the gradle build, showing the task it is on. Gradle's own progress lines
 * are kept out of the spinner label (only `> Task :x:y` lines advance it), and
 * the tail of the log is printed on failure, since that is where the compiler
 * error is.
 */
async function runBuild(
	source: Required<LunaSourceConfig>,
	modules: string[] | undefined,
): Promise<luna.BuildResult> {
	const label = modules?.length ? modules.join(", ") : t("cli.luna.allModules");
	const spin = new Spinner().start(t("cli.luna.building", { label }));

	// the build runs in the daemon; gradle's output lines arrive as progress
	// messages, and only `> Task :x:y` lines advance the spinner label
	const reporter = new ProgressReporter(`build ${label}`);

	reporter.onUpdate((update) => {
		const task = /^> Task (\S+)/.exec(update.message ?? "");

		if (task) {
			spin.update(`${t("cli.luna.building", { label })} ${pc.dim(task[1]!)}`);
		}
	});

	const result = await luna.build(source, { modules, reporter });

	spin.stop();

	if (!result.ok) {
		for (const line of result.log.slice(-25)) {
			console.error(pc.dim(line));
		}

		throw new Bail(t("cli.luna.buildFailed", { code: result.exitCode ?? -1 }));
	}

	ok(t("cli.luna.buildSucceeded", { duration: fmtDuration(result.tookMs) }));

	return result;
}

/** Pool the built artifacts and report what moved. */
async function runSync(
	source: Required<LunaSourceConfig>,
	stamp: luna.LunaBuildStamp,
	modules: string[] | undefined,
): Promise<luna.SyncEntry[]> {
	const lock = await loadLock();
	const spin = new Spinner().start(t("cli.luna.pooling"));

	const all = await luna.artifacts(source);
	const built = modules?.length
		? all.filter((artifact) => modules.includes(artifact.module))
		: all;

	const results = await luna.sync(lock, built, stamp);

	await saveLock(lock);
	spin.stop();

	if (built.length === 0) {
		warn(t("cli.luna.noArtifacts"));

		return results;
	}

	for (const entry of results.filter((entry) => entry.action === "registered")) {
		info(
			t("cli.luna.registered", {
				name: pc.bold(entry.name),
				command: pc.cyan(`luna plugins apply ${entry.name} --to <targets>`),
			}),
		);
	}

	const moved = results.filter((entry) => entry.action !== "unchanged");

	for (const entry of moved) {
		ok(`${pc.bold(entry.file)} ${pc.dim(`(${entry.action}, ${entry.version})`)}`);
	}

	if (!moved.length) {
		ok(t("cli.luna.poolMatches"));
	}

	const unassigned = results.filter((entry) => entry.unassigned);

	if (unassigned.length) {
		warn(
			t("cli.luna.noTargets", { names: unassigned.map((entry) => entry.name).join(", ") }),
		);
	}

	return results;
}

command({
	path: ["luna", "build"],
	desc: t("cli.luna.build.desc"),
	args: [{ name: "module", variadic: true, complete: lunaModules }],
	opts: [{ flag: "--sync", desc: t("cli.luna.build.optSync") }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const source = luna.lunaSource(cfg);
		const result = await runBuild(source, args);

		const artifacts = await luna.artifacts(source);
		const total = artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);

		info(
			`${t("cli.luna.build.jarCount", { count: artifacts.length })} ${pc.dim(`(${fmtBytes(total)})`)}`,
		);

		if (result.stamp.dirty) {
			warn(t("cli.luna.build.dirty", { version: luna.stampVersion(result.stamp) }));
		}

		if (opts.sync) {
			await runSync(source, result.stamp, args);
		} else {
			info(t("cli.luna.build.poolHint", { command: pc.cyan("luna luna deploy") }));
		}
	},
});

command({
	path: ["luna", "sync"],
	desc: t("cli.luna.sync.desc"),
	args: [{ name: "module", variadic: true, complete: lunaModules }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const source = luna.lunaSource(cfg);

		await runSync(source, await luna.buildStamp(source), args);

		info(t("cli.luna.sync.pushHint", { command: pc.cyan("luna plugins deploy") }));
	},
});

command({
	path: ["luna", "deploy"],
	desc: t("cli.luna.deploy.desc"),
	args: [{ name: "module", variadic: true, complete: lunaModules }],
	opts: [
		{ flag: "--no-build", desc: t("cli.luna.deploy.optNoBuild") },
		{ flag: "--restart", desc: t("cli.luna.deploy.optRestart") },
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
			ok(t("cli.luna.deploy.nothing"));

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
			const { effectiveTargets } = await import("../../client/core/families");

			for (const target of effectiveTargets(cfg, lock, entry.name)) {
				affected.add(target);
			}
		}

		const instances = await import("../../client/core/instances");
		const statuses = await instances.getAllStatuses(cfg);

		// Restart backends before the proxy so players are never routed at a dead backend.
		const order = [...affected].sort((a, b) => (a === "proxy" ? 1 : b === "proxy" ? -1 : 0));

		for (const name of order) {
			if (statuses.find((status) => status.name === name)?.state === "stopped") {
				info(t("cli.luna.deploy.leftDown", { name }));

				continue;
			}

			const spin = new Spinner().start(t("cli.luna.deploy.restarting", { name }));
			const stopped = await instances.stopInstance(cfg, name);

			if (stopped.outcome === "forced") {
				spin.stop();
				fail(t("cli.luna.deploy.forced", { name }));
			} else {
				spin.stop();
			}

			await instances.startInstance(cfg, name);
			ok(t("cli.luna.deploy.restarted", { name: pc.bold(name) }));
		}
	},
});
