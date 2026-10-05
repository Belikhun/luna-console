// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * MCP tokens, their call log, and the knowledge the MCP endpoint serves, at the
 * terminal. Every verb is a bridge call into `core/mcp`, the same functions the
 * console's MCP screens use, so the two can never disagree about what a token may
 * do.
 */

import { command, Bail, UsageError } from "../framework";
import { pc, ok, info, warn, printTable } from "../ui";
import { activeUser } from "../actor";
import {
	createKnowledge,
	createMcpToken,
	getKnowledge,
	getMcpToken,
	KNOWLEDGE_KINDS,
	listKnowledge,
	listMcpTokens,
	mcpAudit,
	readMcpCalls,
	removeKnowledge,
	removeMcpToken,
	rotateMcpToken,
	setMcpTokenEnabled,
	updateKnowledge,
	updateMcpToken,
	type KnowledgeKind,
	type McpTokenSecret,
	type McpTokenSummary,
} from "../../client/core/mcp";
import { appendJournal } from "../../client/core/journal";
import { MCP_TOOL_GROUPS, MCP_TOOLS, type McpScope, type McpToolGroup } from "../../shared/mcptools";
import { t } from "../../shared/i18n";

const DAY_MS = 24 * 60 * 60 * 1000;

function stamp(at: number | null | undefined): string {
	if (!at) {
		return pc.dim("—");
	}

	return new Date(at).toLocaleString("en-GB");
}

function paintState(token: McpTokenSummary): string {
	if (!token.enabled) {
		return pc.dim(t("cli.mcp.stateDisabled"));
	}

	if (token.expired) {
		return pc.red(t("cli.mcp.stateExpired"));
	}

	return pc.green(t("cli.mcp.stateActive"));
}

function instanceList(token: McpTokenSummary): string {
	if (token.scope.instances === null) {
		return "*";
	}

	return token.scope.instances.join(", ") || pc.dim("—");
}

function list(value: unknown): string[] | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/** The scope flags shared by `token add` and `token update`, as a partial scope. */
function scopeFlags(opts: Record<string, unknown>): Partial<McpScope> | undefined {
	const scope: Partial<McpScope> = {};
	const groups = list(opts.groups);

	if (groups) {
		const unknown = groups.filter((group) => !MCP_TOOL_GROUPS.includes(group as McpToolGroup));

		if (unknown.length > 0) {
			throw new UsageError(
				t("cli.mcp.unknownGroups", { groups: unknown.join(", "), known: MCP_TOOL_GROUPS.join(", ") }),
			);
		}

		scope.groups = groups as McpToolGroup[];
	}

	const allow = list(opts.allow);
	const deny = list(opts.deny);

	if (allow) {
		scope.allow = allow;
	}

	if (deny) {
		scope.deny = deny;
	}

	if (opts["all-instances"]) {
		scope.instances = null;
	} else if (typeof opts.instances === "string") {
		scope.instances = list(opts.instances) ?? [];
	}

	return Object.keys(scope).length > 0
		? scope
		: undefined;
}

function expiryFlag(opts: Record<string, unknown>): number | null | undefined {
	if (opts["no-expiry"]) {
		return null;
	}

	if (typeof opts["expires-days"] !== "string") {
		return undefined;
	}

	const days = Number(opts["expires-days"]);

	if (!Number.isFinite(days) || days <= 0) {
		throw new UsageError(t("cli.mcp.badDays"));
	}

	return Date.now() + days * DAY_MS;
}

async function confirmOrBail(message: string, opts: Record<string, unknown>): Promise<void> {
	if (opts.yes) {
		return;
	}

	const { confirm, isCancel } = await import("@clack/prompts");
	const answer = await confirm({ message, initialValue: false });

	if (isCancel(answer) || !answer) {
		throw new Bail(t("cli.mcp.cancelled"));
	}
}

/** Print a freshly minted bearer: the one time it exists outside the client. */
function printSecret(result: McpTokenSecret): void {
	console.log();
	warn(t("cli.mcp.secretOnce"));
	console.log(`  ${pc.bold(result.bearer)}`);
	console.log();
	info(t("cli.mcp.secretUse", { header: pc.cyan("Authorization: Bearer <token>"), path: pc.cyan("/api/mcp") }));
	console.log();
}

async function tokenNames(): Promise<string[]> {
	try {
		return (await listMcpTokens()).map((token) => token.name);
	} catch {
		return [];
	}
}

