// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Mèo Béo's helpers: the subagents a run may hand a self-contained job to
 * through the SDK's `Agent` tool. Each works in a context of its own, with its
 * own instructions and a narrower set of luna tools, and answers once; its
 * tool calls go through the run's `canUseTool` like the agent's, so a helper
 * never runs anything the mode would have asked about.
 *
 * Two are built in (`investigator`, `researcher`); the rest are defined on the
 * agent settings screen. A helper's tools are always cut down to what the
 * agent's token can reach, so a definition naming a tool the token lacks
 * simply goes without it.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import type { AgentSubagent } from '$core/agent';
import { MCP_TOOLS, mcpTool } from '$shared/mcptools';

/** Read-only file tools a helper gets for the conversation's scratch folder. */
const SCRATCH_READ = ['Read', 'Glob', 'Grep'];

/** What every helper is told about where it stands, ahead of its own instructions. */
const PREAMBLE = `You are one of Mèo Béo's helpers, working for it on the Luna Minecraft cluster's console. Mèo Béo gave you one job; do it with your tools and reply with a single report it can act on. Nobody reads your messages but Mèo Béo, so do not greet, ask questions or offer follow-ups. Quote the evidence (log lines, values, versions) that supports each finding, and say plainly what you could not find out.`;

interface Builtin {
	name: string;
	description: string;
	prompt: string;
	/** Which catalog tools it may use, out of what the token reaches */
	picks: (name: string) => boolean;
}

function readOnly(name: string): boolean {
	return mcpTool(name)?.annotations.readOnlyHint === true;
}

const BUILTINS: Builtin[] = [
	{
		name: 'investigator',
		description: 'Diagnoses a problem without changing anything: reads logs, consoles, metrics, health, configuration and player data across instances, and reports what is wrong with the evidence. Use it for "why did X crash", "what is lagging", or to check several servers at once while you keep talking to the operator.',
		prompt: `${PREAMBLE}\n\nYou investigate; you never change anything. Start from the symptom you were given, read the relevant logs and state, follow the trail to a cause, and finish with: what is wrong, the evidence, and the fix you would suggest (without applying it).`,
		picks: readOnly
	},
	{
		name: 'researcher',
		description: 'Researches addons and packs without installing anything: searches Modrinth, CurseForge, Hangar and the pool, compares versions and compatibility with the servers it would go on, and recommends one. Use it for "find a plugin that does X" or "which version of Y works on Z".',
		prompt: `${PREAMBLE}\n\nYou research; you never install, update or remove anything. Search the providers and the pool, check each candidate's versions against the target servers' platform and Minecraft version, and finish with a short comparison and one recommendation, naming the exact project and version.`,
		picks: (name) => {
			const group = mcpTool(name)?.group;

			return readOnly(name) && (group === 'addons' || group === 'packs' || group === 'observe' || group === 'network');
		}
	}
];

/** The SDK name of a luna tool, as the run's MCP server exposes it. */
function sdkName(tool: string): string {
	return `mcp__luna__${tool}`;
}

/** A definition's tool list (names and `group:<name>`) as the luna tools the token reaches. */
function resolveTools(entries: string[], reachable: Set<string>): string[] {
	const out = new Set<string>();

	for (const entry of entries) {
		if (entry.startsWith('group:')) {
			const group = entry.slice('group:'.length);

			for (const tool of MCP_TOOLS) {
				if (tool.group === group && reachable.has(tool.name)) {
					out.add(tool.name);
				}
			}
		} else if (reachable.has(entry)) {
			out.add(entry);
		}
	}

	return [...out];
}

/** A helper the panel lists: what it is for and how many tools it ended up with. */
export interface SubagentSummary {
	name: string;
	description: string;
	builtin: boolean;
	tools: number;
}

/**
 * The helpers a run offers, as the SDK's `agents` option: the built-ins and the
 * console's enabled definitions, each cut down to the luna tools in `reachable`
 * (the agent token's own tools). A helper left with no tools is not offered.
 */
export function subagentDefinitions(custom: AgentSubagent[], reachable: string[]): Record<string, AgentDefinition> {
	const reach = new Set(reachable);
	const agents: Record<string, AgentDefinition> = {};

	for (const builtin of BUILTINS) {
		const tools = reachable.filter(builtin.picks);

		if (tools.length) {
			agents[builtin.name] = {
				description: builtin.description,
				prompt: builtin.prompt,
				tools: [...tools.map(sdkName), ...SCRATCH_READ]
			};
		}
	}

	for (const definition of custom) {
		if (!definition.enabled) {
			continue;
		}

		const tools = resolveTools(definition.tools, reach);

		if (!tools.length) {
			continue;
		}

		agents[definition.name] = {
			description: definition.description,
			prompt: `${PREAMBLE}\n\n${definition.prompt}`,
			tools: [...tools.map(sdkName), ...SCRATCH_READ],
			...(definition.model && definition.model !== 'inherit' ? { model: definition.model } : {})
		};
	}

	return agents;
}

/** The helpers as the settings screen and the composer describe them. */
export function subagentSummaries(custom: AgentSubagent[], reachable: string[]): SubagentSummary[] {
	const reach = new Set(reachable);

	return [
		...BUILTINS.map((builtin) => ({
			name: builtin.name,
			description: builtin.description,
			builtin: true,
			tools: reachable.filter(builtin.picks).length
		})),
		...custom
			.filter((definition) => definition.enabled)
			.map((definition) => ({
				name: definition.name,
				description: definition.description,
				builtin: false,
				tools: resolveTools(definition.tools, reach).length
			}))
	];
}
