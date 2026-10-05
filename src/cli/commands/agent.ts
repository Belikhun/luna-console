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
import { pc, ok, info, printTable } from "../ui";
import { activeUser } from "../actor";
import {
	agentStatus,
	clearAgentCredential,
	setAgentCredential,
	updateAgentSettings,
	type AgentSettingsPatch,
	type AgentStatus,
} from "../../client/core/agent";
import { appendJournal } from "../../client/core/journal";
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
