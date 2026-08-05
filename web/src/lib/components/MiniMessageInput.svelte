<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * A MiniMessage field: the source, syntax-highlighted, with a toolbar that
	 * inserts tags and a live preview of what the game will draw.
	 *
	 * The source stays the thing being edited. A rich-text surface that serialises
	 * back to MiniMessage would have to decide what to do with the tags it does
	 * not model; hover events, fonts, nested gradients; and the honest answer is
	 * that it would lose them.
	 *
	 * The highlight is a backdrop element behind a transparent textarea, the two
	 * sharing metrics and scroll position exactly.
	 */

	import { t } from '$lib/i18n.svelte';
	import Btn from './Btn.svelte';
	import ColorPicker from './ColorPicker.svelte';
	import Icon from './Icon.svelte';
	import MinecraftText from './MinecraftText.svelte';
	import { KNOWN_PLACEHOLDERS } from '$shared/selector';

	interface Props {
		value: string;
		label?: string;
		hint?: string;
		placeholder?: string;
		/** Values for the preview; without them placeholders stay visible as tokens */
		values?: Record<string, string>;
		/** Offered by the insert menu; defaults to everything the plugin resolves */
		placeholders?: readonly string[];
		/** Lore is upright, chat is not */
		italicDefault?: boolean;
		baseColor?: string;
		multiline?: boolean;
		rows?: number;
		disabled?: boolean;
		onchange: (value: string) => void;
	}

	const {
		value,
		label,
		hint,
		placeholder,
		values,
		placeholders = KNOWN_PLACEHOLDERS,
		italicDefault = true,
		baseColor,
		multiline = false,
		rows = 3,
		disabled = false,
		onchange
	}: Props = $props();

	let input: HTMLTextAreaElement | undefined = $state();
	let backdrop: HTMLDivElement | undefined = $state();
	let insertOpen = $state(false);
	let colorOpen = $state(false);

	/** Split the source into tags, placeholders and plain text, for colouring. */
	const tokens = $derived.by(() => {
		const out: Array<{ text: string; kind: 'tag' | 'placeholder' | 'unknown' | 'text' }> = [];
		const pattern = /<\/?[!#a-zA-Z][^<>]*>|%[a-zA-Z0-9_]+%/g;
		let last = 0;

		for (const match of (value ?? '').matchAll(pattern)) {
			const start = match.index ?? 0;

			if (start > last) {
				out.push({ text: value.slice(last, start), kind: 'text' });
			}

			const text = match[0];

			if (text.startsWith('%')) {
				const name = text.slice(1, -1);
				out.push({ text, kind: KNOWN_PLACEHOLDERS.includes(name) ? 'placeholder' : 'unknown' });
			} else {
				out.push({ text, kind: 'tag' });
			}

			last = start + text.length;
		}

		out.push({ text: (value ?? '').slice(last), kind: 'text' });

		return out;
	});

	function syncScroll(): void {
		if (input && backdrop) {
			backdrop.scrollTop = input.scrollTop;
			backdrop.scrollLeft = input.scrollLeft;
		}
	}

	/** Wrap the selection, or insert at the caret when there is none. */
	function surround(open: string, close: string): void {
		const field = input;

		if (!field || disabled) {
			return;
		}

		const start = field.selectionStart ?? value.length;
		const end = field.selectionEnd ?? start;
		const next = value.slice(0, start) + open + value.slice(start, end) + close + value.slice(end);

		onchange(next);

		// put the caret back around what the author had selected
		queueMicrotask(() => {
			field.focus();
			field.setSelectionRange(start + open.length, end + open.length);
		});
	}

	function insert(text: string): void {
		const field = input;

		if (!field || disabled) {
			return;
		}

		const start = field.selectionStart ?? value.length;
		const end = field.selectionEnd ?? start;
		onchange(value.slice(0, start) + text + value.slice(end));

		queueMicrotask(() => {
			field.focus();
			field.setSelectionRange(start + text.length, start + text.length);
		});
	}
</script>

<div class="field mm-field" class:disabled>
	{#if label}
		<span class="lbl">{label}</span>
	{/if}

	<div class="toolbar">
		<!-- the icon set ships no B/I/U/S glyphs, and the letters read better here anyway -->
		<Btn variant="icon" title={t('web.minimessage.bold')} disabled={disabled} onclick={() => surround('<b>', '</b>')}>
			<span class="glyph bold">B</span>
		</Btn>
		<Btn variant="icon" title={t('web.minimessage.italic')} disabled={disabled} onclick={() => surround('<i>', '</i>')}>
			<span class="glyph italic">I</span>
		</Btn>
		<Btn variant="icon" title={t('web.minimessage.underline')} disabled={disabled} onclick={() => surround('<u>', '</u>')}>
			<span class="glyph underline">U</span>
		</Btn>
		<Btn variant="icon" title={t('web.minimessage.strikethrough')} disabled={disabled} onclick={() => surround('<st>', '</st>')}>
			<span class="glyph strike">S</span>
		</Btn>

		<span class="sep"></span>

		<Btn variant="icon" title={t('web.minimessage.colour')} disabled={disabled} onclick={() => (colorOpen = !colorOpen)}>
			<Icon name="droplet" style="solid" />
		</Btn>
		<Btn
			variant="icon"
			title={t('web.minimessage.gradient')}
			disabled={disabled}
			onclick={() => surround('<gradient:#ff9900:#42b4ff>', '</gradient>')}
		>
			<Icon name="wandMagicSparkles" style="solid" />
		</Btn>

		<span class="sep"></span>

		<Btn variant="icon" title={t('web.minimessage.insertPlaceholder')} disabled={disabled} onclick={() => (insertOpen = !insertOpen)}>
			<Icon name="percent" style="solid" />
		</Btn>
	</div>

	{#if colorOpen}
		<div class="picker">
			<ColorPicker
				label={t('web.minimessage.insertColour')}
				onchange={(hex) => {
					surround(`<color:${hex}>`, '</color>');
					colorOpen = false;
				}}
			/>
		</div>
	{/if}

	{#if insertOpen}
		<div class="placeholders">
			{#each placeholders as name (name)}
				<button
					class="token"
					type="button"
					onclick={() => {
						insert(`%${name}%`);
						insertOpen = false;
					}}>%{name}%</button
				>
			{/each}
		</div>
	{/if}

	<div class="editor">
		<div class="backdrop" bind:this={backdrop} aria-hidden="true">
			{#each tokens as token, index (index)}<span class={token.kind}>{token.text}</span>{/each}<span class="tail"> </span>
		</div>

		<textarea
			bind:this={input}
			class="source"
			rows={multiline ? rows : 1}
			spellcheck="false"
			{placeholder}
			{disabled}
			value={value}
			oninput={(event) => onchange((event.currentTarget as HTMLTextAreaElement).value)}
			onscroll={syncScroll}
		></textarea>
	</div>

	<div class="preview">
		<MinecraftText source={value} {values} {italicDefault} {baseColor} markPlaceholders={!values} knownPlaceholders={KNOWN_PLACEHOLDERS} />
	</div>

	{#if hint}
		<span class="hint">{hint}</span>
	{/if}
</div>

<style lang="scss">
	.mm-field {
		min-width: 0;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		margin-bottom: 0.25rem;
	}

	.glyph {
		font-size: 0.8125rem;
		line-height: 1;

		&.bold {
			font-weight: 700;
		}

		&.italic {
			font-style: italic;
		}

		&.underline {
			text-decoration: underline;
		}

		&.strike {
			text-decoration: line-through;
		}
	}

	.sep {
		width: var(--hairline);
		height: 1rem;
		margin: 0 0.25rem;
		background: var(--border-divider);
	}

	.picker {
		margin-bottom: 0.5rem;
	}

	.placeholders {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		max-height: 8rem;
		overflow-y: auto;
		margin-bottom: 0.5rem;
		padding: 0.5rem;
		border: var(--hairline) solid var(--border-divider);
		border-radius: var(--radius-input);
		background: var(--bg-panel-raised);
	}

	.token {
		@include bare-button;

		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		background: var(--bg-input);
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 0.75rem;

		&:hover {
			background: var(--bg-hover);
			color: var(--text);
		}
	}

	// the highlight and the field must agree on every metric that affects where a
	// glyph lands, or the colours drift away from the characters as you type
	.editor {
		position: relative;
	}

	.backdrop,
	.source {
		padding: 0.25rem 0.5rem;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		border: var(--border-control) solid transparent;
	}

	.backdrop {
		@include fill;

		overflow: hidden;
		border-radius: var(--radius-input);
		background: var(--bg-input);
		pointer-events: none;

		.tag {
			color: #6dd4ff;
		}

		.placeholder {
			color: var(--primary);
		}

		.unknown {
			color: var(--error);
			text-decoration: underline dashed;
		}
	}

	.source {
		position: relative;
		display: block;
		width: 100%;
		min-height: var(--control-h);
		resize: vertical;
		border-color: var(--border-input);
		border-radius: var(--radius-input);
		background: transparent;
		// the text itself is drawn by the backdrop; only the caret shows here
		color: transparent;
		caret-color: var(--text);

		&:focus {
			@include focus-ring;

			border-color: var(--link);
		}

		&::selection {
			background: rgba(66, 180, 255, 0.35);
		}
	}

	.preview {
		margin-top: 0.375rem;
		padding: 0.375rem 0.5rem;
		border-radius: var(--radius-input);
		background: #101014;
		font-size: 0.8125rem;
		min-height: 1.75rem;
	}

	.disabled .preview {
		opacity: 0.6;
	}
</style>
