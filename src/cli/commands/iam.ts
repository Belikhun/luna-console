// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Console authorization at the terminal: managed policies, groups, what is
 * attached to whom, the simulator and the IAM audit trail.
 *
 * None of it gates the shell running these commands: the CLI acts as `root`
 * and is never evaluated (see `docs/IAM.md`). What it edits is what the console
 * enforces, so every change is journalled under the actor the shell runs as.
 */

import { command, Bail, UsageError } from "../framework";
import { pc, ok, info, warn, printTable } from "../ui";
import { accountNames, actionNames, groupNames, policyNames, resourceIds } from "../completers";
import { activeUser } from "../actor";
import {
	accountPermissions,
	addGroupMembers,
	attachPolicy,
	authorize,
	createGroup,
	createPolicy,
	deleteGroup,
	deleteInlinePolicy,
	deletePolicy,
	detachPolicy,
	getGroup,
	getPolicy,
	iamAudit,
	listGroups,
	listPolicies,
	putInlinePolicy,
	removeGroupMembers,
	updatePolicy,
	validatePolicyYaml,
	type AttachTarget,
	type IamAuditEntry,
	type PolicySummary,
} from "../../client/core/iam";
import { appendJournal } from "../../client/core/journal";
import { IAM_ACTIONS, IAM_SERVICES, actionLabelKey, actionsOf, type IamAccess } from "../../shared/iam/actions";
import type { PolicyIssue, PolicySource, Verdict } from "../../shared/iam/grammar";
import { t } from "../../shared/i18n";

/** Who the audit trail records for a change made from a shell; see `cli/actor.ts`. */
function cliActor(): string {
	return activeUser();
}

/** Date and time of a timestamp, or a dash for "never". */
function stamp(at: number | null | undefined): string {
	if (!at) {
		return pc.dim("—");
	}

	return new Date(at).toLocaleString("en-GB");
}

/** A list of names as one cell, or a dash when there are none. */
function names(values: string[]): string {
	if (values.length === 0) {
		return pc.dim("—");
	}

	return values.join(", ");
}

/** A policy's kind as one coloured word: built-ins are code, managed ones are editable. */
function paintKind(policy: PolicySummary): string {
	if (policy.builtin) {
		return pc.blue(t("cli.iam.kindBuiltin"));
	}

	return pc.green(t("cli.iam.kindManaged"));
}

/** An action's access level, coloured by how much it can break. */
function paintAccess(access: IamAccess): string {
	switch (access) {
		case "read":
			return pc.dim(t("cli.iam.accessRead"));

		case "sensitive":
			return pc.magenta(t("cli.iam.accessSensitive"));

		case "write":
			return pc.yellow(t("cli.iam.accessWrite"));

		case "destructive":
			return pc.red(t("cli.iam.accessDestructive"));
	}
}

/** Where a document came from, as the simulator names it. */
function paintSource(source: PolicySource): string {
	const kind = source.kind === "builtin"
		? t("cli.iam.kindBuiltin")
		: source.kind === "managed"
			? t("cli.iam.kindManaged")
			: t("cli.iam.kindInline");

	const via = source.group
		? pc.dim(` ${t("cli.iam.viaGroup", { group: source.group })}`)
		: "";

	return `${pc.bold(source.name)} ${pc.dim(`(${kind})`)}${via}`;
}

/** The verdict as one coloured word. */
function paintVerdict(verdict: Verdict): string {
	if (verdict.allowed) {
		return pc.green(t("cli.iam.verdictAllowed"));
	}

	return pc.red(t("cli.iam.verdictDenied"));
}

/** Why the verdict came out as it did. */
function reasonText(verdict: Verdict): string {
	switch (verdict.reason) {
		case "explicit-deny":
			return t("cli.iam.reasonExplicitDeny");

		case "allow":
			return t("cli.iam.reasonAllow");

		case "implicit-deny":
			return t("cli.iam.reasonImplicitDeny");

		case "root":
			return t("cli.iam.reasonRoot");
	}
}

