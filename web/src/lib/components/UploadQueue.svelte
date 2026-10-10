<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { formatBytes, formatRate } from '$lib/upload';
	import { baseName, parentOf } from '$lib/files';
	import type { UploadItem, UploadQueue } from '$lib/uploads.svelte';
	import Btn from './Btn.svelte';
	import Icon from './Icon.svelte';

	/**
	 * The upload queue as a floating tray in the corner, in the idiom of a
	 * cloud drive's upload card: it sits over the page rather than taking a
	 * strip of it, folds down to its header, and shows one line per file with
	 * a progress ring that turns into a tick. The header sums what is still
	 * going, and the verb a row needs (cancel, retry, or the replace-or-skip
	 * answer a conflict waits on) sits at its end.
	 */
	let {
		queue,
		collapsed = $bindable(false)
	}: {
		queue: UploadQueue;
		collapsed?: boolean;
	} = $props();

	const summary = $derived(queue.summary);
	const conflicts = $derived(queue.conflicts);

	/** Something waits on a person: a conflict to answer, or a file that failed */
	const attention = $derived(conflicts.length > 0 || summary.failed > 0);

	const headline = $derived.by(() => {
		if (summary.live > 0) {
			return t('web.instanceFiles.trayUploading', { count: summary.live });
		}

		if (conflicts.length > 0) {
			return t('web.instanceFiles.queueConflicts', { count: conflicts.length });
		}

		if (summary.failed > 0) {
			return t('web.instanceFiles.queueFailed', { done: summary.done, failed: summary.failed });
		}

		return t('web.instanceFiles.queueDone', { count: summary.done });
	});

	/** The second line of the header while bytes move: how much, how fast. */
	const subline = $derived.by(() => {
		if (summary.live === 0) {
			return '';
		}

		const rate = formatRate(summary.rate);

		return `${formatBytes(summary.loaded)} / ${formatBytes(summary.total)}${rate ? ` · ${rate}` : ''}`;
	});

	/** Overall fraction for the thin bar along the header's bottom edge. */
	const overall = $derived(summary.total > 0 ? Math.min(1, summary.loaded / summary.total) : 0);

	/** Geometry of the progress ring: radius and circumference in SVG units. */
	const RING_R = 8;
	const RING_C = 2 * Math.PI * RING_R;

	function fraction(item: UploadItem): number {
		if (item.state === 'placing' || item.state === 'done') {
			return 1;
		}

		return item.total > 0 ? Math.min(1, item.loaded / item.total) : 0;
	}

	function rowLine(item: UploadItem): string {
		if (item.state === 'uploading') {
			const rate = formatRate(item.rate);

			return `${formatBytes(item.loaded)} / ${formatBytes(item.total)}${rate ? ` · ${rate}` : ''}`;
		}

		if (item.state === 'failed' && item.error) {
			return item.error;
		}

		if (item.state === 'conflict') {
			return t('web.instanceFiles.conflictHint');
		}

		if (item.state === 'done') {
			return parentOf(item.path) || '/';
		}

		return t(`web.instanceFiles.uploadState.${item.state}`);
	}

	/**
	 * The close button: finished rows go, and with nothing left moving the tray
	 * goes with them; while something still moves it only folds.
	 */
	function dismiss(): void {
		queue.clearFinished();

		if (queue.items.length > 0) {
			collapsed = true;
		}
	}
</script>

