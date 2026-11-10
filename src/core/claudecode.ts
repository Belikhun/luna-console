// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The Claude Code executable Mèo Béo runs, kept at `<root>/.bin/claude`.
 *
 * The console's agent SDK drives a native Claude Code binary, and the two speak
 * a control protocol that moves between releases, so each SDK release names the
 * build it pairs with (its `manifest.json`). This module reads what is
 * installed, asks Anthropic's release bucket what exists, and swaps a new build
 * in on request. Nothing here runs on its own: the binary is only replaced when
 * an operator asks, and the subprocess itself runs with its updater disabled.
 *
 * The bucket is the one Claude Code's own installer reads: `stable` and
 * `latest` hold a version, `<version>/manifest.json` lists every platform's
 * SHA-256 and size, and `<version>/<platform>/claude` is the binary. Every byte
 * is checked against the manifest before the swap.
 *
 * The SDK itself is part of the console bundle, so it changes with a luna
 * release; `checkClaudeCode` reports the newest one on npm so the screen can say
 * when a release would bring one.
 */

import { existsSync } from "node:fs";
import { access, chmod, constants, link, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { t } from "../shared/i18n";
import { root } from "./config";
import { appendJournal } from "./journal";
import { ProgressReporter } from "./progress";

/** Where Claude Code's builds are published; `LUNA_CLAUDE_RELEASES` points a test at a stand-in. */
export const CLAUDE_CODE_RELEASES = process.env.LUNA_CLAUDE_RELEASES || "https://downloads.claude.ai/claude-code-releases";

/** The npm package the console's agent runner is built on. */
export const AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

const NPM_REGISTRY = process.env.LUNA_NPM_REGISTRY || "https://registry.npmjs.org";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** What an upgrade may be asked for: a channel, or one exact version. */
export type ClaudeCodeTarget = "stable" | "latest" | string;

export interface ClaudeCodeCheck {
	/** Where luna keeps the binary; the agent uses it unless its settings or `LUNA_CLAUDE_BIN` name another */
	path: string;
	/** The installed build's version; null when there is none, or it would not say */
	installed: string | null;
	/** The release-bucket name for this machine (`linux-x64`, `linux-arm64-musl`, …) */
	platform: string;
	stable: string | null;
	latest: string | null;
	/** The newest agent SDK on npm, which a luna release would bring */
	sdkLatest: string | null;
	/** Whether the daemon may write the binary's directory; an upgrade cannot land otherwise */
	writable: boolean;
	/** What could not be asked, one line each; the rest of the answer still stands */
	problems: string[];
	at: number;
}

export interface ClaudeCodeUpgradeResult {
	from: string | null;
	to: string;
	path: string;
	/** Where the replaced build was kept, for going back by hand; null when there was none */
	previous: string | null;
}

interface ReleaseManifest {
	version?: string;
	platforms?: Record<string, { binary?: string; checksum?: string; size?: number }>;
}

/** Where luna keeps the Claude Code binary. */
export function claudeCodePath(): string {
	return join(root(), ".bin", "claude");
}

/** The release bucket's platform name for this machine; musl builds are separate. */
export function claudeCodePlatform(): string {
	const os = process.platform === "darwin"
		? "darwin"
		: "linux";
	const arch = process.arch === "arm64"
		? "arm64"
		: "x64";
	const musl = os === "linux"
		&& (existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1"));

	return musl
		? `${os}-${arch}-musl`
		: `${os}-${arch}`;
}

/** A binary's own version, as `claude --version` prints it; null when it will not run. */
async function binaryVersion(path: string): Promise<string | null> {
	if (!existsSync(path)) {
		return null;
	}

	try {
		const child = Bun.spawn([path, "--version"], {
			// nothing of the daemon's environment: it carries the cluster token
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dirname(path), DISABLE_AUTOUPDATER: "1" },
			stdout: "pipe",
			stderr: "ignore",
		});
		const timer = setTimeout(() => child.kill(), 15_000);
		const output = await new Response(child.stdout).text();

		await child.exited;
		clearTimeout(timer);

		return /^(\d+\.\d+\.\d+)/.exec(output.trim())?.[1] ?? null;
	} catch {
		return null;
	}
}

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

	if (!response.ok) {
		throw new Error(t("core.claudeCode.httpFailed", { url, status: response.status }));
	}

	return (await response.text()).trim();
}

