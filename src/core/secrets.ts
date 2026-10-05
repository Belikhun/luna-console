// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The primitives every bearer credential in luna is built from: console access
 * keys, session tokens and MCP tokens all mint a 256-bit random secret, store
 * only its SHA-256 digest, and compare digests in constant time.
 *
 * SHA-256 is enough because the secret is already 256 bits of randomness; a slow
 * hash protects guessable input, and nothing here is guessable. Passwords are the
 * exception and stay with argon2id in `accounts.ts`.
 */

import { randomBytes } from "node:crypto";

/** 64 bits of id, prefixed so a stray value says what it is. */
export function newId(prefix: string): string {
	return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** A fresh 256-bit secret, URL-safe so it survives a header or a query string. */
export function newSecret(): string {
	return randomBytes(32).toString("base64url");
}

/** SHA-256 hex. Only ever applied to values that are already 256-bit random. */
export function digest(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/**
 * Compare two hex digests without leaking where they diverge. The token arrives
 * from the client, so the lookup is an attacker-controlled comparison.
 */
export function sameDigest(left: string, right: string): boolean {
	if (left.length !== right.length) {
		return false;
	}

	let diff = 0;

	for (let i = 0; i < left.length; i++) {
		diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}

	return diff === 0;
}

/**
 * Split a `<id>.<secret>` bearer into its halves, or null when it has no id. The
 * id travels in the clear so a lookup is one row, never a scan of every digest.
 */
export function splitBearer(bearer: string): { id: string; secret: string } | null {
	const split = bearer.indexOf(".");

	if (split <= 0 || split === bearer.length - 1) {
		return null;
	}

	return { id: bearer.slice(0, split), secret: bearer.slice(split + 1) };
}
