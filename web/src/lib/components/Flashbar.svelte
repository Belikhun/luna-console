<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';
	import {
		Notifications,
		type NotificationItem,
		type NotificationLevel
	} from '$lib/notifications.svelte';

	/**
	 * Notification flashbar: solid level-coloured cards with white content.
	 * Several notifications collapse into a stack; only the newest card renders,
	 * with the others peeking out below it as darker slivers; and a dark counter
	 * bar straddles the stack's bottom edge, listing every level's count and
	 * toggling the full list. Loading notifications carry a spinner (or a
	 * determinate bar) and never dismiss themselves.
	 */
	const ICONS: Record<NotificationLevel, string> = {
		info: 'circleInfo',
		success: 'circleCheck',
		warning: 'triangleExclamation',
		error: 'circleXMark',
		loading: 'rotate'
	};

	/** counter icons; no circled-ellipsis glyph exists, so in-progress uses circleDot */
	const COUNTER_ICONS: Record<NotificationLevel, string> = {
		error: 'circleXMark',
		warning: 'triangleExclamation',
		success: 'circleCheck',
		info: 'circleInfo',
		loading: 'circleDot'
	};

	/** the counter bar always lists every level, zeros included, in this order */
	const COUNTER_ORDER: NotificationLevel[] = ['error', 'warning', 'success', 'info', 'loading'];

	/** ghost slivers rendered behind the newest card */
	const MAX_GHOSTS = 2;

	const items = $derived(Notifications.ordered);
	const stacked = $derived(Notifications.collapsed && items.length > 1);
	const shown = $derived(stacked ? items.slice(0, 1) : items);
	const counts = $derived(Notifications.counts);
	const ghosts = $derived(stacked ? Math.min(items.length - 1, MAX_GHOSTS) : 0);
</script>

