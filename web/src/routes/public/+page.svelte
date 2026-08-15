<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onMount } from 'svelte';

	import { t } from '$lib/i18n.svelte';
	import { followPublic } from '$lib/public.svelte';
	import Gauge from '$lib/components/Gauge.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import BrandIcon from '$lib/components/BrandIcon.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import CopyValue from '$lib/components/CopyValue.svelte';
	import UptimeTimeline from '$lib/components/UptimeTimeline.svelte';
	import PublicCard from './PublicCard.svelte';
	import type { PublicSnapshot } from '$core/publicsite';

	let { data } = $props();

	/**
	 * The last streamed document, if one has arrived.
	 *
	 * Kept beside the loaded one rather than seeded from it: a `$state`
	 * initialised from `data` captures only the first value, so a reload that
	 * brings a new document would be ignored until the next frame.
	 */
	let live: PublicSnapshot | null = $state(null);

	const snapshot = $derived(live ?? data.snapshot);

	onMount(() => followPublic((frame) => (live = frame)));

	const totals = $derived(snapshot.totals);
	const offline = $derived(totals.instancesTotal - totals.instancesOnline);

	/** Days on the card strips; a card is too narrow to read ninety of them. */
	const CARD_DAYS = 30;

	const playerPoints = $derived(snapshot.series.players.map((point) => ({ t: point.t, v: point.v })));
</script>

