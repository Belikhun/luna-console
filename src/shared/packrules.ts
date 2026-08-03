/**
 * Resource-pack server rules — the one vocabulary luna-pack has for "which
 * backends get this pack": a list of instance names, `*` for all, `!name` to
 * exclude, with exclusions beating inclusions.
 *
 * This lives in `shared/` because both sides need it: the daemon writes the
 * rules into the `.yml` the proxy reads, and the console's rule matrix has to
 * predict what a checkbox will do *before* saving. A second implementation in
 * the browser would be a second matcher to keep in step with the plugin, so
 * there is exactly one, here.
 */

/**
 * Whether a rule list matches one backend name — a direct port of luna-pack's
 * `PackDefinition.matchesServer`, so the console predicts exactly what the
 * plugin will do. Exclusions win; "all" is an alias for "*".
 */
export function respackMatchesServer(servers: string[], serverName: string): boolean {
	const normalized = serverName.trim().toLowerCase();
	let included = false;

	for (const rawRule of servers) {
		let rule = rawRule.trim().toLowerCase();

		if (!rule) {
			continue;
		}

		const excluded = rule.startsWith("!");

		if (excluded) {
			rule = rule.slice(1).trim();
		}

		if (rule === "all") {
			rule = "*";
		}

		const matches = rule === "*" || rule === normalized;

		if (!matches) {
			continue;
		}

		if (excluded) {
			return false;
		}

		included = true;
	}

	return included;
}

/**
 * Rewrite a rule list so one backend is served (`on`) or not served, keeping
 * the rest of the list — and its `*` wildcards — intact.
 *
 * The two directions are not symmetric, because the matcher is not: turning a
 * backend *on* only needs a rule when nothing already matches it, while turning
 * it *off* under a `*` needs an explicit exclusion, since exclusions are the
 * only thing that beats the wildcard.
 *
 * An empty result would be an *invalid* definition (luna-pack skips a pack with
 * no rules), so "nothing" is spelled out as the one rule that matches nothing.
 */
export function toggleServerRule(servers: string[], instance: string, on: boolean): string[] {
	const target = instance.trim().toLowerCase();

	// both spellings of a rule about this backend go, whichever way we are
	// heading — what is left is every rule that talks about something else
	const rest = servers.filter((rule) => {
		const bare = rule.trim().toLowerCase().replace(/^!/, "").trim();

		return bare !== target;
	});

	const matchesAlready = respackMatchesServer(rest, target);

	if (on && !matchesAlready) {
		rest.push(target);
	}

	if (!on && matchesAlready) {
		rest.push(`!${target}`);
	}

	return rest.length ? rest : ["!*"];
}

/** Whether a rule list is the "serve everywhere" wildcard, exclusions aside. */
export function hasWildcard(servers: string[]): boolean {
	return servers.some((rule) => {
		const normalized = rule.trim().toLowerCase();

		return normalized === "*" || normalized === "all";
	});
}

/**
 * Rewrite a rule list to serve everywhere (`on`) or to name backends one by one.
 *
 * Turning the wildcard off keeps serving exactly the backends that were being
 * served — the matrix's checkboxes must not all flip because the operator
 * changed how the same set is spelled. `matched` is the backend list to freeze;
 * the caller has it because it is what the checkboxes render from.
 */
export function toggleWildcard(servers: string[], on: boolean, matched: string[]): string[] {
	if (on) {
		// a wildcard makes every other inclusion redundant, but not the exclusions
		const exclusions = servers.filter((rule) => rule.trim().startsWith("!") && rule.trim() !== "!*");

		return ["*", ...exclusions];
	}

	return matched.length ? [...matched] : ["!*"];
}
