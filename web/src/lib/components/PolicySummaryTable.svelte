<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import DataTable from './DataTable.svelte';
	import Icon from './Icon.svelte';
	import Toggle from './Toggle.svelte';
	import type { Column } from './table';
	import { actionLabelKey, type IamActionSpec } from '$shared/iam/actions';
	import type { PolicyDocument } from '$shared/iam/grammar';
	import {
		SUMMARY_ACCESS_LEVELS,
		actionsByLevel,
		summarizePolicyDocument,
		type ServiceSummaryRow,
		type SummaryAccessLevel
	} from '$shared/iam/summary';
	import { serviceLabel } from './policyvisual';

	/**
	 * A policy document in plain words, AWS's policy summary: an Allow table and
	 * a Deny table, one row per service saying how much of it the policy reaches
	 * (full or limited, by access level), on which resources and under which
	 * conditions. A row unfolds into the actions themselves. The services the
	 * policy does not mention can be shown too, as rows granting nothing.
	 */
	let {
		document
	}: {
		document: PolicyDocument;
	} = $props();

	/** A summary row, or a service the policy does not reach at all. */
	type Row = ServiceSummaryRow | { service: string; none: true };

	let showRemaining = $state(false);

	const summary = $derived(summarizePolicyDocument(document));

	const allowRows: Row[] = $derived([
		...summary.allow,
		...(showRemaining ? summary.remaining.map((service) => ({ service, none: true as const })) : [])
	]);

	const columns: Column[] = $derived([
		{ id: 'service', label: t('web.policySummary.colService'), sortable: true, width: 200 },
		{ id: 'access', label: t('web.policySummary.colAccess'), width: 240 },
		{ id: 'resource', label: t('web.policySummary.colResource'), width: 260 },
		{ id: 'condition', label: t('web.policySummary.colCondition') }
	]);

	const levelLabels: Record<SummaryAccessLevel, string> = $derived({
		List: t('web.policySummary.levelList'),
		Read: t('web.policySummary.levelRead'),
		Write: t('web.policySummary.levelWrite'),
		Delete: t('web.policySummary.levelDelete')
	});

	function isNone(row: Row): row is { service: string; none: true } {
		return 'none' in row;
	}

	function accessText(row: ServiceSummaryRow): string {
		if (row.full) {
			return t('web.policySummary.fullAccess');
		}

		return t('web.policySummary.limited', {
			levels: row.levels.map((level) => levelLabels[level]).join(', ')
		});
	}

	function actionText(spec: IamActionSpec): string {
		const key = actionLabelKey(spec);
		const label = t(key);

		return label === key
			? spec.verb
			: label;
	}

	function sortValue(row: Row, col: string): string | number | null {
		if (col === 'service') {
			return serviceLabel(row.service);
		}

		return null;
	}
</script>

{#snippet table(rows: Row[], id: string)}
	<DataTable
		{columns}
		{rows}
		getId={(row) => `${id}:${row.service}`}
		{sortValue}
		expandable={(row) => !isNone(row)}
		emptyTitle={t('web.policySummary.noRows')}
	>
		{#snippet cell(row, col)}
			{#if col === 'service'}
				<span class="service">
					<b>{serviceLabel(row.service)}</b>
					<span class="mono dim">{row.service}</span>
				</span>
			{:else if isNone(row)}
				{#if col === 'access'}
					<span class="dim">{t('web.policySummary.noAccess')}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'access'}
				<span class:full={row.full}>{accessText(row)}</span>
				<span class="dim count">{t('web.policySummary.actionCount', { count: row.actions.length, total: row.total })}</span>
			{:else if col === 'resource'}
				{#if row.allResources}
					{t('web.policySummary.allResources')}
				{:else if row.exceptResources.length}
					<span>{t('web.policySummary.allExcept')}</span>
					<span class="mono">{row.exceptResources.join(', ')}</span>
				{:else if row.resources.length}
					<span class="mono">{row.resources.join(', ')}</span>
				{:else}
					<span class="dim">{t('web.policySummary.noResources')}</span>
				{/if}
			{:else if col === 'condition'}
				{#if row.conditions.length}
					<span class="mono">
						{row.conditions.map((entry) => `${entry.operator} ${entry.key}: ${entry.values.join(', ')}`).join('; ')}
					</span>
				{:else}
					<span class="dim">{t('web.common.none')}</span>
				{/if}
			{/if}
		{/snippet}

		{#snippet expanded(row)}
			{#if !isNone(row)}
				{@const byLevel = actionsByLevel(row)}
				<div class="levels">
					{#each SUMMARY_ACCESS_LEVELS as level (level)}
						{#if byLevel[level].length}
							<div class="level">
								<h5>{levelLabels[level]} <span class="dim">({byLevel[level].length})</span></h5>
								<ul>
									{#each byLevel[level] as spec (spec.name)}
										<li>
											<span class="mono">{spec.name}</span>
											<span class="dim">{actionText(spec)}</span>
										</li>
									{/each}
								</ul>
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		{/snippet}
	</DataTable>
{/snippet}

<div class="summary">
	<div class="bar">
		<label class="toggle">
			<Toggle
				checked={showRemaining}
				label={t('web.policySummary.showRemaining', { count: summary.remaining.length })}
				onchange={(checked) => (showRemaining = checked)}
			/>
			<span>{t('web.policySummary.showRemaining', { count: summary.remaining.length })}</span>
		</label>
	</div>

	<section>
		<h4>
			<Icon name="circleCheck" size="0.875rem" style="solid" color="var(--success)" />
			{t('web.policySummary.allowHeading', { count: summary.allow.length, total: summary.services })}
		</h4>
		{@render table(allowRows, 'allow')}
	</section>

	{#if summary.deny.length}
		<section>
			<h4>
				<Icon name="ban" size="0.875rem" style="solid" color="var(--error)" />
				{t('web.policySummary.denyHeading', { count: summary.deny.length, total: summary.services })}
			</h4>
			{@render table(summary.deny, 'deny')}
		</section>
	{/if}
</div>

<style lang="scss">
	.summary {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.bar {
		display: flex;
		justify-content: flex-end;
	}

	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		cursor: pointer;
	}

	section h4 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.5rem;
		font-size: 0.875rem;
	}

	.service {
		display: inline-flex;
		align-items: baseline;
		gap: 0.5rem;

		.mono {
			font-size: 0.75rem;
		}
	}

	.full {
		font-weight: 700;
	}

	.count {
		margin-left: 0.5rem;
		font-size: 0.75rem;
	}

	.levels {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0.75rem 1.5rem;
	}

	.level {
		h5 {
			margin: 0 0 0.25rem;
			font-size: 0.8125rem;
		}

		ul {
			margin: 0;
			padding: 0;
			list-style: none;
		}

		li {
			display: flex;
			flex-direction: column;
			padding: 0.125rem 0;
			font-size: 0.8125rem;

			.dim {
				font-size: 0.75rem;
			}
		}
	}
</style>
