// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { command, Bail } from "../framework";
import { pc, info, ok } from "../ui";
import { root } from "../../client/core/config";
import { ensureConnected } from "../../client/socket";
import { t } from "../../shared/i18n";

command({
	path: ["web"],
	desc: t("cli.web.desc"),
	opts: [
		{ flag: "--port", desc: t("cli.web.optPort"), value: true },
		{ flag: "--host", desc: t("cli.web.optHost"), value: true },
		{ flag: "--dev", desc: t("cli.web.optDev") },
		{ flag: "--behind-proxy", desc: t("cli.web.optBehindProxy") },
		{ flag: "--proxy-depth", desc: t("cli.web.optProxyDepth"), value: true },
	],

	handler: async (_args, opts) => {
		// the console only runs beside the primary daemon: its backend talks to
		// the daemon over the same socket the CLI uses
		const daemon = await ensureConnected();

		if (daemon.mode !== "primary") {
			throw new Bail(t("cli.web.followerHost", { name: daemon.name }));
		}

		// the console normally lives in the source tree beside the cluster root;
		// a container image ships it somewhere else entirely, hence the override
		const webDir = process.env.LUNA_WEB_DIR ?? join(root(), "control", "web");
		const port = (opts.port as string) ?? "8330";
		const host = (opts.host as string) ?? "127.0.0.1";

		if (!existsSync(webDir)) {
			throw new Bail(t("cli.web.notFound", { dir: webDir }));
		}

		const stdio = {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		} as const;

		/**
		 * Reverse-proxy mode, opt-in and never a default.
		 *
		 * Behind nginx every request arrives from 127.0.0.1 over plain HTTP, so
		 * without these the console records the proxy as the client address, marks
		 * no session cookie `Secure`, and builds redirects against the internal
		 * host. adapter-node reads all four from the environment.
		 *
		 * It has to be opt-in: `X-Forwarded-For` is a request header like any
		 * other, so a directly-reachable console that trusted it would let anyone
		 * choose the address written into the audit trail, and pick a fresh one per
		 * request to sidestep the sign-in lockout. `XFF_DEPTH` says how many
		 * proxies of our own to count back through; with one nginx in front that is
		 * 1, and a larger number would start trusting client-supplied hops.
		 */
		const proxyEnv: Record<string, string> = {};

		if (opts["behind-proxy"]) {
			proxyEnv.ADDRESS_HEADER = "X-Forwarded-For";
			proxyEnv.XFF_DEPTH = (opts["proxy-depth"] as string) ?? "1";
			proxyEnv.PROTOCOL_HEADER = "X-Forwarded-Proto";
			proxyEnv.HOST_HEADER = "X-Forwarded-Host";

			info(t("cli.web.behindProxy", { depth: proxyEnv.XFF_DEPTH }));
		}

		let proc;

		if (opts.dev) {
			info(
				`${t("cli.web.devStarting", { url: pc.cyan(`http://${host}:${port}`) })} ${pc.dim(t("cli.web.devHotReload"))}`,
			);

			// --strictPort so a stale server on this port can never shadow the new one
			proc = Bun.spawn(
				["bun", "run", "dev", "--", "--port", port, "--host", host, "--strictPort"],
				{
					cwd: webDir,
					env: { ...process.env, LUNA_ROOT: root() },
					...stdio,
				},
			);
		} else {
			const build = join(webDir, "build", "index.js");

			if (!existsSync(build)) {
				throw new Bail(t("cli.web.buildMissing", { dir: webDir }));
			}

			ok(
				`${t("cli.web.serving", { url: pc.cyan(`http://${host}:${port}`) })} ${pc.dim(t("cli.web.stopHint"))}`,
			);

			proc = Bun.spawn(["bun", build], {
				cwd: webDir,
				// BODY_SIZE_LIMIT: adapter-node caps request bodies at 512K by
				// default, which rejects pack uploads; a resource pack zip is
				// easily tens of MB
				env: {
					...process.env,
					LUNA_ROOT: root(),
					PORT: port,
					HOST: host,
					BODY_SIZE_LIMIT: process.env.BODY_SIZE_LIMIT ?? "256M",
					...proxyEnv,
				},
				...stdio,
			});
		}

		process.exit(await proc.exited);
	},
});