<svelte:head>
	<title>{snapshot.site.title}</title>
	{#if snapshot.site.tagline}
		<meta name="description" content={snapshot.site.tagline} />
	{/if}
</svelte:head>

<div class="page">
	<div class="wrap">
		<header class="mast">
			<!-- the ringed mark rather than the gradient plate the console's top bar
			     wears: this page is the cluster's front door rather than a screen inside
			     the product, and the ring is the artwork's own edge at any size -->
			<span class="mark"><BrandIcon name="luna" size="3rem" /></span>
			<div class="who">
				<h1>{snapshot.site.title}</h1>
				{#if snapshot.site.tagline}<p>{snapshot.site.tagline}</p>{/if}
			</div>

			{#if snapshot.site.address}
				<div class="join">
					<CopyValue value={snapshot.site.address} label={t('web.public.address')} chip size="large" />
				</div>
			{/if}
		</header>

		<!-- the one thing a visitor checks first: is it up -->
		<div class="banner" class:warn={offline > 0}>
			<Icon name={offline ? 'circleInfo' : 'circleCheck'} style="solid" size="1.5rem" />
			<div>
				<div class="t">
					{offline
						? t('web.public.someOffline', { count: String(offline) })
						: t('web.public.allUp')}
				</div>
				<div class="s">
					{t('web.public.playersAcross', {
						players: String(totals.players),
						servers: String(totals.instancesOnline)
					})}
				</div>
			</div>
		</div>

		<section>
			<Panel>
				<div class="dials">
					<Gauge
						value={totals.players}
						max={Math.max(1, totals.maxPlayers)}
						display={String(totals.players)}
						label={t('web.public.players')}
						footnote={t('web.public.ofCapacity', { max: String(totals.maxPlayers) })}
						color="accent"
					/>
					<Gauge
						value={totals.instancesOnline}
						max={Math.max(1, totals.instancesTotal)}
						display={`${totals.instancesOnline}/${totals.instancesTotal}`}
						label={t('web.public.serversUp')}
						footnote={t('web.public.machines', { count: String(totals.machines) })}
						color={offline ? 'warning' : 'success'}
					/>
					<Gauge
						value={totals.cpuPct}
						label={t('web.public.cpu')}
						footnote={t('web.public.acrossFleet')}
					/>
					<Gauge
						value={totals.memUsedMb}
						max={Math.max(1, totals.memTotalMb ?? 1)}
						display={totals.memUsedMb === null
							? undefined
							: `${(totals.memUsedMb / 1024).toFixed(0)} GB`}
						label={t('web.public.memory')}
						footnote={totals.memTotalMb === null
							? undefined
							: t('web.public.ofMemory', { max: (totals.memTotalMb / 1024).toFixed(0) })}
					/>
				</div>

				<div class="chart">
					<Sparkline points={playerPoints} label={t('web.public.playersOnline')} color="#42b4ff" />
				</div>
			</Panel>
		</section>

		<section>
			<div class="eyebrow">{t('web.public.servers')}</div>

			{#if snapshot.instances.length}
				<div class="grid">
					{#each snapshot.instances as instance (instance.name)}
						<PublicCard card={instance} days={CARD_DAYS} />
					{/each}
				</div>
			{:else}
				<Panel>
					<p class="empty">{t('web.public.noneListed')}</p>
				</Panel>
			{/if}
		</section>
	</div>

	<footer>
		<div class="wrap">
			<span>{t('web.public.optInNote')}</span>
			<a class="console" href="/instances">
				<span>{t('web.public.console')}</span>
				<Icon name="externalLink" style="solid" size="0.75em" />
			</a>
		</div>
	</footer>
</div>

<style lang="scss">
	.page {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.wrap {
		width: 100%;
		max-width: 78rem;
		margin: 0 auto;
		padding: 0 1.5rem;
	}

	section {
		margin-bottom: 2rem;
	}

	.mast {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 3rem 0 2rem;
		flex-wrap: wrap;
	}

	.mark {
		display: inline-flex;
		color: var(--text-heading);
		flex: none;
	}

	.who h1 {
		font-size: 1.75rem;
		font-weight: 700;
		line-height: 1.1;
		margin: 0;
		color: var(--text-heading);
	}

	.who p {
		margin: 0;
		color: var(--text-secondary);
	}

	.join {
		margin-left: auto;
	}

	.banner {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		padding: 1.125rem 1.25rem;
		border-radius: var(--radius-container);
		background: var(--bg-panel);
		border: var(--hairline) solid var(--border-divider);
		border-left: 0.25rem solid var(--success);
		box-shadow: var(--shadow-panel);
		margin-bottom: 1.25rem;
		color: var(--success);

		&.warn {
			border-left-color: var(--warning);
			color: var(--warning);
		}

		.t {
			font-size: 1.125rem;
			font-weight: 700;
			color: var(--text-heading);
		}

		.s {
			color: var(--text-secondary);
			font-size: 0.8125rem;
		}
	}

	.dials {
		display: flex;
		gap: 1.5rem;
		flex-wrap: wrap;
		justify-content: center;
	}

	.chart {
		margin-top: 1.5rem;
	}

	.eyebrow {
		color: var(--text-label);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-weight: 600;
		margin-bottom: 0.75rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
		gap: 1.25rem;
	}

	.empty {
		margin: 0;
		color: var(--text-secondary);
	}

	footer {
		border-top: var(--hairline) solid var(--border-divider);
		margin-top: auto;
		padding: 1.25rem 0 2.5rem;
		color: var(--text-secondary);
		font-size: 0.8125rem;

		.wrap {
			display: flex;
			align-items: center;
			gap: 1rem;
			flex-wrap: wrap;
		}
	}

	// the way back in for whoever runs the place; the glyph says it leaves the
	// public page rather than moving around inside it
	.console {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 0.4375rem;
		color: var(--link);

		&:hover {
			color: var(--link-hover);
		}
	}

	@include below($bp-narrow) {
		.wrap {
			padding: 0 1rem;
		}

		.mast {
			padding: 1.5rem 0 1.25rem;
			gap: 0.75rem;
		}

		// the address is what a visitor came for, so it gets its own line rather
		// than being squeezed beside the name
		.join {
			margin-left: 0;
			flex-basis: 100%;
		}

		.who h1 {
			font-size: 1.5rem;
		}

		// two by two rather than whatever fits, so the fourth dial is not left
		// centred on a row of its own
		.dials {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 0.75rem;
			justify-items: center;
		}

		.chart {
			margin-top: 1rem;
		}

		// one card per row: two of them at this width leaves the map art too small
		// to be a picture of anywhere
		.grid {
			grid-template-columns: 1fr;
			gap: 1rem;
		}

		section {
			margin-bottom: 1.5rem;
		}
	}
</style>
