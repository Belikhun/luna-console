// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Mèo Béo's browser: a headless Chromium on the open web that stays open
 * between tool calls, held by the daemon. Ported from harbor's, which also
 * drives instance previews; luna has only the open-web kind.
 *
 * A session belongs to an account (the owner, from the request's actor) and a
 * holder (the conversation driving it, or an MCP token): one per holder, so
 * two conversations never fight over one page. Each session is a browser
 * process of its own with a throwaway profile, wiped on close.
 *
 * **It reaches the network only through its egress proxy** (`egress.ts`): the
 * browser resolves no names itself (`--host-resolver-rules` maps every name to
 * nothing), so every connection, redirects, WebSockets and frames in other
 * processes included, is a request to the proxy, which resolves the name once,
 * refuses private, reserved and host-local destinations (`netguard.ts`) and
 * dials the address it checked. HTTP sign-in prompts are cancelled, file
 * pickers and JS dialogs dismissed, popups closed (their address is logged),
 * and a session moves at most 256 MB.
 *
 * A download lands in the driving conversation's scratch folder under
 * `downloads/` once it finishes (`deliver`), where the agent reads or unpacks
 * it; a token's session has no scratch folder, so its downloads are refused.
 * One file may be at most `MAX_DOWNLOAD_BYTES`.
 *
 * Sessions close after ten idle minutes, when their owner closes them and at
 * daemon shutdown. A crashed tab or browser is reopened on the last address at
 * the next call, which says so. Nobody watches a session live: the chat shows
 * its tool calls and screenshots.
 */

import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { basename, join, sep } from "node:path";

import { t } from "../shared/i18n";
import { compilePattern, textWindow } from "../shared/textwindow";
import type { TextWindowOptions } from "../shared/textwindow";
import { PAGE_HELPER } from "./browserpage";
import { Cdp, clamp, devtoolsAddress, findBrowser, profileBase } from "./devtools";
import type { CdpMessage } from "./devtools";
import { domainSettings } from "./domains";
import { startEgress } from "./egress";
import type { EgressProxy } from "./egress";
import { resolveEgress, setOwnAddresses } from "./netguard";
import { newId } from "./secrets";

/** Sessions open at once on this machine; each is a browser process. */
export const MAX_BROWSER_SESSIONS = 3;

/** How long a session waits for its next call before it closes. */
export const BROWSER_IDLE_MS = 10 * 60 * 1000;

/** How long one call may take, page loads included. */
const ACTION_TIMEOUT_MS = 45_000;

/** How long a navigation gets to fire `load`. */
const LOAD_TIMEOUT_MS = 15_000;

/** How long the pointer takes to glide to a new position; matches the page helper's transition. */
const GLIDE_MS = 480;

/** Console entries and failed requests a session keeps; older ones fall off. */
const MAX_LOG = 1000;

/** The tallest a full-page capture gets. */
const MAX_PAGE_HEIGHT = 6000;

/** The largest result `eval` returns, as JSON. */
const MAX_EVAL_CHARS = 20_000;

/** What a session may move over its egress proxy, both directions. */
const WEB_MAX_BYTES = 256 * 1024 * 1024;

/** The largest file a download may be; a bigger one is cancelled. */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

/** Where downloads land inside the conversation's scratch folder. */
const DOWNLOADS_FOLDER = "downloads";

export type BrowserDevice = "phone" | "tablet" | "desktop";

/** Viewport presets; the scale stays 1 so pictures stay small for the model. */
const DEVICES: Record<BrowserDevice, { width: number; height: number; mobile: boolean }> = {
	phone: { width: 390, height: 844, mobile: true },
	tablet: { width: 820, height: 1180, mobile: true },
	desktop: { width: 1280, height: 800, mobile: false },
};

/** How a tool names an element: one of these, tried in this order. */
export interface ElementSpec {
	ref?: string;
	selector?: string;
	text?: string;
}

/** One call on an open session. */
export type BrowserAction =
	| { kind: "navigate"; path?: string; action?: "back" | "forward" | "reload" }
	| { kind: "scroll"; element?: ElementSpec; deltaX?: number; deltaY?: number; to?: "top" | "bottom" }
	| { kind: "click"; element?: ElementSpec; point?: { x: number; y: number }; double?: boolean; button?: "left" | "right" | "middle" }
	| { kind: "hover"; element?: ElementSpec; point?: { x: number; y: number } }
	| { kind: "type"; element?: ElementSpec; text: string; clear?: boolean; submit?: boolean }
	| { kind: "press"; element?: ElementSpec; keys: string; repeat?: number }
	| { kind: "select"; element: ElementSpec; values: string[] }
	| { kind: "screenshot"; element?: ElementSpec; fullPage?: boolean }
	| { kind: "eval"; script: string }
	| { kind: "console"; since?: number; level?: "all" | "warning" | "error"; pattern?: string; limit?: number }
	| { kind: "network"; since?: number; limit?: number }
	| { kind: "read"; element?: ElementSpec; mode?: "outline" | "text"; maxChars?: number; window?: TextWindowOptions }
	| { kind: "wait"; selector?: string; text?: string; gone?: boolean; networkIdle?: boolean; download?: boolean; timeoutMs?: number };

export interface BrowserViewport {
	width: number;
	height: number;
	scale: number;
	mobile: boolean;
}

/** A session as its owner lists it. */
export interface BrowserSessionInfo {
	id: string;
	/** The conversation (or `token:<id>`) driving it */
	holder: string;
	url: string;
	title: string;
	openedAt: number;
	lastActionAt: number;
	lastAction: string | null;
}

/** What every call returns besides its own data. */
export interface BrowserState {
	session: string;
	url: string;
	title: string;
	status: number | null;
	viewport: BrowserViewport;
	/** The tab or the browser had crashed and was reopened on the last address */
	recovered?: boolean;
	/** Errors the page logged during this call */
	newErrors?: string[];
	/** Downloads that finished, failed or were refused since the last call said so */
	newDownloads?: BrowserDownload[];
	/** Downloads still running */
	downloading?: number;
}

/** A file the page downloaded, as a call reports it. */
export interface BrowserDownload {
	url: string;
	name: string;
	state: "inProgress" | "completed" | "canceled" | "refused";
	bytes: number;
	total: number | null;
	/** Where it landed, relative to the scratch folder, once completed */
	path?: string;
	error?: string;
}

export interface BrowserResult {
	state: BrowserState;
	data?: unknown;
	image?: { data: string; mime: "image/png" | "image/jpeg"; width: number; height: number };
}

export interface BrowserLogEntry {
	seq: number;
	at: number;
	level: "log" | "info" | "warning" | "error" | "debug";
	/** console, exception (uncaught) or browser (its own messages) */
	source: "console" | "exception" | "browser";
	text: string;
	where?: string;
}

export interface BrowserNetworkEntry {
	seq: number;
	at: number;
	url: string;
	method: string;
	type: string;
	/** An HTTP status of 400 or more, or null when the request failed outright */
	status: number | null;
	error?: string;
	/** Refused by the session's guard or its egress proxy */
	blocked?: boolean;
}

/** A request paused at the Fetch domain, as far as the guard reads it. */
interface PausedRequest {
	requestId: string;
	request: { url: string; method: string };
	resourceType: string;
	frameId?: string;
}

/** `host:port` pairs the browser may reach although they are local; set by the daemon runtime. */
let allowLocal: string[] = [];

/** Set by the daemon runtime from its config's `browserAllowLocal` (a stand-in page server). */
export function setBrowserAllowLocal(pairs: string[]): void {
	allowLocal = pairs;
}

const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

/** Keys a tool can press by name, with what DevTools needs to type them. */
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
	enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	escape: { key: "Escape", code: "Escape", keyCode: 27 },
	esc: { key: "Escape", code: "Escape", keyCode: 27 },
	tab: { key: "Tab", code: "Tab", keyCode: 9 },
	backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	delete: { key: "Delete", code: "Delete", keyCode: 46 },
	space: { key: " ", code: "Space", keyCode: 32, text: " " },
	arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	home: { key: "Home", code: "Home", keyCode: 36 },
	end: { key: "End", code: "End", keyCode: 35 },
	pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
	pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

/** A key by name, or a single printable character. */
function keyFor(name: string): { key: string; code: string; keyCode: number; text?: string } {
	const known = KEYS[name.toLowerCase()];

	if (known) {
		return known;
	}

	if (/^f([1-9]|1[0-2])$/i.test(name)) {
		const number = Number(name.slice(1));

		return { key: name.toUpperCase(), code: name.toUpperCase(), keyCode: 111 + number };
	}

	if ([...name].length === 1) {
		const upper = name.toUpperCase();
		const code = /[a-z]/i.test(name)
			? `Key${upper}`
			: /[0-9]/.test(name)
				? `Digit${name}`
				: "";

		return { key: name, code, keyCode: upper.charCodeAt(0), text: name };
	}

	throw new Error(t("core.browser.unknownKey", { key: name }));
}

function originOf(url: string): string | null {
	try {
		const parsed = new URL(url);

		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? parsed.origin
			: null;
	} catch {
		return null;
	}
}

class Session {
	readonly id = newId("brw");
	readonly openedAt = Date.now();
	lastActionAt = Date.now();
	lastAction: string | null = null;

	proc: ReturnType<typeof Bun.spawn> | null = null;
	cdp: Cdp | null = null;
	/** The session's only way out */
	egress: EgressProxy | null = null;
	page = "";
	mainFrame = "";
	profile = "";
	crashed = false;

	/** The isolated world the page helper runs in, once made for the current document */
	world: number | null = null;

	viewport: BrowserViewport = { width: 1280, height: 800, scale: 1, mobile: false };
	cursor: { x: number; y: number } | null = null;

	url = "about:blank";
	title = "";
	status: number | null = null;

	/** Downloads by DevTools guid, and the ones a call has reported already */
	readonly downloads = new Map<string, BrowserDownload & { seq: number }>();
	readonly reportedDownloads = new Set<string>();
	downloadDir = "";

	readonly logs: BrowserLogEntry[] = [];
	readonly failures: BrowserNetworkEntry[] = [];
	readonly inflight = new Map<string, { url: string; method: string; type: string; at: number }>();
	seq = 0;
	lastNetworkAt = Date.now();

	chain: Promise<unknown> = Promise.resolve();
	idleTimer: ReturnType<typeof setTimeout> | null = null;
	closed = false;

	constructor(
		readonly owner: string,
		readonly holder: string,
	) {}

	info(): BrowserSessionInfo {
		return {
			id: this.id,
			holder: this.holder,
			url: this.url,
			title: this.title,
			openedAt: this.openedAt,
			lastActionAt: this.lastActionAt,
			lastAction: this.lastAction,
		};
	}

	state(extra: Partial<BrowserState> = {}): BrowserState {
		// every finished download is told once, in the next result after it ends
		const finished = [...this.downloads.entries()]
			.filter(([guid, entry]) => entry.state !== "inProgress" && !this.reportedDownloads.has(guid));
		const running = [...this.downloads.values()].filter((entry) => entry.state === "inProgress").length;

		for (const [guid] of finished) {
			this.reportedDownloads.add(guid);
		}

		if (finished.length) {
			extra = { ...extra, newDownloads: finished.map(([, { seq: _seq, ...entry }]) => entry) };
		}

		if (running) {
			extra = { ...extra, downloading: running };
		}

		return {
			session: this.id,
			url: this.url,
			title: this.title,
			status: this.status,
			viewport: { ...this.viewport },
			...extra,
		};
	}

	log(entry: Omit<BrowserLogEntry, "seq" | "at">): void {
		this.seq += 1;
		this.logs.push({ seq: this.seq, at: Date.now(), ...entry, text: entry.text.slice(0, 2000) });

		if (this.logs.length > MAX_LOG) {
			this.logs.splice(0, this.logs.length - MAX_LOG);
		}
	}

	fail(entry: Omit<BrowserNetworkEntry, "seq" | "at">): void {
		this.seq += 1;
		this.failures.push({ seq: this.seq, at: Date.now(), ...entry, url: entry.url.slice(0, 2000) });

		if (this.failures.length > MAX_LOG) {
			this.failures.splice(0, this.failures.length - MAX_LOG);
		}
	}

	send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		if (!this.cdp) {
			return Promise.reject(new Error(t("core.browser.gone")));
		}

		return this.cdp.send(method, params, this.page);
	}
}

