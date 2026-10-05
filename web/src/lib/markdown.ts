// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * A small Markdown renderer for chat text: fenced and inline code, headings,
 * lists, quotes, tables, bold, italics and links.
 *
 * Escape first, format second. The input is model output that may quote a
 * player's chat or a log line, so every character is HTML-escaped before any
 * markup is added, and the only tags that can come out are the ones written
 * below; a link is emitted only for an http(s) URL. That ordering is what makes
 * `{@html}` on the result safe, and it is why this is not a general Markdown
 * library: anything outside the subset simply stays text.
 */

import { highlight, languageOf, tidyCode } from './highlight';

export interface MarkdownOptions {
	/** Label of the copy button on code blocks; omit for no button */
	copyLabel?: string;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Inline formatting over one already-split line of text. */
function inline(text: string): string {
	const codes: string[] = [];

	// code spans are lifted out first so nothing inside them is formatted
	let out = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
		codes.push(`<code>${escapeHtml(code)}</code>`);

		return `\u0000${codes.length - 1}\u0000`;
	});

	out = escapeHtml(out);

	out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, href: string) => {
		return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
	});

	out = out
		.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
		.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
		.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

	return out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => codes[Number(index)] ?? '');
}

function tableCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map((cell) => cell.trim());
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Render the block structure of a stretch of text that holds no fenced code. */
function blocks(text: string): string {
	const lines = text.split('\n');
	const out: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index]!;

		if (!line.trim()) {
			index++;

			continue;
		}

		const heading = /^(#{1,4})\s+(.*)$/.exec(line);

		if (heading) {
			const level = Math.min(heading[1]!.length + 2, 6);

			out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
			index++;

			continue;
		}

		if (line.includes('|') && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1]!)) {
			const head = tableCells(line);
			const rows: string[][] = [];

			index += 2;

			while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim()) {
				rows.push(tableCells(lines[index]!));
				index++;
			}

			const headHtml = head.map((cell) => `<th>${inline(cell)}</th>`).join('');
			const bodyHtml = rows
				.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
				.join('');

			out.push(`<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`);

			continue;
		}

		const bullet = /^\s*([-*+]|\d+[.)])\s+/;

		if (bullet.test(line)) {
			const ordered = /^\s*\d/.test(line);
			const items: string[] = [];

			while (index < lines.length && bullet.test(lines[index]!)) {
				items.push(`<li>${inline(lines[index]!.replace(bullet, ''))}</li>`);
				index++;
			}

			const tag = ordered
				? 'ol'
				: 'ul';

			out.push(`<${tag}>${items.join('')}</${tag}>`);

			continue;
		}

		if (/^\s*>/.test(line)) {
			const quoted: string[] = [];

			while (index < lines.length && /^\s*>/.test(lines[index]!)) {
				quoted.push(inline(lines[index]!.replace(/^\s*>\s?/, '')));
				index++;
			}

			out.push(`<blockquote>${quoted.join('<br>')}</blockquote>`);

			continue;
		}

		const paragraph: string[] = [];

		while (
			index < lines.length &&
			lines[index]!.trim() &&
			!/^(#{1,4})\s/.test(lines[index]!) &&
			!bullet.test(lines[index]!) &&
			!/^\s*>/.test(lines[index]!)
		) {
			paragraph.push(inline(lines[index]!));
			index++;
		}

		out.push(`<p>${paragraph.join('<br>')}</p>`);
	}

	return out.join('');
}

/**
 * A fenced block: a header naming the language (and a copy button the caller
 * wires up by its `data-copy` attribute), then the code, pretty-printed when it
 * is JSON and highlighted when the language is one `highlight.ts` knows.
 */
function codeBlock(label: string, body: string, opts: MarkdownOptions): string {
	const language = languageOf(label, body);
	const code = tidyCode(language, body);
	const name = escapeHtml(label.trim() || language || 'text');
	const copy = opts.copyLabel
		? `<button type="button" class="code-copy" data-copy>${escapeHtml(opts.copyLabel)}</button>`
		: '';

	return `<div class="codeblock"><div class="code-head"><span class="code-lang">${name}</span>${copy}</div>`
		+ `<pre><code>${highlight(language, code)}</code></pre></div>`;
}

/** Render chat Markdown to HTML that is safe to insert as-is. */
export function renderMarkdown(source: string, opts: MarkdownOptions = {}): string {
	const parts = source.replace(/\r\n/g, '\n').split(/^```/m);
	const out: string[] = [];

	parts.forEach((part, index) => {
		// odd parts sit between a pair of fences; an unclosed fence (a reply still
		// streaming) renders as code up to the end, which is what it will become
		if (index % 2 === 1) {
			const newline = part.indexOf('\n');
			const label = newline === -1
				? part
				: part.slice(0, newline);
			const body = newline === -1
				? ''
				: part.slice(newline + 1);

			out.push(codeBlock(label, body.replace(/\n$/, ''), opts));

			return;
		}

		out.push(blocks(part));
	});

	return out.join('');
}
