// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * A Mèo Béo conversation as a file to keep: Markdown to read or paste into a
 * ticket, or the transcript as JSON exactly as the console stores it (as this
 * account may see it). Both are built in the browser from what the server
 * already sent, so an export never shows more than the chat did.
 */

import { api } from '$lib/api';
import { AGENT_ASK_TOOL, AGENT_TODO_TOOL } from '$shared/agent';

interface ExportEntry {
	kind: string;
	at: number;
	author?: string;
	text?: string;
	name?: string;
	input?: unknown;
	status?: string;
	output?: string;
	parent?: string;
	label?: string;
	ms?: number;
	tools?: number;
	costUsd?: number;
	preTokens?: number;
	postTokens?: number;
}

interface ExportConversation {
	id: string;
	title: string;
	owner: string;
	createdAt: number;
	costUsd: number;
	entries: ExportEntry[];
}

function stamp(at: number): string {
	return new Date(at).toISOString().replace('T', ' ').slice(0, 16);
}

function fence(text: string): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
	const ticks = '`'.repeat(longest + 1);

	return `${ticks}\n${text}\n${ticks}`;
}

/** The conversation as Markdown: who said what, each tool call folded under a details block. */
export function conversationMarkdown(conversation: ExportConversation, untitled: string): string {
	const lines: string[] = [
		`# ${conversation.title || untitled}`,
		'',
		`- ${conversation.owner} · ${stamp(conversation.createdAt)} · $${conversation.costUsd.toFixed(2)}`,
		''
	];

	for (const entry of conversation.entries) {
		if (entry.parent) {
			continue;
		}

		switch (entry.kind) {
			case 'user':
				lines.push(`## ${entry.author || 'operator'} · ${stamp(entry.at)}`, '', entry.text ?? '', '');
				break;

			case 'assistant':
				lines.push(`### Mèo Béo`, '', entry.text ?? '', '');
				break;

			case 'tool': {
				if (entry.name === AGENT_TODO_TOOL) {
					break;
				}

				const body = entry.name === AGENT_ASK_TOOL
					? JSON.stringify(entry.input, null, 2)
					: [
						entry.input !== undefined ? `Input:\n${fence(JSON.stringify(entry.input, null, 2))}` : '',
						entry.output ? `Output:\n${fence(entry.output)}` : ''
					].filter(Boolean).join('\n\n');

				lines.push(`<details><summary><code>${entry.name}</code> · ${entry.status}</summary>`, '', body, '', '</details>', '');
				break;
			}

			case 'event':
				lines.push(`> **${entry.label || 'event'}** · ${stamp(entry.at)}`, '>', ...(entry.text ?? '').split('\n').map((line) => `> ${line}`), '');
				break;

			case 'error':
				lines.push(`> ⚠ ${entry.text ?? ''}`, '');
				break;

			case 'compact':
				lines.push('---', '', `_compacted: ${entry.preTokens ?? 0} → ${entry.postTokens ?? '?'} tokens_`, '');
				break;

			case 'stats':
				lines.push(`_${Math.round((entry.ms ?? 0) / 1000)}s · ${entry.tools ?? 0} tools · $${(entry.costUsd ?? 0).toFixed(3)}_`, '');
				break;

			default:
				break;
		}
	}

	return lines.join('\n');
}

function download(name: string, type: string, text: string): void {
	const url = URL.createObjectURL(new Blob([text], { type }));
	const link = document.createElement('a');

	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from a title: what survives of it in any file system, and short. */
function fileName(title: string, id: string): string {
	const base = title
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^A-Za-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 60);

	return base || id;
}

/** Fetch a conversation and save it in the browser as Markdown or JSON. */
export async function exportConversation(id: string, format: 'markdown' | 'json', untitled: string): Promise<void> {
	const data = await api<{ conversation: ExportConversation }>(`/agent/conversations/${id}`);
	const conversation = data.conversation;
	const name = fileName(conversation.title, id);

	if (format === 'json') {
		download(`${name}.json`, 'application/json', JSON.stringify(conversation, null, '\t'));
	} else {
		download(`${name}.md`, 'text/markdown', conversationMarkdown(conversation, untitled));
	}
}
