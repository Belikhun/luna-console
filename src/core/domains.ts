// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Hostnames for instances: a name under the configured base domain
 * (`create.mc.belikhun.dev` under `mc.belikhun.dev`) pointing at the proxy,
 * and optionally linked to one instance as a velocity forced host, so a client
 * connecting by that name lands straight on that server instead of the lobby.
 * Modded clients need exactly that: they cannot join a vanilla lobby first.
 *
 * The DNS provider is Namecheap (`services/namecheap.ts`), whose API replaces a
 * whole zone on every write. So every change here is a read-modify-write that:
 *
 * - backs the full zone up first (`.data/dns-backups/<zone>/`),
 * - computes the new record set touching only the names it was asked about,
 * - writes, reads the zone back, and if anything else moved restores the
 *   backup and fails, so a record luna does not manage is never lost.
 *
 * Nothing outside the base domain is ever created, edited or deleted, and only
 * single labels directly under it are hostnames. Buying domains is not here:
 * it spends money and cannot be undone.
 *
 * `domains.json` holds the provider credential, so like `mcp.json` it is
 * primary-local and never mirrored; the console that uses it runs beside the
 * primary. The API key is write-only: reads return a hint.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ClusterConfig } from "./types";
import { t } from "../shared/i18n";
import { saveCluster, statePath } from "./config";
import { setProxyRegistration, syncVelocityToml } from "./proxy";
import { getStatus, sendCommand } from "./instances";
import {
	getNamecheapZone,
	listNamecheapDomains,
	setNamecheapZone,
	type NamecheapCredentials,
	type NamecheapDomain,
	type NamecheapHost,
	type NamecheapZone,
} from "./services/namecheap";

const STORE_FILE = "domains.json";

/** Audit entries kept. */
export const DOMAINS_MAX_AUDIT = 500;

/** Base domain a fresh install uses until an operator changes it. */
export const DEFAULT_BASE_DOMAIN = "mc.belikhun.dev";

/** TTL of the records luna writes; short, so a moved proxy is picked up quickly. */
export const DEFAULT_RECORD_TTL = 300;

/** How long the account's domain list is trusted before it is fetched again. */
const DOMAIN_LIST_TTL_MS = 10 * 60_000;

/** Zone backups kept per zone. */
const MAX_BACKUPS = 50;

/**
 * Record types `setHosts` can write back as they were read (its documented
 * RecordType list, minus CAA, whose flag and tag luna does not read back).
 *
 * SRV is not among them, and that is harmless, as measured on belikhun.dev on
 * 2026-10-07: `getHosts` does not return SRV records at all, and `setHosts`
 * leaves the zone's existing ones in place, while one sent in a write is
 * answered with success and silently not stored. So SRV records are only ever
 * created in Namecheap's dashboard, and no write of luna's can remove them.
 */
export const ROUNDTRIP_TYPES = ["A", "AAAA", "ALIAS", "CNAME", "MX", "MXE", "NS", "TXT", "URL", "URL301", "FRAME"];

export interface DomainProvider {
	kind: "namecheap";
	apiUser: string;
	userName: string;
	apiKey: string;
	clientIp: string;
	sandbox?: boolean;
}

export interface DomainSettings {
	provider: DomainProvider | null;
	/** Every hostname is one label directly under this */
	baseDomain: string;
	/** Where the records point; the provider's client IP when unset */
	publicAddress: string | null;
	ttl: number;
	/**
	 * Whether a write may drop records the API returns but cannot send back
	 * (see ROUNDTRIP_TYPES; in practice CAA). Off by default, so such a zone is
	 * never written until an operator accepts losing them; the backup keeps them.
	 */
	dropUnsupported: boolean;
}

export interface Hostname {
	fqdn: string;
	/** The label under the base domain */
	label: string;
	address: string;
	instance: string | null;
	createdAt: number;
	createdBy: string;
	updatedAt: number;
}

export type DomainAuditAction =
	| "settings.update"
	| "hostname.create"
	| "hostname.update"
	| "hostname.delete"
	| "hostname.link"
	| "hostname.unlink";

