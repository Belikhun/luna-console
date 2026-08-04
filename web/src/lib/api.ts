export class ApiError extends Error {
	constructor(
		message: string,
		public status: number
	) {
		super(message);
	}
}

/**
 * Call a console API route. Non-2xx responses become an ApiError carrying the
 * route's own message where it sent one, so pages can surface it verbatim.
 */
export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`/api${path}`, {
		headers: { 'Content-Type': 'application/json' },
		...init
	});

	if (!res.ok) {
		let msg = `${res.status}`;

		try {
			const body = await res.json();

			msg = body.message ?? body.error ?? JSON.stringify(body);
		} catch {
			// no JSON body — the status code is all we can report
		}

		throw new ApiError(msg, res.status);
	}

	return res.json();
}

/** POST a JSON body. */
export function post<T = any>(path: string, body?: unknown): Promise<T> {
	return api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

/** PUT a JSON body. */
export function put<T = any>(path: string, body?: unknown): Promise<T> {
	return api<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });
}

/** PATCH a JSON body. */
export function patch<T = any>(path: string, body?: unknown): Promise<T> {
	return api<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
}

/** DELETE a resource. */
export function del<T = any>(path: string): Promise<T> {
	return api<T>(path, { method: 'DELETE' });
}

/**
 * A picked file's bytes as base64, for JSON upload bodies — the console
 * uploads as JSON rather than multipart because SvelteKit's CSRF check
 * rejects form posts when the served origin is ambiguous.
 */
export function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();

		reader.onload = () => {
			// readAsDataURL yields "data:<mime>;base64,<data>" — the payload
			// starts after the comma
			const text = String(reader.result);

			resolve(text.slice(text.indexOf(',') + 1));
		};

		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

export interface InstanceRow {
	name: string;
	state:
		| 'running'
		| 'starting'
		| 'stopping'
		| 'stopped'
		| 'restarting'
		| 'provisioning'
		| 'deleting'
		| 'unknown';
	software: string;
	mcVersion: string | null;
	/** null on a placeholder row for a mid-provision instance */
	port: number | null;
	/** host:port the instance answers on — its owning machine's, not always loopback */
	address: string | null;
	memory: string;
	profile: string;
	javaPid: number | null;
	uptimeMs: number | null;
	players: { online: number; max: number } | null;
	pingVersion: string | null;
	cpu: number | null;
	rssMb: number | null;
	/** From LunaCore's heartbeat — null when the plugin is not reporting for this instance */
	tps: number | null;
	heapUsedMb: number | null;
	heapMaxMb: number | null;
	/** ONLINE | MAINT | OFFLINE as the proxy sees it */
	lunaStatus: string | null;
	lunaDisplayName: string | null;
	lastHeartbeatMs: number | null;
	ports: Record<string, number>;
	proxy: { register: boolean; forcedHosts?: string[]; priority?: number } | null;
	external: string | null;
	/** owning daemon — null on the primary's own instances */
	daemon: string | null;
	dir: string;
	checks: Array<{ name: string; ok: boolean | undefined; detail: string }>;
}