/**
 * The policy document a command takes: a YAML file, or stdin when `--stdin`
 * was passed. Exactly one of the two, and stdin only when it is not a terminal,
 * since a document typed interactively has no end.
 */
async function readDocument(opts: Record<string, unknown>): Promise<string> {
	const fromFile = typeof opts.file === "string";
	const fromStdin = opts.stdin === true;

	if (fromFile === fromStdin) {
		throw new UsageError(t("cli.iam.pickSource"));
	}

	if (fromFile) {
		const file = Bun.file(opts.file as string);

		if (!(await file.exists())) {
			throw new UsageError(t("cli.iam.noFile", { path: opts.file as string }));
		}

		return await file.text();
	}

	if (process.stdin.isTTY) {
		throw new UsageError(t("cli.iam.stdinIsTerminal"));
	}

	return await Bun.stdin.text();
}

/**
 * The principal an attach, detach or inline command targets: `--account` or
 * `--group`, exactly one of them.
 */
function readTarget(opts: Record<string, unknown>): AttachTarget {
	const account = typeof opts.account === "string" ? opts.account : undefined;
	const group = typeof opts.group === "string" ? opts.group : undefined;

	if ((account === undefined) === (group === undefined)) {
		throw new UsageError(t("cli.iam.pickTarget"));
	}

	if (account !== undefined) {
		return { account };
	}

	return { group: group! };
}

/** The target as a human reads it in a message. */
function targetLabel(target: AttachTarget): string {
	if ("account" in target) {
		return t("cli.iam.targetAccount", { name: pc.bold(target.account) });
	}

	return t("cli.iam.targetGroup", { name: pc.bold(target.group) });
}

/** A comma-separated option value as a trimmed list. */
function splitList(value: unknown): string[] {
	if (typeof value !== "string") {
		return [];
	}

	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

/** Print validation issues, one per line, located by their path. */
function printIssues(issues: PolicyIssue[]): void {
	for (const issue of issues) {
		console.log(`  ${pc.red(issue.path)} ${issue.message}`);
	}
}

/** Ask for a yes before a removal, unless `--yes` was passed. */
async function confirmRemoval(opts: Record<string, unknown>, message: string): Promise<void> {
	if (opts.yes) {
		return;
	}

	const { confirm, isCancel } = await import("@clack/prompts");
	const answer = await confirm({ message, initialValue: false });

	if (isCancel(answer) || !answer) {
		throw new Bail(t("cli.iam.cancelled"));
	}
}

/** Print the YAML document indented under a heading. */
function printYaml(yaml: string): void {
	for (const line of yaml.replace(/\r\n/g, "\n").trimEnd().split("\n")) {
		console.log(`  ${line}`);
	}
}

command({
	path: ["iam", "policies"],
	desc: t("cli.iam.policies.desc"),

	handler: async () => {
		const policies = await listPolicies();

		if (policies.length === 0) {
			console.log();
			info(t("cli.iam.policies.none"));
			console.log();

			return;
		}

		const rows = policies.map((policy) => [
			pc.bold(policy.name),
			paintKind(policy),
			String(policy.document.Statement.length),
			names(policy.attachedTo.accounts),
			names(policy.attachedTo.groups),
			stamp(policy.updatedAt),
		]);

		console.log();
		printTable(rows, {
			head: [
				t("cli.head.name"),
				t("cli.head.kind"),
				t("cli.iam.head.statements"),
				t("cli.iam.head.accounts"),
				t("cli.iam.head.groups"),
				t("cli.iam.head.updated"),
			],
		});
		console.log();
	},
});

command({
	path: ["iam", "policy", "show"],
	desc: t("cli.iam.policy.show.desc"),
	args: [{ name: "name", required: true, complete: policyNames }],

	handler: async (args) => {
		const name = args[0]!;
		const policy = await getPolicy(name);

		if (!policy) {
			throw new Bail(t("cli.iam.unknownPolicy", { name }));
		}

		console.log();
		info(`${pc.bold(policy.name)} ${paintKind(policy)}`);
		printTable(
			[
				[t("cli.iam.field.id"), policy.id ? pc.dim(policy.id) : pc.dim("—")],
				[t("cli.iam.field.description"), policy.description || pc.dim("—")],
				[t("cli.iam.field.statements"), String(policy.document.Statement.length)],
				[t("cli.iam.field.accounts"), names(policy.attachedTo.accounts)],
				[t("cli.iam.field.groups"), names(policy.attachedTo.groups)],
				[t("cli.iam.field.created"), `${stamp(policy.createdAt)} ${pc.dim(policy.createdBy ?? "")}`],
				[t("cli.iam.field.updated"), `${stamp(policy.updatedAt)} ${pc.dim(policy.updatedBy ?? "")}`],
			],
			{ head: [t("cli.head.field"), t("cli.head.value")] },
		);

		console.log();
		info(t("cli.iam.policy.show.document"));
		console.log();
		printYaml(policy.yaml);
		console.log();
	},
});

command({
	path: ["iam", "policy", "add"],
	desc: t("cli.iam.policy.add.desc"),
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--file", desc: t("cli.iam.optFile"), value: true },
		{ flag: "--stdin", desc: t("cli.iam.optStdin") },
		{ flag: "--description", desc: t("cli.iam.optDescription"), value: true },
	],

	handler: async (args, opts) => {
		const name = args[0]!;
		const yaml = await readDocument(opts);

		const policy = await createPolicy(
			{
				name,
				yaml,
				description: opts.description as string | undefined,
			},
			cliActor(),
		);

		await appendJournal({
			source: "cli",
			message: `iam policy ${policy.name} created`,
			actor: cliActor(),
		});

		ok(t("cli.iam.policy.add.done", {
			name: pc.bold(policy.name),
			count: policy.document.Statement.length,
		}));
	},
});

