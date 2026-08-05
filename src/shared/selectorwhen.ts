/**
 * The `when:` expression language of a selector conditional rule.
 *
 * The plugin evaluates these by splitting on `||`, then on `&&`, both
 * quote-aware but **not** paren-aware: `(a || b) && c` splits at the top-level
 * `||` first and evaluates as something the author did not write. So the
 * structured form here is deliberately flat; an OR of ANDs, nothing nested -
 * and anything that does not fit round-trips as raw text instead.
 */

export type WhenOperator = "==" | "!=" | ">=" | "<=" | ">" | "<";

export const WHEN_OPERATORS: readonly WhenOperator[] = ["==", "!=", ">=", "<=", ">", "<"];

/** Variables the plugin resolves inside a condition. */
export const WHEN_VARIABLES: readonly string[] = [
	"status",
	"server_status",
	"server_name",
	"luna_host_name",
	"luna_server_name",
	"server_display",
	"online",
	"max",
	"whitelist",
	"maint",
	"no_permission",
	"nop",
	"has_permission",
	"tps",
	"cpu_usage",
	"latency_ms",
	"ram_percent",
	"is_online",
	"is_offline",
	"is_maint",
	"is_nop",
];

export interface WhenTerm {
	/** A leading `!`, only meaningful on a truthiness test */
	negated?: boolean;
	variable: string;
	/** Absent means "is this variable truthy" */
	op?: WhenOperator;
	value?: string;
}

export interface WhenClause {
	/** ANDed together */
	terms: WhenTerm[];
}

export interface WhenExpression {
	/** ORed together */
	clauses: WhenClause[];
}

const COMPARISON = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Split on a top-level operator, ignoring occurrences inside quotes. */
function splitTopLevel(expression: string, operator: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: string | null = null;

	for (let index = 0; index < expression.length; index++) {
		const char = expression[index] as string;

		if (quote) {
			current += char;

			if (char === quote) {
				quote = null;
			}

			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			current += char;

			continue;
		}

		if (expression.startsWith(operator, index)) {
			parts.push(current);
			current = "";
			index += operator.length - 1;

			continue;
		}

		current += char;
	}

	parts.push(current);

	return parts.map((part) => part.trim());
}

function parseTerm(raw: string): WhenTerm | undefined {
	let text = raw.trim();

	if (!text) {
		return undefined;
	}

	let negated = false;

	while (text.startsWith("!")) {
		negated = !negated;
		text = text.slice(1).trim();
	}

	const comparison = COMPARISON.exec(text);

	if (comparison) {
		// a negated comparison is representable in the plugin but reads badly and
		// the editor has no control for it; keep it as raw text
		if (negated) {
			return undefined;
		}

		return {
			variable: comparison[1] as string,
			op: comparison[2] as WhenOperator,
			value: (comparison[3] as string).trim(),
		};
	}

	if (!IDENTIFIER.test(text)) {
		return undefined;
	}

	return negated ? { variable: text, negated: true } : { variable: text };
}

/**
 * Parse a condition into the flat structure the editor can render.
 *
 * @returns undefined when the expression is valid for the plugin but not
 *          representable here (parentheses, a negated comparison); the caller
 *          keeps the original string rather than rewriting it
 */
export function parseWhen(expression: string): WhenExpression | undefined {
	const text = (expression ?? "").trim();

	if (!text) {
		return { clauses: [] };
	}

	if (text.includes("(") || text.includes(")")) {
		return undefined;
	}

	const clauses: WhenClause[] = [];

	for (const clauseText of splitTopLevel(text, "||")) {
		const terms: WhenTerm[] = [];

		for (const termText of splitTopLevel(clauseText, "&&")) {
			const term = parseTerm(termText);

			if (!term) {
				return undefined;
			}

			terms.push(term);
		}

		if (terms.length === 0) {
			return undefined;
		}

		clauses.push({ terms });
	}

	return { clauses };
}

function formatTerm(term: WhenTerm): string {
	if (!term.op) {
		return term.negated ? `!${term.variable}` : term.variable;
	}

	return `${term.variable} ${term.op} ${term.value ?? ""}`.trim();
}

/** The facts a condition can ask about, as the plugin supplies them. */
export type WhenContext = Record<string, string | number | boolean | undefined>;

/** `false`, `no`, `0` and blank are falsey; everything else is truthy. */
function truthy(value: string | number | boolean | undefined): boolean {
	if (value === undefined || value === null) {
		return false;
	}

	if (typeof value === "boolean") {
		return value;
	}

	const text = String(value).trim().toLowerCase();

	return text !== "" && text !== "false" && text !== "no" && text !== "0";
}

function compare(left: string | number | boolean | undefined, op: WhenOperator, rightRaw: string): boolean {
	const right = rightRaw.replace(/^['"]|['"]$/g, "");
	const leftNumber = Number.parseFloat(String(left));
	const rightNumber = Number.parseFloat(right);
	const numeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && String(left).trim() !== "";

	if (numeric) {
		switch (op) {
			case "==":
				return leftNumber === rightNumber;
			case "!=":
				return leftNumber !== rightNumber;
			case ">=":
				return leftNumber >= rightNumber;
			case "<=":
				return leftNumber <= rightNumber;
			case ">":
				return leftNumber > rightNumber;
			case "<":
				return leftNumber < rightNumber;
		}
	}

	// the plugin compares strings case-insensitively, which is what makes
	// `status == OFFLINE` work unquoted
	const leftText = String(left ?? "").trim().toLowerCase();
	const rightText = right.trim().toLowerCase();

	switch (op) {
		case "==":
			return leftText === rightText;
		case "!=":
			return leftText !== rightText;
		case ">=":
			return leftText >= rightText;
		case "<=":
			return leftText <= rightText;
		case ">":
			return leftText > rightText;
		case "<":
			return leftText < rightText;
	}
}

/**
 * Evaluate a condition against a context, so a preview can show the same item
 * the player would see.
 *
 * An expression this cannot parse evaluates to false rather than throwing: the
 * editor draws a preview from it, and a preview is never worth an exception.
 */
export function evaluateWhen(expression: string, context: WhenContext): boolean {
	const parsed = parseWhen(expression);

	if (!parsed || parsed.clauses.length === 0) {
		return false;
	}

	return parsed.clauses.some((clause) =>
		clause.terms.every((term) => {
			const value = context[term.variable];

			if (!term.op) {
				return term.negated ? !truthy(value) : truthy(value);
			}

			return compare(value, term.op, term.value ?? "");
		}),
	);
}

/** Render an expression back to the flat form the plugin parses correctly. */
export function formatWhen(expression: WhenExpression): string {
	return expression.clauses
		.map((clause) => clause.terms.map(formatTerm).join(" && "))
		.filter((clause) => clause.length > 0)
		.join(" || ");
}