export interface DomainAuditEntry {
	t: number;
	actor: string;
	action: DomainAuditAction;
	hostname?: string;
	instance?: string;
	detail?: string;
}

interface DomainStore {
	settings: DomainSettings;
	hostnames: Hostname[];
	audit: DomainAuditEntry[];
}

/** Settings as a reader sees them: the key replaced by a hint. */
export interface DomainSettingsView {
	provider: (Omit<DomainProvider, "apiKey"> & { apiKeyHint: string }) | null;
	baseDomain: string;
	publicAddress: string | null;
	effectiveAddress: string | null;
	ttl: number;
	dropUnsupported: boolean;
	configured: boolean;
}

export interface SettingsPatch {
	provider?: Partial<DomainProvider> | null;
	baseDomain?: string;
	publicAddress?: string | null;
	ttl?: number;
	dropUnsupported?: boolean;
}

function storePath(): string {
	return statePath(STORE_FILE);
}

function backupDir(zone: string): string {
	return join(dirname(storePath()), "dns-backups", zone);
}

function defaultStore(): DomainStore {
	return {
		settings: { provider: null, baseDomain: DEFAULT_BASE_DOMAIN, publicAddress: null, ttl: DEFAULT_RECORD_TTL, dropUnsupported: false },
		hostnames: [],
		audit: [],
	};
}

async function loadStore(): Promise<DomainStore> {
	if (!existsSync(storePath())) {
		return defaultStore();
	}

	const store: DomainStore = await Bun.file(storePath()).json();
	const fallback = defaultStore();

	store.settings = { ...fallback.settings, ...(store.settings ?? {}) };
	store.hostnames ??= [];
	store.audit ??= [];

	return store;
}

async function saveStore(store: DomainStore): Promise<void> {
	const sorted: DomainStore = {
		settings: store.settings,
		hostnames: [...store.hostnames].sort((left, right) => left.fqdn.localeCompare(right.fqdn)),
		audit: store.audit.slice(-DOMAINS_MAX_AUDIT),
	};

	await mkdir(dirname(storePath()), { recursive: true });
	await Bun.write(storePath(), JSON.stringify(sorted, null, "\t") + "\n");
}

/**
 * Every change runs through this chain: two zone edits racing would each read
 * the zone, add their record and write, and the second write would drop the
 * first one's record.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
	const next = writeChain.then(work, work);

	writeChain = next.catch(() => undefined);

	return next;
}

function audit(store: DomainStore, entry: Omit<DomainAuditEntry, "t">): void {
	store.audit.push({ t: Date.now(), ...entry });
}

function view(settings: DomainSettings): DomainSettingsView {
	const provider = settings.provider;

	return {
		provider: provider
			? {
				kind: provider.kind,
				apiUser: provider.apiUser,
				userName: provider.userName,
				clientIp: provider.clientIp,
				sandbox: provider.sandbox,
				apiKeyHint: provider.apiKey ? `…${provider.apiKey.slice(-4)}` : "",
			}
			: null,
		baseDomain: settings.baseDomain,
		publicAddress: settings.publicAddress,
		effectiveAddress: settings.publicAddress ?? provider?.clientIp ?? null,
		ttl: settings.ttl,
		dropUnsupported: settings.dropUnsupported,
		configured: Boolean(provider?.apiKey),
	};
}

function credentials(settings: DomainSettings): NamecheapCredentials {
	const provider = settings.provider;

	if (!provider?.apiKey) {
		throw new Error(t("core.domains.notConfigured"));
	}

	return {
		apiUser: provider.apiUser,
		apiKey: provider.apiKey,
		userName: provider.userName || provider.apiUser,
		clientIp: provider.clientIp,
		sandbox: provider.sandbox,
	};
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * The hostname a caller means, from a bare label (`create`) or a full name
 * (`create.mc.belikhun.dev`); refused when it is not one label directly under
 * the base domain.
 */
