/** Helpers shared by the API routes. */

/**
 * Message from an unknown thrown value. Core functions reject with plain Errors
 * carrying a user-facing message, which is what the routes forward as the HTTP
 * body — so this never invents text of its own.
 */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Parse a JSON request body, treating an absent or malformed one as empty. */
export async function jsonBody(request: Request): Promise<any> {
	return await request.json().catch(() => ({}));
}

/** Response headers for every stream in the console — SSE only, never WebSockets. */
export const SSE_HEADERS = {
	'Content-Type': 'text/event-stream',
	'Cache-Control': 'no-cache',
	Connection: 'keep-alive'
};

/**
 * Close a stream controller, ignoring the error thrown when the client has
 * already disconnected — by then the stream is closed either way.
 */
export function closeQuietly(controller: ReadableStreamDefaultController): void {
	try {
		controller.close();
	} catch {
		// already closed by the client
	}
}
