<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * BlueMap's own controls, drawn in the console's language.
	 *
	 * The embedded map ships a full HUD of its own; a burger menu, zoom buttons, a
	 * compass, a settings page. All of it lands under our panels and none of it
	 * looks like the rest of this page, so `BlueMapLink` hides it and this draws
	 * the parts a visitor actually reaches for.
	 *
	 * Two things BlueMap offers are left out on purpose: its debug overlay, which
	 * is a frame-time readout for whoever builds BlueMap, and its language picker,
	 * which only ever spoke to the chrome this page replaced.
	 */
	import { t } from '$lib/i18n.svelte';
	import { MAP_QUALITIES, type BlueMapLink, type MapView } from '$lib/bluemap.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Slider from '$lib/components/Slider.svelte';
	import Toggle from '$lib/components/Toggle.svelte';

	let { link, fullscreenTarget }: { link: BlueMapLink; fullscreenTarget?: HTMLElement } = $props();

	let open = $state(false);
	let fullscreen = $state(false);

	// deliberately not named `state`: a local of that name makes the compiler read
	// every `$state` in this file as a store subscription instead of the rune
	const map = $derived(link.state);

	const VIEW_LABELS: Record<MapView, string> = {
		perspective: 'web.public.map.viewPerspective',
		flat: 'web.public.map.viewFlat',
		free: 'web.public.map.viewFree'
	};

	/** Sunlight and ambient are 0-1; a slider reads better as a percentage. */
	const LIGHT_STEPS = 100;

	/** Mouse sensitivity is BlueMap's own 0.1-5 range, stepped for a slider. */
	const SENSITIVITY_STEPS = 100;
	const SENSITIVITY_MAX = 5;

	// the page rather than the iframe: BlueMap's own button fullscreens its
	// document, which would leave every readout behind on the page underneath
	$effect(() => {
		const sync = (): void => {
			fullscreen = document.fullscreenElement !== null;
		};

		document.addEventListener('fullscreenchange', sync);

		return () => document.removeEventListener('fullscreenchange', sync);
	});

	async function toggleFullscreen(): Promise<void> {
		try {
			if (document.fullscreenElement) {
				await document.exitFullscreen();
			} else {
				await fullscreenTarget?.requestFullscreen();
			}
		} catch {
			// a browser that refuses the request leaves the button where it was; there
			// is nothing useful to say to a visitor about it
		}
	}
</script>