export function resolveHostname(input: string, baseDomain: string): { fqdn: string; label: string } {
	const clean = input.trim().toLowerCase().replace(/\.$/, "");
	const base = baseDomain.toLowerCase();
	const label = clean.endsWith(`.${base}`)
		? clean.slice(0, -(base.length + 1))
		: clean;

	if (!LABEL.test(label)) {
		throw new Error(t("core.domains.badLabel", { name: input.trim(), base }));
	}

	return { fqdn: `${label}.${base}`, label };
}

let domainCache: { at: number; key: string; domains: NamecheapDomain[] } | undefined;

async function accountDomains(settings: DomainSettings, fresh = false): Promise<NamecheapDomain[]> {
	const creds = credentials(settings);
	const key = `${creds.apiUser}|${creds.userName}|${creds.sandbox ? 1 : 0}`;

	if (!fresh && domainCache && domainCache.key === key && Date.now() - domainCache.at < DOMAIN_LIST_TTL_MS) {
		return domainCache.domains;
	}

	const domains = await listNamecheapDomains(creds);

	domainCache = { at: Date.now(), key, domains };

	return domains;
}

/** The registered domain (zone) holding the base domain, and the base's name inside it. */
async function baseZone(settings: DomainSettings): Promise<{ zone: string; prefix: string }> {
	const base = settings.baseDomain.toLowerCase();
	const domains = await accountDomains(settings);
	const zone = domains
		.map((domain) => domain.name)
		.filter((name) => base === name || base.endsWith(`.${name}`))
		.sort((left, right) => right.length - left.length)[0];

	if (!zone) {
		throw new Error(t("core.domains.zoneNotOwned", { base }));
	}

	return { zone, prefix: base === zone ? "" : base.slice(0, -(zone.length + 1)) };
}

/** A record name relative to the zone, for a label under the base. */
function relativeName(label: string, prefix: string): string {
	return prefix ? `${label}.${prefix}` : label;
}

function sameRecord(left: NamecheapHost, right: NamecheapHost): boolean {
	// Namecheap reports an MX preference on every record, but it only means
	// something on MX ones; comparing it elsewhere would fail every write
	const mx = left.type === "MX" || left.type === "MXE";

	return left.name.toLowerCase() === right.name.toLowerCase()
		&& left.type === right.type
		&& left.address.replace(/\.$/, "").toLowerCase() === right.address.replace(/\.$/, "").toLowerCase()
		&& (!mx || (left.mxPref ?? null) === (right.mxPref ?? null));
}

/** Records of `zone` whose name is not in `names`, as a comparable multiset. */
function untouched(zone: NamecheapZone, names: Set<string>): NamecheapHost[] {
	return zone.hosts.filter((host) => !names.has(host.name.toLowerCase()));
}

function sameSet(left: NamecheapHost[], right: NamecheapHost[]): boolean {
	if (left.length !== right.length) {
		return false;
	}

	const pool = [...right];

	for (const host of left) {
		const index = pool.findIndex((candidate) => sameRecord(candidate, host));

		if (index < 0) {
			return false;
		}

		pool.splice(index, 1);
	}

	return true;
}

async function backupZone(zone: NamecheapZone, actor: string): Promise<string> {
	const dir = backupDir(zone.domain);

	await mkdir(dir, { recursive: true });

	const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

	await Bun.write(file, JSON.stringify({ takenAt: Date.now(), actor, zone }, null, "\t") + "\n");

	const all = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();

	for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) {
		await Bun.file(join(dir, old)).delete();
	}

	return file;
}

/**
 * Edit the records at `names` (relative to the zone) and nothing else. `edit`
 * gets the zone's current records at those names and returns what they should
 * become; every other record is carried over verbatim and checked after the
 * write, with the backup restored if any of them moved.
 */