const SCOPE_OPTS = [
	{ flag: "--groups", desc: t("cli.mcp.optGroups"), value: true },
	{ flag: "--allow", desc: t("cli.mcp.optAllow"), value: true },
	{ flag: "--deny", desc: t("cli.mcp.optDeny"), value: true },
	{ flag: "--instances", desc: t("cli.mcp.optInstances"), value: true },
	{ flag: "--all-instances", desc: t("cli.mcp.optAllInstances") },
	{ flag: "--expires-days", desc: t("cli.mcp.optExpiresDays"), value: true },
	{ flag: "--no-expiry", desc: t("cli.mcp.optNoExpiry") },
	{ flag: "--description", desc: t("cli.mcp.optDescription"), value: true },
];

command({
	path: ["mcp", "tokens"],
	desc: t("cli.mcp.tokens.desc"),

	handler: async () => {
		const tokens = await listMcpTokens();

		if (tokens.length === 0) {
			console.log();
			warn(t("cli.mcp.tokens.none"));
			info(t("cli.mcp.tokens.createHint", { command: pc.cyan("luna mcp token add <name>") }));
			console.log();

			return;
		}

		const rows = tokens.map((token) => [
			pc.bold(token.name),
			paintState(token),
			token.scope.groups.join(", ") || pc.dim("—"),
			String(token.tools.length),
			instanceList(token),
			`${token.stats.calls}${token.stats.failures ? pc.dim(` · ${token.stats.failures} ✗`) : ""}`,
			stamp(token.lastUsedAt),
		]);

		console.log();
		printTable(rows, {
			head: [
				t("cli.head.name"),
				t("cli.head.state"),
				t("cli.mcp.head.groups"),
				t("cli.mcp.head.tools"),
				t("cli.mcp.head.instances"),
				t("cli.mcp.head.calls"),
				t("cli.mcp.head.lastUsed"),
			],
		});
		console.log();
	},
});

command({
	path: ["mcp", "token", "show"],
	desc: t("cli.mcp.show.desc"),
	args: [{ name: "token", required: true, complete: tokenNames }],

	handler: async (args) => {
		const token = await getMcpToken(args[0]!);

		if (!token) {
			throw new Bail(t("core.mcp.unknownToken", { name: args[0]! }));
		}

		console.log();
		info(`${pc.bold(token.name)} ${paintState(token)}`);
		printTable(
			[
				[t("cli.mcp.field.id"), pc.dim(token.id)],
				[t("cli.mcp.field.description"), token.description || pc.dim("—")],
				[t("cli.mcp.field.groups"), token.scope.groups.join(", ") || pc.dim("—")],
				[t("cli.mcp.field.allow"), token.scope.allow.join(", ") || pc.dim("—")],
				[t("cli.mcp.field.deny"), token.scope.deny.join(", ") || pc.dim("—")],
				[t("cli.mcp.field.instances"), instanceList(token)],
				[t("cli.mcp.field.created"), `${stamp(token.createdAt)} ${pc.dim(token.createdBy ?? "")}`],
				[t("cli.mcp.field.lastUsed"), stamp(token.lastUsedAt)],
				[t("cli.mcp.field.expires"), stamp(token.expiresAt)],
				[t("cli.mcp.field.rotated"), stamp(token.rotatedAt)],
				[t("cli.mcp.field.calls"), `${token.stats.calls} (${token.stats.failures} ✗)`],
			],
			{ head: [t("cli.head.field"), t("cli.head.value")] },
		);
		console.log();
		info(t("cli.mcp.show.tools", { count: token.tools.length }));
		console.log(`  ${token.tools.join(pc.dim(" · ")) || pc.dim("—")}`);
		console.log();
	},
});

command({
	path: ["mcp", "token", "add"],
	desc: t("cli.mcp.add.desc"),
	args: [{ name: "name", required: true }],
	opts: SCOPE_OPTS,

	handler: async (args, opts) => {
		const result = await createMcpToken(
			{
				name: args[0]!,
				description: opts.description as string | undefined,
				expiresAt: expiryFlag(opts) ?? null,
				scope: scopeFlags(opts),
			},
			activeUser(),
		);

		await appendJournal({ source: "cli", message: `MCP token ${result.token.name} created`, actor: activeUser() });

		ok(t("cli.mcp.add.created", { name: pc.bold(result.token.name), count: result.token.tools.length }));
		printSecret(result);
	},
});

command({
	path: ["mcp", "token", "update"],
	desc: t("cli.mcp.update.desc"),
	args: [{ name: "token", required: true, complete: tokenNames }],
	opts: [...SCOPE_OPTS, { flag: "--name", desc: t("cli.mcp.optName"), value: true }],

	handler: async (args, opts) => {
		const token = await updateMcpToken(
			args[0]!,
			{
				name: opts.name as string | undefined,
				description: opts.description as string | undefined,
				expiresAt: expiryFlag(opts),
				scope: scopeFlags(opts),
			},
			activeUser(),
		);

		ok(t("cli.mcp.update.done", { name: pc.bold(token.name), count: token.tools.length }));
	},
});