async function channelVersion(channel: "stable" | "latest"): Promise<string> {
	const version = await fetchText(`${CLAUDE_CODE_RELEASES}/${channel}`);

	if (!VERSION_PATTERN.test(version)) {
		throw new Error(t("core.claudeCode.badChannel", { channel }));
	}

	return version;
}

async function latestSdk(): Promise<string> {
	const body = JSON.parse(await fetchText(`${NPM_REGISTRY}/${AGENT_SDK_PACKAGE}/latest`)) as { version?: unknown };

	if (typeof body.version !== "string") {
		throw new Error(t("core.claudeCode.badRegistry"));
	}

	return body.version;
}

async function dirWritable(path: string): Promise<boolean> {
	try {
		await access(dirname(path), constants.W_OK);

		return true;
	} catch {
		// a cluster root without .bin yet: creating it is what an upgrade would do
		return !existsSync(dirname(path));
	}
}

/**
 * Describe the Claude Code build luna keeps and what Anthropic offers: the
 * installed version, the `stable` and `latest` channels, and the newest agent
 * SDK on npm. Each question is asked on its own, so one that fails is listed in
 * `problems` and the rest still answer.
 */
export async function checkClaudeCode(): Promise<ClaudeCodeCheck> {
	const path = claudeCodePath();
	const problems: string[] = [];
	const settle = async <T>(work: Promise<T>): Promise<T | null> => {
		try {
			return await work;
		} catch (err) {
			problems.push(err instanceof Error ? err.message : String(err));

			return null;
		}
	};

	const [installed, stable, latest, sdkLatest, writable] = await Promise.all([
		binaryVersion(path),
		settle(channelVersion("stable")),
		settle(channelVersion("latest")),
		settle(latestSdk()),
		dirWritable(path),
	]);

	return { path, installed, platform: claudeCodePlatform(), stable, latest, sdkLatest, writable, problems, at: Date.now() };
}

/**
 * Stream the binary to `staging`, hashing as it goes, so a 300 MB build never
 * sits in the daemon's memory. The caller compares the digest.
 */
async function downloadTo(url: string, staging: string, size: number, reporter: ProgressReporter): Promise<{ digest: string; bytes: number }> {
	const response = await fetch(url);

	if (!response.ok || !response.body) {
		throw new Error(t("core.claudeCode.httpFailed", { url, status: response.status }));
	}

	const hasher = new Bun.CryptoHasher("sha256");
	const writer = Bun.file(staging).writer();
	const reader = response.body.getReader();
	const megabytes = (size / 1024 / 1024).toFixed(0);
	let bytes = 0;
	let lastReport = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			hasher.update(value);
			writer.write(value);
			bytes += value.byteLength;

			// a chunk is a few KB; a report per chunk would be tens of thousands
			if (bytes - lastReport > 4 * 1024 * 1024 || bytes === size) {
				lastReport = bytes;
				reporter.info(size > 0 ? bytes / size : 0, t("core.claudeCode.downloading", {
					done: (bytes / 1024 / 1024).toFixed(0),
					total: megabytes,
				}));
			}
		}
	} finally {
		await writer.end();
	}

	return { digest: hasher.digest("hex"), bytes };
}

/**
 * Install a Claude Code build at `<root>/.bin/claude`: resolve the version (a
 * channel or an exact one), read its manifest, download this platform's binary,
 * check its size and SHA-256 against the manifest, check that it runs and names
 * the version asked for, then rename it over the old one. The replaced build is
 * kept as `claude.old`. A run already going keeps the binary it started with;
 * the next run starts on the new one.
 */
