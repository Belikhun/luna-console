import { t } from "../../shared/i18n";

/**
 * Shared file helpers for the provider clients: verified downloads and
 * hashing. Every provider publishes a different hash (Modrinth sha512, Hangar
 * sha256, CurseForge sha1, Smithed none), so a download verifies whatever the
 * provider knew and always returns the sha512 luna's lockfiles key identity on.
 */

/** User-Agent every outbound provider request carries. */
export const USER_AGENT = "belikhun/luna-control";

/** The hashes a provider published for a file, by algorithm. */
export interface KnownHashes {
	sha512?: string;
	sha256?: string;
	sha1?: string;
}

const HASH_ALGOS = ["sha512", "sha256", "sha1"] as const;

/**
 * Download a file to `dest`, verifying every hash the provider published.
 * Returns the sha512 of what was written; computed locally, so callers can
 * record it even when the provider never published one.
 */
export async function download(
	url: string,
	dest: string,
	expected: KnownHashes = {},
): Promise<string> {
	const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

	if (!res.ok) {
		throw new Error(t("core.services.downloadFailed", { status: res.status, url }));
	}

	const buf = new Uint8Array(await res.arrayBuffer());

	for (const algo of HASH_ALGOS) {
		const want = expected[algo];

		if (!want) {
			continue;
		}

		const hasher = new Bun.CryptoHasher(algo);

		hasher.update(buf);

		if (hasher.digest("hex") !== want.toLowerCase()) {
			throw new Error(t("core.services.hashMismatch", { algo, url }));
		}
	}

	await Bun.write(dest, buf);

	const hasher = new Bun.CryptoHasher("sha512");

	hasher.update(buf);

	return hasher.digest("hex");
}

/** sha512 of a file on disk, in the hex form the lockfiles store. */
export async function sha512File(path: string): Promise<string> {
	const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
	const hasher = new Bun.CryptoHasher("sha512");

	hasher.update(buf);

	return hasher.digest("hex");
}

/**
 * Every hash a provider might have published for this file, computed in one
 * read. Identifying a local file against a project means comparing against
 * whichever algorithm its provider happens to publish, and the file is on disk
 * either way; so all three are cheaper than guessing which one is needed.
 */
export async function hashesOfFile(path: string): Promise<Required<KnownHashes>> {
	const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
	const out = {} as Record<(typeof HASH_ALGOS)[number], string>;

	for (const algo of HASH_ALGOS) {
		const hasher = new Bun.CryptoHasher(algo);

		hasher.update(buf);
		out[algo] = hasher.digest("hex");
	}

	return out as Required<KnownHashes>;
}
