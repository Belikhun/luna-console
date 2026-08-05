<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import BrandLink from '$lib/components/BrandLink.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import Alerts from '$lib/components/Alerts.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One plugin on one instance: what build it runs, how it got here, whether
	 * the server actually loaded it; and every log line of the current boot
	 * session the plugin wrote, with the warn/error tallies.
	 */

	const instance = $derived(page.params.name);
	const plugin = $derived(page.params.plugin);

	let data: any = $state(null);
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let busy = $state(false);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			data = await api(`/instances/${instance}/plugins/${plugin}`);
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(`Could not load ${plugin} on ${instance}`, {
				detail: (err as Error).message
			});
		}

		loading = false;
	}

	onMount(() => {
		void refresh();
	});

	/** Addon phases, plus the override that explains an absent one. */
	const STATE_BADGE: Record<string, { state: string; label: string }> = {
		running: { state: 'running', label: t('web.instancePlugin.running') },
		loading: { state: 'loading', label: t('web.instancePlugin.loading') },
		errored: { state: 'failed', label: t('web.instancePlugin.errored') },
		unknown: { state: 'unknown', label: t('web.instancePlugin.unknown') },
		disabled: { state: 'stopped', label: t('web.instancePlugin.disabled') }
	};

	const badge = $derived.by(() => {
		if (!data) {
			return STATE_BADGE.unknown;
		}

		const key = data.row.disabled ? 'disabled' : data.row.state;

		return STATE_BADGE[key] ?? STATE_BADGE.unknown;
	});

	/** Toggle the per-instance override behind a loading flash, then reload. */
	async function setOverride(state: boolean | null, label: string): Promise<void> {
		busy = true;

		const note = Notify.loading(`${label} ${plugin} on ${instance}…`);

		try {
			const result = await post(`/instances/${instance}/plugins`, { plugin, state });

			note.set({
				level: 'success',
				message: `${plugin}: ${label.toLowerCase()} done`,
				detail: result.removed?.length
					? `Removed ${result.removed.join(', ')}; a running server keeps it loaded until restart.`
					: result.deployed
						? `${result.deployed} deploy change(s).`
						: '',
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not update ${plugin}`,
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = false;
	}

	const infoCells: InfoCell[] = $derived.by(() => {
		if (!data) {
			return [];
		}

		const row = data.row;

		return [
			{ id: 'state', label: t('web.instancePlugin.runtimeState') },
			{ label: t('web.instancePlugin.displayName'), value: row.displayName },
			{ label: t('web.instancePlugin.family'), value: row.family },
			{ label: t('web.instancePlugin.version'), value: row.version ?? '?', style: 'mono' },
			{
				label: t('web.instancePlugin.assignment'),
				value: row.pinned ? 'pinned' : row.variant ? 'variant (auto)' : 'primary'
			},
			{
				label: t('web.instancePlugin.from'),
				value:
					row.origin === 'group'
						? `group: ${row.groups.join(', ')}`
						: row.origin === 'manual'
							? 'manually added'
							: 'explicit target'
			},
			{ id: 'source', label: t('web.instancePlugin.source') },
			{ label: t('web.instancePlugin.updateChannel'), value: data.channel },
			{ label: t('web.instancePlugin.jarFile'), value: row.file, copyable: true, style: 'mono' },
			{ label: t('web.instancePlugin.logNames'), value: data.aliases.join(', ') },
			{ label: t('web.instancePlugin.authors'), value: data.meta?.authors?.join(', ') ?? null },
			{ label: t('web.instancePlugin.description'), value: data.meta?.description ?? null, colSpan: 2 }
		];
	});

	/** Severity of a rendered log line, for its tint. */
	function lineSeverity(line: string): 'warn' | 'error' | '' {
		if (/\[[^\]]*\/ERROR\]|\[ERROR\]:/.test(line)) {
			return 'error';
		}

		if (/\[[^\]]*\/WARN\]|\[WARN\]:/.test(line)) {
			return 'warn';
		}

		return '';
	}
</script>

<svelte:head><title>{plugin} on {instance} | Luna Console</title></svelte:head>

{#if data}
	<PageHeader title={plugin ?? ''} info>
		{#snippet extra()}
			<span class="crumb dim">{t('web.instancePlugin.on')} <a href="/instances/{instance}?tab=plugins">{instance}</a></span>
			<StatusBadge state={badge.state} label={badge.label} />
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="instance-plugin" />
			<Btn icon="circleInfo" onclick={() => goto(`/plugins/${plugin}`)}>{t('web.instancePlugin.pluginDetails')}</Btn>
			{#if data.row.disabled}
				<Btn
					variant="primary"
					loading={busy}
					onclick={() => setOverride(null, 'Re-enabling')}
				>
					Enable on {instance}
				</Btn>
			{:else if data.row.origin === 'manual'}
				<Btn variant="danger" loading={busy} onclick={() => setOverride(null, 'Removing')}>
					Remove from {instance}
				</Btn>
			{:else}
				<Btn variant="danger" loading={busy} onclick={() => setOverride(false, 'Disabling')}>
					Disable on {instance}
				</Btn>
			{/if}
		{/snippet}
	</PageHeader>

	<Panel title={t('web.instancePlugin.pluginOnThisInstance')}>
		<InfoGrid cells={infoCells}>
			{#snippet custom(cell)}
				{#if cell.id === 'state'}
					<StatusBadge state={badge.state} label={badge.label} />
				{:else if cell.id === 'source'}
					<BrandLink source={data.row.source} href={data.url} />
				{/if}
			{/snippet}
		</InfoGrid>
	</Panel>

	<div class="gap"></div>

	<Panel
		title={t('web.instancePlugin.logActivityThisSession')}
		count={data.log.lines.length}
		description={t('web.instancePlugin.everyLineOfTheCurrent')}
		flush
	>
		{#snippet actions()}
			<Alerts warnings={data.log.warnings} errors={data.log.errors} />
			<Btn icon="code" onclick={() => goto(`/instances/${instance}/console`)}>{t('web.instancePlugin.liveConsole')}</Btn>
		{/snippet}
		{#if data.log.lines.length}
			<pre class="logview mono">{#each data.log.lines as line, index (index)}<span
					class="line {lineSeverity(line)}">{line}
</span>{/each}</pre>
		{:else}
			<p class="dim empty">{t('web.instancePlugin.nothingLoggedByThis')}</p>
		{/if}
	</Panel>

	{#if !data.sessionComplete}
		<p class="dim note">
			{t('web.instancePlugin.theBootLinesOf')}
		</p>
	{/if}
{/if}

<style lang="scss">
	.gap {
		height: 1rem;
	}

	.crumb {
		font-size: 0.875rem;
		font-weight: 400;
	}

	.logview {
		margin: 0;
		padding: 0.75rem 1rem;
		max-height: 55vh;
		overflow: auto;
		font-size: 0.75rem;
		line-height: 1.5;
		background: var(--bg-terminal);
		white-space: pre-wrap;
		word-break: break-all;

		.line.warn {
			color: var(--warning);
		}

		.line.error {
			color: var(--error);
		}
	}

	.empty {
		padding: 1rem 1.25rem;
		margin: 0;
	}

	.note {
		margin-top: 0.625rem;
	}
</style>