{#snippet card(item: NotificationItem)}
	<div class="flash" data-level={item.level}>
		<span class="fi">
			{#if item.level === 'loading'}
				<Spinner size="1rem" />
			{:else}
				<Icon name={ICONS[item.level]} size="1rem" />
			{/if}
		</span>
		<div class="body">
			<div class="msg">{item.message}</div>
			{#if item.level === 'loading' && item.segments?.length}
				{@const total = item.segments.length}
				{@const current = Math.min(
					item.segments.filter((seg) => seg.tone === 'done').length + 1,
					total
				)}
				<!-- one line: current task · (done+1 of total) · overall percent -->
				<div class="taskline">
					<span class="task">
						{item.detail ||
							(item.segments.find((seg) => seg.tone !== 'done') ?? item.segments.at(-1))?.label ||
							''}
					</span>
					<span class="count">({current}/{total})</span>
					{#if item.progress !== null}
						<span class="pct">{Math.round(item.progress)}%</span>
					{/if}
				</div>
				<div class="segbar">
					{#each item.segments as seg}
						<span class="seg" data-tone={seg.tone} title={seg.label}>
							<span
								class="fill"
								style:width="{seg.tone === 'done' ? 100 : Math.round(seg.progress * 100)}%"
							></span>
						</span>
					{/each}
				</div>
			{:else}
				{#if item.detail}<div class="detail">{item.detail}</div>{/if}
				{#if item.level === 'loading' && item.progress !== null}
					<!-- a job with no task tree still reads like one: the same taskline
					     and the same bar, with a single segment -->
					<div class="taskline">
						<span class="pct">{Math.round(item.progress)}%</span>
					</div>
					<div class="segbar">
						<span class="seg" data-tone="running">
							<span class="fill" style:width="{Math.round(item.progress)}%"></span>
						</span>
					</div>
				{/if}
			{/if}
			{#if item.actions.length}
				<div class="acts">
					{#each item.actions as act}
						<button
							class="act"
							onclick={() => {
								act.run();

								if (!act.keep) {
									Notifications.close(item.id);
								}
							}}
						>
							{act.label}
						</button>
					{/each}
				</div>
			{/if}
		</div>
		{#if item.closeable}
			<button class="x" title="Dismiss" onclick={() => Notifications.close(item.id)}>
				<Icon name="close" size="1rem" />
			</button>
		{/if}
		{#if item.autocloseMs !== null}
			{#key `${item.id}:${item.autocloseMs}:${item.message}`}
				<span class="timer" style:animation-duration="{item.autocloseMs}ms"></span>
			{/key}
		{/if}
	</div>
{/snippet}

{#if items.length > 0}
	<div class="flashbar" class:has-bar={items.length > 1}>
		<div class="list" class:stacked>
			{#each shown as item (item.id)}
				{@render card(item)}
			{/each}
			{#each { length: ghosts } as _unused, i}
				<div
					class="ghost"
					data-level={items[i + 1]?.level ?? items[0]?.level}
					style:--depth={i + 1}
				></div>
			{/each}
		</div>

		{#if items.length > 1}
			<div class="barrow">
				<button
					class="bar"
					onclick={() => (Notifications.collapsed = !Notifications.collapsed)}
					aria-expanded={!Notifications.collapsed}
					aria-label={stacked ? t('web.flash.showAll', { count: items.length }) : t('web.flash.collapse')}
				>
					{#each COUNTER_ORDER as level}
						<span class="ctr">
							<Icon name={COUNTER_ICONS[level]} size="0.875rem" style="light" />
							{counts[level]}
						</span>
					{/each}
					<span class="chev">
						<Icon name={stacked ? 'arrowDown' : 'arrowUp'} size="0.875rem" style="solid" />
					</span>
				</button>
			</div>
		{/if}
	</div>
{/if}

<style lang="scss">
	// Notification colours are fixed rather than themed; solid fill, white
	// content, no border.
	[data-level='error'] {
		--flash-bg: #d63f38;
	}

	[data-level='warning'] {
		--flash-bg: #8d6605;
	}

	[data-level='success'] {
		--flash-bg: #00802f;
	}

	[data-level='info'] {
		--flash-bg: #0972d3;
	}

	// in-progress reads as informational blue, like the info level; the spinner
	// is what tells them apart (matches the AWS flashbar convention)
	[data-level='loading'] {
		--flash-bg: #0972d3;
	}

	.flashbar {
		margin-bottom: 1rem;
	}

	.list {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;

		// Collapsed stack: only the newest card is real; the ones behind show as
		// slivers stepped *inwards* and down, each darker than the one before, so
		// the peek reads as receding cards. Only the bottom corners are rounded -
		// the square tops hide behind the card above. The list padding reserves the
		// peek so the counter bar still lands on the stack's real bottom edge.
		&.stacked {
			position: relative;
			gap: 0;
			padding-bottom: 0.5rem;
		}
	}

	.ghost {
		position: absolute;
		left: calc(var(--depth) * 0.5rem);
		right: calc(var(--depth) * 0.5rem);
		bottom: calc(0.5rem - var(--depth) * 0.5rem);
		height: 1rem;
		border-radius: 0 0 0.625rem 0.625rem;
		background: var(--flash-bg);
		filter: brightness(calc(1 - var(--depth) * 0.18));
		z-index: calc(3 - var(--depth));
	}

	.flash {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.5rem 1rem;
		border: none;
		border-radius: 0.75rem;
		background: var(--flash-bg);
		box-shadow: rgba(0, 7, 22, 0.5) 0 0.25rem 0.5rem;
		color: #f9f9fa;
		font-size: 0.875rem;
		overflow: hidden;
		animation: fadein 0.14s ease-out;
		z-index: 3;
	}
	.fi {
		display: inline-flex;
		padding-top: 0.25rem;
		color: #f9f9fa;
	}

	.body {
		flex: 1;
		min-width: 0;
		padding: 0.125rem 0;
	}

	.msg {
		line-height: 1.25rem;
	}

	.detail {
		color: rgba(249, 249, 250, 0.85);
		font-size: 0.8125rem;
		margin-top: 0.125rem;
		word-break: break-word;
	}

	// current task · (i/n) · percent, one line above the segmented bar
	.taskline {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		max-width: 30rem;
		margin-top: 0.125rem;
		font-size: 0.8125rem;
		color: rgba(249, 249, 250, 0.85);
	}

	.task {
		@include ellipsis;

		min-width: 0;
	}

	.count {
		flex: none;
		font-variant-numeric: tabular-nums;
	}

	.pct {
		flex: none;
		margin-left: auto;
		font-variant-numeric: tabular-nums;
		font-weight: 700;
		color: #f9f9fa;
	}

	// the job's tasks, one segment each, filled by that task's own progress
	.segbar {
		display: flex;
		gap: 0.25rem;
		max-width: 30rem;
		margin-top: 0.375rem;
	}

	.seg {
		flex: 1;
		height: 0.375rem;
		border-radius: 0.25rem;
		background: rgba(4, 9, 16, 0.35);
		overflow: hidden;

		&[data-tone='done'] .fill {
			background: #7ee2a8;
		}

		&[data-tone='running'] .fill {
			background: #f9f9fa;
		}

		&[data-tone='warn'] .fill {
			background: #ffd166;
		}

		&[data-tone='error'] .fill {
			background: #ff8a80;
		}
	}

	.fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		transition: width 0.15s ease-out;
	}

	// action buttons keep the card's fixed colouring: white outline on the fill
	.acts {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.625rem;
	}

	.act {
		@include bare-button;

		padding: 0.25rem 1rem;
		border: 0.125rem solid rgba(249, 249, 250, 0.7);
		border-radius: 1rem;
		color: #f9f9fa;
		font-family: var(--font);
		font-size: 0.8125rem;
		font-weight: 700;

		&:hover {
			background: rgba(249, 249, 250, 0.16);
			border-color: #f9f9fa;
		}
	}

	.x {
		@include bare-button;

		color: #f9f9fa;
		padding: 0.25rem;
		border-radius: 0.25rem;
		display: inline-flex;

		&:hover {
			background: rgba(249, 249, 250, 0.16);
		}
	}

	.timer {
		position: absolute;
		left: 0;
		bottom: 0;
		height: 0.125rem;
		width: 100%;
		background: #f9f9fa;
		opacity: 0.35;
		transform-origin: left center;
		animation-name: countdown;
		animation-timing-function: linear;
		animation-fill-mode: forwards;
	}
	@keyframes countdown {
		from {
			transform: scaleX(1);
		}

		to {
			transform: scaleX(0);
		}
	}

	// counter bar: a pill straddling the bottom edge of the stack, centred
	.barrow {
		display: flex;
		justify-content: center;
		position: relative;
		z-index: 4;
		margin-top: -0.75rem;
	}
	.bar {
		display: inline-flex;
		align-items: center;
		gap: 1.25rem;
		min-height: 2rem;
		padding: 0.25rem 1.25rem;
		background: var(--bg-hover);
		border: 0.125rem solid var(--bg-hover);
		border-radius: 1.25rem;
		box-shadow: rgb(0, 7, 22) 0 0.375rem 0.75rem 0.1rem;
		color: #fff;
		font-family: var(--font);
		font-size: 0.875rem;
		cursor: pointer;
	}
	.bar:hover {
		border-color: var(--border);
	}

	.ctr {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}

	// pulls the chevron into the pill's trailing padding
	.chev {
		display: inline-flex;
		margin-left: -0.5rem;
	}
</style>
