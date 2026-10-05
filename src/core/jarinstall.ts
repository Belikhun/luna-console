// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Pool an addon jar that arrives as bytes or as a URL rather than through a
 * provider: a file somebody uploaded, a build a CI page links to, an
 * attachment a Discord message carries.
 *
 * What makes this more than `uploadJar` is that nobody has said what the jar
 * is. The jar says it itself: its descriptors (`plugin.yml`,
 * `velocity-plugin.json`, `fabric.mod.json`, `mods.toml`) give the name, and
 * which descriptors are present gives the family, so a caller only overrides
 * what the jar gets wrong.
 *
 * A URL is fetched **by the daemon**, which sits on the cluster's network, and
 * the URL can come from a chat model. So only http(s) is followed, every hop of
 * a redirect is resolved and refused when it lands on a loopback, private,
 * link-local or otherwise internal address, and the body is capped; the point
 * is to download a public file, not to let a prompt probe the LAN.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { ClusterConfig, PluginEntry, PluginFamily, PluginsLock } from "./types";
import { PLUGIN_FAMILIES } from "./types";
import { t } from "../shared/i18n";
import { unzipRead } from "./archive";
import { identityFromFile, uploadJar } from "./plugins";
import { readJarInfo, type JarInfo } from "./pluginstate";
import { USER_AGENT } from "./services/download";

/** Largest jar a URL install downloads. */
export const MAX_JAR_DOWNLOAD = 128 * 1024 * 1024;

/** Redirect hops a URL install follows before giving up. */
const MAX_REDIRECTS = 5;

const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface JarInspection {
	/** File name the jar came under, for display and as a last-resort name */
	fileName: string;
	size: number;
	/** What the descriptors say */
	meta: JarInfo["meta"];
	/** Families whose descriptor the jar carries, most specific first */
	families: PluginFamily[];
	/** The pool name an install would use when the caller gives none */
	suggestedPlugin: string;
	/** The family an install would use when the caller gives none */
	suggestedFamily: PluginFamily | null;
}

export interface JarInstall {
	/** One of these: the jar's bytes, or a public http(s) URL to fetch them from */
	dataBase64?: string;
	url?: string;
	/** Name the bytes came under; a URL install reads it from the response */
	fileName?: string;
	/** Pool name; derived from the descriptors when absent */
	plugin?: string;
	/** Platform; derived from the descriptors when absent */
	family?: PluginFamily;
	/** Instances (or wildcards) to deploy to; empty pools the jar only */
	targets?: string[];
}

/** Which family each descriptor means; order breaks ties when a jar carries several. */
const DESCRIPTORS: Array<[string, PluginFamily]> = [
	["paper-plugin.yml", "paper"],
	["plugin.yml", "paper"],
	["velocity-plugin.json", "velocity"],
	["fabric.mod.json", "fabric"],
	["META-INF/neoforge.mods.toml", "neoforge"],
	["META-INF/mods.toml", "forge"],
];

function isZip(buf: Uint8Array): boolean {
	return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03;
}

