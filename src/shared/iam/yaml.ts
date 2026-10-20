// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The policy document written back out as YAML, for the visual editor.
 *
 * Only the document's own shape is ever emitted, so this is a small writer
 * rather than a YAML library: a fixed key order (Version, Statement; inside a
 * statement Sid, Effect, Action or NotAction, Resource or NotResource,
 * Condition), two-space indentation, one-item lists as a scalar, and a scalar
 * quoted whenever a plain one could be read as something else. Reading YAML
 * stays the daemon's job; what this writes is checked there like any other
 * text.
 */

import type { PolicyDocument, PolicyStatement } from "./grammar";

/** Words a plain YAML scalar would read as a boolean or a null. */
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n", "~"]);

/** Characters that may not open a plain scalar. */
const LEADING = new Set(["*", "&", "!", "|", ">", "'", "\"", "%", "@", "`", "#", ",", "[", "]", "{", "}", "?", "-", ":", "$", " "]);

/** Whether a value has to be quoted to come back as the same string. */
export function needsQuoting(value: string): boolean {
	if (value === "") {
		return true;
	}

	if (LEADING.has(value.charAt(0))) {
		return true;
	}

	if (value.endsWith(" ") || value.endsWith(":")) {
		return true;
	}

	if (RESERVED.has(value.toLowerCase())) {
		return true;
	}

	// a number, a hex or octal literal, or anything a resolver might take for one
	if (/^[-+]?(\d[\d_]*)?(\.\d*)?([eE][-+]?\d+)?$/.test(value) || /^0[xo]/i.test(value) || /^[-+]?\.(inf|nan)$/i.test(value)) {
		return true;
	}

	if (value.includes(": ") || value.includes(" #") || value.includes("\t")) {
		return true;
	}

	return /["'\\{}[\],\n\r]/.test(value);
}

/** A scalar as YAML, double-quoted (JSON's escaping is valid YAML) when it must be. */
export function yamlScalar(value: string): string {
	return needsQuoting(value)
		? JSON.stringify(value)
		: value;
}

/** A list under a key: one value as a scalar, more as a block sequence. */
function listField(lines: string[], indent: string, key: string, values: string[]): void {
	if (values.length === 1) {
		lines.push(`${indent}${yamlScalar(key)}: ${yamlScalar(values[0]!)}`);

		return;
	}

	if (values.length === 0) {
		lines.push(`${indent}${yamlScalar(key)}: []`);

		return;
	}

	lines.push(`${indent}${yamlScalar(key)}:`);

	for (const value of values) {
		lines.push(`${indent}  - ${yamlScalar(value)}`);
	}
}

function statementLines(stmt: PolicyStatement): string[] {
	const lines: string[] = [];
	const body = "    ";

	if (stmt.Sid) {
		lines.push(`${body}Sid: ${yamlScalar(stmt.Sid)}`);
	}

	lines.push(`${body}Effect: ${stmt.Effect}`);

	if (stmt.Action) {
		listField(lines, body, "Action", stmt.Action);
	}

	if (stmt.NotAction) {
		listField(lines, body, "NotAction", stmt.NotAction);
	}

	if (stmt.Resource) {
		listField(lines, body, "Resource", stmt.Resource);
	}

	if (stmt.NotResource) {
		listField(lines, body, "NotResource", stmt.NotResource);
	}

	const operators = Object.entries(stmt.Condition ?? {});

	if (operators.length > 0) {
		lines.push(`${body}Condition:`);

		for (const [operator, keys] of operators) {
			lines.push(`${body}  ${yamlScalar(operator)}:`);

			for (const [key, values] of Object.entries(keys)) {
				listField(lines, `${body}    `, key, values);
			}
		}
	}

	// the first line of a statement carries the sequence dash in place of indent
	const first = lines[0];

	if (first !== undefined) {
		lines[0] = `  - ${first.slice(body.length)}`;
	}

	return lines;
}

/**
 * Write a policy document as YAML in the grammar's canonical layout. The
 * result parses back (and normalizes) to the same document, which is what lets
 * the visual editor hand its work to the daemon as ordinary text.
 */
export function policyToYaml(document: PolicyDocument): string {
	const lines = ["Version: 1"];

	if (document.Statement.length === 0) {
		lines.push("Statement: []");
	} else {
		lines.push("Statement:");

		for (const stmt of document.Statement) {
			lines.push(...statementLines(stmt));
		}
	}

	return `${lines.join("\n")}\n`;
}
