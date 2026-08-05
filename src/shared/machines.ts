/**
 * Translating between a machine's *name* and its *key*.
 *
 * The registry scopes per-machine state by key, where the primary is `""`; the
 * same "absent `daemon` field" its instances carry (core/ports.ts, the
 * environment store's machine overrides). A key of `""` is not something anyone
 * can type at a prompt or read in a table, so every UI works in names and
 * converts at the edges through these helpers.
 */

/** The shape both the CLI and the console already hold for a fleet member. */
export interface MachineLike {
	name: string;
	mode: "primary" | "follower";
}

export interface MachineOption {
	/** Key the state files scope by; `""` for the primary */
	key: string;
	/** Name an operator sees and types */
	name: string;
	primary: boolean;
}

/** Every machine as a name/key pair, primary first. */
export function machineOptions(rows: MachineLike[]): MachineOption[] {
	const options = rows.map((row) => ({
		key: row.mode === "primary" ? "" : row.name,
		name: row.name,
		primary: row.mode === "primary",
	}));

	return options.sort((a, b) => {
		if (a.primary !== b.primary) {
			return a.primary ? -1 : 1;
		}

		return a.name.localeCompare(b.name);
	});
}

/**
 * The key a typed machine name scopes to, or undefined when no machine goes by
 * that name. An empty string in means the primary, so it resolves to itself.
 */
export function machineKeyFor(rows: MachineLike[], typed: string): string | undefined {
	if (typed === "") {
		return "";
	}

	const match = rows.find((row) => row.name === typed);

	if (!match) {
		return undefined;
	}

	return match.mode === "primary" ? "" : match.name;
}

/** The name a stored machine key belongs to, falling back to the key itself. */
export function machineNameFor(rows: MachineLike[], key: string): string {
	if (key === "") {
		return rows.find((row) => row.mode === "primary")?.name ?? "primary";
	}

	return rows.find((row) => row.name === key)?.name ?? key;
}
