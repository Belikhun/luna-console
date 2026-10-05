<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { avatarUrl, initialsOf, type AvatarSubject } from './accountavatar';

	/**
	 * A console account's picture: the uploaded image, the face of its linked
	 * Minecraft skin, or its initials on a tinted disc. Always round, always the
	 * given size, so a row of them lines up whatever each one is.
	 */
	let { account, size = '1.5rem' }: { account: AvatarSubject; size?: string } = $props();

	/** px asked of the renderer; twice a typical 1.5rem so it stays sharp on high-density screens */
	const RENDER_PX = 64;

	let failed = $state(false);

	const url = $derived(avatarUrl(account, RENDER_PX));

	// a different picture deserves a fresh attempt, even after the last one failed
	$effect(() => {
		void url;
		failed = false;
	});
</script>

{#if url && !failed}
	<img
		class="avatar"
		class:pixel={account.avatar?.source === 'minecraft'}
		src={url}
		alt=""
		style:--size={size}
		onerror={() => (failed = true)}
	/>
{:else}
	<span class="avatar initials" style:--size={size} aria-hidden="true">{initialsOf(account)}</span>
{/if}

<style lang="scss">
	.avatar {
		display: inline-grid;
		place-items: center;
		width: var(--size);
		height: var(--size);
		border-radius: 50%;
		object-fit: cover;
		flex: none;

		// a skin face is pixel art and stays crisp scaled; a photo is smoothed
		&.pixel {
			image-rendering: pixelated;
		}
	}

	.initials {
		background: var(--bg-selected);
		border: 0.1rem solid var(--border-input);
		color: var(--text-heading);
		font-size: calc(var(--size) * 0.42);
		font-weight: 700;
		line-height: 1;
		text-transform: uppercase;
	}
</style>
