// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * IPv4 and IPv6 addresses and prefixes as numbers: parsing, the canonical
 * text form, containment, and a range split into the fewest prefixes. Pure,
 * so the firewall's core, its renderers and the console's forms all read an
 * address the same way.
 *
 * An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) is read as the IPv4
 * address it carries: a proxy and the kernel both report such a client by its
 * IPv4 address, and a rule written either way must match it.
 */

/** One address or prefix: the family, the first address as a number and the prefix length. */
export interface Cidr {
	family: 4 | 6;
	base: bigint;
	prefix: number;
}

const V4_BITS = 32;
const V6_BITS = 128;

function bits(family: 4 | 6): number {
	return family === 4
		? V4_BITS
		: V6_BITS;
}

function parseV4(text: string): bigint | null {
	const parts = text.split(".");

	if (parts.length !== 4) {
		return null;
	}

	let value = 0n;

	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) {
			return null;
		}

		const octet = Number(part);

		if (octet > 255 || (part.length > 1 && part.startsWith("0"))) {
			return null;
		}

		value = (value << 8n) | BigInt(octet);
	}

	return value;
}

function parseV6(text: string): bigint | null {
	let source = text.toLowerCase();
	let tail: bigint | null = null;

	// a dotted quad at the end stands for the last two groups
	const lastColon = source.lastIndexOf(":");

	if (lastColon >= 0 && source.slice(lastColon + 1).includes(".")) {
		tail = parseV4(source.slice(lastColon + 1));

		if (tail === null) {
			return null;
		}

		source = `${source.slice(0, lastColon + 1)}0:0`;
	}

	const halves = source.split("::");

	if (halves.length > 2) {
		return null;
	}

	const head = halves[0] ? halves[0].split(":") : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

	if (halves.length === 1 && head.length !== 8) {
		return null;
	}

	if (halves.length === 2 && head.length + rest.length > 7) {
		return null;
	}

	const groups = [
		...head,
		...Array<string>(8 - head.length - rest.length).fill("0"),
		...rest,
	];
	let value = 0n;

	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(group)) {
			return null;
		}

		value = (value << 16n) | BigInt(parseInt(group, 16));
	}

	if (tail !== null) {
		value = (value & ~0xffffffffn) | tail;
	}

	return value;
}

/** An address as a number, or null when the text is not one. A mapped IPv4 address comes back as IPv4. */
export function parseAddress(text: string): { family: 4 | 6; value: bigint } | null {
	const trimmed = text.trim();

	if (trimmed.includes(":")) {
		const value = parseV6(trimmed);

		if (value === null) {
			return null;
		}

		if (value >> 32n === 0xffffn) {
			return { family: 4, value: value & 0xffffffffn };
		}

		return { family: 6, value };
	}

	const value = parseV4(trimmed);

	return value === null
		? null
		: { family: 4, value };
}

/** The mask of a prefix length in a family's width. */
function maskOf(family: 4 | 6, prefix: number): bigint {
	const width = bits(family);

	return ((1n << BigInt(width)) - 1n) ^ ((1n << BigInt(width - prefix)) - 1n);
}

/**
 * An address or a prefix (`192.0.2.0/24`, `2001:db8::/32`, a bare address
 * meaning itself), host bits cleared; null when the text is not one.
 */
export function parseCidr(text: string): Cidr | null {
	const [addressText = "", prefixText, extra] = text.trim().split("/");

	if (extra !== undefined) {
		return null;
	}

	const address = parseAddress(addressText);

	if (!address) {
		return null;
	}

	let prefix = bits(address.family);

	if (prefixText !== undefined) {
		if (!/^\d{1,3}$/.test(prefixText)) {
			return null;
		}

		prefix = Number(prefixText);

		// a mapped address written with a v6 prefix length counts its v4 part
		if (address.family === 4 && addressText.includes(":")) {
			prefix -= 96;
		}

		if (prefix < 0 || prefix > bits(address.family)) {
			return null;
		}
	}

	return {
		family: address.family,
		base: address.value & maskOf(address.family, prefix),
		prefix,
	};
}