command({
	path: ["iam", "policy", "edit"],
	desc: t("cli.iam.policy.edit.desc"),
	args: [{ name: "name", required: true, complete: policyNames }],
	opts: [
		{ flag: "--file", desc: t("cli.iam.optFile"), value: true },
		{ flag: "--stdin", desc: t("cli.iam.optStdin") },
		{ flag: "--description", desc: t("cli.iam.optDescription"), value: true },
		{ flag: "--rename", desc: t("cli.iam.policy.edit.optRename"), value: true },
	],

	handler: async (args, opts) => {
		const name = args[0]!;
		const hasDocument = typeof opts.file === "string" || opts.stdin === true;
		const description = opts.description as string | undefined;
		const rename = opts.rename as string | undefined;

		if (!hasDocument && description === undefined && rename === undefined) {
			throw new UsageError(t("cli.iam.policy.edit.nothing"));
		}

		const yaml = hasDocument ? await readDocument(opts) : undefined;

		const policy = await updatePolicy(
			name,
			{
				yaml,
				description,
				name: rename,
			},
			cliActor(),
		);

		await appendJournal({
			source: "cli",
			message: `iam policy ${name} updated`,
			actor: cliActor(),
		});

		ok(t("cli.iam.policy.edit.done", { name: pc.bold(policy.name) }));
	},
});

command({
	path: ["iam", "policy", "remove"],
	desc: t("cli.iam.policy.remove.desc"),
	args: [{ name: "name", required: true, complete: policyNames }],
	opts: [{ flag: "--yes", desc: t("cli.iam.optYes") }],

	handler: async (args, opts) => {
		const name = args[0]!;
		const policy = await getPolicy(name);

		if (!policy) {
			throw new Bail(t("cli.iam.unknownPolicy", { name }));
		}

		const attached = policy.attachedTo.accounts.length + policy.attachedTo.groups.length;

		await confirmRemoval(opts, t("cli.iam.policy.remove.confirm", { name: policy.name, attached }));

		await deletePolicy(policy.name, cliActor());

		await appendJournal({
			source: "cli",
			level: "warn",
			message: `iam policy ${policy.name} deleted`,
			actor: cliActor(),
		});

		ok(t("cli.iam.policy.remove.done", { name: pc.bold(policy.name) }));
	},
});

