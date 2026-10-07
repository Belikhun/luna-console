// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/domains. Every op runs on the primary, which holds the
 * provider credential; there is no bridge that could return the API key.
 */

import type * as core from "../../core/domains";

import { call } from "../rpc";

export type {
	CreateHostnameOptions,
	DomainAuditEntry,
	DomainSettingsView,
	Hostname,
	HostnameOutcome,
	ProviderCheck,
	SettingsPatch,
} from "../../core/domains";
export { DEFAULT_BASE_DOMAIN, DEFAULT_RECORD_TTL, resolveHostname } from "../../core/domains";
export type { NamecheapDomain, NamecheapHost } from "../../core/services/namecheap";

export const domainSettings = call("domains.settings") as typeof core.domainSettings;
export const updateDomainSettings = call("domains.updateSettings") as typeof core.updateDomainSettings;
export const checkDomainProvider = call("domains.check") as typeof core.checkDomainProvider;
export const listHostnames = call("domains.list") as typeof core.listHostnames;
export const getHostname = call("domains.get") as typeof core.getHostname;
export const hostnameRecords = call("domains.records") as typeof core.hostnameRecords;
export const baseDomainRecords = call("domains.baseRecords") as typeof core.baseDomainRecords;
export const createHostname = call("domains.create", { cfg: 0 }) as typeof core.createHostname;
export const updateHostname = call("domains.update") as typeof core.updateHostname;
export const linkHostname = call("domains.link", { cfg: 0 }) as typeof core.linkHostname;
export const unlinkHostname = call("domains.unlink", { cfg: 0 }) as typeof core.unlinkHostname;
export const deleteHostname = call("domains.delete", { cfg: 0 }) as typeof core.deleteHostname;
export const domainAudit = call("domains.audit") as typeof core.domainAudit;