for (const enabled of [true, false]) {
	command({
		path: ["mcp", "token", enabled ? "enable" : "disable"],
		desc: enabled
			? t("cli.mcp.enable.desc")
			: t("cli.mcp.disable.desc"),
		args: [{ name: "token", required: true, complete: tokenNames }],

		handler: async (args) => {
			const token = await setMcpTokenEnabled(args[0]!, enabled, activeUser());

			await appendJournal({
				source: "cli",
				message: `MCP token ${token.name} ${enabled ? "enabled" : "disabled"}`,
				actor: activeUser(),
			});

			const message = enabled
				? t("cli.mcp.enable.done", { name: pc.bold(token.name) })
				: t("cli.mcp.disable.done", { name: pc.bold(token.name) });

			ok(message);
		},
	});
}

command({
	path: ["mcp", "token", "rotate"],
	desc: t("cli.mcp.rotate.desc"),
	args: [{ name: "token", required: true, complete: tokenNames }],
	opts: [{ flag: "--yes", desc: t("cli.mcp.optYes") }],

	handler: async (args, opts) => {
		const token = await getMcpToken(args[0]!);

		if (!token) {
			throw new Bail(t("core.mcp.unknownToken", { name: args[0]! }));
		}

		await confirmOrBail(t("cli.mcp.rotate.confirm", { name: token.name }), opts);

		const result = await rotateMcpToken(token.id, activeUser());

		await appendJournal({ source: "cli", level: "warn", message: `MCP token ${token.name} rotated`, actor: activeUser() });

		ok(t("cli.mcp.rotate.done", { name: pc.bold(token.name) }));
		printSecret(result);
	},
});

command({
	path: ["mcp", "token", "remove"],
	desc: t("cli.mcp.remove.desc"),
	args: [{ name: "token", required: true, complete: tokenNames }],
	opts: [{ flag: "--yes", desc: t("cli.mcp.optYes") }],

	handler: async (args, opts) => {
		const token = await getMcpToken(args[0]!);

		if (!token) {
			throw new Bail(t("core.mcp.unknownToken", { name: args[0]! }));
		}

		await confirmOrBail(t("cli.mcp.remove.confirm", { name: token.name }), opts);

		const result = await removeMcpToken(token.id, activeUser());

		await appendJournal({ source: "cli", level: "warn", message: `MCP token ${token.name} removed`, actor: activeUser() });

		ok(t("cli.mcp.remove.done", { name: pc.bold(token.name), count: result.knowledgeRemoved }));
	},
});

command({
	path: ["mcp", "tools"],
	desc: t("cli.mcp.tools.desc"),

	handler: async () => {
		const rows = MCP_TOOLS.map((tool) => [
			pc.bold(tool.name),
			tool.group,
			tool.annotations.destructiveHint
				? pc.yellow(t("cli.mcp.tools.changesState"))
				: tool.annotations.readOnlyHint
					? pc.dim(t("cli.mcp.tools.readOnly"))
					: "",
			pc.dim(tool.description),
		]);

		console.log();
		printTable(rows, { head: [t("cli.head.name"), t("cli.mcp.head.group"), "", t("cli.mcp.head.description")] });
		console.log();
	},
});

command({
	path: ["mcp", "calls"],
	desc: t("cli.mcp.calls.desc"),
	opts: [
		{ flag: "--token", desc: t("cli.mcp.calls.optToken"), value: true, complete: tokenNames },
		{ flag: "--tool", desc: t("cli.mcp.calls.optTool"), value: true, complete: async () => MCP_TOOLS.map((tool) => tool.name) },
		{ flag: "--failed", desc: t("cli.mcp.calls.optFailed") },
		{ flag: "--search", desc: t("cli.mcp.calls.optSearch"), value: true },
		{ flag: "--limit", desc: t("cli.mcp.calls.optLimit"), value: true },
	],

	handler: async (_args, opts) => {
		let tokenId: string | undefined;

		if (typeof opts.token === "string") {
			const token = await getMcpToken(opts.token);

			if (!token) {
				throw new Bail(t("core.mcp.unknownToken", { name: opts.token }));
			}

			tokenId = token.id;
		}

		const page = await readMcpCalls({
			token: tokenId,
			tool: opts.tool as string | undefined,
			ok: opts.failed ? false : undefined,
			search: opts.search as string | undefined,
			limit: Number(opts.limit ?? 50),
		});

		if (page.calls.length === 0) {
			warn(t("cli.mcp.calls.none"));

			return;
		}

		const rows = page.calls.map((call) => [
			stamp(call.t),
			call.ok
				? pc.green("ok")
				: pc.red("✗"),
			pc.bold(call.tool),
			call.tokenName,
			typeof call.onBehalfOf?.label === "string"
				? call.onBehalfOf.label
				: pc.dim("—"),
			`${call.durationMs} ms`,
			pc.dim((call.error ?? call.args ?? "").slice(0, 80)),
		]);

		console.log();
		printTable(rows, {
			head: [
				t("cli.mcp.head.when"),
				"",
				t("cli.mcp.head.tool"),
				t("cli.mcp.head.token"),
				t("cli.mcp.head.onBehalfOf"),
				t("cli.mcp.head.duration"),
				t("cli.mcp.head.detail"),
			],
		});

		if (page.truncated) {
			info(t("cli.mcp.calls.truncated", { count: page.calls.length }));
		}

		console.log();
	},
});

