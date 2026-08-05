<script lang="ts">
	import { onMount, untrack } from 'svelte';

	import type { EditorSelection } from './codeeditor';
	import { languageFor } from './codeeditor';
	import Spinner from './Spinner.svelte';

	/**
	 * Monaco, wrapped as one component. Monaco is loaded on mount and only in the
	 * browser (`$lib/monaco` touches `self` at import time), so the editor is a
	 * placeholder for the moment it takes to arrive.
	 *
	 * `value` is bindable and is the single source of truth: an edit inside Monaco
	 * writes it back, and a change from outside (loading another file) replaces the
	 * model's text without losing the undo stack of the file being replaced —
	 * Monaco keeps one model per path for exactly that reason.
	 */
	let {
		value = $bindable(''),
		path,
		readOnly = false,
		height = '32rem',
		onselect,
		onsave
	}: {
		value: string;
		/** File path — decides syntax highlighting and keys Monaco's model */
		path: string;
		readOnly?: boolean;
		height?: string;
		/** Fires as the selection moves, for a placeholder flow to read */
		onselect?: (selection: EditorSelection) => void;
		/** Ctrl/Cmd+S inside the editor */
		onsave?: () => void;
	} = $props();

	let host: HTMLDivElement | undefined = $state();
	let loading = $state(true);
	let failed = $state('');

	/**
	 * Monaco's own objects. They are deliberately *not* `$state`: they are large,
	 * cyclic and mutated constantly by the editor itself, and proxying them would
	 * both cost and confuse Monaco's internal identity checks.
	 */
	let editor: import('$lib/monaco').StandaloneEditor | undefined;
	let monaco: import('$lib/monaco').Monaco | undefined;

	/** Guard against the model-change handler writing back what it just received. */
	let applying = false;

	onMount(() => {
		let disposed = false;

		void (async () => {
			try {
				const loaded = await import('$lib/monaco');

				monaco = await loaded.loadMonaco();

				if (disposed || !host) {
					return;
				}

				editor = monaco.editor.create(host, {
					value: untrack(() => value),
					language: languageFor(path),
					theme: loaded.LUNA_THEME,
					readOnly,
					automaticLayout: true,
					fontSize: 13,
					fontFamily: 'JetBrains Mono, Fira Code, Menlo, Consolas, monospace',
					fontLigatures: false,
					lineNumbersMinChars: 3,
					minimap: { enabled: false },
					scrollBeyondLastLine: false,
					renderWhitespace: 'selection',
					// a config file's indentation is load-bearing (yaml), so tabs are
					// shown as what they are and never silently converted
					renderControlCharacters: true,
					tabSize: 2,
					insertSpaces: true,
					smoothScrolling: true,
					padding: { top: 8, bottom: 8 },
					scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
				});

				editor.onDidChangeModelContent(() => {
					if (applying) {
						return;
					}

					value = editor?.getValue() ?? '';
				});

				editor.onDidChangeCursorSelection(() => {
					if (!onselect || !editor) {
						return;
					}

					const selection = editor.getSelection();
					const model = editor.getModel();

					if (!selection || !model) {
						return;
					}

					onselect({
						text: model.getValueInRange(selection),
						line: selection.startLineNumber,
						offset: model.getOffsetAt(selection.getStartPosition())
					});
				});

				// Monaco swallows the browser's own Ctrl+S, so the page's save has to
				// be re-bound inside it or the shortcut simply stops working in focus
				editor.addCommand(
					// KeyMod.CtrlCmd | KeyCode.KeyS
					monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
					() => onsave?.()
				);

				loading = false;
			} catch (err) {
				failed = (err as Error).message;
				loading = false;
			}
		})();

		return () => {
			disposed = true;
			editor?.getModel()?.dispose();
			editor?.dispose();
			editor = undefined;
		};
	});

	// an outside change (another file opened, a template reloaded) replaces the
	// text; an edit the editor itself made is already in `value` and would only
	// bounce the cursor to the top if written back
	$effect(() => {
		const next = value;

		if (!editor || editor.getValue() === next) {
			return;
		}

		applying = true;
		editor.setValue(next);
		applying = false;
	});

	$effect(() => {
		const language = languageFor(path);
		const model = editor?.getModel();

		if (monaco && model) {
			monaco.editor.setModelLanguage(model, language);
		}
	});

	$effect(() => {
		editor?.updateOptions({ readOnly });
	});

	/** Insert text at the cursor, replacing the selection. Used by the placeholder flow. */
	export function replaceSelection(text: string): void {
		const selection = editor?.getSelection();

		if (!editor || !selection) {
			return;
		}

		editor.executeEdits('luna', [{ range: selection, text, forceMoveMarkers: true }]);
		editor.focus();
	}

	/** Give the editor keyboard focus. */
	export function focus(): void {
		editor?.focus();
	}
</script>

<div class="wrap" style:height>
	<div class="host" bind:this={host}></div>
	{#if loading || failed}
		<div class="overlay">
			{#if failed}
				<span class="err">The editor could not load: {failed}</span>
			{:else}
				<Spinner />
				<span class="dim">Loading the editor…</span>
			{/if}
		</div>
	{/if}
</div>

<style lang="scss">
	.wrap {
		position: relative;
		background: var(--bg-terminal);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
		overflow: hidden;

		// `height: 100%` alone cannot shrink inside a flex column, so a caller that
		// hands the editor the remaining space gets these too; both are inert when
		// the wrapper is a plain block with a fixed height
		flex: 1;
		min-height: 0;
	}

	.host {
		width: 100%;
		height: 100%;
	}

	.overlay {
		position: absolute;
		inset: 0;

		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.625rem;

		background: var(--bg-terminal);
		font-size: 0.8125rem;
	}
</style>
