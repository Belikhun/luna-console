// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';
import { cliBinary, root, INTERACTIVE_COMMANDS } from '$lib/server/luna';
import { SSE_HEADERS, closeQuietly } from '$lib/server/http';

/** Parse and validate the argv query parameter. */
function parseArgv(raw: string | null): string[] {
	let argv: unknown;

	try {
		argv = JSON.parse(raw ?? '[]');
	} catch {
		throw error(400, 'argv must be a JSON string array');
	}

	if (!Array.isArray(argv) || !argv.every((word) => typeof word === 'string')) {
		throw error(400, 'argv must be a JSON string array');
	}

	if (argv.length === 0) {
		throw error(400, 'empty command');
	}

	// commands that attach to a screen session need a real TTY, which SSE is not
	if (INTERACTIVE_COMMANDS.has(argv[0]!)) {
		throw error(400, `"${argv[0]}" is interactive; use the instance Console tab instead`);
	}

	return argv;
}

/**
 * GET ?argv=<json array> → SSE stream of CLI output chunks.
 * Events: data {chunk}, exit {code}. The drawer terminal renders the ANSI output.
 */
export async function GET({ url }) {
	const argv = parseArgv(url.searchParams.get('argv'));

	let proc: ReturnType<typeof Bun.spawn> | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const send = (event: string, data: unknown): void => {
				controller.enqueue(
					encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
				);
			};

			// FORCE_COLOR so picocolors keeps its ANSI codes for xterm.js to render
			proc = Bun.spawn([cliBinary(), ...argv], {
				env: { ...process.env, LUNA_ROOT: root(), FORCE_COLOR: '3', LUNA_WEB: '1' },
				stdout: 'pipe',
				stderr: 'pipe',
				stdin: 'ignore'
			});

			const pump = async (source: ReadableStream<Uint8Array>): Promise<void> => {
				const reader = source.getReader();
				const decoder = new TextDecoder();

				while (true) {
					const { done, value } = await reader.read();

					if (done) {
						break;
					}

					send('data', decoder.decode(value));
				}
			};

			Promise.all([
				pump(proc.stdout as ReadableStream<Uint8Array>),
				pump(proc.stderr as ReadableStream<Uint8Array>)
			])
				.then(async () => {
					send('exit', { code: await proc!.exited });
					closeQuietly(controller);
				})
				.catch(() => closeQuietly(controller));
		},

		cancel() {
			proc?.kill();
		}
	});

	return new Response(stream, { headers: SSE_HEADERS });
}
