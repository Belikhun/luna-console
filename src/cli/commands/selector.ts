import { command, Bail } from "../framework";
import { pc, Sym, ok, warn, info, fail, printTable, ProgressView } from "../ui";
import { loadCluster } from "../../client/core/config";
import { ProgressReporter } from "../../client/core/progress";
import * as selector from "../../client/core/selector";
import type { SelectorIssue } from "../../client/core/selector";

/** One line per validation issue, errors first. */
function printIssues(issues: SelectorIssue[]): void {
	if (issues.length === 0) {
		return;
	}

	const rows = [...issues]
		.sort((left, right) => (left.level === right.level ? 0 : left.level === "error" ? -1 : 1))
		.map((issue) => [
			issue.level === "error" ? `${Sym.bad} ${pc.red("error")}` : `${Sym.warn} ${pc.yellow("warn")}`,
			pc.dim(issue.path),
			issue.message,
		]);

	console.log();
	printTable(rows, { head: ["", "where", "problem"] });
}

function printDiff(diff: string[]): void {
	if (diff.length === 0) {
		return;
	}

	console.log();
	info("differences between the file and what luna would generate:");

	for (const line of diff.slice(0, 40)) {
		console.log(`  ${pc.dim("·")} ${line}`);
	}

	if (diff.length > 40) {
		console.log(`  ${pc.dim(`… and ${diff.length - 40} more`)}`);
	}
}

command({
	path: ["selector", "status"],
	desc: "Show the server selector: placement, validation and drift from servers.yml",

	handler: async () => {
		const cfg = await loadCluster();
		const state = await selector.state(cfg);
		const draft = await selector.draft(cfg);

		const rows = Object.entries(draft.servers)
			.filter(([, server]) => selector.isPlaced(server))
			.sort(([, left], [, right]) => {
				const a = left.selector!;
				const b = right.selector!;

				return a.page - b.page || a.slot - b.slot;
			})
			.map(([name, server]) => [
				pc.bold(name),
				`${server.selector?.page}:${String(server.selector?.slot).padStart(2, " ")}`,
				server.serverIcon ?? pc.dim("(by status)"),
				server.accentColor ? pc.dim(server.accentColor) : pc.dim("—"),
				`${(server.description ?? []).length} line(s)`,
				pc.dim(server.hostName),
			]);

		console.log();
		printTable(rows, { head: ["server", "page:slot", "material", "accent", "description", "host"] });

		console.log();
		info(
			`${state.placed} server(s) across ${state.pages} page(s) · ` +
				(state.configured ? pc.green("configured in cluster.json") : pc.yellow("not configured — run luna selector migrate")),
		);

		if (!state.fileExists) {
			warn(`no servers.yml yet — apply will create it`);
		} else if (state.drift) {
			warn(`servers.yml differs from cluster.json (${state.driftPaths.length} path(s)) — apply to bring it in line`);
			printDiff(state.driftPaths);
		} else {
			ok("servers.yml matches cluster.json");
		}

		if (!state.proxyReachable) {
			warn("the proxy's HTTP API did not answer — apply can write the file but not reload it");
		}

		printIssues(state.issues);
	},
});

command({
	path: ["selector", "check"],
	desc: "Validate the selector the way the proxy would before a reload",

	handler: async () => {
		const cfg = await loadCluster();
		const issues = (await selector.state(cfg)).issues;
		const errors = selector.selectorErrors(issues);

		printIssues(issues);

		if (errors.length > 0) {
			throw new Bail(`${errors.length} error(s) — the proxy would refuse to reload`);
		}

		ok(issues.length ? `no errors, ${issues.length} warning(s)` : "no issues");
	},
});

command({
	path: ["selector", "preview"],
	desc: "Print the servers.yml luna would generate, without writing it",

	handler: async () => {
		const cfg = await loadCluster();

		console.log(await selector.preview(cfg));
	},
});

command({
	path: ["selector", "migrate"],
	desc: "Import the existing servers.yml into cluster.json (one-time)",
	opts: [
		{ flag: "--dry-run", desc: "report what would be imported, saving nothing" },
		{ flag: "--force", desc: "save even when the round-trip check finds differences" },
		{ flag: "--yes", desc: "skip the confirmation" },
	],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();

		if (!opts["dry-run"] && !opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const sure = await confirm({
				message: "Import servers.yml into cluster.json? This rewrites the selector metadata of every matching instance.",
			});

			if (isCancel(sure) || !sure) {
				info("aborted");

				return;
			}
		}

		const report = await selector.importServersYml(cfg, {
			dryRun: !!opts["dry-run"],
			force: !!opts.force,
		});

		for (const message of report.warnings) {
			warn(message);
		}

		info(`${report.imported.length} instance(s): ${report.imported.join(", ") || pc.dim("none")}`);

		if (report.equal) {
			ok("round-trip check passed — regenerating reproduces the current configuration");
		} else {
			fail(`round-trip check failed on ${report.diff.length} path(s)`);
			printDiff(report.diff);
		}

		if (report.saved) {
			ok("cluster.json updated");

			return;
		}

		if (opts["dry-run"]) {
			info("dry run — nothing saved");

			return;
		}

		throw new Bail("nothing saved — re-run with --force to import anyway");
	},
});

command({
	path: ["selector", "apply"],
	desc: "Generate servers.yml from cluster.json and reload the proxy",
	opts: [{ flag: "--yes", desc: "skip the confirmation" }],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();
		const state = await selector.state(cfg);
		const errors = selector.selectorErrors(state.issues);

		if (errors.length > 0) {
			printIssues(state.issues);

			throw new Bail(`${errors.length} error(s) — fix them before applying`);
		}

		if (!opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const sure = await confirm({
				message: `Write servers.yml (${state.placed} server(s)) and reload the live proxy?`,
			});

			if (isCancel(sure) || !sure) {
				info("aborted");

				return;
			}
		}

		const progress = new ProgressReporter("apply selector");
		const view = new ProgressView(progress).start();

		try {
			const result = await selector.apply(cfg, { reporter: progress });

			view.stop();

			ok(`servers.yml written (${result.placed} server(s))`);

			if (result.proxyReloaded) {
				ok("proxy reloaded — backends pick the new layout up on their next heartbeat");
			} else {
				warn("the proxy did not reload — run /lunacoreproxy reload there, or restart it");
			}

			if (result.reloadOutput) {
				info(result.reloadOutput);
			}
		} catch (err) {
			view.stop();

			throw err;
		}
	},
});
