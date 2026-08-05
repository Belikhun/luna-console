<script lang="ts">
	import type { ProgressSnapshot } from '$core/progress';
	import { flattenProgress } from '$lib/jobs';
	import ProgressBar from './ProgressBar.svelte';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	/**
	 * Live view of a ProgressReporter tree: one row per step, indented by depth,
	 * each with its own bar and its last message. This is the console's half of the
	 * long-running-task pattern; the CLI renders the same tree in the terminal.
	 *
	 * `state` is the job's, not a node's: it decides whether a step that is still
	 * short of 100% is waiting its turn or was abandoned when the job failed.
	 */
	let {
		root,
		state = 'running'
	}: {
		root: ProgressSnapshot | null | undefined;
		state?: 'running' | 'done' | 'failed';
	} = $props();

	const rows = $derived(flattenProgress(root));

	const ICONS: Record<string, string> = {
		okay: 'circleCheck',
		warn: 'triangleExclamation',
		error: 'circleXMark'
	};

	/**
	 * How a row reads: its own warning or failure outranks being finished, so a step
	 * that completed with a problem never shows a plain tick.
	 */
	function tone(node: ProgressSnapshot): 'okay' | 'warn' | 'error' | 'running' | 'idle' {
		if (node.status === 'error') {
			return 'error';
		}

		if (node.status === 'warn') {
			return 'warn';
		}

		if (node.done) {
			return 'okay';
		}

		// nothing reported yet and the job is over: this step never ran
		if (state !== 'running' && node.progress === 0) {
			return 'idle';
		}

		return state === 'running' ? 'running' : 'idle';
	}
</script>

<div class="tree">
	{#each rows as node (node.id)}
		{@const kind = tone(node)}
		{@const indent = `${(node.level - 1) * 1.25}rem`}
		<div class="row" data-tone={kind}>
			<span class="glyph" style:margin-left={indent}>
				{#if kind === 'running'}
					<Spinner size="0.875rem" />
				{:else if kind === 'idle'}
					<Icon name="circle" size="0.875rem" style="light" />
				{:else}
					<Icon name={ICONS[kind] ?? 'circle'} size="0.875rem" />
				{/if}
			</span>
			<!-- the name column absorbs the indent, so every bar starts at the same x -->
			<span class="name" style:width="calc(13rem - {indent})">{node.name}</span>
			<ProgressBar
				compact
				value={node.progress}
				max={1}
				transition={false}
				color={kind === 'error' ? 'danger' : kind === 'warn' ? 'warning' : kind === 'okay' ? 'success' : 'accent'}
				right="{Math.round(node.progress * 100)}%"
				width="11rem"
			/>
			<span class="msg">{node.message ?? ''}</span>
		</div>
	{/each}
</div>

<style lang="scss">
	.tree {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		font-size: 0.8125rem;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.625rem;

		&[data-tone='okay'] .glyph {
			color: var(--success);
		}

		&[data-tone='warn'] .glyph {
			color: var(--warning);
		}

		&[data-tone='error'] .glyph {
			color: var(--error);
		}

		&[data-tone='running'] .glyph {
			color: var(--link);
		}

		&[data-tone='idle'] {
			color: var(--text-disabled);

			.glyph {
				color: var(--text-disabled);
			}
		}
	}

	.glyph {
		display: inline-flex;
		flex: none;
		width: 0.875rem;
	}

	.name {
		flex: none;
		font-weight: 700;
		color: var(--text-heading);

		@include ellipsis;
	}

	.row[data-tone='idle'] .name {
		color: var(--text-disabled);
		font-weight: 400;
	}

	.msg {
		@include ellipsis;

		flex: 1;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}
</style>
