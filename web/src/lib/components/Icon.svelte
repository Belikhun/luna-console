<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/** Font Awesome icon (static/FontAwesome integration: <icon data-icon="…">). */
	let {
		name,
		style = 'solid',
		spin = false,
		size,
		color
	}: {
		name: string;
		style?: 'solid' | 'regular' | 'light' | 'thin';
		spin?: boolean;
		size?: string;
		color?: string;
	} = $props();
</script>

<icon
	data-icon={name}
	class="style-{style}"
	class:spin
	style:font-size={size}
	style:color
></icon>

<style lang="scss">
	icon {
		flex: none;

		// the glyph lives in ::after, so that is what has to rotate
		&.spin::after {
			display: inline-block;
			animation: spin 0.9s linear infinite;
		}
	}
</style>
