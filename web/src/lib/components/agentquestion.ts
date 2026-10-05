// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** One option of a question the agent asked. */
export interface AgentQuestionOption {
	label: string;
	description?: string;
}

/** One question of an `AskUserQuestion` call, as the SDK's tool input carries it. */
export interface AgentQuestion {
	question: string;
	header?: string;
	options: AgentQuestionOption[];
	multiSelect: boolean;
}

/** Where a question stands: waiting for the operator, answered, dismissed, or left unanswered. */
export type AgentQuestionState = 'waiting' | 'answered' | 'dismissed' | 'timeout';

/** The questions out of the tool's input, dropping anything that is not shaped like one. */
export function readQuestions(input: unknown): AgentQuestion[] {
	const raw = (input as { questions?: unknown } | undefined)?.questions;

	if (!Array.isArray(raw)) {
		return [];
	}

	return raw
		.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && typeof entry.question === 'string')
		.map((entry) => ({
			question: entry.question as string,
			header: typeof entry.header === 'string'
				? entry.header
				: undefined,
			multiSelect: entry.multiSelect === true,
			options: Array.isArray(entry.options)
				? entry.options
					.filter((option): option is Record<string, unknown> => typeof option === 'object' && option !== null && typeof option.label === 'string')
					.map((option) => ({
						label: option.label as string,
						description: typeof option.description === 'string'
							? option.description
							: undefined
					}))
				: []
		}));
}

/** The answers the operator gave, out of the tool's input once it was answered. */
export function readAnswers(input: unknown): Record<string, string> | undefined {
	const raw = (input as { answers?: unknown } | undefined)?.answers;

	if (!raw || typeof raw !== 'object') {
		return undefined;
	}

	return raw as Record<string, string>;
}
