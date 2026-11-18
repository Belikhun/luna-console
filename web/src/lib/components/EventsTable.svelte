<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { t } from '$lib/i18n.svelte';

	import DateTime from './DateTime.svelte';
	import Icon from './Icon.svelte';
	import ResourceTable from './ResourceTable.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import { actorOf, enrichEvents, eventText, factsOf, fmtWhen, reasonOf, stateChange, type InstanceEvent } from './events';
	import type { Column, TableFilterGroup } from './table';

	/**
	 * A daemon event list, newest first: when, what happened (a state change
	 * drawn as the two states it moved between), who caused it, and why with the
	 * figures that were true at the moment. Search and a kind filter; the
	 * console-wide list adds an Instance column.
	 */
	let {
		tableId,
		events,
		instanceColumn = false,
		maxHeight = '22rem',
		loading = false,
		emptyTitle,
		emptyText
	}: {
		tableId: string;
		events: InstanceEvent[];
		instanceColumn?: boolean;
		maxHeight?: string;
		loading?: boolean;
		emptyTitle?: string;
		emptyText?: string;
	} = $props();

	// an older daemon's events carry no actor of their own; read what the sentence says
	const rows = $derived(enrichEvents(events));

	const columns: Column[] = $derived([
		{ id: 't', label: t('web.events.col.when'), width: 130, sortable: true },
		...(instanceColumn ? [{ id: 'instance', label: t('web.events.col.instance'), width: 130, sortable: true }] : []),
		{ id: 'event', label: t('web.events.col.event'), width: 300 },
		{ id: 'actor', label: t('web.events.col.actor'), width: 160, sortable: true },
		// no width of its own: the reason takes whatever the table has left
		{ id: 'detail', label: t('web.events.col.detail'), minWidth: 240 }
	]);

	const filters: TableFilterGroup<InstanceEvent>[] = $derived([
		{
			id: 'kind',
			label: t('web.events.filterKind'),
			width: '10rem',
			options: [
				{ value: 'all', label: t('web.events.kindAll') },
				{ value: 'state', label: t('web.events.kind.state'), match: (event: InstanceEvent) => event.kind === 'state' },
				{ value: 'action', label: t('web.events.kind.action'), match: (event: InstanceEvent) => event.kind === 'action' },
				{ value: 'error', label: t('web.events.kind.error'), match: (event: InstanceEvent) => event.kind === 'error' }
			]
		}
	]);

	/** The glyph beside an event that is not a state change. */
	function glyph(event: InstanceEvent): { icon: string; tone: string } {
		return event.kind === 'error'
			? { icon: 'triangleExclamation', tone: 'error' }
			: { icon: 'bolt', tone: 'action' };
	}
</script>

<ResourceTable
	{tableId}
	{columns}
	rows={rows}
	{filters}
	getId={(event) => `${event.instance ?? ''}:${event.t}:${event.message}`}
	selectable="none"
	paging={false}
	{maxHeight}
	{loading}
	snug
	defaultSort={{ col: 't', dir: 'desc' }}
	sortValue={(event, col) =>
		col === 't'
			? event.t
			: col === 'instance'
				? (event.instance ?? '')
				: col === 'actor'
					? actorOf(event).label
					: null}
	searchValue={(event) => `${event.message} ${event.instance ?? ''} ${actorOf(event).label} ${reasonOf(event) ?? ''}`}
	searchPlaceholder={t('web.events.search')}
	noun={t('web.events.noun')}
	emptyTitle={emptyTitle ?? t('web.instances.events.none')}
	{emptyText}
>
	{#snippet cell(event, col)}
		{#if col === 't'}
			<span class="mono when"><DateTime at={event.t} text={fmtWhen(event.t)} /></span>
		{:else if col === 'instance'}
			{#if event.instance?.startsWith('daemon:')}
				<!-- a machine's own event, filed under its daemon's key -->
				{@const machine = event.instance.slice(7)}
				<span class="machine">
					<Icon name="server" />
					<a href="/machines/{encodeURIComponent(machine)}">{machine}</a>
				</span>
			{:else if event.instance}
				<a href="/instances/{encodeURIComponent(event.instance)}/monitoring">{event.instance}</a>
			{:else}
				<span class="dim">–</span>
			{/if}
		{:else if col === 'event'}
			{@const change = stateChange(event)}
			{#if change}
				<span class="change">
					<StatusBadge state={change.from} />
					<span class="arrow"><Icon name="arrowRight" /></span>
					<StatusBadge state={change.to} />
				</span>
			{:else}
				{@const mark = glyph(event)}
				<span class="event">
					<span class="glyph {mark.tone}"><Icon name={mark.icon} style="solid" /></span>
					<span class="words" class:error={event.kind === 'error'}>{eventText(event)}</span>
				</span>
			{/if}
		{:else if col === 'actor'}
			{@const actor = actorOf(event)}
			<span class="actor {actor.kind}">
				<Icon name={actor.icon} />
				{#if actor.href}
					<a href={actor.href}>{actor.label}</a>
				{:else}
					<span>{actor.label}</span>
				{/if}
			</span>
		{:else if col === 'detail'}
			{@const reason = reasonOf(event)}
			{@const facts = factsOf(event)}
			<span class="detail">
				{#if reason}
					<span class="reason" class:error={event.kind === 'error' || event.reasonKey === 'crashed'}>{reason}</span>
				{/if}
				{#each facts as fact (fact)}
					<span class="fact">{fact}</span>
				{/each}
				{#if !reason && facts.length === 0}
					<span class="dim">–</span>
				{/if}
			</span>
		{/if}
	{/snippet}
</ResourceTable>

<style lang="scss">
	.when {
		white-space: nowrap;
	}

	// a state change reads left to right, as the server went
	.change {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;

		.arrow {
			color: var(--text-secondary);
			font-size: 0.75rem;
		}
	}

	.event {
		display: inline-flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}

	.glyph {
		flex: none;
		font-size: 0.75rem;

		&.action {
			color: var(--link);
		}

		&.error {
			color: var(--error);
		}
	}

	.words {
		@include ellipsis;

		&.error {
			color: var(--error);
		}
	}

	.machine {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;

		:global(icon) {
			color: var(--text-secondary);
			font-size: 0.75rem;
		}
	}

	.actor {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;

		:global(icon) {
			color: var(--text-secondary);
			font-size: 0.75rem;
		}

		// the server itself and "nobody on record" are not people; they read quieter
		&.server,
		&.nobody {
			color: var(--text-secondary);
		}
	}

	// the reason first, then the facts as small chips
	.detail {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		min-width: 0;
	}

	.reason {
		&.error {
			color: var(--error);
		}
	}

	.fact {
		padding: 0 0.375rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.25rem;
		color: var(--text-secondary);
		font-size: 0.75rem;
		line-height: 1.25rem;
		white-space: nowrap;
	}
</style>
