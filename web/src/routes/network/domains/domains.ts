// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Shapes the domains screen renders, as the API answers them. */

export interface SettingsView {
	provider: { kind: 'namecheap'; apiUser: string; userName: string; clientIp: string; sandbox?: boolean; apiKeyHint: string } | null;
	baseDomain: string;
	publicAddress: string | null;
	effectiveAddress: string | null;
	ttl: number;
	dropUnsupported: boolean;
	configured: boolean;
}

export interface HostnameRow {
	fqdn: string;
	label: string;
	address: string;
	instance: string | null;
	createdAt: number;
	createdBy: string;
	updatedAt: number;
}

export interface RecordRow {
	key: string;
	name: string;
	type: string;
	address: string;
	mxPref?: number;
	ttl?: number;
}

export interface AuditRow {
	key: string;
	t: number;
	actor: string;
	action: string;
	hostname?: string;
	instance?: string;
	detail?: string;
}
