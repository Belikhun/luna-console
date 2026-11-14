<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';

	import { t } from '$lib/i18n.svelte';

	import CopyValue from './CopyValue.svelte';
	import InfoPopover from './InfoPopover.svelte';
	import { dateFacts, fmtMoment, toMillis, type DateValue } from './datetime';

	/**
	 * A moment shown the way the screen writes it ("3 min ago", "14:02:11",
	 * "12 Nov 14:02"), with the dashed underline that opens every other reading
	 * of it on click: the local date with its weekday and seconds, the viewer's
	 * time zone and offset, the relative time (live while the card is open), UTC,
	 * ISO 8601 and Unix time, the last two copyable.
	 *
	 * In a clipping cell the trigger shrinks and ends in an ellipsis like the
	 * cell's own text. A missing or unreadable moment renders `empty` plainly.
	 */
	let {
		at,
		text,
		empty = '–',
		mono = false,
		children
	}: {
		at: DateValue | null | undefined;
		/** what is shown; defaults to the date and time to the second */
		text?: string;
		/** shown, without a trigger, when `at` is missing or not a date */
		empty?: string;
		mono?: boolean;
		/** rich content for the trigger, in place of `text` */
		children?: Snippet;
	} = $props();

	/** the relative reading ticks while the card is open, so "12 seconds ago" stays true */
	const TICK_MS = 1000;

	const ms = $derived(toMillis(at));

	let open = $state(false);
	let now = $state(Date.now());

	$effect(() => {
		if (!open) {
			return;
		}

		now = Date.now();

		const timer = setInterval(() => {
			now = Date.now();
		}, TICK_MS);

		return () => clearInterval(timer);
	});

</script>

{#if ms === null}
	<span class="none">{empty}</span>
{:else}
	<span class="datetime" class:mono>
		<InfoPopover bind:open wide truncate inherit>
			{#if children}
				{@render children()}
			{:else}
				{text ?? fmtMoment(ms)}
			{/if}

			<!-- worked out only while the card is open: a log view holds one per line -->
			{#snippet content()}
				{@const facts = dateFacts(ms, now)}
				<span class="facts">
					<span class="label">{t('web.dateTime.local')}</span>
					<span class="value">{facts.local}</span>

					<span class="label">{t('web.dateTime.zone')}</span>
					<span class="value">
						{facts.zone} · {facts.offset}
						<span class="note">{facts.zoneName}</span>
					</span>

					<span class="label">{t('web.dateTime.relative')}</span>
					<span class="value">{facts.relative}</span>

					<span class="label">{t('web.dateTime.utc')}</span>
					<span class="value">{facts.utc}</span>

					<span class="label">{t('web.dateTime.iso')}</span>
					<span class="value">
						<CopyValue value={facts.iso} label={t('web.dateTime.iso')} />
						<CopyValue value={facts.isoLocal} label={t('web.dateTime.isoLocal')} />
					</span>

					<span class="label">{t('web.dateTime.unix')}</span>
					<span class="value">
						<CopyValue value={String(facts.unix)} label={t('web.dateTime.unix')} />
					</span>

					<span class="label">{t('web.dateTime.unixMs')}</span>
					<span class="value">
						<CopyValue value={String(facts.unixMs)} label={t('web.dateTime.unixMs')} />
					</span>
				</span>
			{/snippet}
		</InfoPopover>
	</span>
{/if}

<style lang="scss">
	// inline-flex inside InfoPopover; the wrapper only caps it at the cell's width
	.datetime {
		display: inline-flex;
		max-width: 100%;
		min-width: 0;
		vertical-align: bottom;

		&.mono {
			font-family: var(--font-mono);
		}
	}

	.none {
		color: var(--text-secondary);
	}

	// the card's text is body text wherever the trigger sits (a mono cell, a heading)
	.facts {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.375rem 1rem;
		font-family: var(--font);
		white-space: normal;
		text-align: left;
	}

	.label {
		color: var(--text-secondary);
	}

	.value {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		color: var(--text-heading);
		word-break: break-word;
	}

	// an ISO string or a timestamp is read whole; breaking it at a hyphen misreads it
	.value :global(.mono) {
		white-space: nowrap;

		// a phone has no room for the offset form whole; it wraps by character there
		@include below($bp-narrow) {
			white-space: normal;
			word-break: break-all;
		}
	}

	.note {
		color: var(--text-secondary);
		font-size: 0.8125rem;
	}
</style>
