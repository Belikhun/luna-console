<script lang="ts">
	import { untrack } from 'svelte';

	import Icon from './Icon.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import { REFRESH_INTERVALS, formatLastUpdated, loadInterval, saveInterval } from './refresh';
	import { t } from '$lib/i18n.svelte';

	/**
	 * Refresh control: "Last updated <timestamp>" beside a split button -
	 * the round segment refreshes now, the caret segment picks the auto-refresh
	 * interval (Off, 5 seconds … 15 minutes). The chosen interval is remembered
	 * per storage key, and the timer restarts whenever it changes.
	 */
	let {
		onrefresh,
		lastUpdated = null,
		loading = false,
		storageKey
	}: {
		onrefresh: () => void | Promise<void>;
		/** epoch ms of the last successful load */
		lastUpdated?: number | null;
		loading?: boolean;
		/** localStorage key for the remembered interval */
		storageKey?: string;
	} = $props();

	/** how often the "Last updated" stamp is re-rendered on its own */
	const STAMP_TICK_MS = 30_000;

	// the remembered interval is read once: the key identifies the screen, and
	// re-reading it would undo an interval the user just picked
	let intervalMs = $state(untrack(() => loadInterval(storageKey)));
	let menuOpen = $state(false);
	let caretEl: HTMLButtonElement | undefined = $state();
	let menu: ContextMenu | undefined = $state();
	let tick = $state(0);

	const label = $derived(
		t(REFRESH_INTERVALS.find((interval) => interval.ms === intervalMs)?.label ?? 'web.refresh.off')
	);

	const stamp = $derived.by(() => {
		void tick;

		return formatLastUpdated(lastUpdated);
	});

	$effect(() => {
		if (intervalMs <= 0) {
			return;
		}

		const id = setInterval(() => void onrefresh(), intervalMs);

		return () => clearInterval(id);
	});

	// keeps the relative part of the stamp honest while nothing else re-renders
	$effect(() => {
		const id = setInterval(() => tick++, STAMP_TICK_MS);

		return () => clearInterval(id);
	});

	function pick(ms: number): void {
		intervalMs = ms;
		saveInterval(storageKey, ms);
	}

	async function toggleMenu(event: MouseEvent): Promise<void> {
		event.stopPropagation();

		if (menuOpen) {
			menu?.close();

			return;
		}

		menuOpen = true;

		await menu?.openAtElement(caretEl!, 'bottom', 4);
	}
</script>

<div class="rc">
	<span class="stamp">
		<span class="lbl">{t('web.refresh.lastUpdated')}</span>
		<span class="when">{stamp}</span>
	</span>
	<div class="split">
		<button
			class="seg now"
			title={t('web.refresh.refreshNow')}
			aria-label={t('web.refresh.refreshNow')}
			disabled={loading}
			onclick={() => void onrefresh()}
		>
			<Icon name="sync" size="0.875rem" spin={loading} />
		</button>
		<button
			bind:this={caretEl}
			class="seg caret"
			class:open={menuOpen}
			title={t('web.refresh.autoRefresh', { label })}
			aria-label={t('web.refresh.autoRefreshInterval')}
			onclick={toggleMenu}
		>
			<Icon name="caretDown" size="0.75rem" />
		</button>
	</div>
	<ContextMenu
		bind:this={menu}
		minWidth="11rem"
		onclose={() => (menuOpen = false)}
		items={REFRESH_INTERVALS.map((interval) => ({
			label: t(interval.label),
			icon: interval.ms === intervalMs ? 'check' : undefined,
			action: () => pick(interval.ms)
		}))}
	/>
</div>

<style lang="scss">
	.rc {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
	}

	.stamp {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		font-size: 0.75rem;
		line-height: 1.125rem;
		color: var(--text-secondary);
		white-space: nowrap;

		.when {
			color: var(--text);
		}
	}

	.split {
		display: inline-flex;
		align-items: stretch;
		height: var(--control-h);
	}

	.seg {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: var(--border-control) solid var(--link);
		background: transparent;
		color: var(--link);
		cursor: pointer;
	}
	.now {
		padding: 0 0.875rem;
		border-radius: var(--radius-button) 0 0 var(--radius-button);
		border-right: none;
	}
	.caret {
		padding: 0 0.5rem;
		border-radius: 0 var(--radius-button) var(--radius-button) 0;
		border-left: 0.1rem solid var(--link);
	}
	.seg:hover:not(:disabled),
	.caret.open {
		background: color-mix(in srgb, var(--link) 12%, transparent);
	}

	.seg:disabled {
		border-color: var(--text-disabled);
		color: var(--text-disabled);
		cursor: default;
	}
</style>