function formatV4(value: bigint): string {
	return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

/** RFC 5952's text form: lower case, no leading zeros, the longest run of two or more zero groups as `::`. */
function formatV6(value: bigint): string {
	const groups: number[] = [];

	for (let index = 7; index >= 0; index--) {
		groups.push(Number((value >> BigInt(index * 16)) & 0xffffn));
	}

	let bestStart = -1;
	let bestLength = 0;

	for (let index = 0; index < 8;) {
		if (groups[index] !== 0) {
			index++;

			continue;
		}

		let end = index;

		while (end < 8 && groups[end] === 0) {
			end++;
		}

		if (end - index > bestLength && end - index >= 2) {
			bestStart = index;
			bestLength = end - index;
		}

		index = end;
	}

	const hex = groups.map((group) => group.toString(16));

	if (bestStart < 0) {
		return hex.join(":");
	}

	const left = hex.slice(0, bestStart).join(":");
	const right = hex.slice(bestStart + bestLength).join(":");

	return `${left}::${right}`;
}

/** An address's canonical text. */
export function formatAddress(family: 4 | 6, value: bigint): string {
	return family === 4
		? formatV4(value)
		: formatV6(value);
}

/** A prefix's canonical text; a single address is written without its length. */
export function formatCidr(cidr: Cidr): string {
	const address = formatAddress(cidr.family, cidr.base);

	return cidr.prefix === bits(cidr.family)
		? address
		: `${address}/${cidr.prefix}`;
}

/** An address or prefix in its canonical form, or null when the text is not one. */
export function normalizeCidr(text: string): string | null {
	const cidr = parseCidr(text);

	return cidr
		? formatCidr(cidr)
		: null;
}

/** An address in its canonical form, or null when the text is not a single address. */
export function normalizeAddress(text: string): string | null {
	const address = parseAddress(text);

	return address
		? formatAddress(address.family, address.value)
		: null;
}

/** Whether a prefix holds an address. */
export function cidrContains(cidr: Cidr, address: { family: 4 | 6; value: bigint }): boolean {
	if (cidr.family !== address.family) {
		return false;
	}

	return (address.value & maskOf(cidr.family, cidr.prefix)) === cidr.base;
}

/** Whether two prefixes share any address. */
export function cidrOverlaps(left: Cidr, right: Cidr): boolean {
	if (left.family !== right.family) {
		return false;
	}

	const prefix = Math.min(left.prefix, right.prefix);
	const mask = maskOf(left.family, prefix);

	return (left.base & mask) === (right.base & mask);
}

/** Whether any of the prefixes, given as text, holds the address. */
export function anyCidrContains(prefixes: readonly string[], address: string): boolean {
	const parsed = parseAddress(address);

	if (!parsed) {
		return false;
	}

	return prefixes.some((text) => {
		const cidr = parseCidr(text);

		return cidr !== null && cidrContains(cidr, parsed);
	});
}

/** The /64 an IPv6 address is in, as text; an IPv4 address is returned as it is. */
export function banKey(address: string): string | null {
	const parsed = parseAddress(address);

	if (!parsed) {
		return null;
	}

	if (parsed.family === 4) {
		return formatAddress(4, parsed.value);
	}

	return formatCidr({ family: 6, base: parsed.value & maskOf(6, 64), prefix: 64 });
}

/**
 * The fewest prefixes covering exactly `start` to `end` (inclusive), in order:
 * at each step the largest aligned block that starts there and does not pass
 * the end.
 */
export function rangeToCidrs(family: 4 | 6, start: bigint, end: bigint): Cidr[] {
	const width = BigInt(bits(family));
	const out: Cidr[] = [];
	let at = start;

	while (at <= end) {
		let size = 0n;

		// grow the block while it stays aligned at `at` and within the range
		while (size < width) {
			const next = size + 1n;
			const block = 1n << next;

			if ((at & (block - 1n)) !== 0n || at + block - 1n > end) {
				break;
			}

			size = next;
		}

		out.push({ family, base: at, prefix: Number(width - size) });
		at += 1n << size;
	}

	return out;
}
