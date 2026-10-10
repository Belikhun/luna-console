<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { fmtBytes, fmtDateTime } from '$lib/format';
	import { downloadUrl, fileIconOf, previewable, triggerDownload, type FileKind } from '$lib/files';
	import Btn from './Btn.svelte';
	import Icon from './Icon.svelte';

	/**
	 * What the browser can show of a file that is not text: an image, a video,
	 * a sound, a PDF. Everything else gets its facts and a download button, so
	 * opening a jar is never a dead end. The bytes come from the console's own
	 * download route, inline, which honours ranges so a video can seek.
	 */
	let {
		instance,
		path,
		name,
		kind,
		size,
		modified,
		note = ''
	}: {
		instance: string;
		path: string;
		name: string;
		kind: FileKind;
		size: number;
		modified: number;
		/** why the editor did not take it, when that is the reason it is here */
		note?: string;
	} = $props();

	const src = $derived(downloadUrl(instance, path, { inline: true }));
	const canShow = $derived(previewable(kind));

	let failed = $state(false);
	/** a texture-sized image is blown up, or a 16px icon would be a dot in the pane */
	let tiny = $state(false);

	/** Below this many pixels on both sides an image is scaled up to be looked at. */
	const TINY_PX = 256;

	$effect(() => {
		// a new file gets a new chance; the flag belongs to the previous source
		void src;
		failed = false;
		tiny = false;
	});
</script>

<div class="preview" class:media={canShow && !failed}>
	{#if canShow && !failed}
		{#if kind === 'image'}
			<img
				{src}
				alt={name}
				class:tiny
				onerror={() => (failed = true)}
				onload={(event) => {
					const image = event.currentTarget as HTMLImageElement;

					tiny = image.naturalWidth <= TINY_PX && image.naturalHeight <= TINY_PX;
				}}
			/>
		{:else if kind === 'video'}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video {src} controls preload="metadata" onerror={() => (failed = true)}></video>
		{:else if kind === 'audio'}
			<div class="audio">
				<Icon name="fileMusic" size="2.5rem" style="light" />
				<audio {src} controls preload="metadata" onerror={() => (failed = true)}></audio>
			</div>
		{:else if kind === 'pdf'}
			<iframe {src} title={name}></iframe>
		{/if}
	{:else}
		<div class="facts">
			<Icon name={fileIconOf(kind)} size="2.5rem" style="light" />
			<h3 class="mono">{name}</h3>
			<p class="dim">
				{fmtBytes(size)} · {fmtDateTime(modified)}
			</p>
			{#if failed}
				<p class="dim">{t('web.instanceFiles.previewFailed')}</p>
			{:else if note}
				<p class="dim">{note}</p>
			{:else}
				<p class="dim">{t('web.instanceFiles.noPreview')}</p>
			{/if}
			<Btn icon="download" onclick={() => triggerDownload(downloadUrl(instance, path))}>
				{t('web.instanceFiles.download')}
			</Btn>
		</div>
	{/if}
</div>

<style lang="scss">
	.preview {
		display: flex;
		align-items: center;
		justify-content: center;

		flex: 1;
		min-height: 0;
		padding: 1rem;
		overflow: auto;

		// a dark checker tells a transparent PNG apart from the panel behind it
		&.media {
			background-color: var(--bg-body);
			background-image:
				linear-gradient(45deg, var(--bg-panel) 25%, transparent 25%),
				linear-gradient(-45deg, var(--bg-panel) 25%, transparent 25%),
				linear-gradient(45deg, transparent 75%, var(--bg-panel) 75%),
				linear-gradient(-45deg, transparent 75%, var(--bg-panel) 75%);
			background-size: 1.5rem 1.5rem;
			background-position:
				0 0,
				0 0.75rem,
				0.75rem -0.75rem,
				-0.75rem 0;
		}
	}

	img,
	video {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		box-shadow: var(--shadow-panel);
	}

	// pixel art stays crisp when a 16px texture is blown up to fill the pane
	img {
		image-rendering: pixelated;

		// small enough to be a texture: shown at a size a person can read
		&.tiny {
			width: auto;
			height: 50%;
			max-width: 100%;
		}
	}

	iframe {
		width: 100%;
		height: 100%;
		border: none;
		background: white;
	}

	.audio {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;

		audio {
			width: 24rem;
			max-width: 100%;
		}
	}

	.facts {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;

		text-align: center;

		h3 {
			margin: 0;
			font-size: 1rem;
			word-break: break-all;
		}

		p {
			margin: 0;
			max-width: 30rem;
			font-size: 0.8125rem;
		}
	}
</style>
