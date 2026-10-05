// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * A small syntax highlighter for code in chat: JSON, YAML, properties/TOML/INI,
 * shell, the C family (JS, TS, Java, Kotlin), XML and logs.
 *
 * Monaco already colours code in the config editor, but it is megabytes behind
 * a dynamic import and a chat bubble needs a few spans, so this is a sticky-regex
 * tokenizer instead. Its classes (`k`, `s`, `n`, `w`, `c`, `p`, `v`) use the same
 * palette as the console's Monaco theme, so a config pasted in chat looks the
 * way it does in the editor. Every token is HTML-escaped as it is emitted, which
 * keeps the result safe for `{@html}`.
 */

type Rule = [RegExp, string | null];

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

const C_KEYWORDS = new Set([
	'abstract', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'continue',
	'default', 'delete', 'do', 'double', 'else', 'enum', 'export', 'extends', 'false', 'final', 'finally',
	'float', 'for', 'from', 'fun', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'int',
	'interface', 'let', 'long', 'new', 'null', 'object', 'override', 'package', 'private', 'protected',
	'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'throws', 'true', 'try', 'type',
	'typeof', 'undefined', 'val', 'var', 'void', 'when', 'while', 'yield'
]);

const SHELL_KEYWORDS = new Set([
	'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
	'function', 'return', 'export', 'local', 'sudo'
]);

const RULES: Record<string, Rule[]> = {
	json: [
		[/"(?:[^"\\]|\\.)*"(?=\s*:)/y, 'k'],
		[/"(?:[^"\\]|\\.)*"/y, 's'],
		[/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, 'n'],
		[/\b(?:true|false|null)\b/y, 'w'],
		[/[{}[\],:]/y, 'p']
	],
	yaml: [
		[/#.*/y, 'c'],
		[/(?<=^|\n)[ \t-]*[\w.\-/"']+(?=\s*:(?:\s|$))/y, 'k'],
		[/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/y, 's'],
		[/\b(?:true|false|yes|no|on|off|null|~)\b/y, 'w'],
		[/-?\b\d+(?:\.\d+)?\b/y, 'n'],
		[/[:\-[\]{},|>]/y, 'p']
	],
	ini: [
		[/[#;].*/y, 'c'],
		[/\[[^\]\n]*\]/y, 'w'],
		[/(?<=^|\n)\s*[\w.\-]+(?=\s*[=:])/y, 'k'],
		[/"(?:[^"\\]|\\.)*"|'[^'\n]*'/y, 's'],
		[/\b(?:true|false)\b/y, 'w'],
		[/-?\b\d+(?:\.\d+)?\b/y, 'n'],
		[/[=:]/y, 'p']
	],
	shell: [
		[/#.*/y, 'c'],
		[/"(?:[^"\\]|\\.)*"|'[^']*'/y, 's'],
		[/\$\{[^}]*\}|\$[\w@#?$!*-]+/y, 'v'],
		[/(?<=\s|^)--?[\w-]+/y, 'k'],
		[/[A-Za-z_]\w*/y, 'word'],
		[/[|&;<>()]+/y, 'p']
	],
	c: [
		[/\/\/.*|\/\*[\s\S]*?\*\//y, 'c'],
		[/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/y, 's'],
		[/@\w+/y, 'v'],
		[/\b\d+(?:\.\d+)?[fFdDlL]?\b/y, 'n'],
		[/[A-Za-z_$][\w$]*/y, 'word'],
		[/[{}()[\];,.<>:=+\-*/!&|?]/y, 'p']
	],
	xml: [
		[/<!--[\s\S]*?-->/y, 'c'],
		[/<\/?[\w:.-]+|\/?>/y, 'k'],
		[/[\w:.-]+(?==)/y, 'v'],
		[/"[^"]*"|'[^']*'/y, 's']
	],
	log: [
		[/\b(?:ERROR|SEVERE|FATAL|Exception|Error)\b[^\n]*/y, 'e'],
		[/\b(?:WARN|WARNING)\b/y, 'w'],
		[/\b(?:INFO|DEBUG|TRACE)\b/y, 'k'],
		[/\[\d{1,2}:\d{2}:\d{2}[^\]]*\]|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/y, 'c'],
		[/\b\d+(?:\.\d+)?\b/y, 'n']
	],
	diff: [
		[/^\+.*$/my, 'add'],
		[/^-.*$/my, 'del'],
		[/^@@.*$/my, 'k']
	]
};

const ALIASES: Record<string, string> = {
	json: 'json', jsonc: 'json', json5: 'json',
	yaml: 'yaml', yml: 'yaml',
	properties: 'ini', ini: 'ini', toml: 'ini', conf: 'ini', cfg: 'ini', env: 'ini',
	sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', luna: 'shell',
	js: 'c', javascript: 'c', ts: 'c', typescript: 'c', java: 'c', kotlin: 'c', kt: 'c', c: 'c', cpp: 'c', cs: 'c', go: 'c', rust: 'c',
	xml: 'xml', html: 'xml', svg: 'xml',
	log: 'log', logs: 'log',
	diff: 'diff', patch: 'diff'
};

function tokenize(text: string, rules: Rule[], keywords: Set<string> | null): string {
	let out = '';
	let plain = '';
	let index = 0;

	const flush = (): void => {
		if (plain) {
			out += escapeHtml(plain);
			plain = '';
		}
	};

	while (index < text.length) {
		let matched = false;

		for (const [pattern, cls] of rules) {
			pattern.lastIndex = index;

			const found = pattern.exec(text);

			if (!found || found[0].length === 0) {
				continue;
			}

			const token = found[0];
			let kind = cls;

			// a bare word is only coloured when it is a keyword of the language
			if (kind === 'word') {
				kind = keywords?.has(token) ? 'w' : null;
			}

			flush();
			out += kind
				? `<span class="t-${kind}">${escapeHtml(token)}</span>`
				: escapeHtml(token);
			index += token.length;
			matched = true;
			break;
		}

		if (!matched) {
			plain += text[index];
			index++;
		}
	}

	flush();

	return out;
}

/** The language a code block is in, from its fence label or, for JSON, from its content. */
export function languageOf(label: string, code: string): string | null {
	const known = ALIASES[label.trim().toLowerCase()];

	if (known) {
		return known;
	}

	const trimmed = code.trim();

	if (/^[[{]/.test(trimmed)) {
		try {
			JSON.parse(trimmed);

			return 'json';
		} catch {
			// not JSON; leave it plain
		}
	}

	return null;
}

/** Pretty-print JSON that arrived on one line; anything that does not parse is returned as it was. */
export function tidyCode(language: string | null, code: string): string {
	if (language !== 'json') {
		return code;
	}

	try {
		return JSON.stringify(JSON.parse(code), null, 2);
	} catch {
		return code;
	}
}

/** Highlight code as HTML that is safe to insert as-is; unknown languages come back escaped and plain. */
export function highlight(language: string | null, code: string): string {
	const rules = language ? RULES[language] : undefined;

	if (!rules) {
		return escapeHtml(code);
	}

	const keywords = language === 'c'
		? C_KEYWORDS
		: language === 'shell'
			? SHELL_KEYWORDS
			: null;

	return tokenize(code, rules, keywords);
}