async function editZone(
	settings: DomainSettings,
	zoneName: string,
	names: string[],
	edit: (current: NamecheapHost[]) => NamecheapHost[],
	actor: string,
): Promise<{ before: NamecheapHost[]; after: NamecheapHost[]; backup: string; dropped: NamecheapHost[] }> {
	const creds = credentials(settings);
	const zone = await getNamecheapZone(creds, zoneName);

	if (!zone.usingOurDns) {
		throw new Error(t("core.domains.notOurDns", { zone: zoneName }));
	}

	const unsupported = zone.hosts.filter((host) => !ROUNDTRIP_TYPES.includes(host.type));

	if (unsupported.length > 0 && !settings.dropUnsupported) {
		throw new Error(t("core.domains.unsupportedRecords", {
			zone: zoneName,
			records: unsupported.map((host) => `${host.name} ${host.type}`).join(", "),
		}));
	}

	const touched = new Set(names.map((name) => name.toLowerCase()));
	const current = zone.hosts.filter((host) => touched.has(host.name.toLowerCase()) && ROUNDTRIP_TYPES.includes(host.type));
	const desired = edit(current);

	for (const host of desired) {
		if (!touched.has(host.name.toLowerCase())) {
			throw new Error(`internal: an edit of ${[...touched].join(", ")} produced a record at ${host.name}`);
		}
	}

	const keep = untouched(zone, touched).filter((host) => ROUNDTRIP_TYPES.includes(host.type));
	const backup = await backupZone(zone, actor);

	await setNamecheapZone(creds, zoneName, [...keep, ...desired], zone.emailType);

	const reread = await getNamecheapZone(creds, zoneName);
	const intact = sameSet(untouched(reread, touched).filter((host) => ROUNDTRIP_TYPES.includes(host.type)), keep);
	const landed = sameSet(reread.hosts.filter((host) => touched.has(host.name.toLowerCase())), desired);

	if (!intact || !landed) {
		await setNamecheapZone(creds, zoneName, zone.hosts, zone.emailType).catch(() => undefined);

		throw new Error(t("core.domains.writeMismatch", { zone: zoneName, backup }));
	}

	return { before: current, after: desired, backup, dropped: unsupported };
}

/** Whether velocity is up to take a reload; a stopped proxy reads velocity.toml when it starts. */
async function reloadVelocity(cfg: ClusterConfig): Promise<boolean> {
	const status = await getStatus(cfg, "proxy").catch(() => undefined);

	if (!status || status.state === "stopped") {
		return false;
	}

	return await sendCommand(cfg, "proxy", "velocity reload");
}

/** Add or remove one forced host on an instance, then land it in velocity. */
async function setForcedHost(cfg: ClusterConfig, instance: string, fqdn: string, present: boolean): Promise<{ velocityReloaded: boolean }> {
	const inst = cfg.instances[instance];

	if (!inst) {
		throw new Error(t("core.proxy.notRegistrable", { name: instance }));
	}

	const hosts = (inst.proxy?.forcedHosts ?? []).filter((host) => host !== fqdn);

	if (present) {
		hosts.push(fqdn);
	}

	// a forced host routes nothing to a server velocity does not know, so
	// linking registers the instance; unlinking leaves the registration alone
	const result = setProxyRegistration(cfg, instance, {
		forcedHosts: hosts,
		...(present ? { register: true } : {}),
	});

	if (result.changed.length > 0) {
		await saveCluster(cfg);
	}

	await syncVelocityToml(cfg);

	return { velocityReloaded: await reloadVelocity(cfg) };
}

//* ===========================================================
//*  Public surface
//* ===========================================================

/** Settings, with the API key replaced by a hint. */
export async function domainSettings(): Promise<DomainSettingsView> {
	return view((await loadStore()).settings);
}