command({
	path: ["iam", "policy", "validate"],
	desc: t("cli.iam.policy.validate.desc"),
	opts: [
		{ flag: "--file", desc: t("cli.iam.optFile"), value: true },
		{ flag: "--stdin", desc: t("cli.iam.optStdin") },
	],

	handler: async (_args, opts) => {
		const yaml = await readDocument(opts);
		const result = await validatePolicyYaml(yaml);

		if (result.ok) {
			ok(t("cli.iam.policy.validate.ok", { count: result.statements }));

			return;
		}

		console.log();
		warn(t("cli.iam.policy.validate.issues", { count: result.issues.length }));
		printIssues(result.issues);
		console.log();

		throw new Bail(t("cli.iam.policy.validate.failed"));
	},
});

command({
	path: ["iam", "groups"],
	desc: t("cli.iam.groups.desc"),

	handler: async () => {
		const groups = await listGroups();

		if (groups.length === 0) {
			console.log();
			info(t("cli.iam.groups.none"));
			info(t("cli.iam.groups.createHint", { command: pc.cyan("luna iam group add <name>") }));
			console.log();

			return;
		}

		const rows = groups.map((group) => [
			pc.bold(group.name),
			group.description || pc.dim("—"),
			String(group.members.length),
			names(group.policies),
			String(group.inline.length),
			stamp(group.updatedAt),
		]);

		console.log();
		printTable(rows, {
			head: [
				t("cli.head.name"),
				t("cli.head.description"),
				t("cli.head.members"),
				t("cli.iam.head.policies"),
				t("cli.iam.head.inline"),
				t("cli.iam.head.updated"),
			],
		});
		console.log();
	},
});

command({
	path: ["iam", "group", "show"],
	desc: t("cli.iam.group.show.desc"),
	args: [{ name: "name", required: true, complete: groupNames }],

	handler: async (args) => {
		const name = args[0]!;
		const group = await getGroup(name);

		if (!group) {
			throw new Bail(t("cli.iam.unknownGroup", { name }));
		}

		console.log();
		info(pc.bold(group.name));
		printTable(
			[
				[t("cli.iam.field.id"), pc.dim(group.id)],
				[t("cli.iam.field.description"), group.description || pc.dim("—")],
				[t("cli.iam.field.members"), names(group.members.map((member) => member.username))],
				[t("cli.iam.field.policies"), names(group.policies)],
				[t("cli.iam.field.inline"), names(group.inline.map((inline) => inline.name))],
				[t("cli.iam.field.created"), `${stamp(group.createdAt)} ${pc.dim(group.createdBy ?? "")}`],
				[t("cli.iam.field.updated"), `${stamp(group.updatedAt)} ${pc.dim(group.updatedBy ?? "")}`],
			],
			{ head: [t("cli.head.field"), t("cli.head.value")] },
		);

		for (const inline of group.inline) {
			console.log();
			info(t("cli.iam.inlineDocument", { name: pc.bold(inline.name) }));
			console.log();
			printYaml(inline.yaml);
		}

		console.log();
	},
});

command({
	path: ["iam", "group", "add"],
	desc: t("cli.iam.group.add.desc"),
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--description", desc: t("cli.iam.optDescription"), value: true },
		{ flag: "--policies", desc: t("cli.iam.group.add.optPolicies"), value: true, complete: policyNames },
		{ flag: "--members", desc: t("cli.iam.group.add.optMembers"), value: true, complete: accountNames },
	],

	handler: async (args, opts) => {
		const name = args[0]!;

		const group = await createGroup(
			{
				name,
				description: opts.description as string | undefined,
				policies: splitList(opts.policies),
				members: splitList(opts.members),
			},
			cliActor(),
		);

		await appendJournal({
			source: "cli",
			message: `iam group ${group.name} created`,
			actor: cliActor(),
		});

		ok(t("cli.iam.group.add.done", {
			name: pc.bold(group.name),
			members: group.members.length,
			policies: group.policies.length,
		}));
	},
});

