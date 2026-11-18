<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import type { FirewallTab } from '$lib/firewall';
	import Btn from '$lib/components/Btn.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Panel from '$lib/components/Panel.svelte';

	/**
	 * What a tab shows while the proxy's firewall cannot be read: the outline
	 * of the tab's own layout, dimmed, under a card saying what would be there
	 * and why it is not. The outline keeps the screen from jumping when the
	 * proxy comes back and the real content takes its place.
	 */
	let {
		tab,
		why,
		loading = false,
		onretry
	}: {
		tab: FirewallTab;
		/** `offline`: the proxy did not answer; `unsupported`: it answered without a firewall */
		why: 'offline' | 'unsupported';
		loading?: boolean;
		onretry: () => void;
	} = $props();

	const ICONS: Record<FirewallTab, string> = {
		activity: 'chartLine',
		bans: 'gavel',
		rules: 'listCheck',
		autoban: 'robot',
		check: 'magnifyingGlass'
	};
</script>

{#snippet rows(count: number)}
	{#each Array.from({ length: count }, (_, index) => index) as index (index)}
		<span class="bone row" style:width="{92 - (index % 3) * 9}%"></span>
	{/each}
{/snippet}

<div class="offline">
	<div class="ghost" aria-hidden="true">
		{#if tab === 'activity'}
			<div class="block chart"><span class="bone title"></span><span class="bone area"></span></div>
			<div class="pair">
				<div class="block">{@render rows(5)}</div>
				<div class="block">{@render rows(5)}</div>
			</div>
			<div class="block">{@render rows(6)}</div>
		{:else if tab === 'autoban'}
			<div class="block">
				{#each [1, 2, 3, 4] as line (line)}
					<span class="field"><span class="bone check"></span><span class="bone label"></span><span class="bone input"></span></span>
				{/each}
			</div>
			<div class="block">{@render rows(3)}</div>
		{:else if tab === 'check'}
			<div class="block"><span class="field"><span class="bone wide"></span><span class="bone button"></span></span></div>
			<div class="block">{@render rows(5)}</div>
		{:else}
			<div class="block">
				<span class="bone toolbar"></span>
				{@render rows(8)}
			</div>
		{/if}
	</div>

	<div class="card">
		<Panel>
			<div class="message">
				<span class="glyph"><Icon name={ICONS[tab]} size="1.5rem" /></span>
				<b>{t(`web.firewall.offline.${tab}Title`)}</b>
				<span class="dim">{t(`web.firewall.offline.${tab}Text`)}</span>
				<span class="dim why">
					{why === 'offline'
						? t('web.firewall.offline.whyOffline')
						: t('web.firewall.offline.whyUnsupported')}
				</span>
				<Btn icon="arrowRotateRight" {loading} onclick={onretry}>{t('web.common.retry')}</Btn>
			</div>
		</Panel>
	</div>
</div>

<style lang="scss">
	.offline {
		position: relative;
		min-height: 24rem;
	}

	// the tab's own shape, too faint to read as content
	.ghost {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		opacity: 0.35;
		pointer-events: none;
	}

	.block {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem 1.25rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
		background: var(--bg-panel);
	}

	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.bone {
		display: block;
		height: 0.875rem;
		border-radius: 0.25rem;
		background: var(--bg-hover);

		&.title {
			width: 12rem;
			height: 1rem;
		}

		&.area {
			height: 10rem;
		}

		&.toolbar {
			width: 40%;
			height: 2rem;
			margin-bottom: 0.25rem;
		}

		&.check {
			flex: none;
			width: 1rem;
			height: 1rem;
		}

		&.label {
			flex: none;
			width: 10rem;
		}

		&.input {
			flex: none;
			width: 4.5rem;
			height: 1.75rem;
		}

		&.wide {
			flex: none;
			width: 22rem;
			max-width: 60%;
			height: 2rem;
		}

		&.button {
			flex: none;
			width: 6rem;
			height: 2rem;
		}
	}

	.field {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	// the message sits over the outline, near the top so it is seen without scrolling
	.card {
		position: absolute;
		top: 3rem;
		left: 50%;
		width: min(30rem, calc(100% - 2rem));
		transform: translateX(-50%);
		box-shadow: var(--shadow-dropdown);
	}

	.message {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 1rem 0.5rem;
		text-align: center;
		font-size: 0.875rem;

		b {
			color: var(--text-heading);
			font-size: 1rem;
		}

		.glyph {
			color: var(--text-secondary);
		}

		.why {
			margin-bottom: 0.5rem;
			font-size: 0.75rem;
		}
	}
</style>