const sessions = new Map<string, Session>();

/** Sessions being started, so the limit counts them too. */
let starting = 0;

function findSession(owner: string, holder: string): Session | undefined {
	return [...sessions.values()].find((session) => session.owner === owner && session.holder === holder);
}

function requireSession(owner: string, holder: string): Session {
	const session = findSession(owner, holder);

	if (!session) {
		throw new Error(t("core.browser.notOpen"));
	}

	return session;
}

/** Run one call on a session after the ones before it, under the action timeout. */
function serialize<T>(session: Session, work: () => Promise<T>): Promise<T> {
	const run = session.chain.then(async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;

		try {
			return await Promise.race([
				work(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(t("core.browser.timedOut", { seconds: String(ACTION_TIMEOUT_MS / 1000) }))), ACTION_TIMEOUT_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	});

	session.chain = run.catch(() => {});

	return run;
}

function touch(session: Session, action: string): void {
	session.lastActionAt = Date.now();
	session.lastAction = action;

	if (session.idleTimer) {
		clearTimeout(session.idleTimer);
	}

	session.idleTimer = setTimeout(() => {
		void shutdown(session);
	}, BROWSER_IDLE_MS);
}

// -- the browser process and its tab ------------------------------------------------

async function launch(session: Session): Promise<void> {
	const browser = findBrowser();

	if (!browser) {
		throw new Error(t("core.browser.noBrowser"));
	}

	if (!session.egress) {
		session.egress = await startEgress({
			maxBytes: WEB_MAX_BYTES,
			allowLocal,
			onRefuse: (target, reason, method) => {
				session.fail({ url: target, method, type: "Other", status: null, error: reason, blocked: true });
			},
		});
	}

	const base = profileBase(browser);

	await mkdir(base, { recursive: true });
	session.profile = await mkdtemp(join(base, "luna-browser-"));

	const args = [
		"--headless=new",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"--disable-extensions",
		"--disable-sync",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-default-apps",
		"--hide-scrollbars",
		"--mute-audio",
		"--force-color-profile=srgb",
		"--remote-debugging-port=0",
		`--user-data-dir=${session.profile}`,
		`--window-size=${session.viewport.width},${session.viewport.height}`,
		// every connection through the egress proxy, which resolves and checks
		// each destination; the browser itself resolves nothing and uses no UDP
		`--proxy-server=http://127.0.0.1:${session.egress.port}`,
		"--proxy-bypass-list=<-loopback>",
		"--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
		"--disable-quic",
		"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
	];

	// the snap's Chromium needs a user session's runtime folder, which a daemon
	// started outside a login has not got
	const uid = process.getuid?.();
	const env: Record<string, string | undefined> = {
		...process.env,
		XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? (uid !== undefined
			? `/run/user/${uid}`
			: undefined),
	};

	session.proc = Bun.spawn([browser, ...args, "about:blank"], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
		env,
	});

	const proc = session.proc;

	try {
		session.cdp = await Cdp.connect(await devtoolsAddress(proc.stderr as ReadableStream<Uint8Array>, 15_000));
	} catch (err) {
		proc.kill("SIGKILL");
		throw err;
	}

	session.cdp.on((message) => onMessage(session, message));
	session.cdp.onClose(() => {
		if (!session.closed) {
			session.crashed = true;
		}
	});

	await openTab(session);
}

/** A fresh tab, wired up: the first one, or one replacing a crashed tab. */
async function openTab(session: Session): Promise<void> {
	const cdp = session.cdp!;
	const created = await cdp.send("Target.createTarget", { url: "about:blank" });
	const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });

	session.page = String(attached.sessionId);
	// a page target's main frame carries the target's id
	session.mainFrame = String(created.targetId);
	session.world = null;
	session.crashed = false;

	await Promise.all([
		session.send("Page.enable"),
		session.send("Network.enable"),
		session.send("Runtime.enable"),
		session.send("Log.enable"),
		session.send("Page.setLifecycleEventsEnabled", { enabled: true }),
		session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }], handleAuthRequests: true }),
	]);

	// a download is saved under the profile by its guid, then moved to the
	// conversation's scratch folder; a token's session has nowhere to put one
	session.downloadDir = join(session.profile, "downloads");
	await mkdir(session.downloadDir, { recursive: true });
	await cdp.send("Browser.setDownloadBehavior", {
		behavior: agentHolder(session.holder)
			? "allowAndName"
			: "deny",
		downloadPath: session.downloadDir,
		eventsEnabled: true,
	}).catch(() => {});

	// a site opens no file picker on the host
	await session.send("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});

	// anything the page opens in a new window is closed before it loads
	await cdp.send("Target.setDiscoverTargets", { discover: true });
	await applyViewport(session);
}

