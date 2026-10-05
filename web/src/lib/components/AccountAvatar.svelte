<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { avatarUrl, initialsOf, type AvatarSubject } from './accountavatar';
	import PlayerSkin from './PlayerSkin.svelte';

	/**
	 * A console account's picture: the uploaded image, the face of its linked
	 * Minecraft skin, or its initials on a tinted disc. Always the given size, so a
	 * row of them lines up whatever each one is. Photos and initials are round; a
	 * skin face is drawn by `PlayerSkin`, exactly as the player screens draw it,
	 * and stays square, since a circle cuts the corners off its pixel art.
	 */
	let { account, size = '1.5rem' }: { account: AvatarSubject; size?: string } = $props();

	/** canvas pixels per skin texel; the canvas is then scaled to the avatar's size */
	const SKIN_PX = 8;

	let failed = $state(false);

	const url = $derived(avatarUrl(account));

	// a different picture deserves a fresh attempt, even after the last one failed
	$effect(() => {
		void url;
		failed = false;
	});
</script>

{#if account.avatar?.source === 'minecraft'}
	<span class="avatar skin" style:--size={size}>
		<PlayerSkin player={account.avatar.uuid} view="face" px={SKIN_PX} />
	</span>
{:else if url && !failed}
	<img
		class="avatar"
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

		&.skin {
			border-radius: 0;

			// PlayerSkin sizes its canvas in device pixels; the avatar decides the size shown
			:global(canvas),
			:global(.fallback) {
				width: 100% !important;
				height: 100% !important;
				border-radius: 0;
			}
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