/** Change the provider credential, the base domain, the record address or the TTL. */
export async function updateDomainSettings(patch: SettingsPatch, actor: string): Promise<DomainSettingsView> {
	return await serialized(async () => {
		const store = await loadStore();
		const settings = store.settings;
		const changed: string[] = [];

		if (patch.provider === null) {
			settings.provider = null;
			changed.push("provider");
		} else if (patch.provider) {
			const next: DomainProvider = {
				kind: "namecheap",
				apiUser: patch.provider.apiUser ?? settings.provider?.apiUser ?? "",
				userName: patch.provider.userName ?? settings.provider?.userName ?? "",
				apiKey: patch.provider.apiKey || settings.provider?.apiKey || "",
				clientIp: patch.provider.clientIp ?? settings.provider?.clientIp ?? "",
				sandbox: patch.provider.sandbox ?? settings.provider?.sandbox,
			};

			if (!next.apiUser || !next.apiKey || !IPV4.test(next.clientIp)) {
				throw new Error(t("core.domains.badProvider"));
			}

			settings.provider = next;
			changed.push("provider");
		}

		if (patch.baseDomain !== undefined) {
			const base = patch.baseDomain.trim().toLowerCase().replace(/\.$/, "");

			if (!DOMAIN.test(base)) {
				throw new Error(t("core.domains.badBase", { base: patch.baseDomain }));
			}

			settings.baseDomain = base;
			changed.push("baseDomain");
		}

		if (patch.publicAddress !== undefined) {
			if (patch.publicAddress !== null && !IPV4.test(patch.publicAddress.trim())) {
				throw new Error(t("core.domains.badAddress", { address: patch.publicAddress }));
			}

			settings.publicAddress = patch.publicAddress?.trim() || null;
			changed.push("publicAddress");
		}

		if (patch.dropUnsupported !== undefined) {
			settings.dropUnsupported = patch.dropUnsupported === true;
			changed.push("dropUnsupported");
		}

		if (patch.ttl !== undefined) {
			if (!Number.isInteger(patch.ttl) || patch.ttl < 60 || patch.ttl > 86400) {
				throw new Error(t("core.domains.badTtl"));
			}

			settings.ttl = patch.ttl;
			changed.push("ttl");
		}

		domainCache = undefined;
		// the record never holds the key, only which fields changed
		audit(store, { actor, action: "settings.update", detail: changed.join(", ") });
		await saveStore(store);

		return view(settings);
	});
}

export interface ProviderCheck {
	ok: boolean;
	error?: string;
	domains: NamecheapDomain[];
	/** The zone holding the base domain, when the account owns one */
	zone: string | null;
}

/** Call the provider once (the domain list) to prove the credential and the whitelisted IP work. */
export async function checkDomainProvider(): Promise<ProviderCheck> {
	const settings = (await loadStore()).settings;

	try {
		const domains = await accountDomains(settings, true);
		const zone = await baseZone(settings).then((found) => found.zone, () => null);

		return { ok: true, domains, zone };
	} catch (err) {
		return { ok: false, error: (err as Error).message, domains: [], zone: null };
	}
}

/** Hostnames luna manages, newest first. */
export async function listHostnames(): Promise<Hostname[]> {
	return [...(await loadStore()).hostnames].sort((left, right) => right.createdAt - left.createdAt);
}

/** One managed hostname, by label or full name; null when luna does not manage it. */
export async function getHostname(name: string): Promise<Hostname | null> {
	const store = await loadStore();
	const { fqdn } = resolveHostname(name, store.settings.baseDomain);

	return store.hostnames.find((entry) => entry.fqdn === fqdn) ?? null;
}

/** The DNS records currently at a hostname, read live from the provider. */
export async function hostnameRecords(name: string): Promise<{ fqdn: string; zone: string; records: NamecheapHost[] }> {
	const settings = (await loadStore()).settings;
	const { fqdn, label } = resolveHostname(name, settings.baseDomain);
	const { zone, prefix } = await baseZone(settings);
	const relative = relativeName(label, prefix).toLowerCase();
	const live = await getNamecheapZone(credentials(settings), zone);

	return { fqdn, zone, records: live.hosts.filter((host) => host.name.toLowerCase() === relative) };
}

/** Every record under the base domain, read live, to show what the zone holds there. */
export async function baseDomainRecords(): Promise<{ zone: string; baseDomain: string; records: NamecheapHost[] }> {
	const settings = (await loadStore()).settings;
	const { zone, prefix } = await baseZone(settings);
	const live = await getNamecheapZone(credentials(settings), zone);
	const suffix = prefix ? `.${prefix}` : "";

	return {
		zone,
		baseDomain: settings.baseDomain,
		records: live.hosts.filter((host) => {
			const name = host.name.toLowerCase();

			return prefix
				? name === prefix || name.endsWith(suffix)
				: true;
		}),
	};
}