async function applyViewport(session: Session): Promise<void> {
	const view = session.viewport;

	await session.send("Emulation.setDeviceMetricsOverride", {
		width: view.width,
		height: view.height,
		deviceScaleFactor: view.scale,
		mobile: view.mobile,
	});
	await session.send("Emulation.setTouchEmulationEnabled", { enabled: view.mobile, ...(view.mobile ? { maxTouchPoints: 5 } : {}) });
}

/** The page's events, as the session keeps them. */
function onMessage(session: Session, message: CdpMessage): void {
	const params = message.params ?? {};

	// a popup or a window the page opened: closed before it does anything
	if (message.method === "Target.targetCreated" && !message.sessionId) {
		const info = params.targetInfo as { targetId?: string; type?: string; openerId?: string } | undefined;

		if (info?.type === "page" && info.targetId !== session.mainFrame && info.openerId) {
			const opened = (info as { url?: string }).url;

			void session.cdp?.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
			session.log({
				level: "warning",
				source: "browser",
				text: opened && opened !== "about:blank"
					? t("core.browser.popupClosedAt", { url: opened })
					: t("core.browser.popupClosed"),
			});
		}

		return;
	}

	if (message.method === "Browser.downloadWillBegin" || message.method === "Browser.downloadProgress") {
		onDownload(session, message.method, params);

		return;
	}

	if (message.sessionId !== session.page) {
		return;
	}

	switch (message.method) {
		case "Fetch.requestPaused": {
			void guard(session, params as unknown as PausedRequest);
			break;
		}

		case "Fetch.authRequired": {
			const request = params.request as { url?: string } | undefined;

			session.log({ level: "warning", source: "browser", text: t("core.browser.authCancelled", { url: request?.url ?? "" }) });
			void session.send("Fetch.continueWithAuth", { requestId: params.requestId, authChallengeResponse: { response: "CancelAuth" } }).catch(() => {});
			break;
		}

		case "Page.javascriptDialogOpening": {
			session.log({ level: "warning", source: "browser", text: t("core.browser.dialogDismissed", { type: String(params.type ?? "alert"), message: String(params.message ?? "") }) });
			void session.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
			break;
		}

		case "Page.fileChooserOpened": {
			session.log({ level: "warning", source: "browser", text: t("core.browser.fileChooserRefused") });
			break;
		}

		case "Page.frameNavigated": {
			const frame = params.frame as { id?: string; parentId?: string; url?: string } | undefined;

			if (frame?.id === session.mainFrame && !frame.parentId) {
				session.url = frame.url ?? session.url;
				session.world = null;
			}

			break;
		}

		case "Page.navigatedWithinDocument": {
			if (params.frameId === session.mainFrame) {
				session.url = String(params.url ?? session.url);
			}

			break;
		}

		case "Page.loadEventFired": {
			void afterLoad(session);
			break;
		}

		case "Inspector.targetCrashed": {
			session.crashed = true;
			session.log({ level: "error", source: "browser", text: t("core.browser.crashed") });
			break;
		}

		case "Runtime.executionContextsCleared": {
			session.world = null;
			break;
		}

		case "Runtime.executionContextDestroyed": {
			if (params.executionContextId === session.world) {
				session.world = null;
			}

			break;
		}

		case "Runtime.consoleAPICalled": {
			const type = String(params.type ?? "log");
			const parts = (params.args as Array<{ value?: unknown; description?: string; type?: string }> | undefined) ?? [];
			const text = parts
				.map((part) => (part.value !== undefined ? (typeof part.value === "string" ? part.value : JSON.stringify(part.value)) : part.description ?? part.type ?? ""))
				.join(" ");
			const frame = (params.stackTrace as { callFrames?: Array<{ url?: string; lineNumber?: number }> } | undefined)?.callFrames?.[0];
			const level = type === "error" || type === "assert"
				? "error"
				: type === "warning"
					? "warning"
					: type === "debug"
						? "debug"
						: type === "info"
							? "info"
							: "log";

			session.log({ level, source: "console", text, ...(frame?.url ? { where: `${frame.url}:${(frame.lineNumber ?? 0) + 1}` } : {}) });
			break;
		}

		case "Runtime.exceptionThrown": {
			const detail = params.exceptionDetails as { text?: string; url?: string; lineNumber?: number; exception?: { description?: string } } | undefined;

			session.log({
				level: "error",
				source: "exception",
				text: detail?.exception?.description ?? detail?.text ?? "exception",
				...(detail?.url ? { where: `${detail.url}:${(detail.lineNumber ?? 0) + 1}` } : {}),
			});
			break;
		}

		case "Log.entryAdded": {
			const entry = params.entry as { level?: string; text?: string; url?: string } | undefined;

			// the browser asks every site for an icon; a missing one is not the page's fault
			if (entry && !entry.url?.endsWith("/favicon.ico")) {
				const level = entry.level === "error" || entry.level === "warning"
					? entry.level
					: "info";

				session.log({ level, source: "browser", text: entry.text ?? "", ...(entry.url ? { where: entry.url } : {}) });
			}

			break;
		}

		case "Network.requestWillBeSent": {
			const request = params.request as { url?: string; method?: string } | undefined;

			session.inflight.set(String(params.requestId), {
				url: request?.url ?? "",
				method: request?.method ?? "GET",
				type: String(params.type ?? ""),
				at: Date.now(),
			});
			session.lastNetworkAt = Date.now();
			break;
		}

		case "Network.responseReceived": {
			const response = params.response as { status?: number; url?: string } | undefined;
			const request = session.inflight.get(String(params.requestId));

			if (params.type === "Document" && params.frameId === session.mainFrame) {
				session.status = response?.status ?? null;
			}

			if ((response?.status ?? 0) >= 400 && !response?.url?.endsWith("/favicon.ico")) {
				session.fail({
					url: response?.url ?? request?.url ?? "",
					method: request?.method ?? "GET",
					type: String(params.type ?? ""),
					status: response?.status ?? null,
				});
			}

			break;
		}

		case "Network.loadingFinished": {
			session.inflight.delete(String(params.requestId));
			session.lastNetworkAt = Date.now();
			break;
		}

		case "Network.loadingFailed": {
			const request = session.inflight.get(String(params.requestId));

			session.inflight.delete(String(params.requestId));
			session.lastNetworkAt = Date.now();

			// the guard already recorded what it refused
			if (request && params.blockedReason === undefined && params.errorText !== "net::ERR_BLOCKED_BY_CLIENT" && params.canceled !== true) {
				session.fail({
					url: request.url,
					method: request.method,
					type: String(params.type ?? request.type),
					status: null,
					error: String(params.errorText ?? "failed"),
				});
			}

			break;
		}

		default:
			break;
	}
}


