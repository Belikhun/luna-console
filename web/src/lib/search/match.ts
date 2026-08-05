/**
 * The console's one text matcher. Both the resource tables and the global
 * search box run queries through it, so a term that finds a row in a table
 * finds the same object in the search box; and neither can drift into its own
 * idea of what "matches" means (DESIGN.md §5.1).
 */

/** Split a query into the terms that must all be present. */
function terms(query: string): string[] {
	return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Whether a haystack satisfies a query: every whitespace-separated term must
 * appear somewhere in it. An empty query matches everything.
 */
export function matches(haystack: string, query: string): boolean {
	const needles = terms(query);

	if (needles.length === 0) {
		return true;
	}

	const hay = haystack.toLowerCase();

	return needles.every((needle) => hay.includes(needle));
}

/**
 * How well a haystack answers a query, for ordering hits. Higher is better;
 * 0 means it does not match at all. A prefix beats a word start, which beats a
 * hit buried mid-token; the ranking a jump box needs to put the exact thing
 * you typed at the top.
 */
export function score(haystack: string, query: string): number {
	const needles = terms(query);

	if (needles.length === 0) {
		return 1;
	}

	const hay = haystack.toLowerCase();
	let total = 0;

	for (const needle of needles) {
		const at = hay.indexOf(needle);

		if (at === -1) {
			return 0;
		}

		if (at === 0) {
			total += 3;
		} else if (/[\s/@:_-]/.test(hay[at - 1] ?? '')) {
			total += 2;
		} else {
			total += 1;
		}

		// a term that is most of the haystack is a better answer than the same
		// term inside a much longer string
		total += needle.length / Math.max(hay.length, 1);
	}

	return total;
}

/**
 * Flatten an arbitrary row into searchable text. This is the fallback haystack
 * for a table that does not declare `searchValue`: primitives are taken as they
 * are and nested objects/arrays are walked one level, which covers the shapes
 * the API routes actually hand the console.
 */
export function rowText(row: unknown, depth = 2): string {
	if (row === null || row === undefined) {
		return '';
	}

	if (typeof row !== 'object') {
		return String(row);
	}

	if (depth <= 0) {
		return '';
	}

	const parts: string[] = [];

	for (const value of Object.values(row as Record<string, unknown>)) {
		if (value === null || value === undefined) {
			continue;
		}

		if (typeof value === 'object') {
			parts.push(rowText(value, depth - 1));

			continue;
		}

		parts.push(String(value));
	}

	return parts.join(' ');
}
