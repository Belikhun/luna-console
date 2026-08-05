<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { api, post } from '$lib/api';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import Icon from '$lib/components/Icon.svelte';

	/** how much scrollback the view keeps before dropping the oldest lines */
	const MAX_LINES = 1500;

	/** the status badge is polled, since the log stream says nothing about state */
	const STATE_POLL_MS = 5000;

	const name = $derived(page.params.name);

	let lines: string[] = $state([]);
	let cmd = $state('');
	let connected = $state(false);
	let inst: any = $state(null);
	let view: HTMLDivElement | undefined = $state();
	let autoscroll = $state(true);
	let history: string[] = [];
	let histIdx = -1;

	onMount(() => {
		void api(`/instances/${name}`).then((loaded) => (inst = loaded));

		const stream = new EventSource(`/api/instances/${name}/console`);

		stream.onmessage = (event) => {
			lines = [...lines.slice(-MAX_LINES), JSON.parse(event.data)];

			if (autoscroll) {
				queueMicrotask(() => view?.scrollTo({ top: view.scrollHeight }));
			}
		};

		stream.onopen = () => (connected = true);
		stream.onerror = () => (connected = false);

		const poll = setInterval(() => {
			api(`/instances/${name}`)
				.then((loaded) => (inst = loaded))
				.catch(() => {
					// the badge just keeps its last value
				});
		}, STATE_POLL_MS);

		return () => {
			stream.close();
			clearInterval(poll);
		};
	});

	async function send(): Promise<void> {
		const command = cmd.trim();

		if (!command) {
			return;
		}

		history.push(command);
		histIdx = -1;
		cmd = '';

		try {
			await post(`/instances/${name}/console`, { command });
		} catch (err) {
			lines = [...lines, `[console] error: ${(err as Error).message}`];
		}
	}

	/** Walk back through the command history. */
	function historyBack(): void {
		if (histIdx === -1) {
			histIdx = history.length - 1;
		} else if (histIdx > 0) {
			histIdx--;
		}

		cmd = history[histIdx] ?? cmd;
	}

	/** Walk forward, clearing the line once past the newest entry. */
	function historyForward(): void {
		if (histIdx < 0) {
			return;
		}

		histIdx++;

		if (histIdx >= history.length) {
			cmd = '';
			histIdx = -1;

			return;
		}

		cmd = history[histIdx]!;
	}

	function onKey(event: KeyboardEvent): void {
		if (event.key === 'Enter') {
			void send();

			return;
		}

		if (event.key === 'ArrowUp') {
			historyBack();
			event.preventDefault();

			return;
		}

		if (event.key === 'ArrowDown') {
			historyForward();
			event.preventDefault();
		}
	}

	/**
	 * Tint the log severities Paper prints. The text is escaped here because the
	 * result is rendered with {@html …}, which is the only way to colour a run of
	 * plain log output.
	 */
	function colorize(line: string): string {
		const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;');

		if (/\/(ERROR|FATAL)\]|Exception|\tat /.test(line)) {
			return `<span style="color:#f56b6b">${escaped}</span>`;
		}

		if (/\/WARN\]/.test(line)) {
			return `<span style="color:#e5c14e">${escaped}</span>`;
		}

		return escaped;
	}

	const canSend = $derived(inst && (inst.state === 'running' || inst.state === 'starting'));

	const placeholder = $derived(
		canSend
			? 'Type a server command (e.g. list, say hello); Enter to send'
			: 'instance is stopped'
	);
</script>

<svelte:head><title>{name} console | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.instanceConsole.serialConsole')}
	description="Live console for {name}; streamed from logs/latest.log, input sent via the screen session"
>
	{#snippet extra()}
		{#if inst}<StatusBadge state={inst.state} />{/if}
	{/snippet}
	{#snippet actions()}
		<label class="autoscroll">
			<Checkbox
				checked={autoscroll}
				label={t('web.instanceConsole.autoscroll')}
				onchange={(value) => (autoscroll = value)}
			/>
			Autoscroll
		</label>
		<Btn href="/instances/{name}">{t('web.instanceConsole.backToInstance')}</Btn>
	{/snippet}
</PageHeader>

<div class="console">
	<div class="chd">
		<span class="src">
			<Icon name="file" size="0.75rem" style="light" />
			<span class="mono dim">{name}/logs/latest.log</span>
		</span>
		<StatusBadge
			state={connected ? 'ok' : 'failed'}
			label={connected ? 'Streaming' : 'Disconnected'}
		/>
	</div>
	<div class="view mono" bind:this={view}>
		{#each lines as line}
			<div class="ln">{@html colorize(line)}</div>
		{/each}
	</div>
	<div class="inputrow">
		<span class="prompt mono">&gt;</span>
		<input
			class="cmdinput mono"
			{placeholder}
			disabled={!canSend}
			bind:value={cmd}
			onkeydown={onKey}
		/>
		<Btn onclick={send} disabled={!cmd.trim() || !canSend}>{t('web.instanceConsole.send')}</Btn>
	</div>
</div>

<style lang="scss">
	.autoscroll {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		font-size: 0.875rem;
	}

	.console {
		display: flex;
		flex-direction: column;

		// fills the viewport below the console chrome, with a floor for short windows
		height: calc(100vh - 16.25rem);
		min-height: 20rem;
		background: var(--bg-panel);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
		overflow: hidden;
	}

	.chd {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 1rem;
		border-bottom: 0.1rem solid var(--border-divider);
	}

	.src {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.view {
		flex: 1;
		overflow-y: auto;
		background: var(--bg-terminal);
		padding: 0.625rem 0.875rem;
		font-size: 0.75rem;
		line-height: 1.5;
	}

	.ln {
		white-space: pre-wrap;
		word-break: break-all;
	}

	.inputrow {
		display: flex;
		gap: 0.625rem;
		align-items: center;
		padding: 0.5rem 0.75rem;
		border-top: 0.1rem solid var(--border-divider);
	}

	.prompt {
		color: var(--primary);
		font-weight: 700;
	}

	.cmdinput {
		flex: 1;
		background: var(--bg-input);
		border: 0.125rem solid var(--border-input);
		border-radius: var(--radius-input);
		color: var(--text);
		padding: 0.25rem 0.75rem;
		outline: none;

		&:focus {
			border-color: var(--link);
		}

		&:disabled {
			color: var(--text-disabled);
		}
	}
</style>