command({
	path: ["iam", "group", "remove"],
	desc: t("cli.iam.group.remove.desc"),
	args: [{ name: "name", required: true, complete: groupNames }],
	opts: [{ flag: "--yes", desc: t("cli.iam.optYes") }],

	handler: async (args, opts) => {
		const name = args[0]!;
		const group = await getGroup(name);

		if (!group) {
			throw new Bail(t("cli.iam.unknownGroup", { name }));
		}

		await confirmRemoval(opts, t("cli.iam.group.remove.confirm", {
			name: group.name,
			members: group.members.length,
		}));

		await deleteGroup(group.name, cliActor());

		await appendJournal({
			source: "cli",
			level: "warn",
			message: `iam group ${group.name} deleted`,
			actor: cliActor(),
		});

		ok(t("cli.iam.group.remove.done", { name: pc.bold(group.name) }));
	},
});

command({
	path: ["iam", "group", "members", "add"],
	desc: t("cli.iam.group.members.add.desc"),
	args: [
		{ name: "group", required: true, complete: groupNames },
		{ name: "account", required: true, variadic: true, complete: accountNames },
	],

	handler: async (args) => {
		const name = args[0]!;
		const members = args.slice(1);

		const group = await addGroupMembers(name, members, cliActor());

		await appendJournal({
			source: "cli",
			message: `iam group ${group.name}: added ${members.join(", ")}`,
			actor: cliActor(),
		});

		ok(t("cli.iam.group.members.add.done", {
			count: members.length,
			name: pc.bold(group.name),
			total: group.members.length,
		}));
	},
});

command({
	path: ["iam", "group", "members", "remove"],
	desc: t("cli.iam.group.members.remove.desc"),
	args: [
		{ name: "group", required: true, complete: groupNames },
		{ name: "account", required: true, variadic: true, complete: accountNames },
	],

	handler: async (args) => {
		const name = args[0]!;
		const members = args.slice(1);

		const group = await removeGroupMembers(name, members, cliActor());

		await appendJournal({
			source: "cli",
			message: `iam group ${group.name}: removed ${members.join(", ")}`,
			actor: cliActor(),
		});

		ok(t("cli.iam.group.members.remove.done", {
			count: members.length,
			name: pc.bold(group.name),
			total: group.members.length,
		}));
	},
});

command({
	path: ["iam", "attach"],
	desc: t("cli.iam.attach.desc"),
	args: [{ name: "policy", required: true, complete: policyNames }],
	opts: [
		{ flag: "--account", desc: t("cli.iam.optAccount"), value: true, complete: accountNames },
		{ flag: "--group", desc: t("cli.iam.optGroup"), value: true, complete: groupNames },
	],

	handler: async (args, opts) => {
		const policy = args[0]!;
		const target = readTarget(opts);

		await attachPolicy(target, policy, cliActor());

		await appendJournal({
			source: "cli",
			message: `iam policy ${policy} attached to ${"account" in target ? `account ${target.account}` : `group ${target.group}`}`,
			actor: cliActor(),
		});

		ok(t("cli.iam.attach.done", { policy: pc.bold(policy), target: targetLabel(target) }));
	},
});

command({
	path: ["iam", "detach"],
	desc: t("cli.iam.detach.desc"),
	args: [{ name: "policy", required: true, complete: policyNames }],
	opts: [
		{ flag: "--account", desc: t("cli.iam.optAccount"), value: true, complete: accountNames },
		{ flag: "--group", desc: t("cli.iam.optGroup"), value: true, complete: groupNames },
	],

	handler: async (args, opts) => {
		const policy = args[0]!;
		const target = readTarget(opts);

		await detachPolicy(target, policy, cliActor());

		await appendJournal({
			source: "cli",
			level: "warn",
			message: `iam policy ${policy} detached from ${"account" in target ? `account ${target.account}` : `group ${target.group}`}`,
			actor: cliActor(),
		});

		ok(t("cli.iam.detach.done", { policy: pc.bold(policy), target: targetLabel(target) }));
	},
});

