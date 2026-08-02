import { existsSync } from "node:fs";
import { join } from "node:path";

import { command, Bail } from "../framework";
import { pc, info, ok } from "../ui";
import { root } from "../../client/core/config";
import { ensureConnected } from "../../client/socket";

command({
	path: ["web"],
	desc: "Start the web console (SvelteKit app in control/web)",
	opts: [
		{ flag: "--port", desc: "listen port (default 8330)", value: true },
		{ flag: "--host", desc: "bind address (default 127.0.0.1)", value: true },
		{ flag: "--dev", desc: "run the vite dev server instead of the production build" },
	],

	handler: async (_args, opts) => {
		// the console only runs beside the primary daemon — its backend talks to
		// the daemon over the same socket the CLI uses
		const daemon = await ensureConnected();

		if (daemon.mode !== "primary") {
			throw new Bail(
				`this host runs the "${daemon.name}" follower daemon — the web console only runs on the primary`,
			);
		}

		// the console normally lives in the source tree beside the cluster root;
		// a container image ships it somewhere else entirely, hence the override
		const webDir = process.env.LUNA_WEB_DIR ?? join(root(), "control", "web");
		const port = (opts.port as string) ?? "8330";
		const host = (opts.host as string) ?? "127.0.0.1";

		if (!existsSync(webDir)) {
			throw new Bail(`web console not found at ${webDir}`);
		}

		const stdio = {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		} as const;

		let proc;

		if (opts.dev) {
			info(`starting dev console on ${pc.cyan(`http://${host}:${port}`)} ${pc.dim("(hot reload)")}`);

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
				throw new Bail(`production build missing — run: cd ${webDir} && bun run build`);
			}

			ok(`web console on ${pc.cyan(`http://${host}:${port}`)} ${pc.dim("(Ctrl+C to stop)")}`);

			proc = Bun.spawn(["bun", build], {
				cwd: webDir,
				env: { ...process.env, LUNA_ROOT: root(), PORT: port, HOST: host },
				...stdio,
			});
		}

		process.exit(await proc.exited);
	},
});