export interface CreateHostnameOptions {
	/** Instance to link it to right away */
	instance?: string;
	/** Address override for this hostname; the settings' address otherwise */
	address?: string;
	/** Take over a name that already has an A record (it is replaced) */
	adopt?: boolean;
}

export interface HostnameOutcome {
	hostname: Hostname;
	records: NamecheapHost[];
	backup?: string;
	/** Records the write could not carry over (only with dropUnsupported) */
	dropped?: NamecheapHost[];
	velocityReloaded?: boolean;
}

/**
 * Create a hostname under the base domain: an A record at the proxy's public
 * address, managed by luna from then on, and linked to an instance when one is
 * named. Refuses a name that already has records unless `adopt` is set, and
 * never touches a name whose records are anything other than A/AAAA/CNAME.
 */
export async function createHostname(
	cfg: ClusterConfig,
	name: string,
	opts: CreateHostnameOptions,
	actor: string,
): Promise<HostnameOutcome> {
	return await serialized(async () => {
		const store = await loadStore();
		const settings = store.settings;
		credentials(settings);

		const { fqdn, label } = resolveHostname(name, settings.baseDomain);
		const address = (opts.address ?? settings.publicAddress ?? settings.provider?.clientIp ?? "").trim();

		if (!IPV4.test(address)) {
			throw new Error(t("core.domains.badAddress", { address: address || "?" }));
		}

		if (store.hostnames.some((entry) => entry.fqdn === fqdn)) {
			throw new Error(t("core.domains.exists", { fqdn }));
		}

		if (opts.instance && !cfg.instances[opts.instance]) {
			throw new Error(t("core.proxy.notRegistrable", { name: opts.instance }));
		}

		const { zone, prefix } = await baseZone(settings);
		const relative = relativeName(label, prefix);

		const written = await editZone(settings, zone, [relative], (current) => {
			const foreign = current.filter((host) => !["A", "AAAA", "CNAME"].includes(host.type));

			if (foreign.length > 0) {
				throw new Error(t("core.domains.foreignRecords", { fqdn, types: [...new Set(foreign.map((host) => host.type))].join(", ") }));
			}

			if (current.length > 0 && !opts.adopt) {
				throw new Error(t("core.domains.recordsExist", { fqdn }));
			}

			return [{ name: relative, type: "A", address, ttl: settings.ttl }];
		}, actor);

		const now = Date.now();
		const hostname: Hostname = { fqdn, label, address, instance: null, createdAt: now, createdBy: actor, updatedAt: now };

		store.hostnames.push(hostname);
		audit(store, { actor, action: "hostname.create", hostname: fqdn, detail: address });

		let velocityReloaded: boolean | undefined;

		if (opts.instance) {
			velocityReloaded = (await setForcedHost(cfg, opts.instance, fqdn, true)).velocityReloaded;
			hostname.instance = opts.instance;
			audit(store, { actor, action: "hostname.link", hostname: fqdn, instance: opts.instance });
		}

		await saveStore(store);

		return { hostname, records: written.after, backup: written.backup, dropped: written.dropped, velocityReloaded };
	});
}

/** Point a managed hostname at another address. */
export async function updateHostname(name: string, patch: { address: string }, actor: string): Promise<HostnameOutcome> {
	return await serialized(async () => {
		const store = await loadStore();
		const settings = store.settings;
		const { fqdn, label } = resolveHostname(name, settings.baseDomain);
		const hostname = store.hostnames.find((entry) => entry.fqdn === fqdn);
		const address = patch.address.trim();

		if (!hostname) {
			throw new Error(t("core.domains.unmanaged", { fqdn }));
		}

		if (!IPV4.test(address)) {
			throw new Error(t("core.domains.badAddress", { address }));
		}

		const { zone, prefix } = await baseZone(settings);
		const relative = relativeName(label, prefix);
		const written = await editZone(settings, zone, [relative], () => [{ name: relative, type: "A", address, ttl: settings.ttl }], actor);

		hostname.address = address;
		hostname.updatedAt = Date.now();
		audit(store, { actor, action: "hostname.update", hostname: fqdn, detail: address });
		await saveStore(store);

		return { hostname, records: written.after, backup: written.backup, dropped: written.dropped };
	});
}