/** Turn a display name into a pool name: lowercase, dashes, nothing a file name would trip on. */
function poolName(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

/** A file name's stem without the version tail most builds carry (`LuckPerms-Bukkit-5.4.150.jar`). */
function stemOf(fileName: string): string {
	return basename(fileName)
		.replace(/\.(jar|wasm)$/i, "")
		.replace(/[-_ ]v?\d+(\.\d+)*([-+.][\w.]+)?$/i, "");
}

async function familiesOf(path: string): Promise<PluginFamily[]> {
	const found: PluginFamily[] = [];

	for (const [member, family] of DESCRIPTORS) {
		if (!found.includes(family) && (await unzipRead(path, member)) !== undefined) {
			found.push(family);
		}
	}

	return found;
}

/** Look inside a jar's bytes: its descriptors, the families they mean, and the name an install would pick. */
export async function inspectJar(dataBase64: string, fileName = "addon.jar"): Promise<JarInspection> {
	const buf = Buffer.from(dataBase64, "base64");

	if (!isZip(buf)) {
		throw new Error(t("core.plugins.notAJar"));
	}

	const dir = await mkdtemp(join(tmpdir(), "luna-jar-"));
	const path = join(dir, "inspect.jar");

	try {
		await Bun.write(path, buf);

		const info = await readJarInfo(path);
		const families = await familiesOf(path);
		const standardized = identityFromFile(fileName);

		// a jar carrying both a bukkit and a velocity descriptor is the one case a
		// guess is safe to call universal: both sides will load it
		const suggestedFamily = standardized?.family
			?? (families.includes("paper") && families.includes("velocity")
				? "universal"
				: families[0] ?? null);

		const suggestedPlugin = standardized?.plugin
			|| poolName(info.meta.id ?? info.meta.name ?? "")
			|| poolName(stemOf(fileName))
			|| "addon";

		return {
			fileName: basename(fileName),
			size: buf.length,
			meta: info.meta,
			families,
			suggestedPlugin,
			suggestedFamily,
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Whether an address is one a public download must never reach. */
function internalAddress(address: string): boolean {
	if (isIP(address) === 6) {
		const lowered = address.toLowerCase();

		if (lowered.startsWith("::ffff:")) {
			return internalAddress(lowered.slice(7));
		}

		return lowered === "::1"
			|| lowered === "::"
			|| lowered.startsWith("fc")
			|| lowered.startsWith("fd")
			|| lowered.startsWith("fe8")
			|| lowered.startsWith("fe9")
			|| lowered.startsWith("fea")
			|| lowered.startsWith("feb");
	}

	const parts = address.split(".").map(Number);
	const [a = 0, b = 0] = parts;

	return a === 0
		|| a === 10
		|| a === 127
		|| (a === 100 && b >= 64 && b <= 127)
		|| (a === 169 && b === 254)
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 168)
		|| (a === 198 && (b === 18 || b === 19))
		|| a >= 224;
}

/**
 * Refuse a URL that would make the daemon fetch from itself or its network: a
 * loopback, private or link-local address, by literal or by what the name
 * resolves to. Shared with the modpack installer, which downloads hundreds of
 * files from addresses a pack author chose.
 */
export async function assertPublic(url: URL): Promise<void> {
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(t("core.jarinstall.badScheme"));
	}

	const host = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host)
		? [host]
		: (await lookup(host, { all: true })).map((entry) => entry.address);

	if (addresses.length === 0 || addresses.some(internalAddress)) {
		throw new Error(t("core.jarinstall.internalHost", { host }));
	}
}

function fileNameFrom(response: Response, url: URL): string {
	const disposition = response.headers.get("content-disposition") ?? "";
	const quoted = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];

	if (quoted) {
		return decodeURIComponent(quoted);
	}

	return decodeURIComponent(basename(url.pathname)) || "addon.jar";
}

/**
 * Download a jar from a public URL, following redirects by hand so each hop is
 * checked, and stopping at the size cap rather than after it.
 */
export async function fetchJar(rawUrl: string): Promise<{ dataBase64: string; fileName: string }> {
	let url: URL;

	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(t("core.jarinstall.badUrl"));
	}

	const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		await assertPublic(url);

		const response = await fetch(url, {
			redirect: "manual",
			signal,
			headers: { "user-agent": USER_AGENT },
		});

		if (response.status >= 300 && response.status < 400) {
			const next = response.headers.get("location");

			if (!next) {
				throw new Error(t("core.jarinstall.httpError", { status: response.status }));
			}

			url = new URL(next, url);

			continue;
		}

		if (!response.ok || !response.body) {
			throw new Error(t("core.jarinstall.httpError", { status: response.status }));
		}

		const declared = Number(response.headers.get("content-length") ?? 0);

		if (declared > MAX_JAR_DOWNLOAD) {
			throw new Error(t("core.jarinstall.tooLarge", { max: MAX_JAR_DOWNLOAD / 1024 / 1024 }));
		}

		const chunks: Uint8Array[] = [];
		let size = 0;

		for await (const chunk of response.body) {
			size += chunk.byteLength;

			if (size > MAX_JAR_DOWNLOAD) {
				throw new Error(t("core.jarinstall.tooLarge", { max: MAX_JAR_DOWNLOAD / 1024 / 1024 }));
			}

			chunks.push(chunk);
		}

		return { dataBase64: Buffer.concat(chunks).toString("base64"), fileName: fileNameFrom(response, url) };
	}

	throw new Error(t("core.jarinstall.tooManyRedirects"));
}

/**
 * Pool a jar from bytes or a URL, naming it from its own descriptors unless the
 * caller says otherwise, then hand it to `uploadJar`, so the entry is exactly
 * what a console upload produces. Deploying is the caller's next step.
 */
export async function installJar(
	cfg: ClusterConfig,
	lock: PluginsLock,
	opts: JarInstall,
): Promise<{ name: string; entry: PluginEntry; inspection: JarInspection }> {
	if (!opts.dataBase64 === !opts.url) {
		throw new Error(t("core.jarinstall.oneSource"));
	}

	const source = opts.url
		? await fetchJar(opts.url)
		: { dataBase64: opts.dataBase64!, fileName: opts.fileName ?? "addon.jar" };

	const inspection = await inspectJar(source.dataBase64, opts.fileName ?? source.fileName);
	const family = opts.family ?? inspection.suggestedFamily;

	if (!family || !PLUGIN_FAMILIES.includes(family)) {
		throw new Error(t("core.jarinstall.unknownFamily", { file: inspection.fileName }));
	}

	const result = await uploadJar(cfg, lock, {
		plugin: opts.plugin?.trim() || inspection.suggestedPlugin,
		family,
		targets: opts.targets,
		dataBase64: source.dataBase64,
	});

	return { ...result, inspection };
}
