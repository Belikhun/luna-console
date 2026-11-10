// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Mèo Béo, the console's chat agent, at the terminal: its state, connecting or
 * disconnecting the Claude credential it runs on, and its settings. Chatting
 * happens in the console; this is the same `core/agent` the settings screen
 * drives.
 *
 * The credential is read from a hidden prompt (or stdin when piped), never from
 * an argument, so it stays out of shell history and `ps`.
 */

import { command, Bail, UsageError } from "../framework";
import { pc, ok, info, warn, printTable, ProgressView } from "../ui";
import { activeUser } from "../actor";
import {
	agentStatus,
	clearAgentCredential,
	setAgentCredential,
	updateAgentSettings,
	type AgentSettingsPatch,
	type AgentStatus,
} from "../../client/core/agent";
import { checkClaudeCode, upgradeClaudeCode } from "../../client/core/claudecode";
import { appendJournal } from "../../client/core/journal";
import { ProgressReporter } from "../../core/progress";
import { t } from "../../shared/i18n";

function stamp(at: number | null | undefined): string {
	if (!at) {
		return pc.dim("—");
	}

	return new Date(at).toLocaleString("en-GB");
}

function printStatus(status: AgentStatus): void {
	const credential = status.credential;
	const state = status.ready
		? pc.green(t("cli.agent.ready"))
		: pc.yellow(status.reason ?? "");

	console.log();
	printTable(
		[
			[t("cli.agent.field.state"), state],
			[
				t("cli.agent.field.credential"),
				credential
					? `${credential.kind === "oauth" ? t("cli.agent.kindOauth") : t("cli.agent.kindApikey")} ${pc.dim(credential.hint)}`
					: pc.dim("—"),
			],
			[t("cli.agent.field.connected"), credential ? `${stamp(credential.setAt)} ${pc.dim(credential.setBy ?? "")}` : pc.dim("—")],
			[t("cli.agent.field.model"), status.settings.model],
			[t("cli.agent.field.effort"), status.settings.effort],
			[t("cli.agent.field.maxTurns"), String(status.settings.maxTurns)],
			[t("cli.agent.field.scratchAttachment"), `${status.settings.scratchAttachmentMb} MB`],
			[t("cli.agent.field.executable"), status.settings.executable || pc.dim(t("cli.agent.auto"))],
			[t("cli.agent.field.token"), status.token ? `${status.token.name} ${pc.dim(`· ${t("cli.agent.tools", { count: status.token.tools.length })}`)}` : pc.dim("—")],
		],
		{ head: [t("cli.head.field"), t("cli.head.value")] },
	);
	console.log();
}

async function readSecret(): Promise<string> {
	if (!process.stdin.isTTY) {
		const piped = (await Bun.stdin.text()).trim();

		if (!piped) {
			throw new UsageError(t("cli.agent.connect.needed"));
		}

		return piped;
	}

	const { password, isCancel, cancel } = await import("@clack/prompts");

	info(t("cli.agent.connect.how", { command: pc.cyan("claude setup-token") }));

	const value = await password({ message: t("cli.agent.connect.prompt") });

	if (isCancel(value)) {
		cancel(t("cli.agent.cancelled"));

		throw new Bail(t("cli.agent.cancelled"));
	}

	return String(value);
}

command({
	path: ["agent"],
	desc: t("cli.agent.desc"),

	handler: async () => {
		printStatus(await agentStatus());
	},
});

command({
	path: ["agent", "connect"],
	desc: t("cli.agent.connect.desc"),

	handler: async () => {
		const status = await setAgentCredential(await readSecret(), activeUser());

		await appendJournal({ source: "cli", message: "Mèo Béo credential set", actor: activeUser() });

		ok(t("cli.agent.connect.done", { kind: status.credential?.kind === "oauth" ? t("cli.agent.kindOauth") : t("cli.agent.kindApikey") }));
		info(t("cli.agent.connect.test"));
	},
});

command({
	path: ["agent", "disconnect"],
	desc: t("cli.agent.disconnect.desc"),
	opts: [{ flag: "--yes", desc: t("cli.agent.optYes") }],

	handler: async (_args, opts) => {
		if (!opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const answer = await confirm({ message: t("cli.agent.disconnect.confirm"), initialValue: false });

			if (isCancel(answer) || !answer) {
				throw new Bail(t("cli.agent.cancelled"));
			}
		}

		await clearAgentCredential(activeUser());
		await appendJournal({ source: "cli", level: "warn", message: "Mèo Béo credential removed", actor: activeUser() });

		ok(t("cli.agent.disconnect.done"));
	},
});

