import { createInterface } from "node:readline";

import { dispatch, resolveCommand, usageLine, allCommands } from "./framework";
import { complete } from "./complete";
import { pc } from "./ui";

/**
 * Split a prompt line into argv words, honouring double quotes. A line that ends
 * in whitespace gets a trailing empty word, which is what tells the completer the
 * cursor sits at the start of a new argument rather than inside the last one.
 */
function splitWords(line: string): string[] {
	const words =
		line.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((word) => word.replace(/^"|"$/g, "")) ?? [];

	if (line === "" || /\s$/.test(line)) {
		words.push("");
	}

	return words;
}

/** Print the inline hint for a `<command> ?` line: usage, description, options. */
function printHint(line: string): void {
	const words = splitWords(line);
	const match = resolveCommand(words);

	if (match) {
		console.log(`  ${usageLine(match.cmd)}`);
		console.log(`  ${pc.dim(match.cmd.desc)}`);

		for (const opt of match.cmd.opts ?? []) {
			console.log(`    ${pc.cyan(opt.flag)}  ${pc.dim(opt.desc ?? "")}`);
		}

		return;
	}

	const prefix = words.filter(Boolean);

	const subs = allCommands().filter(
		(cmd) => !cmd.hidden && cmd.path.slice(0, prefix.length).join(" ") === prefix.join(" "),
	);

	for (const cmd of subs) {
		console.log(`  ${usageLine(cmd)} ${pc.dim("— " + cmd.desc)}`);
	}
}

/** Interactive prompt over the same command registry the CLI dispatches from. */
export async function repl(): Promise<void> {
	console.log(pc.bold(pc.magenta("\n  luna")) + pc.dim(" interactive console"));
	console.log(
		pc.dim(
			"  Tab to complete · 'help' for commands · '?' after a command for hints · 'exit' to leave\n",
		),
	);

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: `${pc.magenta("luna")} ${pc.dim(">>>")} `,
		historySize: 500,

		completer: (line: string, cb: (err: null, result: [string[], string]) => void) => {
			const words = splitWords(line);
			const cur = words[words.length - 1] ?? "";

			complete(words)
				.then((hits) => cb(null, [hits, cur]))
				.catch(() => cb(null, [[], cur]));
		},
	});

	rl.prompt();

	for await (const line of rl) {
		const trimmed = line.trim();

		if (trimmed === "exit" || trimmed === "quit") {
			break;
		}

		if (trimmed === "") {
			rl.prompt();

			continue;
		}

		// "instance create ?" → inline hint
		if (trimmed.endsWith("?")) {
			printHint(trimmed.slice(0, -1).trim());
			rl.prompt();

			continue;
		}

		try {
			// pause readline so interactive prompts/console attach own stdin
			rl.pause();
			await dispatch(splitWords(trimmed).filter(Boolean));
		} catch (err) {
			console.error(pc.red(`✘ ${(err as Error)?.message ?? err}`));
		} finally {
			rl.resume();
			process.exitCode = 0;
			rl.prompt();
		}
	}

	rl.close();
	console.log(pc.dim("bye"));
}
