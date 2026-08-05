// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { command, Bail } from "../framework";
import { pc, Sym, ok, warn, info, fail, printTable, ProgressView } from "../ui";
import { loadCluster } from "../../client/core/config";
import { ProgressReporter } from "../../client/core/progress";
import * as selector from "../../client/core/selector";
import type { SelectorIssue } from "../../client/core/selector";
import { t } from "../../shared/i18n";

/** One line per validation issue, errors first. */
function printIssues(issues: SelectorIssue[]): void {
	if (issues.length === 0) {
		return;
	}

	const rows = [...issues]
		.sort((left, right) => (left.level === right.level ? 0 : left.level === "error" ? -1 : 1))
		.map((issue) => [
			issue.level === "error"
				? `${Sym.bad} ${pc.red(t("cli.level.error"))}`
				: `${Sym.warn} ${pc.yellow(t("cli.level.warn"))}`,
			pc.dim(issue.path),
			issue.message,
		]);

	console.log();
	printTable(rows, { head: ["", t("cli.head.where"), t("cli.head.problem")] });
}

function printDiff(diff: string[]): void {
	if (diff.length === 0) {
		return;
	}

	console.log();
	info(t("cli.selector.diffHeading"));

	for (const line of diff.slice(0, 40)) {
		console.log(`  ${pc.dim("·")} ${line}`);
	}

	if (diff.length > 40) {
		console.log(`  ${pc.dim(t("cli.selector.diffMore", { count: diff.length - 40 }))}`);
	}
}

command({
	path: ["selector", "status"],
	desc: t("cli.selector.status.desc"),

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
				server.serverIcon ?? pc.dim(t("cli.selector.status.byStatus")),
				server.accentColor ? pc.dim(server.accentColor) : pc.dim("—"),
				t("cli.selector.status.lines", { count: (server.description ?? []).length }),
				pc.dim(server.hostName),
			]);

		console.log();
		printTable(rows, {
			head: [
				t("cli.head.server"),
				t("cli.head.pageSlot"),
				t("cli.head.material"),
				t("cli.head.accent"),
				t("cli.head.description"),
				t("cli.head.host"),
			],
		});

		console.log();
		info(
			`${t("cli.selector.status.placement", { placed: state.placed, pages: state.pages })} · ` +
				(state.configured
					? pc.green(t("cli.selector.status.configured"))
					: pc.yellow(t("cli.selector.status.notConfigured"))),
		);

		if (!state.fileExists) {
			warn(t("cli.selector.status.noFile"));
		} else if (state.drift) {
			warn(t("cli.selector.status.drift", { count: state.driftPaths.length }));
			printDiff(state.driftPaths);
		} else {
			ok(t("cli.selector.status.matches"));
		}

		if (!state.proxyReachable) {
			warn(t("cli.selector.status.proxyUnreachable"));
		}

		printIssues(state.issues);
	},
});

command({
	path: ["selector", "check"],
	desc: t("cli.selector.check.desc"),

	handler: async () => {
		const cfg = await loadCluster();
		const issues = (await selector.state(cfg)).issues;
		const errors = selector.selectorErrors(issues);

		printIssues(issues);

		if (errors.length > 0) {
			throw new Bail(t("cli.selector.check.wouldRefuse", { count: errors.length }));
		}

		ok(
			issues.length
				? t("cli.selector.check.warningsOnly", { count: issues.length })
				: t("cli.selector.check.noIssues"),
		);
	},
});

command({
	path: ["selector", "preview"],
	desc: t("cli.selector.preview.desc"),

	handler: async () => {
		const cfg = await loadCluster();

		console.log(await selector.preview(cfg));
	},
});

command({
	path: ["selector", "migrate"],
	desc: t("cli.selector.migrate.desc"),
	opts: [
		{ flag: "--dry-run", desc: t("cli.selector.migrate.optDryRun") },
		{ flag: "--force", desc: t("cli.selector.migrate.optForce") },
		{ flag: "--yes", desc: t("cli.common.optYes") },
	],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();

		if (!opts["dry-run"] && !opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const sure = await confirm({ message: t("cli.selector.migrate.confirm") });

			if (isCancel(sure) || !sure) {
				info(t("cli.common.aborted"));

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

		info(
			t("cli.selector.migrate.imported", {
				count: report.imported.length,
				names: report.imported.join(", ") || pc.dim(t("cli.common.none")),
			}),
		);

		if (report.equal) {
			ok(t("cli.selector.migrate.roundTripOk"));
		} else {
			fail(t("cli.selector.migrate.roundTripFailed", { count: report.diff.length }));
			printDiff(report.diff);
		}

		if (report.saved) {
			ok(t("cli.selector.migrate.saved"));

			return;
		}

		if (opts["dry-run"]) {
			info(t("cli.selector.migrate.dryRun"));

			return;
		}

		throw new Bail(t("cli.selector.migrate.nothingSaved"));
	},
});

command({
	path: ["selector", "apply"],
	desc: t("cli.selector.apply.desc"),
	opts: [{ flag: "--yes", desc: t("cli.common.optYes") }],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();
		const state = await selector.state(cfg);
		const errors = selector.selectorErrors(state.issues);

		if (errors.length > 0) {
			printIssues(state.issues);

			throw new Bail(t("cli.selector.apply.fixFirst", { count: errors.length }));
		}

		if (!opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const sure = await confirm({
				message: t("cli.selector.apply.confirm", { count: state.placed }),
			});

			if (isCancel(sure) || !sure) {
				info(t("cli.common.aborted"));

				return;
			}
		}

		const progress = new ProgressReporter(t("cli.selector.apply.progressName"));
		const view = new ProgressView(progress).start();

		try {
			const result = await selector.apply(cfg, { reporter: progress });

			view.stop();

			ok(t("cli.selector.apply.written", { count: result.placed }));

			if (result.proxyReloaded) {
				ok(t("cli.selector.apply.reloaded"));
			} else {
				warn(t("cli.selector.apply.notReloaded"));
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
