// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Client for the Namecheap API (`api.namecheap.com/xml.response`).
 *
 * Every request carries the API user, the key, the account username and the
 * client IP, and Namecheap refuses any IP that is not whitelisted on the
 * account, so a fresh key fails until the machine's public address is added.
 * Answers are XML; the handful of elements luna reads are flat, attribute-only
 * tags, so a small attribute reader is enough and no XML library is pulled in.
 *
 * The DNS API has no per-record call: `getHosts` returns the whole zone and
 * `setHosts` replaces it, the mail setting included. Everything that edits a
 * zone therefore goes through `core/domains.ts`, which backs the zone up,
 * checks that only the records it meant to touch changed, and verifies the
 * write by reading the zone back.
 */

const ENDPOINT = "https://api.namecheap.com/xml.response";
const SANDBOX_ENDPOINT = "https://api.sandbox.namecheap.com/xml.response";
const REQUEST_TIMEOUT_MS = 30_000;

export interface NamecheapCredentials {
	apiUser: string;
	apiKey: string;
	/** The account the calls act on; the API user unless a reseller sub-account */
	userName: string;
	/** The whitelisted address the calls come from */
	clientIp: string;
	sandbox?: boolean;
}

/** One record as Namecheap stores it. `name` is relative to the zone, `@` for the apex. */
export interface NamecheapHost {
	name: string;
	type: string;
	address: string;
	mxPref?: number;
	ttl?: number;
}

export interface NamecheapZone {
	domain: string;
	usingOurDns: boolean;
	/** MX, MXE, FWD, OX, ... ; must be sent back on every write or mail settings reset */
	emailType: string | null;
	hosts: NamecheapHost[];
}

export interface NamecheapDomain {
	name: string;
	expires: string | null;
	isExpired: boolean;
	isOurDns: boolean;
	autoRenew: boolean;
}

/** A refusal from Namecheap, with its error number when it gave one. */
export class NamecheapError extends Error {
	constructor(message: string, readonly code?: string) {
		super(message);
	}
}

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&amp;/g, "&");
}

/** Attributes of every `<tag .../>` or `<tag ...>` in an XML document. */
export function xmlElements(xml: string, tag: string): Record<string, string>[] {
	const out: Record<string, string>[] = [];
	const pattern = new RegExp(`<${tag}(\\s[^>]*?)?\\s*/?>`, "gi");

	for (const match of xml.matchAll(pattern)) {
		const attrs: Record<string, string> = {};

		for (const attr of (match[1] ?? "").matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) {
			attrs[attr[1]!] = decodeEntities(attr[2]!);
		}

		out.push(attrs);
	}

	return out;
}

/** Run one API command; resolves to the response XML, throws a NamecheapError on a refusal. */
export async function namecheapCall(
	creds: NamecheapCredentials,
	command: string,
	params: Record<string, string> = {},
): Promise<string> {
	const body = new URLSearchParams({
		ApiUser: creds.apiUser,
		ApiKey: creds.apiKey,
		UserName: creds.userName,
		ClientIp: creds.clientIp,
		Command: command,
		...params,
	});

	// POST, because a setHosts call for a busy zone outgrows a URL
	// LUNA_NAMECHEAP_API points a test cluster at a stand-in server; never set in production
	const endpoint = process.env.LUNA_NAMECHEAP_API || (creds.sandbox ? SANDBOX_ENDPOINT : ENDPOINT);
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	const xml = await response.text();

	if (!response.ok) {
		throw new NamecheapError(`Namecheap answered HTTP ${response.status}`);
	}

	const status = /<ApiResponse[^>]*Status="([^"]+)"/i.exec(xml)?.[1];

	if (status?.toUpperCase() !== "OK") {
		const error = /<Error\s+Number="([^"]*)"[^>]*>([\s\S]*?)<\/Error>/i.exec(xml);
		const message = error ? decodeEntities(error[2]!.trim()) : "Namecheap refused the request";

		throw new NamecheapError(message, error?.[1]);
	}

	return xml;
}

function bool(value: string | undefined): boolean {
	return (value ?? "").toLowerCase() === "true";
}

/** The domains on the account (first 100, which is the API's page ceiling). */
export async function listNamecheapDomains(creds: NamecheapCredentials): Promise<NamecheapDomain[]> {
	const xml = await namecheapCall(creds, "namecheap.domains.getList", { PageSize: "100" });

	return xmlElements(xml, "Domain").map((attrs) => ({
		name: (attrs.Name ?? "").toLowerCase(),
		expires: attrs.Expires || null,
		isExpired: bool(attrs.IsExpired),
		isOurDns: bool(attrs.IsOurDNS),
		autoRenew: bool(attrs.AutoRenew),
	})).filter((domain) => domain.name);
}

/** Split a registered domain into the SLD and TLD the DNS commands take. */
export function splitDomain(domain: string): { sld: string; tld: string } {
	const dot = domain.indexOf(".");

	if (dot <= 0) {
		throw new NamecheapError(`"${domain}" is not a registered domain name`);
	}

	return { sld: domain.slice(0, dot), tld: domain.slice(dot + 1) };
}

/** Every record of a zone, and its mail setting. */
export async function getNamecheapZone(creds: NamecheapCredentials, domain: string): Promise<NamecheapZone> {
	const { sld, tld } = splitDomain(domain);
	const xml = await namecheapCall(creds, "namecheap.domains.dns.getHosts", { SLD: sld, TLD: tld });
	const result = xmlElements(xml, "DomainDNSGetHostsResult")[0] ?? {};

	const hosts = xmlElements(xml, "host").map((attrs): NamecheapHost => {
		const host: NamecheapHost = {
			name: attrs.Name ?? "@",
			type: (attrs.Type ?? "").toUpperCase(),
			address: attrs.Address ?? "",
		};

		if (attrs.MXPref !== undefined && attrs.MXPref !== "") {
			host.mxPref = Number(attrs.MXPref);
		}

		if (attrs.TTL !== undefined && attrs.TTL !== "") {
			host.ttl = Number(attrs.TTL);
		}

		return host;
	});

	return {
		domain,
		usingOurDns: bool(result.IsUsingOurDNS),
		emailType: result.EmailType || null,
		hosts,
	};
}

/** Replace a zone's records. Callers go through `core/domains.ts`; see the module header. */
export async function setNamecheapZone(
	creds: NamecheapCredentials,
	domain: string,
	hosts: NamecheapHost[],
	emailType: string | null,
): Promise<void> {
	const { sld, tld } = splitDomain(domain);
	const params: Record<string, string> = { SLD: sld, TLD: tld };

	hosts.forEach((host, index) => {
		const n = index + 1;

		params[`HostName${n}`] = host.name;
		params[`RecordType${n}`] = host.type;
		params[`Address${n}`] = host.address;

		if (host.mxPref !== undefined) {
			params[`MXPref${n}`] = String(host.mxPref);
		}

		if (host.ttl !== undefined) {
			params[`TTL${n}`] = String(host.ttl);
		}
	});

	if (emailType) {
		params.EmailType = emailType;
	}

	const xml = await namecheapCall(creds, "namecheap.domains.dns.setHosts", params);
	const result = xmlElements(xml, "DomainDNSSetHostsResult")[0];

	if (!bool(result?.IsSuccess)) {
		throw new NamecheapError(`Namecheap did not confirm the write to ${domain}`);
	}
}
