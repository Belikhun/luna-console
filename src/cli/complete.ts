// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { allCommands, resolveCommand, type OptSpec } from "./framework";

/**
 * Compute completion candidates. `words` are the argv words typed so far,
 * the last one being the (possibly empty) word under the cursor.
 */
export async function complete(words: string[]): Promise<string[]> {
	const cur = words.length ? words[words.length - 1]! : "";
	const prev = words.slice(0, -1).filter((word) => word.length > 0);
	const cands = new Set<string>();

	// Deeper command path components
	for (const cmd of allCommands()) {
		if (cmd.hidden) {
			continue;
		}

		const isDeeper =
			cmd.path.length > prev.length &&
			cmd.path.slice(0, prev.length).every((part, i) => prev[i] === part);

		if (isDeeper) {
			cands.add(cmd.path[prev.length]!);
		}
	}

	if (prev.length === 0) {
		cands.add("help");
	}

	const match = resolveCommand(prev);

	if (match) {
		const { cmd } = match;
		const optSpecs = cmd.opts ?? [];
		const positionals: string[] = [];
		let expectValueFor: OptSpec | undefined;

		for (const word of match.rest) {
			if (expectValueFor) {
				expectValueFor = undefined;

				continue;
			}

			if (!word.startsWith("--")) {
				positionals.push(word);

				continue;
			}

			const eq = word.indexOf("=");
			const flag = eq === -1 ? word : word.slice(0, eq);
			const spec = optSpecs.find((opt) => opt.flag === flag);

			if (spec?.value && eq === -1) {
				expectValueFor = spec;
			}
		}

		const addValues = async (completer?: () => Promise<string[]>): Promise<void> => {
			if (!completer) {
				return;
			}

			// comma-separated multi-values: complete the segment after the last comma
			const lastComma = cur.lastIndexOf(",");
			const prefix = lastComma === -1 ? "" : cur.slice(0, lastComma + 1);

			for (const value of await completer()) {
				cands.add(prefix + value);
			}
		};

		if (expectValueFor) {
			await addValues(expectValueFor.complete);
		} else if (cur.startsWith("-")) {
			for (const opt of optSpecs) {
				cands.add(opt.flag);
			}
		} else {
			const specs = cmd.args ?? [];
			const last = specs.at(-1);
			const spec = specs[positionals.length] ?? (last?.variadic ? last : undefined);

			await addValues(spec?.complete);

			for (const opt of optSpecs) {
				cands.add(opt.flag);
			}
		}
	}

	return [...cands].filter((cand) => cand.startsWith(cur) && cand !== cur).sort();
}

export const BASH_HOOK = `# luna bash completion
_luna_complete() {
    local IFS=$'\\n'
    COMPREPLY=($(luna __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))
}
complete -o default -F _luna_complete luna
`;

export const ZSH_HOOK = `# luna zsh completion
_luna() {
    local -a completions
    completions=("\${(@f)$(luna __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
    [[ -n "$completions" ]] && compadd -a completions
}
compdef _luna luna
`;

export const FISH_HOOK = `# luna fish completion
complete -c luna -f -a "(luna __complete -- (commandline -opc)[2..] (commandline -ct) 2>/dev/null)"
`;
