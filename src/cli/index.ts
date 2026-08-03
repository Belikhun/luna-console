// luna CLI entry point.
// Layers: core/ = pure domain logic (no console I/O) · cli/ = terminal presentation ·
// web/ = SvelteKit console reusing core through the $core alias.

import "./commands/instance";
import "./commands/plugins";
import "./commands/addons";
import "./commands/luna";
import "./commands/net";
import "./commands/players";
import "./commands/misc";
import "./commands/web";
import "./commands/env";
import "./commands/packs";
import "./commands/schedule";
import "./commands/daemon";
import "./commands/setup";

import { command, dispatch } from "./framework";
import { complete, BASH_HOOK, ZSH_HOOK, FISH_HOOK } from "./complete";
import { pc, fail } from "./ui";

command({
	path: ["completions"],
	desc: "Print shell completion hook (bash|zsh|fish)",
	args: [{ name: "shell", required: true, complete: async () => ["bash", "zsh", "fish"] }],

	handler: async (args) => {
		const shell = args[0]!;
		const hooks: Record<string, string> = { bash: BASH_HOOK, zsh: ZSH_HOOK, fish: FISH_HOOK };
		const hook = hooks[shell];

		if (!hook) {
			fail(`unsupported shell: ${shell}`);
			process.exitCode = 1;

			return;
		}

		console.log(hook);

		const target =
			shell === "fish" ? "config/fish/completions/luna.fish" : `${shell}rc`;

		console.error(pc.dim(`# install: luna completions ${shell} >> ~/.${target}`));
	},
});

async function main(): Promise<void> {
	const argv = process.argv.slice(2);

	// completion protocol: luna __complete -- <words...> — bypasses normal parsing
	// so partial flags like "--a" don't trip the option validator.
	if (argv[0] === "__complete") {
		const words = argv.slice(1).filter((word) => word !== "--");

		// fail soft: a Tab press with the daemon down completes to nothing
		// rather than spraying an error into the user's command line
		try {
			for (const hit of await complete(words)) {
				console.log(hit);
			}
		} catch {
			return;
		}

		return;
	}

	if (argv.length === 0 && process.stdout.isTTY) {
		const { repl } = await import("./repl");

		await repl();

		return;
	}

	await dispatch(argv);
}

main().catch((err) => {
	fail(err?.message ?? String(err));

	if (process.env.LUNA_DEBUG) {
		console.error(err);
	}

	process.exit(1);
});
