// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The public page, from the terminal: whether it is published, which servers it
 * shows, and what each one's uptime record looks like.
 *
 * The console edits the same two switches on the selector screen; both go
 * through `core/publicsite` and the registry, so neither is a second
 * implementation of the other.
 */

import { command, Bail } from "../framework";
import { instanceNames } from "../completers";
import { pc, Sym, ok, info, warn, printTable } from "../ui";
import { loadCluster, managedInstances, saveCluster } from "../../client/core/config";
import * as publicsite from "../../client/core/publicsite";
import { slotTone } from "../../client/core/uptime";
import { t } from "../../shared/i18n";

/** Block glyphs an uptime day is drawn with, worst to best. */
const BARS = ["▁", "▃", "▅", "█"] as const;

/**
 * One instance's uptime as a strip of blocks.
 *
 * The console draws this as bars in a track; a terminal has no track, so the
 * height is carried by the glyph and the band by the colour. A day nobody
 * observed is a dim dot rather than a bar, which is the same distinction the
 * timeline makes: not measured is not the same as down.
 */
function strip(days: Array<{ up: number; seen: number }>): string {
	return days
		.map((day) => {
			if (!day.seen) {
				return pc.dim("·");
			}

			const tone = slotTone((day.up / day.seen) * 100);

			if (tone === "ok") {
				return pc.green(BARS[3]);
			}

			if (tone === "warn") {
				return pc.yellow(BARS[2]);
			}

			return tone === "bad" ? pc.yellow(BARS[1]) : pc.red(BARS[0]);
		})
		.join("");
}

command({
	path: ["public"],
	desc: t("cli.public.desc"),

	handler: async () => {
		const cfg = await loadCluster();
		const site = cfg.publicSite;
		const listed = publicsite.publicInstances(cfg);

		info(
			site?.enabled
				? `${Sym.ok} ${t("cli.public.enabled")}`
				: `${Sym.bad} ${t("cli.public.disabled")}`,
		);

		if (site?.address) {
			console.log(`  ${pc.dim(t("cli.public.address"))} ${site.address}`);
		}

		if (site?.title) {
			console.log(`  ${pc.dim(t("cli.public.title"))} ${site.title}`);
		}

		console.log();

		const rows = publicsite.listableInstances(cfg).map(([name, inst]) => [
			inst.publicListed ? pc.green(Sym.ok) : pc.dim(Sym.bad),
			pc.bold(name),
			inst.publicListed ? t("cli.public.shown") : pc.dim(t("cli.public.hidden")),
			inst.serverDisplay ? pc.dim(inst.serverDisplay) : pc.dim("—"),
		]);

		printTable(rows, {
			head: ["", t("cli.head.instance"), t("cli.public.head.visibility"), t("cli.head.display")],
		});

		console.log();
		info(t("cli.public.summary", { count: listed.length }));
	},
});

command({
	path: ["public", "enable"],
	desc: t("cli.public.enable.desc"),
	opts: [
		{ flag: "--address", value: true, desc: t("cli.public.opt.address") },
		{ flag: "--title", value: true, desc: t("cli.public.opt.title") },
		{ flag: "--tagline", value: true, desc: t("cli.public.opt.tagline") },
	],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();

		cfg.publicSite = { ...(cfg.publicSite ?? {}), enabled: true };

		if (typeof opts.address === "string") {
			cfg.publicSite.address = opts.address;
		}

		if (typeof opts.title === "string") {
			cfg.publicSite.title = opts.title;
		}

		if (typeof opts.tagline === "string") {
			cfg.publicSite.tagline = opts.tagline;
		}

		await saveCluster(cfg);
		ok(t("cli.public.enabled"));

		if (!publicsite.publicInstances(cfg).length) {
			info(t("cli.public.noneListedYet"));
		}
	},
});

command({
	path: ["public", "disable"],
	desc: t("cli.public.disable.desc"),

	handler: async () => {
		const cfg = await loadCluster();

		cfg.publicSite = { ...(cfg.publicSite ?? {}), enabled: false };

		await saveCluster(cfg);
		ok(t("cli.public.disabled"));
	},
});