/**
 * Let a paused request through or refuse it: anything over http(s) passes
 * here, since the egress proxy checks where each one goes; any other scheme
 * is refused.
 */
async function guard(session: Session, paused: PausedRequest): Promise<void> {
	const url = paused.request.url;
	const allowed = originOf(url) !== null;

	try {
		if (allowed) {
			await session.send("Fetch.continueRequest", { requestId: paused.requestId });

			return;
		}

		session.fail({ url, method: paused.request.method, type: paused.resourceType, status: null, error: t("core.browser.blockedScheme"), blocked: true });
		await session.send("Fetch.failRequest", { requestId: paused.requestId, errorReason: "BlockedByClient" });
	} catch {
		// the request went away with its page
	}
}

/** Read the page's title again: a history step or a script can change it without a load. */
async function refreshTitle(session: Session): Promise<void> {
	try {
		const title = await session.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });

		session.title = String((title.result as { value?: unknown } | undefined)?.value ?? "");
	} catch {
		// a page between documents keeps the title it had
	}
}

/** Put the pointer back after a new document loads. */
async function afterLoad(session: Session): Promise<void> {
	try {
		await refreshTitle(session);

		if (session.cursor) {
			await helper(session, "cursor", session.cursor.x, session.cursor.y, true);
		}
	} catch {
		// the page moved on again; the next load tries once more
	}
}

