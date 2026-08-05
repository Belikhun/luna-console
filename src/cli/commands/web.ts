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
				},
				...stdio,
			});
		}

		process.exit(await proc.exited);
	},
});
