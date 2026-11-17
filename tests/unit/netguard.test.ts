// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { describe, expect, test } from "bun:test";

import { normalHost, privateAddress, resolveEgress } from "../../src/core/netguard";

const fixed = (addresses: string[]) => async (): Promise<string[]> => addresses;

describe("privateAddress", () => {
	test("private, local and reserved ranges", () => {
		for (const address of [
			"127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
			"100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1",
			"::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1",
			"::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "not-an-address",
		]) {
			expect(privateAddress(address)).toBe(true);
		}
	});

	test("the public internet", () => {
		for (const address of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
			expect(privateAddress(address)).toBe(false);
		}
	});
});

describe("normalHost", () => {
	test("spells hosts as the browser does", () => {
		expect(normalHost("2130706433")).toBe("127.0.0.1");
		expect(normalHost("0177.0.0.1")).toBe("127.0.0.1");
		expect(normalHost("0x7f.1")).toBe("127.0.0.1");
		expect(normalHost("Example.COM")).toBe("example.com");
		expect(normalHost("[::1]")).toBe("::1");
		expect(normalHost("::1")).toBe("::1");
	});
});

describe("resolveEgress", () => {
	test("a public name is dialled at the address that was checked", async () => {
		expect(await resolveEgress("example.com", 443, { resolve: fixed(["93.184.215.14"]) })).toBe("93.184.215.14");
	});

	test("loopback in any spelling is refused", async () => {
		for (const host of ["127.0.0.1", "2130706433", "0177.0.0.1", "0x7f.1", "[::1]", "[::ffff:127.0.0.1]", "localhost"]) {
			await expect(resolveEgress(host, 443, { resolve: fixed(["127.0.0.1"]) })).rejects.toThrow();
		}
	});

	test("a name with any private address is refused", async () => {
		await expect(resolveEgress("mixed.test", 443, { resolve: fixed(["93.184.215.14", "10.0.0.5"]) })).rejects.toThrow();
		await expect(resolveEgress("meta.test", 80, { resolve: fixed(["169.254.169.254"]) })).rejects.toThrow();
		await expect(resolveEgress("nowhere.test", 443, { resolve: fixed([]) })).rejects.toThrow();
	});

	test("low ports other than 80 and 443 are refused", async () => {
		await expect(resolveEgress("example.com", 22, { resolve: fixed(["93.184.215.14"]) })).rejects.toThrow();
		await expect(resolveEgress("example.com", 25, { resolve: fixed(["93.184.215.14"]) })).rejects.toThrow();
		expect(await resolveEgress("example.com", 8443, { resolve: fixed(["93.184.215.14"]) })).toBe("93.184.215.14");
	});

	test("an allowed local pair passes unchecked, and only that pair", async () => {
		expect(await resolveEgress("127.0.0.1", 8415, { allowLocal: ["127.0.0.1:8415"] })).toBe("127.0.0.1");
		await expect(resolveEgress("127.0.0.1", 8416, { allowLocal: ["127.0.0.1:8415"] })).rejects.toThrow();
	});
});
