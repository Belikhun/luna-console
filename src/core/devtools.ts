// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The host's Chromium and a hand-rolled DevTools protocol client: a websocket
 * and numbered commands, rather than a library that would bring its own
 * browser download. Used by the agent's long-lived browser sessions
 * (`browser.ts`).
 */

import { readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { t } from "../shared/i18n";

/** Executables tried, in order, when the config names none. */
const BROWSER_CANDIDATES = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "/snap/bin/chromium"];

/** The executable the daemon config names; set by the daemon runtime, never by core. */
let configuredBrowser: string | null = null;

/** Set by the daemon runtime from its config's `browser`. */
export function setBrowserExecutable(path: string | null): void {
	configuredBrowser = path;
}

/** The browser executable, or null when the host has none. */
export function findBrowser(): string | null {
	const configured = process.env.LUNA_BROWSER?.trim() || configuredBrowser;

	if (configured) {
		return Bun.which(configured) ?? configured;
	}

	for (const candidate of BROWSER_CANDIDATES) {
		const found = Bun.which(candidate);

		if (found) {
			return found;
		}
	}

	return null;
}


export interface CdpMessage {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message: string };
	sessionId?: string;
}

/** One DevTools connection: numbered commands, and listeners for events. */
export class Cdp {
	#socket: WebSocket;
	#next = 1;
	#pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }>();
	#listeners = new Set<(message: CdpMessage) => void>();
	#closed = false;
	#onClose = new Set<() => void>();

	constructor(socket: WebSocket) {
		this.#socket = socket;

		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as CdpMessage;

			if (message.id !== undefined) {
				const waiter = this.#pending.get(message.id);

				this.#pending.delete(message.id);

				if (message.error) {
					waiter?.reject(new Error(message.error.message));
				} else {
					waiter?.resolve(message.result ?? {});
				}

				return;
			}

			for (const listener of this.#listeners) {
				listener(message);
			}
		});

		socket.addEventListener("close", () => {
			this.#closed = true;

			for (const waiter of this.#pending.values()) {
				waiter.reject(new Error("the browser closed the connection"));
			}

			this.#pending.clear();

			for (const notify of this.#onClose) {
				notify();
			}
		});
	}

	static async connect(url: string): Promise<Cdp> {
		const socket = new WebSocket(url);

		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("could not reach the browser's DevTools socket")), { once: true });
		});

		return new Cdp(socket);
	}

	/** Whether the connection is gone (the browser exited or crashed). */
	get closed(): boolean {
		return this.#closed;
	}

	/** Be told once the connection closes. */
	onClose(notify: () => void): void {
		this.#onClose.add(notify);
	}

	send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
		if (this.#closed) {
			return Promise.reject(new Error("the browser closed the connection"));
		}

		const id = this.#next++;

		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	on(listener: (message: CdpMessage) => void): () => void {
		this.#listeners.add(listener);

		return () => this.#listeners.delete(listener);
	}

	/** The first event matching, or null once the time is up. */
	waitFor(match: (message: CdpMessage) => boolean, ms: number): Promise<CdpMessage | null> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				off();
				resolve(null);
			}, ms);

			const off = this.on((message) => {
				if (match(message)) {
					clearTimeout(timer);
					off();
					resolve(message);
				}
			});
		});
	}

	close(): void {
		this.#socket.close();
	}
}

/** Read the DevTools address Chromium prints on stderr as it starts. */
export async function devtoolsAddress(stderr: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;
	let seen = "";

	try {
		while (Date.now() < deadline) {
			const chunk = await Promise.race([
				reader.read(),
				Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null),
			]);

			if (!chunk || chunk.done) {
				break;
			}

			seen += decoder.decode(chunk.value, { stream: true });

			const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);

			if (match) {
				return match[1]!;
			}
		}
	} finally {
		// the rest of stderr is the browser's chatter (dbus refusals under the
		// snap's confinement); drained so the pipe never fills
		reader.releaseLock();
		void stderr.pipeTo(new WritableStream()).catch(() => {});
	}

	const last = seen.trim().split("\n").slice(-3).join(" ").slice(0, 300);

	throw new Error(t("core.browser.browserFailed", { message: last || "no DevTools address" }));
}

/**
 * Whether the browser is the snap's: `/snap/bin/chromium` (a link to the snap
 * launcher) or a wrapper script that execs it, as Ubuntu's `chromium-browser` is.
 */
export function isSnap(browser: string): boolean {
	let real = browser;

	try {
		real = realpathSync(browser);
	} catch {
		return browser.includes("/snap/");
	}

	if (browser.includes("/snap/") || real.includes("/snap/") || basename(real) === "snap") {
		return true;
	}

	try {
		const head = readFileSync(real).subarray(0, 4096).toString("latin1");

		return head.startsWith("#!") && head.includes("/snap/bin/");
	} catch {
		return false;
	}
}

/**
 * Where a session's throwaway profile goes. The snap's Chromium sees a private
 * /tmp of its own, so a profile made in ours would be created again on its side
 * and never cleaned; its own writable folder under the home is shared with us.
 */
export function profileBase(browser: string): string {
	return isSnap(browser)
		? join(homedir(), "snap", "chromium", "common", "luna-browser")
		: tmpdir();
}

/** A number held inside bounds and rounded, or the fallback when absent. */
export function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) {
		return fallback;
	}

	return Math.max(min, Math.min(max, Math.round(value)));
}
