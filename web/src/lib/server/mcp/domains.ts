// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The domain tools (`domains` / `domains-write`): hostnames under the network's
 * base domain, each optionally routed to one instance as a velocity forced
 * host. DNS is shared by the whole network, so every write is closed to
 * instance-limited tokens; a link additionally names its instance, which the
 * catalog's instanceArg checks.
 */

import { loadCluster } from '$core/config';
import {
	baseDomainRecords,
	createHostname,
	deleteHostname,
	domainSettings,
	hostnameRecords,
	linkHostname,
	listHostnames,
	unlinkHostname,
	updateHostname
} from '$core/domains';
import type { HostnameOutcome } from '$core/domains';
import { pushEvent } from '$lib/server/luna';
import { optBool, optStr, requireWholeCluster, str } from './args';
import { ToolError } from './errors';
import type { ToolHandler } from './errors';

function outcome(result: HostnameOutcome): Record<string, unknown> {
	return {
		hostname: result.hostname.fqdn,
		address: result.hostname.address,
		instance: result.hostname.instance,
		records: result.records.map((record) => ({ name: record.name, type: record.type, address: record.address })),
		velocityReloaded: result.velocityReloaded ?? null,
		zoneBackup: result.backup ?? null
	};
}

async function attempt<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (err) {
		throw new ToolError((err as Error).message);
	}
}

export const DOMAIN_HANDLERS: Record<string, ToolHandler> = {
	async domain_list() {
		const [settings, hostnames] = await Promise.all([domainSettings(), listHostnames()]);

		return {
			baseDomain: settings.baseDomain,
			address: settings.effectiveAddress,
			configured: settings.configured,
			dropsUnsupportedRecords: settings.dropUnsupported,
			hostnames: hostnames.map((entry) => ({
				hostname: entry.fqdn,
				instance: entry.instance,
				address: entry.address,
				createdBy: entry.createdBy,
				createdAt: new Date(entry.createdAt).toISOString()
			}))
		};
	},

	async domain_records(args) {
		const name = optStr(args, 'name')?.trim();

		if (name) {
			return await attempt(() => hostnameRecords(name));
		}

		return await attempt(() => baseDomainRecords());
	},

	async domain_create(args, ctx) {
		requireWholeCluster(ctx, 'DNS');

		const cfg = await loadCluster();
		const instance = optStr(args, 'instance')?.trim() || undefined;
		const result = await attempt(() => createHostname(cfg, str(args, 'name'), {
			instance,
			address: optStr(args, 'address')?.trim() || undefined,
			adopt: optBool(args, 'adopt') === true
		}, ctx.actor));

		pushEvent(instance ?? 'proxy', 'action', `hostname ${result.hostname.fqdn} created${instance ? ` for ${instance}` : ''} by ${ctx.actor}`);

		return {
			...outcome(result),
			note: 'a new DNS name can take a few minutes to resolve everywhere; players connect to it on the default port'
		};
	},

	async domain_update(args, ctx) {
		requireWholeCluster(ctx, 'DNS');

		const result = await attempt(() => updateHostname(str(args, 'name'), { address: str(args, 'address') }, ctx.actor));

		pushEvent(result.hostname.instance ?? 'proxy', 'action', `hostname ${result.hostname.fqdn} pointed at ${result.hostname.address} by ${ctx.actor}`);

		return outcome(result);
	},

	async domain_link(args, ctx) {
		requireWholeCluster(ctx, 'DNS');

		const cfg = await loadCluster();
		const instance = str(args, 'instance');
		const result = await attempt(() => linkHostname(cfg, str(args, 'name'), instance, ctx.actor));

		pushEvent(instance, 'action', `hostname ${result.hostname.fqdn} linked by ${ctx.actor}`);

		return outcome(result);
	},

	async domain_unlink(args, ctx) {
		requireWholeCluster(ctx, 'DNS');

		const cfg = await loadCluster();
		const result = await attempt(() => unlinkHostname(cfg, str(args, 'name'), ctx.actor));

		pushEvent('proxy', 'action', `hostname ${result.hostname.fqdn} unlinked by ${ctx.actor}`);

		return outcome(result);
	},

	async domain_delete(args, ctx) {
		requireWholeCluster(ctx, 'DNS');

		const cfg = await loadCluster();
		const result = await attempt(() => deleteHostname(cfg, str(args, 'name'), ctx.actor));

		pushEvent(result.hostname.instance ?? 'proxy', 'action', `hostname ${result.hostname.fqdn} deleted by ${ctx.actor}`);

		return { ...outcome(result), deleted: true };
	}
};
