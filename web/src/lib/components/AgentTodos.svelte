<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import type { AgentTodo } from '$shared/agent';
	import Icon from './Icon.svelte';

	/**
	 * The agent's checklist for a longer job, as a blade tucked behind the top
	 * of the composer: one line saying where the work stands (the step in
	 * progress, or how many are done), opening to the whole list.
	 */
	let { todos, running }: { todos: AgentTodo[]; running: boolean } = $props();

	let open = $state(false);

	const done = $derived(todos.filter((todo) => todo.status === 'completed').length);
	const current = $derived(todos.find((todo) => todo.status === 'in_progress'));

	const STATUS_ICONS: Record<AgentTodo['status'], string> = {
		pending: 'circle',
		in_progress: 'circleDot',
		completed: 'circleCheck'
	};
</script>

<div class="todos" class:open>
	<button class="head" aria-expanded={open} onclick={() => (open = !open)}>
		<Icon name="listCheck" size="0.75rem" style="solid" />
		<span class="now">
			{#if current && running}
				{current.activeForm}
			{:else}
				{t('web.agent.todoTitle')}
			{/if}
		</span>
		<span class="bar" aria-hidden="true">
			<span style:width="{todos.length ? (done / todos.length) * 100 : 0}%"></span>
		</span>
		<span class="count">{done}/{todos.length}</span>
		<Icon name={open ? 'arrowDown' : 'arrowUp'} size="0.625rem" />
	</button>
	{#if open}
		<ol>
			{#each todos as todo, index (index)}
				<li data-status={todo.status}>
					<Icon name={STATUS_ICONS[todo.status]} size="0.75rem" style={todo.status === 'pending' ? 'regular' : 'solid'} />
					<span>{todo.status === 'in_progress' ? todo.activeForm : todo.content}</span>
				</li>
			{/each}
		</ol>
	{/if}
</div>

<style lang="scss">
	// a blade tucked behind the composer: its own rounded card, pulled down by a
	// negative margin so the composer (stacked above it) covers its bottom edge.
	// The extra bottom padding is the part the composer covers, so nothing of
	// the list hides under it; the overlap is the composer's top margin (0.75rem)
	// plus 0.75rem of the blade itself.
	.todos {
		position: relative;
		margin: 0 1rem -1.5rem;
		padding-bottom: 0.75rem;
		border: 0.1rem solid var(--border-input);
		border-radius: 0.75rem 0.75rem 0 0;
		background: color-mix(in srgb, var(--link) 10%, var(--bg-panel-raised));
		overflow: hidden;
	}

	.head {
		@include bare-button;

		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.375rem 0.75rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
		text-align: left;

		&:hover {
			color: var(--text-heading);
		}

		.now {
			@include ellipsis;

			flex: 1;
			min-width: 0;
			color: var(--text-heading);
		}

		.count {
			font-variant-numeric: tabular-nums;
		}
	}

	// progress sits in the header row as a short track, so it never reads as a border
	.bar {
		flex: none;
		width: 4rem;
		height: 0.25rem;
		border-radius: 1rem;
		background: var(--bg-track);
		overflow: hidden;

		span {
			display: block;
			height: 100%;
			border-radius: inherit;
			background: var(--success);
			transition: width 0.4s ease;
		}
	}

	ol {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-height: 12rem;
		overflow-y: auto;
		margin: 0;
		padding: 0.5rem 0.75rem;
		border-top: 0.1rem solid var(--border-divider);
		list-style: none;
		font-size: 0.8125rem;
	}

	li {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		color: var(--text);

		&[data-status='in_progress'] {
			color: var(--link);
			font-weight: 600;
		}

		&[data-status='completed'] {
			color: var(--text-disabled);

			span {
				text-decoration: line-through;
			}
		}
	}
</style>
