// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Hostnames under the network's base domain, from the terminal: the provider
 * credential, the managed hostnames and their links to instances. Everything
 * goes through `core/domains`, which the console and the MCP tools share.
 */

import { command, Bail, UsageError } from "../framework";
import { instanceNames } from "../completers";
import { activeUser } from "../actor";
import { pc, Sym, ok, info, warn, printTable } from "../ui";
import { loadCluster } from "../../client/core/config";
import * as domains from "../../client/core/domains";
import { t } from "../../shared/i18n";

async function hostnameNames(): Promise<string[]> {
	return (await domains.listHostnames().catch(() => [])).map((entry) => entry.label);
}

function reloadNote(reloaded: boolean | undefined): void {
	if (reloaded === false) {
		info(t("cli.domains.notReloaded"));
	}
}

async function readKey(): Promise<string> {
	if (!process.stdin.isTTY) {
		const piped = (await Bun.stdin.text()).trim();

		if (!piped) {
			throw new UsageError(t("cli.domains.setup.keyNeeded"));
		}

		return piped;
	}

	const { password, isCancel, cancel } = await import("@clack/prompts");
	const value = await password({ message: t("cli.domains.setup.keyPrompt") });

	if (isCancel(value)) {
		cancel(t("cli.domains.cancelled"));

		throw new Bail(t("cli.domains.cancelled"));
	}

	return String(value);
}

command({
	path: ["domains"],
	desc: t("cli.domains.desc"),

	handler: async () => {
		const [settings, hostnames] = await Promise.all([domains.domainSettings(), domains.listHostnames()]);

		printTable(
			[
				[t("cli.domains.field.provider"), settings.provider
					? `Namecheap ${pc.dim(`· ${settings.provider.apiUser} · ${settings.provider.apiKeyHint}${settings.provider.sandbox ? " · sandbox" : ""}`)}`
					: pc.dim(t("cli.domains.notConfigured"))],
				[t("cli.domains.field.base"), settings.baseDomain],
				[t("cli.domains.field.address"), settings.effectiveAddress ?? pc.dim("—")],
				[t("cli.domains.field.ttl"), `${settings.ttl}s`],
				[t("cli.domains.field.dropUnsupported"), settings.dropUnsupported ? pc.yellow(t("cli.domains.dropOn")) : t("cli.domains.dropOff")],
			],
			{ head: [t("cli.head.field"), t("cli.head.value")] },
		);
		console.log();

		if (!hostnames.length) {
			info(t("cli.domains.none"));
			return;
		}

		printTable(
			hostnames.map((entry) => [
				pc.bold(entry.fqdn),
				entry.instance ?? pc.dim("—"),
				entry.address,
				pc.dim(entry.createdBy),
			]),
			{ head: [t("cli.domains.head.hostname"), t("cli.head.instance"), t("cli.domains.head.address"), t("cli.domains.head.by")] },
		);
	},
});

command({
	path: ["domains", "setup"],
	desc: t("cli.domains.setup.desc"),
	opts: [
		{ flag: "--api-user", value: true, desc: t("cli.domains.setup.optApiUser") },
		{ flag: "--user-name", value: true, desc: t("cli.domains.setup.optUserName") },
		{ flag: "--client-ip", value: true, desc: t("cli.domains.setup.optClientIp") },
		{ flag: "--sandbox", desc: t("cli.domains.setup.optSandbox") },
		{ flag: "--keep-key", desc: t("cli.domains.setup.optKeepKey") },
	],

	handler: async (_args, opts) => {
		const current = await domains.domainSettings();
		const apiUser = (opts["api-user"] as string | undefined) ?? current.provider?.apiUser;
		const clientIp = (opts["client-ip"] as string | undefined) ?? current.provider?.clientIp;

		if (!apiUser || !clientIp) {
			throw new UsageError(t("cli.domains.setup.needed"));
		}

		const apiKey = opts["keep-key"] ? "" : await readKey();
		const view = await domains.updateDomainSettings({
			provider: {
				apiUser,
				userName: (opts["user-name"] as string | undefined) ?? current.provider?.userName ?? apiUser,
				clientIp,
				apiKey,
				sandbox: opts.sandbox === true,
			},
		}, activeUser());

		ok(t("cli.domains.setup.saved", { user: view.provider?.apiUser ?? apiUser }));

		const check = await domains.checkDomainProvider();

		if (!check.ok) {
			warn(t("cli.domains.check.failed", { error: check.error ?? "?" }));
			return;
		}

		ok(t("cli.domains.check.ok", { count: check.domains.length, zone: check.zone ?? "—" }));
	},
});