{#if map.ready}
	<div class="controls" class:open>
		{#if open}
			<div class="panel">
				<div class="head">
					<Icon name="sliders" style="solid" size="0.875rem" />
					<span>{t('web.public.map.settings')}</span>
					<button
						class="x"
						onclick={() => (open = false)}
						aria-label={t('web.public.map.close')}
					>
						<Icon name="close" style="solid" size="0.875rem" />
					</button>
				</div>

				<div class="body">
					{#if map.views.length > 1}
						<div class="group">
							<div class="k">{t('web.public.map.view')}</div>
							<div class="segs">
								{#each map.views as mode (mode)}
									<button
										aria-pressed={map.view === mode}
										onclick={() => link.setView(mode)}
									>
										{t(VIEW_LABELS[mode])}
									</button>
								{/each}
							</div>
						</div>
					{/if}

					<div class="group">
						<div class="k">{t('web.public.map.quality')}</div>
						<div class="segs">
							{#each MAP_QUALITIES as quality (quality.value)}
								<button
									aria-pressed={map.quality === quality.value}
									onclick={() => link.setQuality(quality.value)}
								>
									{t(quality.label)}
								</button>
							{/each}
						</div>
					</div>

					<div class="group">
						<div class="k">{t('web.public.map.detail')}</div>
						<label>
							<span>{t('web.public.map.detailNear')}</span>
							<Slider
								value={map.hires}
								min={map.hiresMin}
								max={map.hiresMax}
								step={10}
								unit=" m"
								onchange={(value) => link.setHires(value)}
							/>
						</label>
						<label>
							<span>{t('web.public.map.horizon')}</span>
							<Slider
								value={map.lowres}
								min={map.lowresMin}
								max={map.lowresMax}
								step={100}
								unit=" m"
								onchange={(value) => link.setLowres(value)}
							/>
						</label>
						<div class="row">
							<span>{t('web.public.map.loadWhileMoving')}</span>
							<Toggle
								checked={map.loadWhileMoving}
								label={t('web.public.map.loadWhileMoving')}
								onchange={(on) => link.setLoadWhileMoving(on)}
							/>
						</div>
						<div class="hint">{t('web.public.map.detailHint')}</div>
					</div>

					<div class="group">
						<div class="k">{t('web.public.map.light')}</div>
						<label>
							<span>{t('web.public.map.sunlight')}</span>
							<Slider
								value={Math.round(map.sunlight * LIGHT_STEPS)}
								max={LIGHT_STEPS}
								unit="%"
								onchange={(value) => link.setSunlight(value / LIGHT_STEPS)}
							/>
						</label>
						<label>
							<span>{t('web.public.map.ambient')}</span>
							<Slider
								value={Math.round(map.ambient * LIGHT_STEPS)}
								max={LIGHT_STEPS}
								unit="%"
								onchange={(value) => link.setAmbient(value / LIGHT_STEPS)}
							/>
						</label>
					</div>

					<!-- only in free flight: these do nothing in the other two modes, and a
					     dead control is worse than an absent one -->
					{#if map.view === 'free'}
						<div class="group">
							<div class="k">{t('web.public.map.flight')}</div>
							<label>
								<span>{t('web.public.map.sensitivity')}</span>
								<Slider
									value={Math.round(map.mouseSensitivity * SENSITIVITY_STEPS)}
									min={10}
									max={SENSITIVITY_MAX * SENSITIVITY_STEPS}
									step={5}
									unit="%"
									onchange={(value) => link.setMouseSensitivity(value / SENSITIVITY_STEPS)}
								/>
							</label>
							<div class="row">
								<span>{t('web.public.map.invertY')}</span>
								<Toggle
									checked={map.invertMouse}
									label={t('web.public.map.invertY')}
									onchange={(on) => link.setInvertMouse(on)}
								/>
							</div>
						</div>
					{/if}

					<div class="group">
						<div class="k">{t('web.public.map.world')}</div>
						<div class="row">
							<span>{t('web.public.map.chunkBorders')}</span>
							<Toggle
								checked={map.chunkBorders}
								label={t('web.public.map.chunkBorders')}
								onchange={(on) => link.setChunkBorders(on)}
							/>
						</div>
						<div class="verbs">
							<button onclick={() => link.reloadTiles()}>
								{t('web.public.map.reload')}
							</button>
							<button onclick={() => link.resetSettings()}>
								{t('web.public.map.reset')}
							</button>
						</div>
						<div class="hint">{t('web.public.map.reloadHint')}</div>
					</div>
				</div>
			</div>
		{/if}

		<div class="rail">
			<button onclick={() => link.zoom(-1)} title={t('web.public.map.zoomIn')}>
				<Icon name="plus" style="solid" size="0.875rem" />
			</button>
			<button onclick={() => link.zoom(1)} title={t('web.public.map.zoomOut')}>
				<Icon name="minus" style="solid" size="0.875rem" />
			</button>
			<button onclick={() => link.resetCamera()} title={t('web.public.map.recenter')}>
				<Icon name="compass" style="solid" size="0.9375rem" />
			</button>
			<button onclick={() => link.screenshot()} title={t('web.public.map.screenshot')}>
				<Icon name="camera" style="solid" size="0.9375rem" />
			</button>
			<button
				onclick={() => void toggleFullscreen()}
				title={fullscreen ? t('web.public.map.exitFullscreen') : t('web.public.map.fullscreen')}
			>
				<Icon name={fullscreen ? 'compress' : 'expand'} style="solid" size="0.9375rem" />
			</button>
			<button
				class:on={open}
				onclick={() => (open = !open)}
				title={t('web.public.map.settings')}
				aria-expanded={open}
			>
				<Icon name="sliders" style="solid" size="0.9375rem" />
			</button>
		</div>
	</div>
{/if}

<style lang="scss">
	// bottom-aligned against the player list beside it, so the rail grows upward
	// and the panel opens above the rail rather than over the readouts
	.controls {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.625rem;
		min-height: 0;
	}

	.rail {
		@include glass;

		display: flex;
		flex-direction: column;
		padding: 0.25rem;
		gap: 0.125rem;
		flex: none;

		button {
			@include bare-button;

			display: flex;
			align-items: center;
			justify-content: center;
			width: 2.25rem;
			height: 2.25rem;
			border-radius: var(--radius-button);
			color: var(--text-secondary);

			&:hover {
				background: var(--bg-hover);
				color: var(--text-heading);
			}

			&:focus-visible {
				@include focus-ring;
			}

			&.on {
				background: var(--bg-hover);
				color: var(--text-heading);
			}
		}
	}

	.panel {
		@include glass;

		width: 17rem;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		min-height: 0;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 0.75rem 0.75rem 1rem;
		border-bottom: var(--hairline) solid var(--border-divider);
		font-size: 0.875rem;
		font-weight: 700;
		color: var(--text-heading);
		flex: none;
	}

	.x {
		@include bare-button;

		margin-left: auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-button);
		color: var(--text-secondary);

		&:hover {
			background: var(--bg-hover);
			color: var(--text-heading);
		}
	}

	.body {
		padding: 0.875rem 1rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		overflow-y: auto;
		min-height: 0;
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;

		.k {
			font-size: 0.75rem;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			font-weight: 600;
			color: var(--text-label);
		}
	}

	.hint {
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	// a switch reads as one line with its name, unlike a slider, which needs the
	// width and puts its own readout on the right
	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.8125rem;
		color: var(--text);

		span {
			@include ellipsis;

			flex: 1;
		}
	}

	.verbs {
		display: flex;
		gap: 0.375rem;

		button {
			@include bare-button;

			flex: 1;
			height: 1.875rem;
			border-radius: var(--radius-button);
			border: var(--border-control) solid var(--border);
			color: var(--text);
			font-size: 0.8125rem;

			&:hover {
				border-color: var(--link);
				color: var(--link);
			}

			&:focus-visible {
				@include focus-ring;
			}
		}
	}

	// the slider carries its own readout on the right, so the name goes above it
	// rather than beside; two sliders in a group are unreadable without one
	label {
		display: block;

		span {
			display: block;
			font-size: 0.8125rem;
			color: var(--text);
			margin-bottom: 0.125rem;
		}
	}

	// the same segmented row the world switcher uses, so the two groups of
	// map controls read as one family
	.segs {
		display: flex;
		gap: 0.25rem;

		button {
			@include bare-button;

			flex: 1;
			color: var(--text-secondary);
			font-size: 0.8125rem;
			height: 1.875rem;
			border-radius: var(--radius-button);
			background: var(--bg-track);

			&:hover {
				color: var(--text-heading);
			}

			&:focus-visible {
				@include focus-ring;
			}

			&[aria-pressed='true'] {
				background: var(--bg-hover);
				color: var(--text-heading);
				font-weight: 600;
			}
		}
	}
</style>