command({
	path: ["iam", "inline", "put"],
	desc: t("cli.iam.inline.put.desc"),
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--account", desc: t("cli.iam.optAccount"), value: true, complete: accountNames },
		{ flag: "--group", desc: t("cli.iam.optGroup"), value: true, complete: groupNames },
		{ flag: "--file", desc: t("cli.iam.optFile"), value: true },
		{ flag: "--stdin", desc: t("cli.iam.optStdin") },
	],

	handler: async (args, opts) => {
		const name = args[0]!;
		const target = readTarget(opts);
		const yaml = await readDocument(opts);

		const inline = await putInlinePolicy(target, name, yaml, cliActor());

		await appendJournal({
			source: "cli",
			message: `iam inline policy ${name} put on ${"account" in target ? `account ${target.account}` : `group ${target.group}`}`,
			actor: cliActor(),
		});

		ok(t("cli.iam.inline.put.done", {
			name: pc.bold(inline.name),
			target: targetLabel(target),
			count: inline.document.Statement.length,
		}));
	},
});

command({
	path: ["iam", "inline", "remove"],
	desc: t("cli.iam.inline.remove.desc"),
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--account", desc: t("cli.iam.optAccount"), value: true, complete: accountNames },
		{ flag: "--group", desc: t("cli.iam.optGroup"), value: true, complete: groupNames },
	],

	handler: async (args, opts) => {
		const name = args[0]!;
		const target = readTarget(opts);

		await deleteInlinePolicy(target, name, cliActor());

		await appendJournal({
			source: "cli",
			level: "warn",
			message: `iam inline policy ${name} removed from ${"account" in target ? `account ${target.account}` : `group ${target.group}`}`,
			actor: cliActor(),
		});

		ok(t("cli.iam.inline.remove.done", { name: pc.bold(name), target: targetLabel(target) }));
	},
});

command({
	path: ["iam", "simulate"],
	desc: t("cli.iam.simulate.desc"),
	args: [
		{ name: "account", required: true, complete: accountNames },
		{ name: "action", required: true, complete: actionNames },
		{ name: "resource", complete: resourceIds },
	],

	handler: async (args) => {
		const account = args[0]!;
		const action = args[1]!;
		const resource = args[2] ?? null;

		const result = await authorize(account, action, resource);
		const { verdict } = result;

		console.log();
		info(`${pc.bold(account)} ${pc.dim("→")} ${pc.cyan(result.request.action)} ${pc.dim(resource ?? t("cli.iam.simulate.noResource"))}`);

		const rows: string[][] = [
			[t("cli.iam.simulate.verdict"), paintVerdict(verdict)],
			[t("cli.iam.simulate.reason"), reasonText(verdict)],
		];

		if (verdict.matched) {
			rows.push([t("cli.iam.simulate.source"), paintSource(verdict.matched.source)]);
			rows.push([
				t("cli.iam.simulate.statement"),
				verdict.matched.sid
					? `${verdict.matched.sid} ${pc.dim(`#${verdict.matched.index}`)}`
					: `#${verdict.matched.index}`,
			]);
		}

		if (result.resource) {
			rows.push([t("cli.iam.simulate.resourceCreator"), result.resource.createdBy ?? pc.dim("—")]);

			const tags = Object.entries(result.resource.tags).map(([key, value]) => `${key}=${value}`);

			rows.push([t("cli.iam.simulate.resourceTags"), names(tags)]);
		}

		printTable(rows, { head: [t("cli.head.field"), t("cli.head.value")] });
		console.log();
	},
});

command({
	path: ["iam", "actions"],
	desc: t("cli.iam.actions.desc"),
	args: [{ name: "service", complete: async () => [...IAM_SERVICES] }],

	handler: async (args) => {
		const service = args[0];

		if (service && !IAM_SERVICES.includes(service)) {
			throw new UsageError(t("cli.iam.actions.unknownService", {
				service,
				known: IAM_SERVICES.join(", "),
			}));
		}

		const specs = service ? actionsOf(service) : IAM_ACTIONS;

		const rows = specs.map((spec) => [
			pc.bold(spec.name),
			paintAccess(spec.access),
			spec.resourceType ?? pc.dim(t("cli.iam.actions.clusterWide")),
			pc.dim(t(actionLabelKey(spec))),
		]);

		console.log();
		printTable(rows, {
			head: [
				t("cli.head.action"),
				t("cli.iam.head.access"),
				t("cli.iam.head.resourceType"),
				t("cli.head.description"),
			],
		});
		console.log();
	},
});