command({
	path: ["domains", "set"],
	desc: t("cli.domains.set.desc"),
	opts: [
		{ flag: "--base", value: true, desc: t("cli.domains.set.optBase") },
		{ flag: "--address", value: true, desc: t("cli.domains.set.optAddress") },
		{ flag: "--ttl", value: true, desc: t("cli.domains.set.optTtl") },
		{ flag: "--drop-unsupported", value: true, desc: t("cli.domains.set.optDropUnsupported") },
	],

	handler: async (_args, opts) => {
		const patch: domains.SettingsPatch = {};

		if (typeof opts.base === "string") {
			patch.baseDomain = opts.base;
		}

		if (typeof opts.address === "string") {
			patch.publicAddress = opts.address === "auto" ? null : opts.address;
		}

		if (typeof opts.ttl === "string") {
			patch.ttl = Number(opts.ttl);
		}

		if (typeof opts["drop-unsupported"] === "string") {
			patch.dropUnsupported = ["on", "true", "yes", "1"].includes(opts["drop-unsupported"].toLowerCase());
		}

		if (!Object.keys(patch).length) {
			throw new UsageError(t("cli.domains.set.nothing"));
		}

		const view = await domains.updateDomainSettings(patch, activeUser());

		ok(t("cli.domains.set.saved", { base: view.baseDomain, address: view.effectiveAddress ?? "—", ttl: view.ttl }));
	},
});

command({
	path: ["domains", "check"],
	desc: t("cli.domains.check.desc"),

	handler: async () => {
		const check = await domains.checkDomainProvider();

		if (!check.ok) {
			throw new Bail(t("cli.domains.check.failed", { error: check.error ?? "?" }));
		}

		ok(t("cli.domains.check.ok", { count: check.domains.length, zone: check.zone ?? "—" }));

		printTable(
			check.domains.map((domain) => [
				domain.name === check.zone ? pc.green(Sym.ok) : "",
				pc.bold(domain.name),
				domain.isOurDns ? "Namecheap DNS" : pc.yellow(t("cli.domains.check.externalDns")),
				domain.expires ?? pc.dim("—"),
			]),
			{ head: ["", t("cli.domains.head.domain"), t("cli.domains.head.dns"), t("cli.domains.head.expires")] },
		);
	},
});

command({
	path: ["domains", "records"],
	desc: t("cli.domains.records.desc"),
	args: [{ name: "hostname", desc: t("cli.domains.argHostname"), complete: hostnameNames }],

	handler: async (args) => {
		const result = args[0]
			? await domains.hostnameRecords(args[0])
			: await domains.baseDomainRecords();

		if (!result.records.length) {
			info(t("cli.domains.records.none"));
			return;
		}

		printTable(
			result.records.map((record) => [record.name, record.type, record.address, record.ttl ? `${record.ttl}s` : pc.dim("—")]),
			{ head: [t("cli.domains.head.name"), t("cli.domains.head.type"), t("cli.domains.head.address"), t("cli.domains.head.ttl")] },
		);
	},
});