/** Link a managed hostname to an instance (moving it off any other one). */
export async function linkHostname(cfg: ClusterConfig, name: string, instance: string, actor: string): Promise<HostnameOutcome> {
	return await serialized(async () => {
		const store = await loadStore();
		const { fqdn } = resolveHostname(name, store.settings.baseDomain);
		const hostname = store.hostnames.find((entry) => entry.fqdn === fqdn);

		if (!hostname) {
			throw new Error(t("core.domains.unmanaged", { fqdn }));
		}

		if (!cfg.instances[instance]) {
			throw new Error(t("core.proxy.notRegistrable", { name: instance }));
		}

		if (hostname.instance && hostname.instance !== instance && cfg.instances[hostname.instance]) {
			await setForcedHost(cfg, hostname.instance, fqdn, false);
		}

		const { velocityReloaded } = await setForcedHost(cfg, instance, fqdn, true);

		hostname.instance = instance;
		hostname.updatedAt = Date.now();
		audit(store, { actor, action: "hostname.link", hostname: fqdn, instance });
		await saveStore(store);

		return { hostname, records: [], velocityReloaded };
	});
}

/** Unlink a hostname from its instance; the DNS record stays. */
export async function unlinkHostname(cfg: ClusterConfig, name: string, actor: string): Promise<HostnameOutcome> {
	return await serialized(async () => {
		const store = await loadStore();
		const { fqdn } = resolveHostname(name, store.settings.baseDomain);
		const hostname = store.hostnames.find((entry) => entry.fqdn === fqdn);

		if (!hostname) {
			throw new Error(t("core.domains.unmanaged", { fqdn }));
		}

		let velocityReloaded: boolean | undefined;
		const previous = hostname.instance;

		if (previous && cfg.instances[previous]) {
			velocityReloaded = (await setForcedHost(cfg, previous, fqdn, false)).velocityReloaded;
		}

		hostname.instance = null;
		hostname.updatedAt = Date.now();
		audit(store, { actor, action: "hostname.unlink", hostname: fqdn, instance: previous ?? undefined });
		await saveStore(store);

		return { hostname, records: [], velocityReloaded };
	});
}

/** Delete a managed hostname: unlink it, remove its records, forget it. */
export async function deleteHostname(cfg: ClusterConfig, name: string, actor: string): Promise<HostnameOutcome> {
	return await serialized(async () => {
		const store = await loadStore();
		const settings = store.settings;
		const { fqdn, label } = resolveHostname(name, settings.baseDomain);
		const hostname = store.hostnames.find((entry) => entry.fqdn === fqdn);

		if (!hostname) {
			throw new Error(t("core.domains.unmanaged", { fqdn }));
		}

		let velocityReloaded: boolean | undefined;

		if (hostname.instance && cfg.instances[hostname.instance]) {
			velocityReloaded = (await setForcedHost(cfg, hostname.instance, fqdn, false)).velocityReloaded;
		}

		const { zone, prefix } = await baseZone(settings);
		const relative = relativeName(label, prefix);

		// only the A record luna wrote goes; anything added there by hand stays
		const written = await editZone(settings, zone, [relative], (current) => current.filter((host) => host.type !== "A"), actor);

		store.hostnames = store.hostnames.filter((entry) => entry.fqdn !== fqdn);
		audit(store, { actor, action: "hostname.delete", hostname: fqdn, instance: hostname.instance ?? undefined });
		await saveStore(store);

		return { hostname, records: written.before, backup: written.backup, dropped: written.dropped, velocityReloaded };
	});
}

/** The audit trail, newest first. */
export async function domainAudit(limit = 100): Promise<DomainAuditEntry[]> {
	return (await loadStore()).audit.slice(-limit).reverse();
}
