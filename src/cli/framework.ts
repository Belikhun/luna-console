import { pc } from "./ui";

export interface ArgSpec {
	name: string;
	desc?: string;
	required?: boolean;
	variadic?: boolean;
	/** Dynamic completion values */
	complete?: () => Promise<string[]>;
}

export interface OptSpec {
	/** e.g. "--to" */
	flag: string;
	desc?: string;
	/** Takes a value? */
	value?: boolean;
	complete?: () => Promise<string[]>;
}

export interface Command {
	/** e.g. ["instance", "start"] */
	path: string[];
	desc: string;
	args?: ArgSpec[];
	opts?: OptSpec[];
	hidden?: boolean;
	handler: (args: string[], opts: Record<string, string | boolean>) => Promise<void>;
}

export class UsageError extends Error {}

/** Abort the current command with an error message (REPL-safe, unlike process.exit). */
export class Bail extends Error {}

const commands: Command[] = [];

/** Register a command in the typed registry that drives parsing, help and completion. */
export function command(cmd: Command): void {
	commands.push(cmd);
}

/** Every registered command, in declaration order. */
export function allCommands(): Command[] {
	return commands;
}

/** Find the command matching the longest prefix of argv words. */
export function resolveCommand(words: string[]): { cmd: Command; rest: string[] } | undefined {
	let best: { cmd: Command; rest: string[] } | undefined;

	for (const cmd of commands) {
		if (cmd.path.length > words.length) {
			continue;
		}

		if (!cmd.path.every((part, i) => words[i] === part)) {
			continue;
		}

		if (!best || cmd.path.length > best.cmd.path.length) {
			best = { cmd, rest: words.slice(cmd.path.length) };
		}
	}

	return best;
}

/**
 * Split a command's remaining words into positional arguments and options,
 * validating both against the command's spec. Throws UsageError on anything the
 * command did not declare, so a typo never reaches a handler.
 */
export function parseRest(
	cmd: Command,
	rest: string[],
): { args: string[]; opts: Record<string, string | boolean> } {
	const args: string[] = [];
	const opts: Record<string, string | boolean> = {};
	const optSpecs = cmd.opts ?? [];

	for (let i = 0; i < rest.length; i++) {
		const word = rest[i]!;

		if (!word.startsWith("--")) {
			args.push(word);

			continue;
		}

		const eq = word.indexOf("=");
		const flag = eq === -1 ? word : word.slice(0, eq);
		const spec = optSpecs.find((opt) => opt.flag === flag);

		if (!spec) {
			throw new UsageError(`unknown option ${flag}`);
		}

		const key = flag.replace(/^--/, "");

		if (!spec.value) {
			opts[key] = true;

			continue;
		}

		if (eq !== -1) {
			opts[key] = word.slice(eq + 1);

			continue;
		}

		const next = rest[++i];

		if (next === undefined) {
			throw new UsageError(`option ${flag} requires a value`);
		}

		opts[key] = next;
	}

	const specs = cmd.args ?? [];
	const requiredCount = specs.filter((arg) => arg.required).length;

	if (args.length < requiredCount) {
		throw new UsageError(`missing argument <${specs[args.length]!.name}>`);
	}

	const hasVariadic = specs.some((arg) => arg.variadic);

	if (!hasVariadic && args.length > specs.length) {
		throw new UsageError(`unexpected argument "${args[specs.length]}"`);
	}

	return { args, opts };
}

/** One-line usage synopsis: command path, then arguments, then options. */
export function usageLine(cmd: Command): string {
	const parts = [pc.bold(cmd.path.join(" "))];

	for (const arg of cmd.args ?? []) {
		const name = `${arg.name}${arg.variadic ? "..." : ""}`;

		parts.push(arg.required ? `<${name}>` : `[${name}]`);
	}

	for (const opt of cmd.opts ?? []) {
		parts.push(pc.dim(`[${opt.flag}${opt.value ? " <v>" : ""}]`));
	}

	return parts.join(" ");
}

/** Print grouped help for every visible command, or just one command group. */
export function printHelp(filter?: string): void {
	console.log(pc.bold(pc.magenta("\nmrds")) + pc.dim(" — minecraft cluster control center\n"));

	const groups = new Map<string, Command[]>();

	for (const cmd of commands) {
		if (cmd.hidden) {
			continue;
		}

		if (filter && cmd.path[0] !== filter) {
			continue;
		}

		const group = cmd.path.length > 1 ? cmd.path[0]! : "";

		if (!groups.has(group)) {
			groups.set(group, []);
		}

		groups.get(group)!.push(cmd);
	}

	const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

	for (const [group, cmds] of sorted) {
		if (group) {
			console.log(pc.bold(pc.cyan(`  ${group}`)));
		}

		for (const cmd of cmds) {
			console.log(`    ${usageLine(cmd)}`);
			console.log(`      ${pc.dim(cmd.desc)}`);
		}

		console.log();
	}
}

/** Resolve argv to a command, parse its arguments, and run it. */
export async function dispatch(argv: string[]): Promise<void> {
	if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
		printHelp(argv[1]);

		return;
	}

	const match = resolveCommand(argv);

	if (!match) {
		console.error(pc.red(`unknown command: ${argv.join(" ")}`));
		console.error(pc.dim(`run "mrds help" for usage`));
		process.exit(1);
	}

	try {
		const { args, opts } = parseRest(match.cmd, match.rest);

		await match.cmd.handler(args, opts);
	} catch (err) {
		if (err instanceof UsageError) {
			console.error(pc.red(`usage error: ${err.message}`));
			console.error(`  ${usageLine(match.cmd)}`);
			process.exitCode = 1;

			return;
		}

		if (err instanceof Bail) {
			console.error(pc.red(`✘ ${err.message}`));
			process.exitCode = 1;

			return;
		}

		throw err;
	}
}
