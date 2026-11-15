// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { actorPrompt } from "./actor";
import { dispatch, resolveCommand, usageLine, allCommands } from "./framework";
import { complete } from "./complete";
import { pc } from "./ui";
import { t } from "../shared/i18n";

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

/** Where the REPL keeps its lines between sessions, one per line, oldest first. */
const HISTORY_FILE = join(homedir(), ".luna_history");
const HISTORY_SIZE = 500;

function loadHistory(): string[] {
	try {
		return readFileSync(HISTORY_FILE, "utf8")
			.split(/\r?\n/)
			.filter((line) => line.trim() !== "")
			.slice(-HISTORY_SIZE)
			.reverse();
	} catch {
		return [];
	}
}

function saveHistory(history: string[]): void {
	try {
		writeFileSync(HISTORY_FILE, `${history.slice(0, HISTORY_SIZE).reverse().join("\n")}\n`, { mode: 0o600 });
	} catch {
		// a home this account cannot write only costs the next session its history
	}
}

/**
 * Tab completion for the prompt. A single candidate that is a whole word gets
 * its trailing space, as a shell completes, so the next Tab offers what follows.
 */
function completer(line: string, cb: (err: null, result: [string[], string]) => void): void {
	const words = splitWords(line);
	const cur = words[words.length - 1] ?? "";

	complete(words)
		.then((hits) => {
			if (hits.length === 1 && !/[,=/]$/.test(hits[0]!)) {
				cb(null, [[`${hits[0]} `], cur]);

				return;
			}

			cb(null, [hits, cur]);
		})
		.catch(() => cb(null, [[], cur]));
}

/**
 * Read one line through a readline interface of its own, closed before the line
 * runs. A command then owns stdin outright: a confirmation's own prompt, a
 * console attach in raw mode and Ctrl-C reach it and nothing else, and the next
 * prompt starts with the terminal back in raw mode whatever the command left.
 * `history` (newest first) is carried from one interface to the next. Resolves
 * null on Ctrl-D, and an empty line on Ctrl-C.
 */
function readLine(prompt: string, history: string[]): Promise<string | null> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: true,
		history: [...history],
		historySize: HISTORY_SIZE,
		removeHistoryDuplicates: true,
		completer,
	});

	return new Promise((done) => {
		let settled = false;

		const finish = (line: string | null): void => {
			if (settled) {
				return;
			}

			settled = true;

			const kept = (rl as unknown as { history?: string[] }).history;

			if (line !== null && Array.isArray(kept)) {
				history.splice(0, history.length, ...kept);
			}

			rl.close();
			done(line);
		};

		rl.on("SIGINT", () => {
			process.stdout.write("^C\n");
			finish("");
		});

		rl.on("close", () => finish(null));
		rl.question(prompt, (line) => finish(line));
	});
}

/** Interactive prompt over the same command registry the CLI dispatches from. */
export async function repl(): Promise<void> {
	console.log(pc.bold(pc.magenta("\n  luna")) + pc.dim(` ${t("cli.repl.title")}`));
	console.log(pc.dim(`  ${t("cli.repl.hints")}\n`));

	// user@luna, as a shell names itself: the CLI acts as `root` unless the
	// console's terminal drawer told it whose session it is running for, and the
	// prompt is where that has to be visible before a command is typed
	const prompt = `${pc.magenta(actorPrompt())} ${pc.dim(">>>")} `;
	const history = loadHistory();

	// Ctrl-C while a line runs stops what listens for it and never the prompt itself
	const keepPrompt = (): void => {
		process.stdout.write("\n");
	};

	while (true) {
		const line = await readLine(prompt, history);

		if (line === null) {
			break;
		}

		const trimmed = line.trim();

		if (trimmed === "exit" || trimmed === "quit") {
			break;
		}

		if (trimmed === "") {
			continue;
		}

		saveHistory(history);

		// "instance create ?" → inline hint
		if (trimmed.endsWith("?")) {
			printHint(trimmed.slice(0, -1).trim());

			continue;
		}

		process.on("SIGINT", keepPrompt);

		try {
			await dispatch(splitWords(trimmed).filter(Boolean));
		} catch (err) {
			console.error(pc.red(`✘ ${(err as Error)?.message ?? err}`));
		} finally {
			process.off("SIGINT", keepPrompt);
			process.exitCode = 0;
		}
	}

	console.log(pc.dim(t("cli.repl.bye")));
}