command({
	path: ["public", "show"],
	desc: t("cli.public.show.desc"),
	args: [
		{
			name: "instance",
			desc: t("cli.public.arg.instance"),
			required: true,
			complete: instanceNames,
		},
	],

	handler: async (args) => {
		const name = args[0];

		if (!name) {
			throw new Bail(t("cli.public.needInstance"));
		}

		const cfg = await loadCluster();
		const inst = cfg.instances[name];

		// the proxy is deliberately not listable: players connect through it, and
		// its address is the one the page already advertises
		if (!inst) {
			throw new Bail(t("core.instances.unknown", { name }));
		}

		inst.publicListed = true;

		await saveCluster(cfg);
		ok(t("cli.public.nowShown", { name }));

		if (!cfg.publicSite?.enabled) {
			info(t("cli.public.stillDisabled"));
		}
	},
});

command({
	path: ["public", "hide"],
	desc: t("cli.public.hide.desc"),
	args: [
		{
			name: "instance",
			desc: t("cli.public.arg.instance"),
			required: true,
			complete: instanceNames,
		},
	],

	handler: async (args) => {
		const name = args[0];

		if (!name) {
			throw new Bail(t("cli.public.needInstance"));
		}

		const cfg = await loadCluster();
		const inst = cfg.instances[name];

		if (!inst) {
			throw new Bail(t("core.instances.unknown", { name }));
		}

		delete inst.publicListed;

		await saveCluster(cfg);
		ok(t("cli.public.nowHidden", { name }));
	},
});

command({
	path: ["uptime"],
	desc: t("cli.uptime.desc"),
	args: [{ name: "instance", desc: t("cli.uptime.arg.instance"), complete: instanceNames }],
	opts: [{ flag: "--days", value: true, desc: t("cli.uptime.opt.days") }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const days = opts.days ? Number(opts.days) : 30;

		if (!Number.isFinite(days) || days < 1) {
			throw new Bail(t("cli.uptime.badDays"));
		}

		const target = args[0];

		if (target && !cfg.instances[target]) {
			throw new Bail(t("core.instances.unknown", { name: target }));
		}

		const names = target ? [target] : publicsite.listableInstances(cfg).map(([name]) => name);
		const rows: string[][] = [];

		for (const name of names) {
			const window = await publicsite.uptimeSeries(name, days);

			rows.push([
				pc.bold(name),
				strip(window.days),
				window.pct === null ? pc.dim("—") : `${window.pct.toFixed(2)}%`,
				window.stops ? String(window.stops) : pc.dim("0"),
			]);
		}

		printTable(rows, {
			head: [
				t("cli.head.instance"),
				t("cli.uptime.head.window", { days }),
				t("cli.uptime.head.uptime"),
				t("cli.uptime.head.stops"),
			],
		});
	},
});

command({
	path: ["maps"],
	desc: t("cli.maps.desc"),
	args: [{ name: "instance", complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const wanted = args[0];

		if (wanted && !managedInstances(cfg)[wanted]) {
			throw new Bail(t("cli.maps.unknownInstance", { name: wanted }));
		}

		const names = wanted ? [wanted] : Object.keys(managedInstances(cfg));
		const rows: string[][] = [];
		const notes: string[] = [];

		for (const name of names) {
			const source = await publicsite.mapSource(name);

			if (!source) {
				continue;
			}

			rows.push([
				pc.bold(name),
				pc.cyan(source.provider),
				source.origin ? pc.dim(source.origin) : pc.dim(t("cli.maps.filesOnly")),
				source.webroot ? Sym.ok : Sym.off,
				source.offlineReady ? Sym.ok : Sym.warn,
			]);

			// the one thing an operator cannot work out from the table: *why* a map
			// that is plainly there stops existing the moment the server does
			if (source.webroot && !source.offlineReady) {
				notes.push(t("cli.maps.notOfflineReady", { name, provider: source.provider }));
			}

			if (!source.webroot) {
				notes.push(t("cli.maps.notRendered", { name }));
			}
		}

		if (!rows.length) {
			info(wanted ? t("cli.maps.noneForInstance", { name: wanted }) : t("cli.maps.none"));

			return;
		}

		console.log();

		printTable(rows, {
			head: [
				t("cli.head.instance"),
				t("cli.maps.head.map"),
				t("cli.head.address"),
				t("cli.maps.head.rendered"),
				t("cli.maps.head.survivesStop"),
			],
		});

		console.log(pc.dim(`\n  ${t("cli.maps.legend", { ok: Sym.ok, off: Sym.off, warn: Sym.warn })}`));

		for (const note of notes) {
			console.log();
			warn(note);
		}

		console.log();
	},
});