command({
	path: ["agent", "set"],
	desc: t("cli.agent.set.desc"),
	opts: [
		{ flag: "--model", desc: t("cli.agent.set.optModel"), value: true },
		{ flag: "--effort", desc: t("cli.agent.set.optEffort"), value: true },
		{ flag: "--max-turns", desc: t("cli.agent.set.optMaxTurns"), value: true },
		{ flag: "--scratch-attachment-mb", desc: t("cli.agent.set.optScratchAttachment"), value: true },
		{ flag: "--executable", desc: t("cli.agent.set.optExecutable"), value: true },
		{ flag: "--enable", desc: t("cli.agent.set.optEnable") },
		{ flag: "--disable", desc: t("cli.agent.set.optDisable") },
	],

	handler: async (_args, opts) => {
		const patch: AgentSettingsPatch = {};

		if (opts.enable && opts.disable) {
			throw new UsageError(t("cli.agent.set.bothToggles"));
		}

		if (opts.enable || opts.disable) {
			patch.enabled = !!opts.enable;
		}

		if (typeof opts.model === "string") {
			patch.model = opts.model;
		}

		if (typeof opts.effort === "string") {
			patch.effort = opts.effort as AgentSettingsPatch["effort"];
		}

		if (typeof opts["max-turns"] === "string") {
			patch.maxTurns = Number(opts["max-turns"]);
		}

		if (typeof opts["scratch-attachment-mb"] === "string") {
			patch.scratchAttachmentMb = Number(opts["scratch-attachment-mb"]);
		}

		if (typeof opts.executable === "string") {
			patch.executable = opts.executable;
		}

		if (Object.keys(patch).length === 0) {
			throw new UsageError(t("cli.agent.set.nothing"));
		}

		printStatus(await updateAgentSettings(patch, activeUser()));
		ok(t("cli.agent.set.done"));
	},
});

command({
	path: ["agent", "claude"],
	desc: t("cli.agent.claude.desc"),

	handler: async () => {
		const check = await checkClaudeCode();

		console.log();
		printTable(
			[
				[t("cli.agent.claude.field.path"), check.path],
				[t("cli.agent.claude.field.installed"), check.installed ?? pc.dim(t("cli.agent.claude.none"))],
				[t("cli.agent.claude.field.platform"), check.platform],
				[t("cli.agent.claude.field.latest"), check.latest ?? pc.dim("—")],
				[t("cli.agent.claude.field.stable"), check.stable ?? pc.dim("—")],
				[t("cli.agent.claude.field.sdkLatest"), check.sdkLatest ?? pc.dim("—")],
			],
			{ head: [t("cli.head.field"), t("cli.head.value")] },
		);
		console.log();

		for (const problem of check.problems) {
			warn(problem);
		}

		if (!check.writable) {
			warn(t("cli.agent.claude.notWritable", { path: check.path }));
		}

		info(t("cli.agent.claude.pairHint"));
	},
});

command({
	path: ["agent", "claude", "install"],
	desc: t("cli.agent.claude.install.desc"),
	args: [{
		name: "version",
		required: true,
		complete: async () => ["stable", "latest"],
		desc: t("cli.agent.claude.install.argVersion"),
	}],
	opts: [{ flag: "--yes", desc: t("cli.agent.optYes") }],

	handler: async (args, opts) => {
		const version = String(args[0] ?? "").trim();

		if (!/^(\d+\.\d+\.\d+|stable|latest)$/.test(version)) {
			throw new UsageError(t("cli.agent.claude.install.badVersion", { version }));
		}

		if (!opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const answer = await confirm({ message: t("cli.agent.claude.install.confirm", { version }), initialValue: true });

			if (isCancel(answer) || !answer) {
				throw new Bail(t("cli.agent.cancelled"));
			}
		}

		const progress = new ProgressReporter(t("cli.agent.claude.install.progressName"));
		const view = new ProgressView(progress).start();

		try {
			const result = await upgradeClaudeCode({ version, actor: activeUser(), reporter: progress });

			view.stop();
			ok(t("cli.agent.claude.install.done", { from: result.from ?? "—", to: result.to }));

			if (result.previous) {
				info(t("cli.agent.claude.install.kept", { path: result.previous }));
			}
		} catch (err) {
			view.stop();

			throw err;
		}
	},
});
