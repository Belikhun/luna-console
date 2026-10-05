<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Checkbox from './Checkbox.svelte';
	import Toggle from './Toggle.svelte';
	import MultiSelect from './MultiSelect.svelte';
	import {
		MCP_TOOL_GROUPS,
		MCP_TOOLS,
		allowedTools,
		type McpScope,
		type McpToolGroup,
		type McpToolSpec
	} from '$shared/mcptools';

	/**
	 * What an MCP token may do, edited as the operator thinks about it: whole groups
	 * first, then single tools on top. A tool inside a granted group unticks into a
	 * deny; a tool outside one ticks into an allow; so the two lists stay the
	 * exceptions they are and never restate the groups.
	 *
	 * The instance limit is separate on purpose: it narrows every tool that names an
	 * instance, whichever group granted it.
	 */
	let {
		scope = $bindable(),
		instances = [],
		disabled = false
	}: {
		scope: McpScope;
		/** Instance names the limit can pick from */
		instances?: string[];
		disabled?: boolean;
	} = $props();

	const effective = $derived(new Set(allowedTools(scope).map((tool) => tool.name)));

	function toolsOf(group: McpToolGroup): McpToolSpec[] {
		return MCP_TOOLS.filter((tool) => tool.group === group);
	}

	function without(list: string[], name: string): string[] {
		return list.filter((entry) => entry !== name);
	}

	function toggleGroup(group: McpToolGroup, on: boolean): void {
		const names = toolsOf(group).map((tool) => tool.name);

		// granting or revoking a whole group clears that group's exceptions, which
		// would otherwise linger invisibly and surprise the next edit
		scope = {
			...scope,
			groups: on
				? [...scope.groups, group]
				: scope.groups.filter((entry) => entry !== group),
			allow: scope.allow.filter((name) => !names.includes(name)),
			deny: scope.deny.filter((name) => !names.includes(name))
		};
	}

	function toggleTool(tool: McpToolSpec, on: boolean): void {
		const granted = scope.groups.includes(tool.group);

		if (granted) {
			scope = {
				...scope,
				deny: on
					? without(scope.deny, tool.name)
					: [...scope.deny, tool.name]
			};

			return;
		}

		scope = {
			...scope,
			allow: on
				? [...scope.allow, tool.name]
				: without(scope.allow, tool.name)
		};
	}

	function groupState(group: McpToolGroup): { checked: boolean; indeterminate: boolean } {
		const names = toolsOf(group).map((tool) => tool.name);
		const on = names.filter((name) => effective.has(name)).length;

		return { checked: on === names.length, indeterminate: on > 0 && on < names.length };
	}

	const instanceOptions = $derived(instances.map((name) => ({ value: name, label: name })));
</script>

<div class="scope">
	{#each MCP_TOOL_GROUPS as group (group)}
		{@const state = groupState(group)}
		<section class="group" class:on={state.checked || state.indeterminate}>
			<label class="head">
				<Checkbox
					checked={state.checked}
					indeterminate={state.indeterminate}
					{disabled}
					label={t(`web.mcp.group.${group}`)}
					onchange={(value) => toggleGroup(group, value)}
				/>
				<span class="name">{t(`web.mcp.group.${group}`)}</span>
				<span class="hint">{t(`web.mcp.groupHint.${group}`)}</span>
			</label>

			<div class="tools">
				{#each toolsOf(group) as tool (tool.name)}
					<label class="tool" title={tool.description}>
						<Checkbox
							checked={effective.has(tool.name)}
							{disabled}
							label={tool.name}
							onchange={(value) => toggleTool(tool, value)}
						/>
						<span class="mono">{tool.name}</span>
						{#if tool.annotations.destructiveHint}
							<span class="danger">{t('web.mcp.destructive')}</span>
						{/if}
					</label>
				{/each}
			</div>
		</section>
	{/each}

	<section class="group instances">
		<label class="head">
			<Toggle
				checked={scope.instances === null}
				{disabled}
				label={t('web.mcp.allInstances')}
				onchange={(value) => (scope = { ...scope, instances: value ? null : [] })}
			/>
			<span class="name">{t('web.mcp.allInstances')}</span>
			<span class="hint">{t('web.mcp.allInstancesHint')}</span>
		</label>

		{#if scope.instances !== null}
			<div class="picker">
				<MultiSelect
					label={t('web.mcp.limitInstances')}
					options={instanceOptions}
					value={scope.instances}
					placeholder={t('web.mcp.noInstancesPicked')}
					onchange={(value) => (scope = { ...scope, instances: value })}
				/>
			</div>
		{/if}
	</section>
</div>

<style lang="scss">
	.scope {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.group {
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-input);
		padding: 0.75rem 1rem;

		&.on {
			border-color: var(--border-input);
		}
	}

	.head {
		display: flex;
		align-items: baseline;
		gap: 0.625rem;
		cursor: pointer;
	}

	.name {
		font-weight: 600;
		color: var(--text-heading);
	}

	.hint {
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.25rem;
		margin-top: 0.625rem;
		padding-left: 1.625rem;
	}

	.tool {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		cursor: pointer;
	}

	.danger {
		font-size: 0.6875rem;
		color: var(--warning);
	}

	.picker {
		margin-top: 0.75rem;
		padding-left: 2.875rem;
	}
</style>
