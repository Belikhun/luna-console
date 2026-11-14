<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import Icon from './Icon.svelte';
	import InfoPopover from './InfoPopover.svelte';
	import { stateStyle, type StatusDetailRow } from './statusbadge';

	/**
	 * State indicator: coloured icon + label. When `detail` is given the label
	 * becomes a popover trigger; dashed underline in body colour, per the
	 * console convention that a solid underline means "navigates" and a dashed
	 * one means "reveals more about this value".
	 */
	// the row shape lives in statusbadge.ts beside the state map; re-exported here
	// for the screens that import it from this component
	export type { StatusDetailRow };

	// `state` is renamed on the way in: leaving it in scope would shadow the
	// $state rune for the whole component.
	let {
		state: kind,
		label,
		detail
	}: {
		state: string;
		label?: string;
		/**
		 * Explanation revealed in a popover on click. Strings render as plain
		 * rows; StatusDetailRow entries get a state-coloured icon, a bold name
		 * and a secondary detail line; used for per-check breakdowns.
		 */
		detail?: string | Array<string | StatusDetailRow>;
	} = $props();

	const style = $derived(stateStyle(kind));
	const text = $derived(label ?? kind.charAt(0).toUpperCase() + kind.slice(1));
</script>

<span class="badge" style="color: {style.color}">
	<Icon name={style.icon} spin={style.spin ?? false} size="1rem" />
	{#if detail}
		<InfoPopover {detail}>{text}</InfoPopover>
	{:else}
		{text}
	{/if}
</span>

<style lang="scss">
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		line-height: 1.25rem;
		font-size: 0.875rem;
		white-space: nowrap;
	}
</style>