/** An audit action, coloured by whether it widened or narrowed somebody's access. */
function paintAuditAction(entry: IamAuditEntry): string {
	switch (entry.action) {
		case "policy.delete":
		case "group.delete":
		case "detach":
		case "inline.delete":
		case "group.members.remove":
			return pc.red(entry.action);

		case "attach":
		case "inline.put":
		case "group.members.add":
		case "seed":
			return pc.yellow(entry.action);

		default:
			return entry.action;
	}
}

command({
	path: ["iam", "audit"],
	desc: t("cli.iam.audit.desc"),
	opts: [
		{ flag: "--target", desc: t("cli.iam.audit.optTarget"), value: true },
		{ flag: "--limit", desc: t("cli.iam.audit.optLimit"), value: true },
	],

	handler: async (_args, opts) => {
		const limit = Number(opts.limit ?? 50);
		const entries = await iamAudit({
			target: opts.target as string | undefined,
			limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
		});

		if (entries.length === 0) {
			console.log();
			info(t("cli.iam.audit.none"));
			console.log();

			return;
		}

		console.log();
		printTable(
			entries.map((entry) => [
				stamp(entry.t),
				paintAuditAction(entry),
				entry.target ?? pc.dim("—"),
				entry.actor ?? pc.dim("—"),
				pc.dim(entry.detail ?? ""),
			]),
			{
				head: [
					t("cli.head.when"),
					t("cli.head.action"),
					t("cli.iam.head.target"),
					t("cli.iam.head.actor"),
					t("cli.head.detail"),
				],
			},
		);
		console.log();
	},
});

command({
	path: ["account", "permissions"],
	desc: t("cli.iam.permissions.desc"),
	args: [{ name: "username", required: true, complete: accountNames }],

	handler: async (args) => {
		const name = args[0]!;
		const permissions = await accountPermissions(name);
		const tags = Object.entries(permissions.tags).map(([key, value]) => `${key}=${value}`);

		console.log();
		info(`${pc.bold(permissions.username)} ${permissions.administrator ? pc.yellow(t("cli.iam.permissions.administrator")) : ""}`.trimEnd());
		printTable(
			[
				[t("cli.iam.field.id"), pc.dim(permissions.accountId)],
				[t("cli.iam.field.administrator"), permissions.administrator ? pc.yellow(t("cli.iam.yes")) : pc.dim(t("cli.iam.no"))],
				[t("cli.iam.field.groups"), names(permissions.groups.map((group) => group.name))],
				[t("cli.iam.field.policies"), names(permissions.policies)],
				[t("cli.iam.field.inline"), names(permissions.inline.map((inline) => inline.name))],
				[t("cli.iam.field.tags"), names(tags)],
				[t("cli.iam.field.effective"), String(permissions.effective.length)],
			],
			{ head: [t("cli.head.field"), t("cli.head.value")] },
		);

		if (permissions.groups.length > 0) {
			console.log();
			info(t("cli.iam.permissions.groups", { count: permissions.groups.length }));
			printTable(
				permissions.groups.map((group) => [
					pc.bold(group.name),
					names(group.policies),
					names(group.inline),
				]),
				{ head: [t("cli.head.group"), t("cli.iam.head.policies"), t("cli.iam.head.inline")] },
			);
		}

		if (permissions.effective.length > 0) {
			console.log();
			info(t("cli.iam.permissions.effective", { count: permissions.effective.length }));
			printTable(
				permissions.effective.map((attached, index) => [
					pc.dim(String(index + 1)),
					paintSource(attached.source),
					String(attached.document.Statement.length),
				]),
				{ head: ["#", t("cli.head.source"), t("cli.iam.head.statements")] },
			);
		} else {
			console.log();
			warn(t("cli.iam.permissions.nothing"));
		}

		for (const inline of permissions.inline) {
			console.log();
			info(t("cli.iam.inlineDocument", { name: pc.bold(inline.name) }));
			console.log();
			printYaml(inline.yaml);
		}

		console.log();
	},
});