command({
	path: ["domain", "add"],
	desc: t("cli.domains.add.desc"),
	args: [{ name: "hostname", required: true, desc: t("cli.domains.argHostname") }],
	opts: [
		{ flag: "--instance", value: true, desc: t("cli.domains.add.optInstance"), complete: instanceNames },
		{ flag: "--address", value: true, desc: t("cli.domains.add.optAddress") },
		{ flag: "--adopt", desc: t("cli.domains.add.optAdopt") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const result = await domains.createHostname(cfg, args[0]!, {
			instance: opts.instance as string | undefined,
			address: opts.address as string | undefined,
			adopt: opts.adopt === true,
		}, activeUser());

		ok(t("cli.domains.add.done", { fqdn: result.hostname.fqdn, address: result.hostname.address }));

		if (result.hostname.instance) {
			ok(t("cli.domains.link.done", { fqdn: result.hostname.fqdn, instance: result.hostname.instance }));
		}

		reloadNote(result.velocityReloaded);
	},
});

command({
	path: ["domain", "point"],
	desc: t("cli.domains.point.desc"),
	args: [
		{ name: "hostname", required: true, desc: t("cli.domains.argHostname"), complete: hostnameNames },
		{ name: "address", required: true, desc: t("cli.domains.point.argAddress") },
	],

	handler: async (args) => {
		const result = await domains.updateHostname(args[0]!, { address: args[1]! }, activeUser());

		ok(t("cli.domains.point.done", { fqdn: result.hostname.fqdn, address: result.hostname.address }));
	},
});

command({
	path: ["domain", "link"],
	desc: t("cli.domains.link.desc"),
	args: [
		{ name: "hostname", required: true, desc: t("cli.domains.argHostname"), complete: hostnameNames },
		{ name: "instance", required: true, desc: t("cli.domains.link.argInstance"), complete: instanceNames },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const result = await domains.linkHostname(cfg, args[0]!, args[1]!, activeUser());

		ok(t("cli.domains.link.done", { fqdn: result.hostname.fqdn, instance: args[1]! }));
		reloadNote(result.velocityReloaded);
	},
});

command({
	path: ["domain", "unlink"],
	desc: t("cli.domains.unlink.desc"),
	args: [{ name: "hostname", required: true, desc: t("cli.domains.argHostname"), complete: hostnameNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const result = await domains.unlinkHostname(cfg, args[0]!, activeUser());

		ok(t("cli.domains.unlink.done", { fqdn: result.hostname.fqdn }));
		reloadNote(result.velocityReloaded);
	},
});

command({
	path: ["domain", "remove"],
	desc: t("cli.domains.remove.desc"),
	args: [{ name: "hostname", required: true, desc: t("cli.domains.argHostname"), complete: hostnameNames }],
	opts: [{ flag: "--yes", desc: t("cli.domains.remove.optYes") }],

	handler: async (args, opts) => {
		const entry = await domains.getHostname(args[0]!);

		if (!entry) {
			throw new Bail(t("core.domains.unmanaged", { fqdn: args[0]! }));
		}

		if (!opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const answer = await confirm({
				message: t("cli.domains.remove.confirm", { fqdn: entry.fqdn, instance: entry.instance ?? "—" }),
				initialValue: false,
			});

			if (isCancel(answer) || !answer) {
				throw new Bail(t("cli.domains.cancelled"));
			}
		}

		const cfg = await loadCluster();
		const result = await domains.deleteHostname(cfg, entry.fqdn, activeUser());

		ok(t("cli.domains.remove.done", { fqdn: result.hostname.fqdn }));
		reloadNote(result.velocityReloaded);
	},
});

command({
	path: ["domains", "audit"],
	desc: t("cli.domains.audit.desc"),
	opts: [{ flag: "--limit", value: true, desc: t("cli.domains.audit.optLimit") }],

	handler: async (_args, opts) => {
		const entries = await domains.domainAudit(Number(opts.limit ?? 50) || 50);

		if (!entries.length) {
			info(t("cli.domains.audit.none"));
			return;
		}

		printTable(
			entries.map((entry) => [
				pc.dim(new Date(entry.t).toLocaleString()),
				entry.actor,
				entry.action,
				entry.hostname ?? pc.dim("—"),
				entry.instance ?? entry.detail ?? "",
			]),
			{ head: [t("cli.domains.head.when"), t("cli.domains.head.by"), t("cli.domains.head.action"), t("cli.domains.head.hostname"), ""] },
		);
	},
});