/** Bring a crashed tab or browser back, on the last address. True when it had to. */
async function revive(session: Session): Promise<boolean> {
	if (!session.cdp || session.cdp.closed) {
		session.proc?.kill("SIGKILL");
		await rm(session.profile, { recursive: true, force: true }).catch(() => {});
		await launch(session);
	} else if (session.crashed) {
		await session.cdp.send("Target.closeTarget", { targetId: session.mainFrame }).catch(() => {});
		await openTab(session);
	} else {
		return false;
	}

	if (session.url !== "about:blank" && originOf(session.url) !== null) {
		await navigate(session, session.url);
	}

	return true;
}

// -- downloads -----------------------------------------------------------------

/** Whether a holder is a Mèo Béo conversation (an MCP token's holder is `token:<id>`). */
function agentHolder(holder: string): boolean {
	return !holder.startsWith("token:");
}

/** A download's events, from the browser's own target. */
function onDownload(session: Session, method: string, params: Record<string, unknown>): void {
	const guid = String(params.guid ?? "");

	if (!guid) {
		return;
	}

	if (method === "Browser.downloadWillBegin") {
		session.seq += 1;
		session.downloads.set(guid, {
			seq: session.seq,
			url: String(params.url ?? "").slice(0, 2000),
			name: safeName(String(params.suggestedFilename ?? "")),
			state: agentHolder(session.holder)
				? "inProgress"
				: "refused",
			bytes: 0,
			total: null,
			...(agentHolder(session.holder) ? {} : { error: t("core.browser.downloadNoScratch") }),
		});

		return;
	}

	const entry = session.downloads.get(guid);

	if (!entry || entry.state !== "inProgress") {
		return;
	}

	entry.bytes = Number(params.receivedBytes ?? entry.bytes);
	entry.total = Number(params.totalBytes ?? 0) || null;

	if (entry.bytes > MAX_DOWNLOAD_BYTES || (entry.total ?? 0) > MAX_DOWNLOAD_BYTES) {
		entry.state = "refused";
		entry.error = t("core.browser.downloadTooLarge", { max: String(MAX_DOWNLOAD_BYTES / 1024 / 1024) });
		session.seq += 1;
		entry.seq = session.seq;
		void session.cdp?.send("Browser.cancelDownload", { guid }).catch(() => {});
		void rm(join(session.downloadDir, guid), { force: true }).catch(() => {});

		return;
	}

	if (params.state === "canceled") {
		entry.state = "canceled";
		session.seq += 1;
		entry.seq = session.seq;

		return;
	}

	if (params.state === "completed") {
		void deliver(session, guid, entry);
	}
}

/** A file name a download may land under: no path, no control characters, not hidden. */
function safeName(suggested: string): string {
	const name = basename(suggested.replace(/\\/g, "/"))
		.replace(/[\u0000-\u001f\u007f/]/g, "")
		.replace(/^\.+/, "")
		.trim()
		.slice(0, 120);

	return name || "download";
}

/**
 * Move a finished download into the conversation's scratch folder. The folder
 * is the agent's, written by its own file tools too, so nothing in it is
 * followed: the file is copied to a fresh name that must not exist yet, then
 * renamed over whatever stands at the destination.
 */
async function deliver(session: Session, guid: string, entry: BrowserDownload & { seq: number }): Promise<void> {
	const source = join(session.downloadDir, guid);

	try {
		const { agentScratch } = await import("./agent");
		const scratch = await realpath(await agentScratch(session.holder, session.owner));
		const dir = join(scratch, DOWNLOADS_FOLDER);

		await mkdir(dir, { recursive: true });

		const real = await realpath(dir);

		if (real !== join(scratch, DOWNLOADS_FOLDER) || !real.startsWith(scratch + sep)) {
			throw new Error(t("core.browser.downloadFolder"));
		}

		const dot = entry.name.lastIndexOf(".");
		const stem = dot > 0
			? entry.name.slice(0, dot)
			: entry.name;
		const ext = dot > 0
			? entry.name.slice(dot)
			: "";
		let name = entry.name;

		for (let n = 2; await lstat(join(real, name)).then(() => true, () => false); n++) {
			name = `${stem} (${n})${ext}`;
		}

		const incoming = join(real, `.incoming-${guid}`);

		await copyFile(source, incoming, fsConstants.COPYFILE_EXCL);
		await rename(incoming, join(real, name));

		entry.name = name;
		entry.path = `${DOWNLOADS_FOLDER}/${name}`;
		entry.state = "completed";
	} catch (err) {
		entry.state = "refused";
		entry.error = (err as Error).message;
	} finally {
		await rm(source, { force: true }).catch(() => {});
		session.seq += 1;
		entry.seq = session.seq;
	}
}

// -- the page --------------------------------------------------------------------

/** Call the page helper in its isolated world, installing it first when the document is new. */
async function helper(session: Session, method: string, ...args: unknown[]): Promise<unknown> {
	for (let attempt = 0; attempt < 2; attempt++) {
		if (session.world === null) {
			const made = await session.send("Page.createIsolatedWorld", { frameId: session.mainFrame, worldName: "luna" });

			session.world = Number(made.executionContextId);
		}

		const call = `(${PAGE_HELPER}), globalThis.__luna.${method}(...${JSON.stringify(args)})`;
		let answer: Record<string, unknown>;

		try {
			answer = await session.send("Runtime.evaluate", {
				expression: call,
				contextId: session.world,
				returnByValue: true,
				awaitPromise: true,
			});
		} catch (err) {
			// the document went away under the call; one more try in the new one
			session.world = null;

			if (attempt === 0) {
				continue;
			}

			throw err;
		}

		const failure = answer.exceptionDetails as { exception?: { description?: string; value?: unknown }; text?: string } | undefined;

		if (failure) {
			const text = failure.exception?.description ?? String(failure.exception?.value ?? failure.text ?? "the page refused");

			throw new Error(text.replace(/^Error: /, "").split("\n")[0]);
		}

		return (answer.result as { value?: unknown } | undefined)?.value;
	}

	return undefined;
}

