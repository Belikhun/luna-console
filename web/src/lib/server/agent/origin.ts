// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Where this console answers on loopback. The agent's subprocess reaches
 * `/api/mcp` through it rather than through the address the browser used,
 * which behind nginx is a public name the host may not even resolve to itself.
 */
export function loopbackOrigin(url: URL): string {
	const port = process.env.PORT || url.port || (url.protocol === 'https:' ? '443' : '80');

	return `http://127.0.0.1:${port}`;
}
