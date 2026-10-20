// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Resource metadata and tags at the terminal: what the cluster knows about each
 * object it holds (who made it, when), and the tags a policy's conditions read.
 *
 * Ids are `luna:<type>/<name>`; a tag is `key=value`. Tagging a resource the
 * store has not met yet gives it a record with no creator, so anything the
 * cluster had before the store existed can still be tagged.
 */

import { command, Bail, UsageError } from "../framework";
import { pc, ok, info, printTable } from "../ui";
import { accountNames, resourceIds } from "../completers";
import { activeUser } from "../actor";
import {
	describeResource,
	isResourceType,
	listResources,
	sweepResources,
	tagResource,
	untagResource,
	type ResourceView,
} from "../../client/core/resources";
import { IAM_RESOURCE_TYPES } from "../../shared/iam/actions";
import { parseResourceId } from "../../shared/iam/resources";
import { appendJournal } from "../../client/core/journal";
import { t } from "../../shared/i18n";

/** Who the journal records for a change made from a shell; see `cli/actor.ts`. */
function cliActor(): string {
	return activeUser();
}

/** Date and time of a timestamp, or a dash for "unknown". */
function stamp(at: number | null | undefined): string {
	if (!at) {
		return pc.dim("—");
	}

	return new Date(at).toLocaleString("en-GB");
}

/** A tag set as one cell: `k=v, k=v`, or a dash when there are none. */
function paintTags(tags: Record<string, string>): string {
	const entries = Object.entries(tags);

	if (entries.length === 0) {
		return pc.dim("—");
	}

	return entries.map(([key, value]) => `${pc.cyan(key)}=${value}`).join(", ");
}

/** Refuse an id that is not `luna:<type>/<name>` before it reaches the daemon. */
function requireId(id: string): string {
	if (!parseResourceId(id)) {
		throw new UsageError(t("cli.resources.badId", { id }));
	}

	return id;
}

/** Split `key=value` arguments into a tag set; a value may hold `=` itself. */
function parseTags(pairs: string[]): Record<string, string> {
	const tags: Record<string, string> = {};

	for (const pair of pairs) {
		const eq = pair.indexOf("=");

		if (eq <= 0) {
			throw new UsageError(t("cli.resources.badTag", { tag: pair }));
		}

		tags[pair.slice(0, eq)] = pair.slice(eq + 1);
	}

	return tags;
}

/** One resource as a listing row. */
function row(resource: ResourceView): string[] {
	return [
		pc.bold(resource.id),
		resource.type,
		resource.name,
		resource.createdBy ?? pc.dim("—"),
		stamp(resource.createdAt),
		stamp(resource.updatedAt),
		paintTags(resource.tags),
	];
}

command({
	path: ["resources"],
	desc: t("cli.resources.list.desc"),
	opts: [
		{ flag: "--type", desc: t("cli.resources.list.optType"), value: true, complete: async () => [...IAM_RESOURCE_TYPES] },
		{ flag: "--tag", desc: t("cli.resources.list.optTag"), value: true },
		{ flag: "--created-by", desc: t("cli.resources.list.optCreatedBy"), value: true, complete: accountNames },
	],

	handler: async (_args, opts) => {
		const type = opts.type as string | undefined;

		if (type !== undefined && !isResourceType(type)) {
			throw new UsageError(t("cli.resources.badType", {
				type,
				known: IAM_RESOURCE_TYPES.join(", "),
			}));
		}

		// `--tag k` alone matches any value, as the explorer's filter does
		const tags = typeof opts.tag === "string"
			? parseTags([opts.tag.includes("=") ? opts.tag : `${opts.tag}=`])
			: undefined;

		const resources = await listResources({
			type: type !== undefined && isResourceType(type) ? type : undefined,
			tags,
			createdBy: opts["created-by"] as string | undefined,
		});

		if (resources.length === 0) {
			console.log();
			info(t("cli.resources.list.none"));
			console.log();

			return;
		}

		console.log();
		printTable(resources.map(row), {
			head: [
				t("cli.head.id"),
				t("cli.resources.head.type"),
				t("cli.head.name"),
				t("cli.resources.head.createdBy"),
				t("cli.head.created"),
				t("cli.resources.head.modified"),
				t("cli.resources.head.tags"),
			],
		});
		console.log();
		info(t("cli.resources.list.count", { count: resources.length }));
	},
});