/** A model's pattern, case-insensitive, or why it is not one. */
function patternOf(pattern: string): RegExp {
	return compilePattern(pattern);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for the page to load after a navigation started, then briefly for its requests to settle. */
async function settle(session: Session, loaded: Promise<CdpMessage | null>): Promise<void> {
	await loaded;
	await waitNetworkIdle(session, 2_000);
}

async function waitNetworkIdle(session: Session, ms: number, quietMs = 500): Promise<boolean> {
	const deadline = Date.now() + ms;

	while (Date.now() < deadline) {
		if (session.inflight.size === 0 && Date.now() - session.lastNetworkAt >= quietMs) {
			return true;
		}

		await sleep(100);
	}

	return false;
}

function loadEvent(session: Session, ms = LOAD_TIMEOUT_MS): Promise<CdpMessage | null> {
	return session.cdp!.waitFor((message) => message.sessionId === session.page && message.method === "Page.loadEventFired", ms);
}

/** Go to a public address; anything else is refused, with the reason, before the browser sees it. */
async function navigate(session: Session, url: string): Promise<void> {
	await checkWebAddress(url);

	session.status = null;

	const loaded = loadEvent(session);
	const result = await session.send("Page.navigate", { url });

	if (typeof result.errorText === "string" && result.errorText !== "") {
		throw new Error(t("core.browser.navigateFailed", { url, message: result.errorText }));
	}

	await settle(session, loaded);
}

/** The address a path (on the current page's origin) or a full URL resolves to. */
function resolveAddress(session: Session, given: string): string {
	const trimmed = given.trim();

	if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
		const base = originOf(session.url);

		if (!base) {
			throw new Error(t("core.browser.noOrigin"));
		}

		return `${base}${trimmed}`;
	}

	return trimmed;
}

/**
 * Refuse an address before the browser sees it, with the reason: not http(s),
 * or a destination the egress proxy would refuse anyway. The proxy still
 * checks every connection; this is what makes a refused navigation say why.
 */
async function checkWebAddress(url: string): Promise<URL> {
	let parsed: URL;

	try {
		parsed = new URL(url);
	} catch {
		throw new Error(t("core.browser.badUrl", { url }));
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(t("core.browser.badScheme", { url }));
	}

	const port = parsed.port
		? Number(parsed.port)
		: parsed.protocol === "https:"
			? 443
			: 80;

	await resolveEgress(parsed.hostname, port, { allowLocal });

	return parsed;
}

/** Where to aim: an element's centre (scrolled into view) or the point given. */
async function aim(session: Session, element: ElementSpec | undefined, point: { x: number; y: number } | undefined): Promise<{ x: number; y: number; target?: unknown }> {
	if (element && (element.ref || element.selector || element.text)) {
		const found = await helper(session, "locate", element) as { x: number; y: number };

		return { x: found.x, y: found.y, target: found };
	}

	if (point) {
		return { x: clamp(point.x, 0, session.viewport.width - 1, 0), y: clamp(point.y, 0, session.viewport.height - 1, 0) };
	}

	throw new Error(t("core.browser.noTarget"));
}

/** Glide the drawn pointer to a point and move the real mouse there. */
async function moveTo(session: Session, x: number, y: number): Promise<void> {
	const first = session.cursor === null;

	session.cursor = { x, y };
	await helper(session, "cursor", x, y, first);

	if (!first) {
		await sleep(GLIDE_MS);
	}

	await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

async function pressKeys(session: Session, combo: string): Promise<void> {
	const parts = combo.split("+").map((part) => part.trim()).filter(Boolean);
	const keyName = parts.pop();

	if (!keyName) {
		throw new Error(t("core.browser.unknownKey", { key: combo }));
	}

	let modifiers = 0;

	for (const part of parts) {
		const bit = MODIFIERS[part.toLowerCase()];

		if (bit === undefined) {
			throw new Error(t("core.browser.unknownKey", { key: part }));
		}

		modifiers |= bit;
	}

	const key = keyFor(keyName);
	// with Control or Meta held, a letter is a shortcut, not text
	const text = modifiers & (MODIFIERS.control! | MODIFIERS.meta!)
		? undefined
		: key.text;

	await session.send("Input.dispatchKeyEvent", {
		type: text ? "keyDown" : "rawKeyDown",
		key: key.key,
		code: key.code,
		windowsVirtualKeyCode: key.keyCode,
		modifiers,
		...(text ? { text, unmodifiedText: text } : {}),
	});
	await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers });
}

/** Run something that may start a navigation, and let the page settle if it did. */
async function maybeNavigates(session: Session, work: () => Promise<void>): Promise<void> {
	const started = session.cdp!.waitFor(
		(message) => message.sessionId === session.page && message.method === "Page.frameStartedLoading" && message.params?.frameId === session.mainFrame,
		400,
	);
	const loaded = loadEvent(session, 10_000);

	await work();

	if (await started) {
		await settle(session, loaded);
	} else {
		await waitNetworkIdle(session, 1_500, 300);
	}
}

async function capture(session: Session, element: ElementSpec | undefined, fullPage: boolean): Promise<NonNullable<BrowserResult["image"]>> {
	const view = session.viewport;

	if (element && (element.ref || element.selector || element.text)) {
		const box = await helper(session, "box", element) as { x: number; y: number; width: number; height: number };
		const width = Math.max(1, Math.min(box.width, 4000));
		const height = Math.max(1, Math.min(box.height, MAX_PAGE_HEIGHT));
		const shot = await session.send("Page.captureScreenshot", {
			format: "png",
			captureBeyondViewport: true,
			clip: { x: box.x, y: box.y, width, height, scale: 1 },
		});

		return { data: String(shot.data), mime: "image/png", width: Math.round(width), height: Math.round(height) };
	}

	if (fullPage) {
		const position = await helper(session, "position") as { height: number; width: number };
		const height = Math.min(Math.max(view.height, position.height), MAX_PAGE_HEIGHT);
		const shot = await session.send("Page.captureScreenshot", {
			format: "jpeg",
			quality: 80,
			captureBeyondViewport: true,
			clip: { x: 0, y: 0, width: view.width, height, scale: 1 },
		});

		return { data: String(shot.data), mime: "image/jpeg", width: view.width, height };
	}

	const shot = await session.send("Page.captureScreenshot", { format: "png" });

	return { data: String(shot.data), mime: "image/png", width: view.width, height: view.height };
}

/** The page's errors logged after a sequence number, for a call's result. */
function errorsSince(session: Session, seq: number): string[] {
	return session.logs
		.filter((entry) => entry.seq > seq && entry.level === "error")
		.slice(0, 5)
		.map((entry) => entry.text.split("\n")[0]!.slice(0, 300));
}

