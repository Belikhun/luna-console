/**
 * Console-wide notification list, feeding the Flashbar.
 *
 * The handle API mirrors the dashboard's ScreenChild.alert(): raise a
 * "loading" notification when work starts, keep the returned handle, and
 * `set()` it to its final level when the work settles. Informational levels
 * fade away on their own; problems and loading states stay until dismissed.
 */

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error' | 'loading';

export interface NotificationInit {
	level?: NotificationLevel;
	message?: string;
	/** secondary line, e.g. the failing detail behind a short headline */
	detail?: string;
	closeable?: boolean;
	/** 0-100 turns the loading spinner row into a determinate bar */
	progress?: number | null;
}

export interface NotificationItem extends Required<Omit<NotificationInit, 'progress'>> {
	id: number;
	progress: number | null;
	/** epoch ms at which the item auto-dismisses, null when it stays */
	expiresAt: number | null;
	autocloseMs: number | null;
}

export interface NotificationHandle {
	readonly id: number;
	readonly level: NotificationLevel | null;
	set(values: NotificationInit): NotificationHandle;
	autoclose(ms: number | false): NotificationHandle;
	close(): void;
	readonly closed: boolean;
}

/** Levels that never dismiss themselves — problems and in-flight work. */
export const KEEP_LEVELS: NotificationLevel[] = ['warning', 'error', 'loading'];

/** Default lifetime of a self-dismissing notification. */
export const AUTOCLOSE_MS = 6000;

class NotificationStore {
	items: NotificationItem[] = $state([]);

	/** collapsed = stacked flashbar, only the newest item is rendered */
	collapsed = $state(true);

	private nextId = 1;
	private timers = new Map<number, ReturnType<typeof setTimeout>>();

	/** Newest first, the order the flashbar renders in. */
	get ordered(): NotificationItem[] {
		return [...this.items].reverse();
	}

	/** How many notifications are live at each level. */
	get counts(): Record<NotificationLevel, number> {
		const out: Record<NotificationLevel, number> = {
			info: 0,
			success: 0,
			warning: 0,
			error: 0,
			loading: 0
		};

		for (const item of this.items) {
			out[item.level]++;
		}

		return out;
	}

	/** Raise a notification and return the handle that settles it later. */
	push(
		level: NotificationLevel,
		message: string,
		init: NotificationInit = {}
	): NotificationHandle {
		const id = this.nextId++;

		const item: NotificationItem = {
			id,
			level,
			message,
			detail: init.detail ?? '',
			closeable: init.closeable ?? true,
			progress: init.progress ?? null,
			expiresAt: null,
			autocloseMs: null
		};

		this.items = [...this.items, item];
		this.applyDefaultAutoclose(id);

		return this.handle(id);
	}

	private find(id: number): NotificationItem | undefined {
		return this.items.find((item) => item.id === id);
	}

	/**
	 * (Re)arm the dismiss timer. Without an explicit duration the level decides:
	 * problems and in-flight work stay, everything else fades.
	 */
	private applyDefaultAutoclose(id: number, explicit?: number | false): void {
		const item = this.find(id);

		if (!item) {
			return;
		}

		const running = this.timers.get(id);

		if (running !== undefined) {
			clearTimeout(running);
			this.timers.delete(id);
		}

		let ms: number | null;

		if (explicit === false) {
			ms = null;
		} else if (typeof explicit === 'number') {
			ms = explicit;
		} else {
			ms = KEEP_LEVELS.includes(item.level) || !item.closeable ? null : AUTOCLOSE_MS;
		}

		item.autocloseMs = ms;
		item.expiresAt = ms === null ? null : Date.now() + ms;

		if (ms !== null) {
			this.timers.set(
				id,
				setTimeout(() => this.close(id), ms)
			);
		}
	}

	/** Dismiss one notification. */
	close(id: number): void {
		const running = this.timers.get(id);

		if (running !== undefined) {
			clearTimeout(running);
			this.timers.delete(id);
		}

		this.items = this.items.filter((item) => item.id !== id);
	}

	/** Dismiss everything. */
	clear(): void {
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}

		this.timers.clear();
		this.items = [];
	}

	/** A live handle to one notification — safe to keep after it has closed. */
	handle(id: number): NotificationHandle {
		const store = this;

		return {
			get id() {
				return id;
			},

			get closed() {
				return store.find(id) === undefined;
			},

			get level() {
				return store.find(id)?.level ?? null;
			},

			set(values: NotificationInit) {
				const item = store.find(id);

				if (!item) {
					return this;
				}

				if (values.level !== undefined) {
					item.level = values.level;
				}

				if (values.message !== undefined) {
					item.message = values.message;
				}

				if (values.detail !== undefined) {
					item.detail = values.detail;
				}

				if (values.closeable !== undefined) {
					item.closeable = values.closeable;
				}

				if (values.progress !== undefined) {
					item.progress = values.progress;
				}

				// content changed — restart the countdown with the new level's policy
				store.applyDefaultAutoclose(id);

				return this;
			},

			autoclose(ms: number | false) {
				store.applyDefaultAutoclose(id, ms);

				return this;
			},

			close() {
				store.close(id);
			}
		};
	}
}

export const Notifications = new NotificationStore();

/** Shorthand raisers — `Notify.loading(...)` returns a handle to settle later. */
export const Notify = {
	info: (message: string, init?: NotificationInit) => Notifications.push('info', message, init),

	success: (message: string, init?: NotificationInit) =>
		Notifications.push('success', message, init),

	warning: (message: string, init?: NotificationInit) =>
		Notifications.push('warning', message, init),

	error: (message: string, init?: NotificationInit) => Notifications.push('error', message, init),

	loading: (message: string, init?: NotificationInit) =>
		Notifications.push('loading', message, { closeable: false, ...init })
};

/**
 * Run an async operation behind a loading notification, settling it to a
 * success or error flash. Returns the operation's result, or undefined when
 * it threw (the error is already surfaced to the user).
 */
export async function withNotification<T>(
	loadingMessage: string,
	fn: (handle: NotificationHandle) => Promise<T>,
	done?: (result: T) => string
): Promise<T | undefined> {
	const handle = Notify.loading(loadingMessage);

	try {
		const result = await fn(handle);

		handle.set({
			level: 'success',
			message: done ? done(result) : loadingMessage,
			closeable: true
		});

		return result;
	} catch (err) {
		handle.set({
			level: 'error',
			message: loadingMessage,
			detail: err instanceof Error ? err.message : String(err),
			closeable: true
		});

		return undefined;
	}
}
