// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";

import { startEgress } from "../../src/core/egress";
import type { EgressProxy } from "../../src/core/egress";

let upstream: ReturnType<typeof Bun.serve>;

/** Send raw bytes to the proxy and read until it closes or goes quiet. */
async function exchange(port: number, request: string): Promise<string> {
	return await new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port });
		let out = "";
		const done = (): void => {
			socket.destroy();
			resolve(out);
		};

		socket.on("data", (chunk) => {
			out += chunk.toString("latin1");
		});
		socket.on("close", done);
		socket.on("error", done);
		socket.write(request);
		setTimeout(done, 2000);
	});
}

beforeAll(() => {
	upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("hello from upstream") });
});

afterAll(() => {
	upstream.stop(true);
});

describe("the egress proxy", () => {
	let proxy: EgressProxy;
	const refused: string[] = [];

	beforeAll(async () => {
		proxy = await startEgress({
			maxBytes: 1024 * 1024,
			allowLocal: [`127.0.0.1:${upstream.port}`],
			resolve: async (host) => (host === "rebind.test" ? ["127.0.0.1"] : []),
			onRefuse: (target) => refused.push(target),
		});
	});

	afterAll(() => {
		proxy.close();
	});

	test("a plain request to an allowed pair goes through, closed after one exchange", async () => {
		const reply = await exchange(proxy.port, `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nConnection: keep-alive\r\n\r\n`);

		expect(reply).toContain("200");
		expect(reply).toContain("hello from upstream");
		expect(proxy.bytes).toBeGreaterThan(0);
	});

	test("a tunnel to an allowed pair is opened", async () => {
		const reply = await exchange(proxy.port, `CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\n\r\nGET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);

		expect(reply).toContain("200 Connection Established");
		expect(reply).toContain("hello from upstream");
	});

	test("loopback, a name resolving to it and a low port are refused", async () => {
		expect(await exchange(proxy.port, "CONNECT 127.0.0.1:22 HTTP/1.1\r\n\r\n")).toContain("403");
		expect(await exchange(proxy.port, "CONNECT rebind.test:443 HTTP/1.1\r\n\r\n")).toContain("403");
		expect(await exchange(proxy.port, "GET http://2130706433:8080/ HTTP/1.1\r\n\r\n")).toContain("403");
		expect(await exchange(proxy.port, "GET http://[::1]:8080/ HTTP/1.1\r\n\r\n")).toContain("403");
		expect(refused.length).toBe(4);
	});

	test("anything but a full http address is refused as a plain request", async () => {
		expect(await exchange(proxy.port, "GET / HTTP/1.1\r\n\r\n")).toContain("403");
		expect(await exchange(proxy.port, "GET ftp://example.com/ HTTP/1.1\r\n\r\n")).toContain("403");
	});

	test("past the allowance new connections are refused", async () => {
		const small = await startEgress({ maxBytes: 1, allowLocal: [`127.0.0.1:${upstream.port}`] });

		try {
			await exchange(small.port, `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: x\r\n\r\n`);

			expect(await exchange(small.port, `CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\n\r\n`)).toContain("403");
		} finally {
			small.close();
		}
	});
});