command({
	path: ["resource", "show"],
	desc: t("cli.resources.show.desc"),
	args: [{ name: "id", required: true, complete: resourceIds }],

	handler: async (args) => {
		const id = requireId(args[0]!);
		const resource = await describeResource(id);

		console.log();
		info(`${pc.bold(resource.id)} ${resource.unknown ? pc.dim(t("cli.resources.show.unknown")) : ""}`.trimEnd());
		printTable(
			[
				[t("cli.resources.field.type"), resource.type],
				[t("cli.resources.field.name"), resource.name],
				[t("cli.resources.field.createdBy"), resource.createdBy ?? pc.dim("—")],
				[t("cli.resources.field.created"), stamp(resource.createdAt)],
				[t("cli.resources.field.modifiedBy"), resource.updatedBy ?? pc.dim("—")],
				[t("cli.resources.field.modified"), stamp(resource.updatedAt)],
			],
			{ head: [t("cli.head.field"), t("cli.head.value")] },
		);

		const entries = Object.entries(resource.tags);

		console.log();
		info(t("cli.resources.show.tags", { count: entries.length }));

		if (entries.length > 0) {
			printTable(
				entries.map(([key, value]) => [pc.cyan(key), value]),
				{ head: [t("cli.resources.head.key"), t("cli.head.value")] },
			);
		}

		console.log();
	},
});

command({
	path: ["tag"],
	desc: t("cli.resources.tag.desc"),
	args: [
		{ name: "id", required: true, complete: resourceIds },
		{ name: "tag", required: true, variadic: true },
	],

	handler: async (args) => {
		const id = requireId(args[0]!);
		const tags = parseTags(args.slice(1));
		const keys = Object.keys(tags);

		if (keys.length === 0) {
			throw new UsageError(t("cli.resources.tag.none"));
		}

		const resource = await tagResource(id, tags, cliActor());

		await appendJournal({
			source: "cli",
			message: `resource ${id} tagged: ${keys.join(", ")}`,
			actor: cliActor(),
		});

		ok(t("cli.resources.tag.done", {
			count: keys.length,
			id: pc.bold(resource.id),
			total: Object.keys(resource.tags).length,
		}));
	},
});

command({
	path: ["untag"],
	desc: t("cli.resources.untag.desc"),
	args: [
		{ name: "id", required: true, complete: resourceIds },
		{ name: "key", required: true, variadic: true },
	],

	handler: async (args) => {
		const id = requireId(args[0]!);
		const keys = args.slice(1);
		const before = await describeResource(id);
		const present = keys.filter((key) => key in before.tags);

		if (present.length === 0) {
			throw new Bail(t("cli.resources.untag.nothing", { id }));
		}

		const resource = await untagResource(id, keys, cliActor());

		await appendJournal({
			source: "cli",
			message: `resource ${id} untagged: ${present.join(", ")}`,
			actor: cliActor(),
		});

		ok(t("cli.resources.untag.done", {
			count: present.length,
			id: pc.bold(resource.id),
			total: Object.keys(resource.tags).length,
		}));
	},
});

command({
	path: ["resources", "sync"],
	desc: t("cli.resources.sync.desc"),

	handler: async () => {
		const result = await sweepResources();

		await appendJournal({
			source: "cli",
			message: `resource sweep: ${result.added} added, ${result.total} total`,
			actor: cliActor(),
		});

		ok(t("cli.resources.sync.done", { added: result.added, total: result.total }));
	},
});