command({
	path: ["mcp", "audit"],
	desc: t("cli.mcp.audit.desc"),
	opts: [
		{ flag: "--token", desc: t("cli.mcp.calls.optToken"), value: true, complete: tokenNames },
		{ flag: "--limit", desc: t("cli.mcp.calls.optLimit"), value: true },
	],

	handler: async (_args, opts) => {
		const entries = await mcpAudit({ token: opts.token as string | undefined, limit: Number(opts.limit ?? 50) });

		if (entries.length === 0) {
			warn(t("cli.mcp.audit.none"));

			return;
		}

		console.log();
		printTable(
			entries.map((entry) => [stamp(entry.t), pc.bold(entry.action), entry.actor ?? pc.dim("—"), pc.dim(entry.detail ?? "")]),
			{ head: [t("cli.mcp.head.when"), t("cli.mcp.head.action"), t("cli.mcp.head.actor"), t("cli.mcp.head.detail")] },
		);
		console.log();
	},
});

async function readBody(opts: Record<string, unknown>): Promise<string | undefined> {
	if (typeof opts.file === "string") {
		const file = Bun.file(opts.file);

		if (!(await file.exists())) {
			throw new UsageError(t("cli.mcp.knowledge.noFile", { path: opts.file }));
		}

		return await file.text();
	}

	return typeof opts.body === "string"
		? opts.body
		: undefined;
}

function scopeArg(opts: Record<string, unknown>): { kind: "console" } | { kind: "token"; token: string } | undefined {
	if (typeof opts.scope !== "string") {
		return undefined;
	}

	return opts.scope === "console"
		? { kind: "console" }
		: { kind: "token", token: opts.scope };
}

command({
	path: ["mcp", "knowledge"],
	desc: t("cli.mcp.knowledge.desc"),
	opts: [
		{ flag: "--kind", desc: t("cli.mcp.knowledge.optKind"), value: true, complete: async () => [...KNOWLEDGE_KINDS] },
		{ flag: "--scope", desc: t("cli.mcp.knowledge.optScope"), value: true },
		{ flag: "--search", desc: t("cli.mcp.calls.optSearch"), value: true },
	],

	handler: async (_args, opts) => {
		const [items, tokens] = await Promise.all([
			listKnowledge({
				kind: opts.kind as KnowledgeKind | undefined,
				scope: opts.scope as string | undefined,
				search: opts.search as string | undefined,
			}),
			listMcpTokens(),
		]);

		if (items.length === 0) {
			warn(t("cli.mcp.knowledge.none"));

			return;
		}

		const nameOf = (id: string): string => tokens.find((token) => token.id === id)?.name ?? id;

		console.log();
		printTable(
			items.map((item) => [
				pc.dim(item.id),
				item.kind,
				pc.bold(item.title),
				item.scope.kind === "console"
					? pc.dim(t("cli.mcp.knowledge.everyToken"))
					: nameOf(item.scope.token),
				[item.pinned ? pc.cyan("pinned") : "", item.enabled ? "" : pc.dim("disabled")].filter(Boolean).join(" "),
				stamp(item.updatedAt),
			]),
			{
				head: [
					t("cli.mcp.head.id"),
					t("cli.mcp.head.kind"),
					t("cli.mcp.head.title"),
					t("cli.mcp.head.scope"),
					"",
					t("cli.mcp.head.updated"),
				],
			},
		);
		console.log();
	},
});