export async function upgradeClaudeCode(opts: { version?: ClaudeCodeTarget; actor?: string; reporter?: ProgressReporter } = {}): Promise<ClaudeCodeUpgradeResult> {
	const progress = opts.reporter ?? new ProgressReporter("claude-code-upgrade");
	const resolving = progress.child(t("core.claudeCode.steps.resolve"), 1);
	const fetching = progress.child(t("core.claudeCode.steps.download"), 12);
	const installing = progress.child(t("core.claudeCode.steps.install"), 2);
	const target = (opts.version ?? "latest").trim();
	const path = claudeCodePath();
	const platform = claudeCodePlatform();

	progress.weighOwn(0);

	const plan = await resolving.task({ start: t("core.claudeCode.steps.resolving") }, async () => {
		if (!(await dirWritable(path))) {
			throw new Error(t("core.claudeCode.notWritable", { dir: dirname(path) }));
		}

		const version = target === "stable" || target === "latest"
			? await channelVersion(target)
			: target;

		if (!VERSION_PATTERN.test(version)) {
			throw new Error(t("core.claudeCode.badVersion", { version }));
		}

		const manifest = JSON.parse(await fetchText(`${CLAUDE_CODE_RELEASES}/${version}/manifest.json`)) as ReleaseManifest;
		const entry = manifest.platforms?.[platform];

		if (!entry?.checksum || !entry.size) {
			throw new Error(t("core.claudeCode.noPlatform", { version, platform }));
		}

		const from = await binaryVersion(path);

		resolving.complete(t("core.claudeCode.steps.resolved", { version, platform }));

		return { version, from, checksum: entry.checksum, size: entry.size, binary: entry.binary || "claude" };
	});

	const staging = `${path}.new`;

	await mkdir(dirname(path), { recursive: true });

	try {
		const { digest, bytes } = await downloadTo(
			`${CLAUDE_CODE_RELEASES}/${plan.version}/${platform}/${plan.binary}`,
			staging,
			plan.size,
			fetching,
		);

		if (bytes !== plan.size) {
			throw new Error(t("core.claudeCode.sizeMismatch", { got: bytes, expected: plan.size }));
		}

		if (digest !== plan.checksum) {
			throw new Error(t("core.claudeCode.checksumMismatch", { got: digest.slice(0, 12), expected: plan.checksum.slice(0, 12) }));
		}

		fetching.complete(t("core.claudeCode.steps.verified"));
	} catch (err) {
		fetching.error(fetching.progress, err instanceof Error ? err.message : String(err));
		await unlink(staging).catch(() => undefined);

		throw err;
	}

	const previous = `${path}.old`;
	let kept: string | null = null;

	await installing.task({ start: t("core.claudeCode.steps.installing") }, async () => {
		try {
			await chmod(staging, 0o755);

			const runs = await binaryVersion(staging);

			if (runs !== plan.version) {
				throw new Error(t("core.claudeCode.wontRun", { version: plan.version, got: runs ?? "-" }));
			}

			if (existsSync(path)) {
				// a hard link keeps the old build without a moment where `claude` is missing
				await unlink(previous).catch(() => undefined);
				await link(path, previous);
				kept = previous;
			}

			await rename(staging, path);
		} catch (err) {
			await unlink(staging).catch(() => undefined);

			throw err;
		}

		installing.complete(t("core.claudeCode.steps.installed", { from: plan.from ?? "-", to: plan.version }));
	});

	progress.complete(t("core.claudeCode.steps.installed", { from: plan.from ?? "-", to: plan.version }));

	await appendJournal({
		source: "agent",
		level: "info",
		message: `claude code ${plan.from ?? "(none)"} → ${plan.version} (${platform})`,
		actor: opts.actor,
	});

	return { from: plan.from, to: plan.version, path, previous: kept };
}
