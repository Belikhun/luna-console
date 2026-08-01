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

/** PATCH a JSON body. */
export function patch<T = any>(path: string, body?: unknown): Promise<T> {
	return api<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
}

/** DELETE a resource. */
export function del<T = any>(path: string): Promise<T> {
	return api<T>(path, { method: 'DELETE' });
}

export interface InstanceRow {
	name: string;
	state: 'running' | 'starting' | 'stopping' | 'stopped' | 'restarting';
	software: string;
	mcVersion: string | null;
	port: number;
	memory: string;
	profile: string;
	javaPid: number | null;
	uptimeMs: number | null;
	players: { online: number; max: number } | null;
	pingVersion: string | null;
	cpu: number | null;
	rssMb: number | null;
	ports: Record<string, number>;
	proxy: { register: boolean; forcedHosts?: string[]; priority?: number } | null;
	external: string | null;
	dir: string;
	checks: Array<{ name: string; ok: boolean | undefined; detail: string }>;
}
