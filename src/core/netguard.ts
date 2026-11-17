// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Where the daemon may connect on someone else's behalf: the agent's open-web
 * browser loading a page.
 *
 * `privateAddress` says whether an address is anything but the public
 * internet. `resolveEgress` turns a host and port into the one address to
 * dial: the name resolved once, every address it has checked, and the first
 * one returned, so the connection goes where the check looked (no second
 * lookup a rebinding name could answer differently). The host's own
 * addresses are public, but they also reach whatever listens on the host, so
 * only nginx's ports pass there.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

import { t } from "../shared/i18n";

/** Ports the open web is reached on: the web's own, and anything unprivileged. */
const LOW_PORTS = new Set([80, 443]);

/** An IPv6 address as its eight 16-bit groups, or null when it does not parse. */
function ipv6Groups(address: string): number[] | null {
	let text = address.toLowerCase();
	const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);

	if (dotted) {
		const octets = dotted[2]!.split(".").map(Number);

		text = `${dotted[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
	}

	const halves = text.split("::");

	if (halves.length > 2) {
		return null;
	}

	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;

	if (missing < 0 || (halves.length === 1 && missing !== 0)) {
		return null;
	}

	const groups = [...head, ...Array<string>(missing).fill("0"), ...tail].map((group) => parseInt(group, 16));

	return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
		? groups
		: null;
}

function privateIpv4(address: string): boolean {
	const [a = 0, b = 0, c = 0] = address.split(".").map(Number);

	return a === 0
		|| a === 10
		|| a === 127
		|| (a === 100 && b >= 64 && b <= 127)
		|| (a === 169 && b === 254)
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 0 && c === 0)
		|| (a === 192 && b === 168)
		|| (a === 198 && (b === 18 || b === 19))
		|| a >= 224;
}

/**
 * Whether an address is anything but the public internet: loopback, private
 * and link-local ranges (the host, its containers, the LAN, cloud metadata),
 * carrier NAT, multicast and reserved space.
 */
export function privateAddress(address: string): boolean {
	if (isIP(address) === 4) {
		return privateIpv4(address);
	}

	const groups = ipv6Groups(address);

	if (!groups) {
		return true;
	}

	const [first = 0] = groups;
	const v4 = (high: number, low: number): string => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

	// an IPv4 address carried in IPv6 (mapped, compatible or NAT64) is judged as itself
	if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
		return groups[5] === 0 && groups[6] === 0
			? true
			: privateIpv4(v4(groups[6]!, groups[7]!));
	}

	if (first === 0x64 && groups[1] === 0xff9b) {
		return privateIpv4(v4(groups[6]!, groups[7]!));
	}

	return (first & 0xfe00) === 0xfc00
		|| (first & 0xffc0) === 0xfe80
		|| (first & 0xff00) === 0xff00
		|| first === 0x2001 && groups[1] === 0xdb8;
}

/** An address as one spelling: IPv4 as is, IPv6 as its groups, so two spellings compare equal. */
function canonical(address: string): string {
	if (isIP(address) === 4) {
		return address;
	}

	const groups = ipv6Groups(address.replace(/%.*$/, ""));

	if (!groups) {
		return address.toLowerCase();
	}

	// an IPv4-mapped address is the IPv4 address it carries
	if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
		return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
	}

	return groups.map((group) => group.toString(16)).join(":");
}

/** Public addresses of this host that no interface carries (behind NAT); set by `setOwnAddresses`. */
let extraOwn: string[] = [];

/** Tell the guard which public addresses are this host's although no interface carries them. */
export function setOwnAddresses(addresses: string[]): void {
	extraOwn = addresses;
}

/** The host's own addresses: its interfaces, and the public address its hostnames point at. */
export function ownAddresses(): Set<string> {
	const out = new Set<string>();

	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			out.add(canonical(entry.address));
		}
	}

	for (const address of extraOwn) {
		out.add(canonical(address));
	}

	return out;
}

/**
 * A host as the browser would spell it: the WHATWG parser turns decimal, octal
 * and hex IPv4 forms into dotted quads, lowercases names and strips IPv6
 * brackets. Null when it is not a host.
 */
export function normalHost(host: string): string | null {
	try {
		const parsed = new URL(`http://${host.includes(":") && !host.startsWith("[") && isIP(host) === 6 ? `[${host}]` : host}/`);

		return parsed.hostname.replace(/^\[|\]$/g, "") || null;
	} catch {
		return null;
	}
}

/** What may be dialled besides the public internet: `host:port` pairs from the daemon config. */
export interface EgressRules {
	allowLocal?: string[];
	/** Looks a name up; the system resolver unless a test hands its own */
	resolve?: (host: string) => Promise<string[]>;
}

async function systemResolve(host: string): Promise<string[]> {
	return await lookup(host, { all: true, verbatim: true })
		.then((entries) => entries.map((entry) => entry.address))
		.catch(() => [] as string[]);
}

/**
 * The address to dial for a host and port on the open web, or an error saying
 * why not: a port below 1024 other than 80 and 443, a name that does not
 * resolve, any address in a private or reserved range, or the host itself on
 * a port nginx does not serve. A `host:port` the config allows is dialled as
 * resolved, unchecked.
 */
export async function resolveEgress(host: string, port: number, rules: EgressRules = {}): Promise<string> {
	const name = normalHost(host);

	if (!name || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(t("core.netguard.badHost", { host }));
	}

	const resolve = rules.resolve ?? systemResolve;
	const pair = `${name}:${port}`;

	if (rules.allowLocal?.includes(pair)) {
		const [first] = isIP(name)
			? [name]
			: await resolve(name);

		if (!first) {
			throw new Error(t("core.netguard.unresolved", { host: name }));
		}

		return first;
	}

	if (port < 1024 && !LOW_PORTS.has(port)) {
		throw new Error(t("core.netguard.port", { host: name, port: String(port) }));
	}

	const addresses = isIP(name)
		? [name]
		: await resolve(name);

	if (addresses.length === 0) {
		throw new Error(t("core.netguard.unresolved", { host: name }));
	}

	if (addresses.some(privateAddress)) {
		throw new Error(t("core.netguard.private", { host: name }));
	}

	const own = ownAddresses();

	if (!LOW_PORTS.has(port) && addresses.some((address) => own.has(canonical(address)))) {
		throw new Error(t("core.netguard.ownHost", { host: name, port: String(port) }));
	}

	return addresses[0]!;
}
