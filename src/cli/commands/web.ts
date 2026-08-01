import { existsSync } from "node:fs";
import { join } from "node:path";

import { command, Bail } from "../framework";
import { pc, info, ok } from "../ui";
import { root } from "../../core/config";

command({
	path: ["web"],
	desc: "Start the web console (SvelteKit app in control/web)",
	opts: [
		{ flag: "--port", desc: "listen port (default 8330)", value: true },
		{ flag: "--host", desc: "bind address (default 127.0.0.1)", value: true },
		{ flag: "--dev", desc: "run the vite dev server instead of the production build" },
	],

	handler: async (_args, opts) => {
		const webDir = join(root(), "control", "web");
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
					env: { ...process.env, MRDS_ROOT: root() },
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
				env: { ...process.env, MRDS_ROOT: root(), PORT: port, HOST: host },
				...stdio,
			});
		}

		process.exit(await proc.exited);
	},
});