command({
	path: ["mcp", "knowledge", "show"],
	desc: t("cli.mcp.knowledge.show.desc"),
	args: [{ name: "id", required: true }],

	handler: async (args) => {
		const item = await getKnowledge(args[0]!);

		if (!item) {
			throw new Bail(t("core.mcp.unknownKnowledge", { id: args[0]! }));
		}

		console.log();
		info(`${pc.bold(item.title)} ${pc.dim(`${item.kind} · ${item.id}`)}`);

		if (item.description) {
			console.log(pc.dim(item.description));
		}

		console.log();
		console.log(item.body);
		console.log();
	},
});

command({
	path: ["mcp", "knowledge", "add"],
	desc: t("cli.mcp.knowledge.add.desc"),
	args: [
		{ name: "kind", required: true, complete: async () => [...KNOWLEDGE_KINDS] },
		{ name: "title", required: true },
	],
	opts: [
		{ flag: "--body", desc: t("cli.mcp.knowledge.optBody"), value: true },
		{ flag: "--file", desc: t("cli.mcp.knowledge.optFile"), value: true },
		{ flag: "--scope", desc: t("cli.mcp.knowledge.optScope"), value: true },
		{ flag: "--description", desc: t("cli.mcp.optDescription"), value: true },
		{ flag: "--tags", desc: t("cli.mcp.knowledge.optTags"), value: true },
		{ flag: "--pinned", desc: t("cli.mcp.knowledge.optPinned") },
	],

	handler: async (args, opts) => {
		const kind = args[0] as KnowledgeKind;

		if (!KNOWLEDGE_KINDS.includes(kind)) {
			throw new UsageError(t("core.mcp.badKnowledgeKind"));
		}

		const body = await readBody(opts);

		if (!body) {
			throw new UsageError(t("cli.mcp.knowledge.bodyNeeded"));
		}

		const item = await createKnowledge(
			{
				kind,
				title: args[1]!,
				body,
				description: opts.description as string | undefined,
				tags: list(opts.tags),
				pinned: !!opts.pinned,
				scope: scopeArg(opts),
			},
			activeUser(),
		);

		ok(t("cli.mcp.knowledge.add.done", { title: pc.bold(item.title), id: pc.dim(item.id) }));
	},
});

command({
	path: ["mcp", "knowledge", "edit"],
	desc: t("cli.mcp.knowledge.edit.desc"),
	args: [{ name: "id", required: true }],
	opts: [
		{ flag: "--title", desc: t("cli.mcp.knowledge.optTitle"), value: true },
		{ flag: "--body", desc: t("cli.mcp.knowledge.optBody"), value: true },
		{ flag: "--file", desc: t("cli.mcp.knowledge.optFile"), value: true },
		{ flag: "--scope", desc: t("cli.mcp.knowledge.optScope"), value: true },
		{ flag: "--description", desc: t("cli.mcp.optDescription"), value: true },
		{ flag: "--tags", desc: t("cli.mcp.knowledge.optTags"), value: true },
		{ flag: "--pin", desc: t("cli.mcp.knowledge.optPin") },
		{ flag: "--unpin", desc: t("cli.mcp.knowledge.optUnpin") },
		{ flag: "--enable", desc: t("cli.mcp.knowledge.optEnable") },
		{ flag: "--disable", desc: t("cli.mcp.knowledge.optDisable") },
	],

	handler: async (args, opts) => {
		const pinned = opts.pin
			? true
			: opts.unpin
				? false
				: undefined;
		const enabled = opts.enable
			? true
			: opts.disable
				? false
				: undefined;

		const item = await updateKnowledge(
			args[0]!,
			{
				title: opts.title as string | undefined,
				body: await readBody(opts),
				description: opts.description as string | undefined,
				tags: list(opts.tags),
				scope: scopeArg(opts),
				pinned,
				enabled,
			},
			activeUser(),
		);

		ok(t("cli.mcp.knowledge.edit.done", { title: pc.bold(item.title) }));
	},
});

command({
	path: ["mcp", "knowledge", "remove"],
	desc: t("cli.mcp.knowledge.remove.desc"),
	args: [{ name: "id", required: true }],
	opts: [{ flag: "--yes", desc: t("cli.mcp.optYes") }],

	handler: async (args, opts) => {
		const item = await getKnowledge(args[0]!);

		if (!item) {
			throw new Bail(t("core.mcp.unknownKnowledge", { id: args[0]! }));
		}

		await confirmOrBail(t("cli.mcp.knowledge.remove.confirm", { title: item.title }), opts);
		await removeKnowledge(item.id, activeUser());

		ok(t("cli.mcp.knowledge.remove.done", { title: pc.bold(item.title) }));
	},
});