async function perform(session: Session, action: BrowserAction): Promise<{ data?: unknown; image?: BrowserResult["image"] }> {
	switch (action.kind) {
		case "navigate": {
			if (action.action === "reload") {
				const loaded = loadEvent(session);

				await session.send("Page.reload");
				await settle(session, loaded);

				return {};
			}

			if (action.action === "back" || action.action === "forward") {
				const history = await session.send("Page.getNavigationHistory");
				const entries = history.entries as Array<{ id: number; url: string }>;
				const index = Number(history.currentIndex) + (action.action === "back" ? -1 : 1);
				const entry = entries[index];

				if (!entry) {
					throw new Error(t("core.browser.noHistory", { direction: action.action }));
				}

				const loaded = loadEvent(session);

				await session.send("Page.navigateToHistoryEntry", { entryId: entry.id });
				await settle(session, loaded);

				return {};
			}

			if (!action.path) {
				throw new Error(t("core.browser.noPath"));
			}

			await navigate(session, resolveAddress(session, action.path));

			return {};
		}

		case "scroll": {
			await helper(session, "scroll", action.element ?? null, action.deltaX ?? 0, action.deltaY ?? 0, action.to ?? null);

			// a smooth scroll takes as long as it takes; it is over once the position holds
			let last = "";

			for (let tries = 0; tries < 20; tries++) {
				await sleep(150);

				const now = JSON.stringify(await helper(session, "position"));

				if (now === last) {
					break;
				}

				last = now;
			}

			return { data: { scroll: JSON.parse(last || "null") } };
		}

		case "click": {
			const aimed = await aim(session, action.element, action.point);
			const button = action.button ?? "left";

			await moveTo(session, aimed.x, aimed.y);
			await maybeNavigates(session, async () => {
				await helper(session, "ripple", aimed.x, aimed.y);

				const presses = action.double ? [1, 2] : [1];

				for (const clickCount of presses) {
					await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: aimed.x, y: aimed.y, button, clickCount });
					await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: aimed.x, y: aimed.y, button, clickCount });
				}
			});

			return { data: { clicked: aimed.target ?? { x: aimed.x, y: aimed.y } } };
		}

		case "hover": {
			const aimed = await aim(session, action.element, action.point);

			await moveTo(session, aimed.x, aimed.y);
			await sleep(200);

			return { data: { hovering: aimed.target ?? { x: aimed.x, y: aimed.y } } };
		}

		case "type": {
			let field: unknown = null;

			if (action.element && (action.element.ref || action.element.selector || action.element.text)) {
				const aimed = await aim(session, action.element, undefined);

				await moveTo(session, aimed.x, aimed.y);
				field = await helper(session, "focus", action.element);
			}

			if (action.clear) {
				field = await helper(session, "clear", null) ?? field;
			}

			await session.send("Input.insertText", { text: action.text });

			if (action.submit) {
				await maybeNavigates(session, () => pressKeys(session, "Enter"));
			}

			return { data: { typed: action.text.length, ...(field ? { field } : {}) } };
		}

		case "press": {
			if (action.element && (action.element.ref || action.element.selector || action.element.text)) {
				await helper(session, "focus", action.element);
			}

			await maybeNavigates(session, async () => {
				for (let index = 0; index < clamp(action.repeat, 1, 50, 1); index++) {
					await pressKeys(session, action.keys);
				}
			});

			return { data: { pressed: action.keys } };
		}

		case "select": {
			const aimed = await aim(session, action.element, undefined);

			await moveTo(session, aimed.x, aimed.y);

			return { data: await helper(session, "select", action.element, action.values) };
		}

		case "screenshot": {
			return { image: await capture(session, action.element, action.fullPage === true) };
		}

		case "eval": {
			const answer = await session.send("Runtime.evaluate", {
				expression: action.script,
				returnByValue: true,
				awaitPromise: true,
				userGesture: true,
				timeout: 15_000,
			});
			const failure = answer.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;

			if (failure) {
				throw new Error(t("core.browser.scriptFailed", { message: (failure.exception?.description ?? failure.text ?? "").split("\n")[0]!.slice(0, 500) }));
			}

			const result = answer.result as { value?: unknown; type?: string; description?: string } | undefined;
			const value = result && "value" in result
				? result.value
				: result?.description ?? null;
			const json = JSON.stringify(value ?? null) ?? "null";

			return {
				data: json.length > MAX_EVAL_CHARS
					? { result: `${json.slice(0, MAX_EVAL_CHARS)}… [${json.length - MAX_EVAL_CHARS} more characters]`, cut: true }
					: { result: value ?? null, type: result?.type ?? "undefined" },
			};
		}

		case "console": {
			const since = action.since ?? 0;
			const levels = action.level === "error"
				? ["error"]
				: action.level === "warning"
					? ["error", "warning"]
					: null;
			const regex = action.pattern
				? patternOf(action.pattern)
				: null;
			const entries = session.logs
				.filter((entry) => entry.seq > since && (!levels || levels.includes(entry.level)))
				.filter((entry) => !regex || regex.test(entry.text) || (entry.where !== undefined && regex.test(entry.where)));
			const limit = clamp(action.limit, 1, 500, 100);

			return {
				data: {
					entries: entries.slice(-limit).map((entry) => ({ ...entry, at: new Date(entry.at).toISOString() })),
					...(entries.length > limit ? { earlier: entries.length - limit } : {}),
					next: session.seq,
				},
			};
		}

		case "network": {
			const since = action.since ?? 0;
			const entries = session.failures.filter((entry) => entry.seq > since);
			const limit = clamp(action.limit, 1, 500, 100);
			const now = Date.now();

			return {
				data: {
					failed: entries.slice(-limit).map((entry) => ({ ...entry, at: new Date(entry.at).toISOString() })),
					pending: [...session.inflight.values()].slice(0, 20).map((entry) => ({ url: entry.url, method: entry.method, type: entry.type, forMs: now - entry.at })),
					next: session.seq,
				},
			};
		}

		case "read": {
			const element = action.element && (action.element.ref || action.element.selector || action.element.text)
				? action.element
				: null;

			// a window reads the whole page (up to the cap) and returns only its lines
			if (action.window) {
				if (action.window.pattern) {
					patternOf(action.window.pattern);
				}

				const max = clamp(action.maxChars, 500, 60_000, 60_000);
				const lines = action.mode === "text"
					? String(await helper(session, "text", element, max)).split("\n")
					: (await helper(session, "outline", element, max) as { lines: string[] }).lines;

				return { data: { [action.mode === "text" ? "text" : "outline"]: textWindow(lines, { ...action.window, label: action.mode === "text" ? "text" : "outline" }).text } };
			}

			const max = clamp(action.maxChars, 500, 60_000, 20_000);

			if (action.mode === "text") {
				return { data: { text: await helper(session, "text", element, max) } };
			}

			const outline = await helper(session, "outline", element, max) as { lines: string[]; cut: boolean };

			return { data: { outline: outline.lines.join("\n"), ...(outline.cut ? { cut: true } : {}) } };
		}

		case "wait": {
			const timeout = clamp(action.timeoutMs, 100, 60_000, 10_000);
			const deadline = Date.now() + timeout;

			if (action.networkIdle && !action.selector && !action.text) {
				return { data: { happened: await waitNetworkIdle(session, timeout) } };
			}

			// until a download nobody was told about yet has finished, and none is still running
			if (action.download) {
				while (Date.now() < deadline) {
					const entries = [...session.downloads.entries()];
					const running = entries.some(([, entry]) => entry.state === "inProgress");
					const fresh = entries.some(([guid, entry]) => entry.state !== "inProgress" && !session.reportedDownloads.has(guid));

					if (fresh && !running) {
						return { data: { happened: true } };
					}

					await sleep(200);
				}

				return { data: { happened: false } };
			}

			const spec = action.selector
				? { selector: action.selector }
				: action.text
					? { text: action.text }
					: null;

			if (!spec) {
				throw new Error(t("core.browser.nothingToWaitFor"));
			}

			while (Date.now() < deadline) {
				const present = await helper(session, "exists", spec).catch(() => false) as boolean;

				if (present !== (action.gone === true)) {
					return { data: { happened: true } };
				}

				await sleep(150);
			}

			return { data: { happened: false } };
		}

		default:
			throw new Error(t("core.browser.unknownAction"));
	}
}

