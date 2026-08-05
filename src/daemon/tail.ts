/**
 * Follow one log file line by line; the daemon's half of a live console.
 * `tail -F` rather than `-f`: the server rotates latest.log, and tail has to
 * follow the new file by name instead of holding the old descriptor open.
 * Used directly by the local SSE console and, on a follower, to feed console
 * frames back over the cluster link.
 */

export interface TailHandle {
	stop(): void;
}

/**
 * Start tailing. Every complete line reaches `onLine`; `onEnd` fires once when
 * the tail process exits (the file's directory vanished, or `stop` was
 * called). Stopping twice is safe.
 */
export function tailFollow(
	path: string,
	lines: number,
	onLine: (line: string) => void,
	onEnd?: () => void,
): TailHandle {
	const proc = Bun.spawn(["tail", "-n", String(lines), "-F", path], {
		stdout: "pipe",
		stderr: "ignore",
	});

	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	let stopped = false;
	let remainder = "";

	void (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					break;
				}

				const text = remainder + new TextDecoder().decode(value);
				const parts = text.split("\n");

				remainder = parts.pop() ?? "";

				for (const line of parts) {
					if (line.length > 0) {
						onLine(line);
					}
				}
			}
		} catch {
			// the reader was torn down mid-read by stop()
		}

		if (!stopped) {
			stopped = true;
			onEnd?.();
		}
	})();

	return {
		stop() {
			if (stopped) {
				return;
			}

			stopped = true;
			proc.kill();
		},
	};
}
