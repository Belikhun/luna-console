<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import type { InfoCell } from './grid';
	import { tooltip, refreshTooltip } from '$lib/tooltip.svelte';
	import { copyText } from '$lib/clipboard';

	/**
	 * vloom ScreenGrid-style info grid: responsive column count
	 * ([desktop, tablet, mobile]), cells divided by right borders, small
	 * secondary labels, copyable values with success feedback.
	 * Custom cell content via the `custom` snippet (matched by cell id).
	 */
	let {
		cells,
		columns = [4, 3, 2],
		custom
	}: {
		cells: InfoCell[];
		/** columns at ≥64rem / ≥40rem / below */
		columns?: [number, number, number] | number;
		custom?: Snippet<[InfoCell]>;
	} = $props();

	const cols = $derived(typeof columns === 'number' ? [columns, columns, columns] : columns);

	/** matches ScreenInfoGrid: the check state lingers for three seconds */
	const COPIED_RESET_MS = 3000;

	let copied: string | null = $state(null);
	let resetTimer: ReturnType<typeof setTimeout> | undefined;

	const keyOf = (cellItem: InfoCell): string => cellItem.id ?? cellItem.label;

	async function copy(cellItem: InfoCell): Promise<void> {
		if (cellItem.value == null) {
			return;
		}

		if (!(await copyText(String(cellItem.value)))) {
			return;
		}

		copied = keyOf(cellItem);

		// the tooltip is already open on the button; re-read its label in place
		refreshTooltip();
		clearTimeout(resetTimer);

		resetTimer = setTimeout(() => {
			copied = null;
			refreshTooltip();
		}, COPIED_RESET_MS);
	}

	/** grid-column for a cell: full row, an explicit span, or one column. */
	function spanOf(cellItem: InfoCell): string | undefined {
		if (cellItem.colSpan === 'all') {
			return '1 / -1';
		}

		return cellItem.colSpan ? `span ${cellItem.colSpan}` : undefined;
	}
</script>

<div
	class="info-grid"
	style:--cols-desktop={cols[0]}
	style:--cols-tablet={cols[1]}
	style:--cols-mobile={cols[2]}
>
	{#each cells as cellItem (cellItem.id ?? cellItem.label)}
		<div class="cell" style:grid-column={spanOf(cellItem)}>
			<div class="header">
				<span class="label">{cellItem.label}</span>
				{#if cellItem.help}
					<span class="help" use:tooltip={{ content: cellItem.help }}>
						<Icon name="circleQuestion" size="0.75em" />
					</span>
				{/if}
			</div>
			<div class="content" data-style={cellItem.style ?? 'default'}>
				{#if cellItem.copyable && cellItem.value != null}
					<button
						class="copy"
						aria-label="Copy {cellItem.label}"
						use:tooltip={{
								content: () => (copied === keyOf(cellItem) ? t('web.common.copied') : t('web.infogrid.clickToCopy'))
							}}
						onclick={() => copy(cellItem)}
					>
						<Icon
							name={copied === keyOf(cellItem) ? 'circleCheck' : 'copy'}
							style="solid"
							size="0.875em"
							color={copied === keyOf(cellItem) ? 'var(--link)' : undefined}
						/>
					</button>
				{/if}
				<span class="display">
					{#if custom && cellItem.id}
						{@render custom(cellItem)}
					{:else if cellItem.value === null || cellItem.value === undefined || cellItem.value === ''}
						<span class="none">–</span>
					{:else if cellItem.href}
						<a href={cellItem.href}>{cellItem.value}</a>
					{:else}
						{cellItem.value}
					{/if}
				</span>
			</div>
		</div>
	{/each}
</div>

<style lang="scss">
	.info-grid {
		--columns: var(--cols-desktop, 4);

		display: grid;
		grid-template-columns: repeat(var(--columns), 1fr);
		gap: 0 1rem;
		overflow: hidden;

		@include below($bp-medium) {
			--columns: var(--cols-tablet, 3);
		}

		@include below($bp-narrow) {
			--columns: var(--cols-mobile, 2);
		}
	}

	.cell {
		border-right: 0.1rem solid var(--border-divider);
		margin-right: -0.1rem;
		padding-right: 1rem;
		padding-bottom: 1rem;
		min-width: 0;
	}

	.header {
		font-size: 0.875rem;
		font-weight: 700;
		color: var(--text-heading);
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.help {
		color: var(--text-secondary);
		display: inline-flex;
	}

	.content {
		display: flex;
		flex-direction: row;
		align-items: baseline;
		gap: 0.5rem;
		margin-top: 0.25rem;
		color: var(--text);

		&[data-style='mono'] .display,
		&[data-style='code'] .display {
			font-family: var(--font-mono);
			font-size: 0.75rem;
		}

		&[data-style='code'] .display {
			background: var(--bg-terminal);
			padding: 0.125rem 0.375rem;
			border-radius: 0.375rem;
			white-space: pre-wrap;
		}

		&[data-style='heading'] .display {
			font-size: 1.5rem;
			font-weight: 700;
			line-height: 1.2;
			color: var(--text-heading);
		}
	}

	// negative margin keeps the glyph on its baseline while the padding gives the
	// 0.875rem icon a hit area worth aiming at
	.copy {
		@include bare-button;

		padding: 0.25rem;
		margin: -0.25rem;
		color: var(--text-secondary);
		display: inline-flex;
		flex: none;
		align-self: center;

		&:hover {
			color: var(--text-heading);
		}
	}

	.display {
		min-width: 0;
		word-break: break-word;
	}

	.none {
		color: var(--text-secondary);
	}
</style>
