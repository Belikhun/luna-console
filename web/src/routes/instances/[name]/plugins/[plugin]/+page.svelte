<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import Icon from '$lib/components/Icon.svelte';
	import Alerts from '$lib/components/Alerts.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One plugin on one instance: what build it runs, how it got here, whether
	 * the server actually loaded it — and every log line of the current boot
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

	const STATE_BADGE: Record<string, { state: string; label: string }> = {
		running: { state: 'running', label: 'Running' },
		errored: { state: 'failed', label: 'Errored' },
		'not-loaded': { state: 'warning', label: 'Not loaded' },
		disabled: { state: 'stopped', label: 'Disabled' },
		stopped: { state: 'stopped', label: 'Stopped' },
		unknown: { state: 'unknown', label: 'Unknown' }
	};

	const badge = $derived(
		data ? (STATE_BADGE[data.row.state] ?? STATE_BADGE.unknown) : STATE_BADGE.unknown
	);

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
					? `Removed ${result.removed.join(', ')} — a running server keeps it loaded until restart.`
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
			{ id: 'state', label: 'Runtime state' },
			{ label: 'Display name', value: row.displayName },
			{ label: 'Family', value: row.family },
			{ label: 'Version', value: row.version ?? '?', style: 'mono' },
			{
				label: 'Assignment',
				value: row.pinned ? 'pinned' : row.variant ? 'variant (auto)' : 'primary'
			},
			{
				label: 'From',
				value:
					row.origin === 'group'
						? `group: ${row.groups.join(', ')}`
						: row.origin === 'manual'
							? 'manually added'
							: 'explicit target'
			},
			{ id: 'source', label: 'Source' },
			{ label: 'Update channel', value: data.channel },
			{ label: 'Jar file', value: row.file, copyable: true, style: 'mono' },
			{ label: 'Log names', value: data.aliases.join(', ') },
			{ label: 'Authors', value: data.meta?.authors?.join(', ') ?? null },
			{ label: 'Description', value: data.meta?.description ?? null, colSpan: 2 }
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

<svelte:head><title>{plugin} on {instance} | MRDS Console</title></svelte:head>

{#if data}
	<PageHeader title={plugin ?? ''} info>
		{#snippet extra()}
			<span class="crumb dim">on <a href="/instances/{instance}?tab=plugins">{instance}</a></span>
			<StatusBadge state={badge.state} label={badge.label} />
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="instance-plugin" />
			<Btn icon="circleInfo" onclick={() => goto(`/plugins/${plugin}`)}>Plugin details</Btn>
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

	<Panel title="Plugin on this instance">
		<InfoGrid cells={infoCells}>
			{#snippet custom(cell)}
				{#if cell.id === 'state'}
					<StatusBadge state={badge.state} label={badge.label} />
				{:else if cell.id === 'source'}
					{data.row.source}{#if data.modrinth}&nbsp;·&nbsp;<a
							href="https://modrinth.com/plugin/{data.modrinth.slug}"
							target="_blank"
							rel="noreferrer"
						>
							<span class="lt">modrinth</span>
							<Icon name="externalLink" size="0.625rem" />
						</a>{/if}
				{/if}
			{/snippet}
		</InfoGrid>
	</Panel>

	<div class="gap"></div>

	<Panel
		title="Log activity this session"
		count={data.log.lines.length}
		description="Every line of the current boot session attributed to this plugin's log names"
		flush
	>
		{#snippet actions()}
			<Alerts warnings={data.log.warnings} errors={data.log.errors} />
			<Btn icon="code" onclick={() => goto(`/instances/${instance}/console`)}>Live console</Btn>
		{/snippet}
		{#if data.log.lines.length}
			<pre class="logview mono">{#each data.log.lines as line, index (index)}<span
					class="line {lineSeverity(line)}">{line}
</span>{/each}</pre>
		{:else}
			<p class="dim empty">Nothing logged by this plugin in the current session.</p>
		{/if}
	</Panel>

	{#if !data.sessionComplete}
		<p class="dim note">
			The boot lines of this session have rotated out of the log window — early activity may be
			missing from the list above.
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