<div class="tray" class:attention class:collapsed role="region" aria-label={t('web.instanceFiles.uploads')}>
	<div class="hd">
		<div class="words">
			<span class="title">
				{#if attention}
					<span class="warnmark"><Icon name="triangleExclamation" size="0.75rem" style="solid" /></span>
				{/if}
				{headline}
			</span>
			{#if subline}
				<span class="sub">{subline}</span>
			{/if}
		</div>
		<div class="acts">
			{#if conflicts.length > 0 && !collapsed}
				<Btn variant="link" onclick={() => queue.replaceAll()}>{t('web.instanceFiles.replaceAll')}</Btn>
			{/if}
			<button
				class="hbtn"
				onclick={() => (collapsed = !collapsed)}
				aria-expanded={!collapsed}
				title={collapsed ? t('web.instanceFiles.trayExpand') : t('web.instanceFiles.trayCollapse')}
			>
				<Icon name={collapsed ? 'arrowUp' : 'arrowDown'} size="0.75rem" style="solid" />
			</button>
			<button class="hbtn" onclick={dismiss} title={t('web.common.close')}>
				<Icon name="close" size="0.75rem" style="solid" />
			</button>
		</div>
		{#if summary.live > 0}
			<span class="bar" style:--pct="{Math.round(overall * 100)}%"></span>
		{/if}
	</div>

	{#if !collapsed}
		<div class="rows">
			{#each queue.items as item (item.id)}
				<div class="row" class:failed={item.state === 'failed'}>
					<Icon name="file" size="1rem" style="light" />
					<div class="what">
						<span class="nm" title={item.path}>{baseName(item.path)}</span>
						<span class="line" class:err={item.state === 'failed'}>{rowLine(item)}</span>
					</div>
					<div class="end">
						{#if item.state === 'conflict'}
							<Btn variant="link" onclick={() => queue.resolveConflict(item, 'replace')}>{t('web.instanceFiles.replace')}</Btn>
							<Btn variant="link" onclick={() => queue.resolveConflict(item, 'skip')}>{t('web.instanceFiles.skip')}</Btn>
						{:else if item.state === 'failed' || item.state === 'cancelled'}
							<span class="mark bad"><Icon name="circleXMark" size="1.125rem" style="solid" /></span>
							<button class="rbtn" title={t('web.common.retry')} onclick={() => queue.retry(item)}>
								<Icon name="rotateLeft" size="0.75rem" style="solid" />
							</button>
						{:else if item.state === 'done'}
							<span class="mark ok"><Icon name="circleCheck" size="1.125rem" style="solid" /></span>
						{:else if item.state === 'skipped'}
							<span class="mark muted"><Icon name="minusCircle" size="1.125rem" style="solid" /></span>
						{:else}
							<!-- a ring for a file on its way; it fills as the bytes land and spins
							     while the owning daemon is still placing the file -->
							<svg class="ring" class:spin={item.state === 'placing'} viewBox="0 0 20 20" aria-hidden="true">
								<circle class="track" cx="10" cy="10" r={RING_R} />
								<circle
									class="fill"
									cx="10"
									cy="10"
									r={RING_R}
									stroke-dasharray={RING_C}
									stroke-dashoffset={RING_C * (1 - fraction(item))}
								/>
							</svg>
							<button class="rbtn" title={t('web.common.cancel')} onclick={() => queue.cancel(item)}>
								<Icon name="close" size="0.75rem" style="solid" />
							</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style lang="scss">
	// Anchored to the corner over the page, clear of the terminal drawer and the
	// agent panel, which the --split-* offsets measure. Below menus and modals,
	// which must stay on top of it.
	.tray {
		position: fixed;
		right: calc(1.5rem + var(--split-right, 0rem));
		// above the status bar and the terminal drawer, with a gap of its own
		bottom: calc(var(--statusbar-h, 1.75rem) + 1rem + var(--split-bottom, 0rem));
		z-index: var(--z-popover);

		display: flex;
		flex-direction: column;

		width: 22rem;
		max-width: calc(100vw - 3rem);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
		background: var(--bg-panel-raised);
		box-shadow: var(--shadow-dropdown);
		overflow: hidden;

		// A warning in a corner is easy to miss, so the tray nudges itself when
		// one appears and keeps a glowing ring breathing until the conflict is
		// answered or the failure cleared. This motion is the message itself, not
		// decoration, so it is deliberately not switched off for reduced motion:
		// the alternative is a file silently waiting on an answer nobody sees.
		&.attention {
			border-color: var(--warning);
			animation:
				attention-nudge 0.6s ease-in-out 1,
				attention-pulse 1.4s ease-in-out 0.6s infinite;
		}
	}

	@keyframes attention-nudge {
		0%,
		100% {
			transform: translateX(0);
		}

		20%,
		60% {
			transform: translateX(-0.5rem);
		}

		40%,
		80% {
			transform: translateX(0.5rem);
		}
	}

	@keyframes attention-pulse {
		0%,
		100% {
			box-shadow:
				0 0 0 0.125rem color-mix(in srgb, var(--warning) 25%, transparent),
				0 0 0 0 color-mix(in srgb, var(--warning) 0%, transparent),
				var(--shadow-dropdown);
		}

		50% {
			box-shadow:
				0 0 0 0.25rem color-mix(in srgb, var(--warning) 90%, transparent),
				0 0 1.5rem 0.375rem color-mix(in srgb, var(--warning) 45%, transparent),
				var(--shadow-dropdown);
		}
	}

	.hd {
		position: relative;

		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;

		padding: 0.625rem 0.75rem;
		background: var(--bg-table-header);
	}

	.words {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;

		min-width: 0;
	}

	.title {
		@include ellipsis;

		font-size: 0.8125rem;
		font-weight: 700;
		color: var(--text-heading);
	}

	.attention .title {
		color: var(--warning);
	}

	.warnmark {
		display: inline-flex;
		margin-right: 0.25rem;
		animation: warn-blink 1.4s ease-in-out infinite;
	}

	@keyframes warn-blink {
		0%,
		100% {
			opacity: 1;
		}

		50% {
			opacity: 0.25;
		}
	}

	.sub {
		@include ellipsis;

		font-size: 0.6875rem;
		color: var(--text-secondary);
	}

	.acts {
		display: flex;
		align-items: center;
		gap: 0.125rem;

		flex-shrink: 0;
	}

	.hbtn,
	.rbtn {
		@include bare-button;

		display: inline-flex;
		align-items: center;
		justify-content: center;

		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		color: var(--text-secondary);

		&:hover {
			background: var(--bg-hover);
			color: var(--text);
		}

		&:focus-visible {
			@include focus-ring;
		}
	}

	// a hairline along the header's bottom edge for the whole batch
	.bar {
		position: absolute;
		left: 0;
		bottom: 0;
		width: var(--pct);
		height: 0.125rem;
		background: var(--primary);
		transition: width 0.2s;
	}

	.rows {
		max-height: 16rem;
		overflow-y: auto;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.625rem;

		padding: 0.375rem 0.75rem;
		border-top: 0.1rem solid var(--border-divider);
		font-size: 0.75rem;

		// the cancel cross shows itself only under the pointer, as a drive's does;
		// the row stays legible without a column of crosses
		.rbtn {
			opacity: 0;
		}

		&:hover .rbtn,
		.rbtn:focus-visible {
			opacity: 1;
		}

		&.failed .rbtn {
			opacity: 1;
		}
	}

	.what {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;

		flex: 1;
		min-width: 0;
	}

	.nm {
		@include ellipsis;
	}

	.line {
		@include ellipsis;

		font-size: 0.6875rem;
		color: var(--text-secondary);

		&.err {
			color: var(--error);
		}
	}

	.end {
		display: flex;
		align-items: center;
		gap: 0.25rem;

		flex-shrink: 0;
	}

	.mark {
		display: inline-flex;

		&.ok {
			color: var(--success);
		}

		&.bad {
			color: var(--error);
		}

		&.muted {
			color: var(--text-disabled);
		}
	}

	.ring {
		width: 1.25rem;
		height: 1.25rem;
		transform: rotate(-90deg);

		circle {
			fill: none;
			stroke-width: 2.5;
		}

		.track {
			stroke: var(--bg-track);
		}

		.fill {
			stroke: var(--primary);
			stroke-linecap: round;
			transition: stroke-dashoffset 0.2s;
		}

		&.spin {
			animation: ring-spin 1s linear infinite;

			// three quarters of the ring, so the spin reads as motion
			.fill {
				stroke-dashoffset: 12.6;
				stroke: var(--success);
			}

			@media (prefers-reduced-motion: reduce) {
				animation: none;
			}
		}
	}

	@keyframes ring-spin {
		from {
			transform: rotate(-90deg);
		}

		to {
			transform: rotate(270deg);
		}
	}
</style>
