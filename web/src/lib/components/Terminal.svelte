<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * Drawer terminal running the luna CLI.
	 * Line editing + history + Tab completion + inline ghost suggestion,
	 * backed by /api/shell/complete (the CLI's own completion engine) and
	 * /api/shell/exec (SSE-streamed CLI output with ANSI colors).
	 */
	import { onMount } from 'svelte';
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';
	import { post } from '$lib/api';

	let { user = 'root' }: { user?: string } = $props();

	/**
	 * `user@luna >>> `, matching the prompt the real REPL draws (`cli/actor.ts`).
	 * The drawer runs the same binary as a shell does, and the commands it sends are
	 * attributed to the signed-in account rather than to `root`, so the prompt has
	 * to say which of the two is typing.
	 */
	const PROMPT = $derived(`\x1b[38;5;135m${user}@luna\x1b[0m \x1b[90m>>>\x1b[0m `);

	const GHOST_DEBOUNCE_MS = 60;
	const HISTORY_KEY = 'luna.shell.history';
	const HISTORY_MAX = 200;

	/** Tab-completion listing: column width and the spacing between columns. */
	const LIST_COL_W = 28;
	const LIST_PAD = 26;

	let host: HTMLDivElement;
	let term: Terminal;
	let fit: FitAddon;

	let line = '';
	let cursor = 0; // index within line
	let ghost = ''; // inline suggestion suffix
	let history: string[] = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
	let histIdx = -1;
	let histStash = '';
	let running: EventSource | null = null;
	let completeTimer: ReturnType<typeof setTimeout> | undefined;

	/** guards against a slow completion response overwriting a newer keystroke */
	let ghostSeq = 0;

	/** Split the line the way the CLI does, with a trailing empty word after space. */
	function words(input: string): string[] {
		const out =
			input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((word) => word.replace(/^"|"$/g, '')) ?? [];

		if (input === '' || /\s$/.test(input)) {
			out.push('');
		}

		return out;
	}

	function redraw(): void {
		// clear line, print prompt + line + ghost, reposition cursor
		const tail = ghost ? `\x1b[90m${ghost}\x1b[0m` : '';

		term.write(`\r\x1b[2K${PROMPT}${line}${tail}`);

		const back = line.length - cursor + ghost.length;

		if (back > 0) {
			term.write(`\x1b[${back}D`);
		}
	}

	/**
	 * The suggestion is dropped synchronously by the caller before the redraw, so
	 * a stale ghost never lingers next to freshly typed text; this only fills the
	 * new one in once the completion round-trip lands. Late replies are discarded
	 * by sequence number.
	 */
	async function refreshGhost(): Promise<void> {
		clearTimeout(completeTimer);

		const seq = ++ghostSeq;

		completeTimer = setTimeout(async () => {
			if (!line || cursor !== line.length || running) {
				return;
			}

			const snapshot = line;
			let next = '';

			try {
				const typed = words(line);
				const { completions } = await post('/shell/complete', { words: typed });
				const cur = typed[typed.length - 1] ?? '';

				// a flag is never suggested inline; it would fight with typing a value
				const hit = completions.find(
					(candidate: string) =>
						candidate.startsWith(cur) && candidate !== cur && !candidate.startsWith('--')
				);

				next = hit && cur ? hit.slice(cur.length) : '';
			} catch {
				next = '';
			}

			if (seq !== ghostSeq || line !== snapshot || ghost === next) {
				return;
			}

			ghost = next;
			redraw();
		}, GHOST_DEBOUNCE_MS);
	}

	/** Longest prefix shared by every candidate. */
	function commonPrefix(hits: string[]): string {
		let prefix = hits[0] ?? '';

		for (const hit of hits) {
			let i = 0;

			while (i < prefix.length && prefix[i] === hit[i]) {
				i++;
			}

			prefix = prefix.slice(0, i);
		}

		return prefix;
	}

	/** Print the candidate list in as many columns as the terminal is wide. */
	function writeCandidates(hits: string[]): void {
		term.write('\r\n');

		const cols = Math.max(1, Math.floor((term.cols || 80) / LIST_COL_W));

		for (let i = 0; i < hits.length; i += cols) {
			const row = hits
				.slice(i, i + cols)
				.map((hit) => hit.padEnd(LIST_PAD))
				.join(' ');

			term.writeln(row);
		}
	}

	async function tabComplete(): Promise<void> {
		const typed = words(line);
		const cur = typed[typed.length - 1] ?? '';

		try {
			const { completions } = await post('/shell/complete', { words: typed });
			const hits = completions.filter((candidate: string) => candidate.startsWith(cur));

			if (hits.length === 0) {
				return;
			}

			if (hits.length === 1) {
				line = line.slice(0, line.length - cur.length) + hits[0] + ' ';
				cursor = line.length;
				ghost = '';
				redraw();

				return;
			}

			const prefix = commonPrefix(hits);

			if (prefix.length > cur.length) {
				line = line.slice(0, line.length - cur.length) + prefix;
				cursor = line.length;
			}

			writeCandidates(hits);
			redraw();
		} catch {
			// the completion endpoint is unreachable; leave the line untouched
		}
	}

	/** Remember a command, capped at HISTORY_MAX entries. */
	function remember(cmd: string): void {
		history.push(cmd);

		if (history.length > HISTORY_MAX) {
			history = history.slice(-HISTORY_MAX);
		}

		localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
	}

	function runCommand(cmd: string): void {
		const argv = words(cmd).filter(Boolean);

		if (argv.length === 0) {
			prompt();

			return;
		}

		if (argv[0] === 'clear') {
			term.clear();
			prompt();

			return;
		}

		if (argv[0] === 'exit') {
			term.writeln('\x1b[90m(this shell has no exit; close the drawer instead)\x1b[0m');
			prompt();

			return;
		}

		remember(cmd);

		const query = encodeURIComponent(JSON.stringify(argv));
		const stream = new EventSource(`/api/shell/exec?argv=${query}`);

		running = stream;

		stream.addEventListener('data', (event) => {
			// the CLI emits bare \n; a terminal needs the carriage return too
			term.write(JSON.parse((event as MessageEvent).data).replace(/\n/g, '\r\n'));
		});

		stream.addEventListener('exit', (event) => {
			const { code } = JSON.parse((event as MessageEvent).data);

			stream.close();
			running = null;

			if (code !== 0) {
				term.writeln(`\x1b[90m(exit ${code})\x1b[0m`);
			}

			prompt();
		});

		stream.onerror = () => {
			if (running !== stream) {
				return;
			}

			stream.close();
			running = null;
			term.writeln('\x1b[31mconnection lost\x1b[0m');
			prompt();
		};
	}

	function prompt(): void {
		line = '';
		cursor = 0;
		ghost = '';
		histIdx = -1;
		term.write(`\r\n${PROMPT}`);
	}

	/**
	 * Index of the last byte of the escape sequence starting at `start`. CSI
	 * (`ESC [`) and SS3 (`ESC O`) run until a byte in `@`-`~`; anything else is a
	 * two-byte sequence.
	 */
	function endOfEscape(data: string, start: number): number {
		const kind = data[start + 1];

		if (kind !== '[' && kind !== 'O') {
			return start + 1;
		}

		for (let i = start + 2; i < data.length; i++) {
			const code = data.charCodeAt(i);

			if (code >= 0x40 && code <= 0x7e) {
				return i;
			}
		}

		return data.length - 1;
	}

	/** Accept the current suggestion into the line. */
	function acceptGhost(): void {
		line += ghost;
		cursor = line.length;
		ghost = '';
		redraw();
	}

	function onData(data: string): void {
		if (running) {
			// Ctrl+C cancels the stream
			if (data === '\x03') {
				running.close();
				running = null;
				term.writeln('\r\n\x1b[31m^C\x1b[0m');
				prompt();
			}

			return;
		}

		for (let i = 0; i < data.length; i++) {
			const ch = data[i]!;

			if (ch === '\x1b') {
				// Arrows/Home/End arrive here as full escape sequences *and* through
				// onKey. Swallow the whole sequence; letting its bytes fall through
				// to the printable branch is what typed "[A" into the line.
				i = endOfEscape(data, i);

				continue;
			}

			if (ch === '\r') {
				term.write('\r\n');

				const cmd = line.trim();

				line = '';
				cursor = 0;
				ghost = '';

				if (cmd) {
					runCommand(cmd);
				} else {
					term.write(PROMPT);
				}

				return;
			}

			if (ch === '\x7f') {
				if (cursor > 0) {
					line = line.slice(0, cursor - 1) + line.slice(cursor);
					cursor--;
				}

				ghost = '';

				continue;
			}

			if (ch === '\t') {
				if (ghost) {
					acceptGhost();
				} else {
					void tabComplete();
				}

				return;
			}

			if (ch === '\x03') {
				term.write('^C');
				prompt();

				return;
			}

			if (ch >= ' ') {
				// Typing the next character of the suggestion just consumes it, so the
				// ghost tracks the keystroke instead of blinking out until the next
				// completion round-trip lands.
				const atEnd = cursor === line.length;

				line = line.slice(0, cursor) + ch + line.slice(cursor);
				cursor++;
				ghost = atEnd && ghost.startsWith(ch) ? ghost.slice(1) : '';
			}
		}

		redraw();
		void refreshGhost();
	}

	/** Walk back through history, stashing the half-typed line on the first step. */
	function historyBack(): void {
		if (history.length === 0) {
			return;
		}

		if (histIdx === -1) {
			histStash = line;
			histIdx = history.length - 1;
		} else if (histIdx > 0) {
			histIdx--;
		}

		line = history[histIdx] ?? '';
		cursor = line.length;
		ghost = '';
		redraw();
	}

	/** Walk forward, restoring the stashed line once past the newest entry. */
	function historyForward(): void {
		if (histIdx === -1) {
			return;
		}

		histIdx++;

		if (histIdx >= history.length) {
			histIdx = -1;
			line = histStash;
		} else {
			line = history[histIdx] ?? '';
		}

		cursor = line.length;
		ghost = '';
		redraw();
	}

	function onKey(event: { domEvent: KeyboardEvent }): void {
		if (running) {
			return;
		}

		const key = event.domEvent.key;

		if (key === 'ArrowLeft') {
			if (cursor > 0) {
				cursor--;
				redraw();
			}

			return;
		}

		if (key === 'ArrowRight') {
			if (cursor < line.length) {
				cursor++;
				redraw();
			} else if (ghost) {
				acceptGhost();
			}

			return;
		}

		if (key === 'ArrowUp') {
			historyBack();

			return;
		}

		if (key === 'ArrowDown') {
			historyForward();

			return;
		}

		if (key === 'Home') {
			cursor = 0;
			redraw();

			return;
		}

		if (key === 'End') {
			cursor = line.length;
			redraw();
		}
	}

	let cleanup: (() => void) | undefined;

	onMount(() => {
		void init();

		return () => cleanup?.();
	});

	async function init(): Promise<void> {
		const [{ Terminal }, { FitAddon }] = await Promise.all([
			import('@xterm/xterm'),
			import('@xterm/addon-fit')
		]);

		await import('@xterm/xterm/css/xterm.css');

		term = new Terminal({
			fontFamily: "'JetBrains Mono', Menlo, Consolas, monospace",
			fontSize: 13,
			cursorBlink: true,

			// the console's own palette, so CLI output matches the surrounding page
			theme: {
				background: '#0b0f14',
				foreground: '#d1d5db',
				cursor: '#ff9900',
				selectionBackground: '#264f78',
				black: '#0b0f14',
				red: '#f56b6b',
				green: '#2bb534',
				yellow: '#e5c14e',
				blue: '#42b4ff',
				magenta: '#bf7edb',
				cyan: '#44b9d6',
				white: '#d1d5db',
				brightBlack: '#5f6b7a',
				brightRed: '#ff8a8a',
				brightGreen: '#5fd068',
				brightYellow: '#f0d573',
				brightBlue: '#89bdee',
				brightMagenta: '#d8a9ea',
				brightCyan: '#7fd6ec',
				brightWhite: '#f0f1f3'
			}
		});

		fit = new FitAddon();

		term.loadAddon(fit);
		term.open(host);
		fit.fit();
		term.onData(onData);
		term.onKey(onKey);

		const observer = new ResizeObserver(() => {
			try {
				fit.fit();
			} catch {
				// the drawer is mid-animation and has no usable size yet
			}
		});

		observer.observe(host);

		term.writeln('\x1b[1m\x1b[38;5;135mluna\x1b[0m cluster shell; the CLI, in your browser.');
		term.writeln(
			'\x1b[90mTab to complete · ghost text = suggestion (→ to accept) · ↑↓ history · ' +
				'Ctrl+C cancel · try "help"\x1b[0m'
		);
		term.write(PROMPT);
		term.focus();

		cleanup = () => {
			observer.disconnect();
			running?.close();
			term.dispose();
		};
	}
</script>

<div class="term" bind:this={host}></div>

<style lang="scss">
	.term {
		width: 100%;
		height: 100%;
		background: var(--bg-terminal);
		padding: 0.375rem 0.5rem 0.125rem;

		// xterm renders its own DOM inside, so it is out of this component's scope
		:global(.xterm) {
			height: 100%;
		}
	}
</style>