// -- the API ------------------------------------------------------------------------

/** Tell the address guard the public address luna's hostnames point at, which may be on no interface. */
async function learnOwnAddress(): Promise<void> {
	try {
		const settings = await domainSettings();

		setOwnAddresses(settings.effectiveAddress
			? [settings.effectiveAddress]
			: []);
	} catch {
		// no domain settings: the interfaces are what the guard knows
	}
}

/**
 * Open the owner's browser for a holder on a public address, or move the one
 * already open there.
 */
export async function openBrowser(owner: string, holder: string, url: string, device?: BrowserDevice): Promise<BrowserResult> {
	await learnOwnAddress();

	const parsed = await checkWebAddress(url);
	let session = findSession(owner, holder);

	if (!session) {
		if (sessions.size + starting >= MAX_BROWSER_SESSIONS) {
			throw new Error(t("core.browser.busy", { max: String(MAX_BROWSER_SESSIONS) }));
		}

		const fresh = new Session(owner, holder);

		if (device) {
			fresh.viewport = { ...DEVICES[device], scale: 1 };
		}

		starting += 1;

		try {
			await launch(fresh);
		} catch (err) {
			fresh.closed = true;
			fresh.proc?.kill("SIGKILL");
			fresh.egress?.close();
			await rm(fresh.profile, { recursive: true, force: true }).catch(() => {});
			throw err;
		} finally {
			starting -= 1;
		}

		sessions.set(fresh.id, fresh);
		session = fresh;
	}

	const opened = session;

	return await serialize(opened, async () => {
		touch(opened, "open");

		const recovered = await revive(opened);

		if (device) {
			opened.viewport = { ...DEVICES[device], scale: 1 };
			await applyViewport(opened);
		}

		const mark = opened.seq;

		await navigate(opened, parsed.href);
		await afterLoad(opened);

		const outline = await helper(opened, "outline", null, 4000) as { lines: string[]; cut: boolean };
		const errors = errorsSince(opened, mark);

		return {
			state: opened.state({ ...(recovered ? { recovered } : {}), ...(errors.length ? { newErrors: errors } : {}) }),
			data: { outline: outline.lines.join("\n"), ...(outline.cut ? { cut: true } : {}) },
		};
	});
}

/** One call on the owner's open browser for a holder. */
export async function browserAct(owner: string, holder: string, action: BrowserAction): Promise<BrowserResult> {
	const session = requireSession(owner, holder);

	return await serialize(session, async () => {
		touch(session, action.kind);

		const recovered = await revive(session);
		const mark = session.seq;
		const done = await perform(session, action);

		await refreshTitle(session);

		const errors = action.kind === "console" || action.kind === "network"
			? []
			: errorsSince(session, mark);

		return {
			state: session.state({ ...(recovered ? { recovered } : {}), ...(errors.length ? { newErrors: errors } : {}) }),
			...done,
		};
	});
}

/** End a session: the browser, its proxy and its profile go. */
async function shutdown(session: Session): Promise<void> {
	if (session.closed) {
		return;
	}

	session.closed = true;
	sessions.delete(session.id);

	if (session.idleTimer) {
		clearTimeout(session.idleTimer);
	}

	if (session.cdp && !session.cdp.closed) {
		await Promise.race([session.cdp.send("Browser.close").catch(() => ({})), sleep(1000)]);
	}

	session.cdp?.close();
	session.proc?.kill("SIGKILL");
	session.egress?.close();
	await session.proc?.exited.catch(() => {});
	await rm(session.profile, { recursive: true, force: true }).catch(() => {});
}

/** Close the owner's browser for a holder; false when none was open. */
export async function closeBrowser(owner: string, holder: string): Promise<boolean> {
	const session = findSession(owner, holder);

	if (!session) {
		return false;
	}

	await shutdown(session);

	return true;
}

/** The owner's open sessions, newest action first. */
export function listBrowsers(owner: string): BrowserSessionInfo[] {
	return [...sessions.values()]
		.filter((session) => session.owner === owner)
		.sort((left, right) => right.lastActionAt - left.lastActionAt)
		.map((session) => session.info());
}

/** Close every session; the daemon's shutdown. */
export async function closeAllBrowsers(): Promise<void> {
	await Promise.all([...sessions.values()].map((session) => shutdown(session)));
}
