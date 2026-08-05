import type { PortPool, PortPoolOverride } from '$core/types';
import { t } from '$lib/i18n.svelte';

/**
 * Client-side helpers shared by the pool wizard and the machine screen's pools
 * panel. The one rule both enforce: a pool still identical to its built-in
 * default is *omitted* from the PUT payload, so an untouched default stays
 * inherited instead of being frozen into cluster.json by a passing edit.
 */

/** Two reserved lists with the same numbers, order-insensitive. */
function sameReserved(a?: number[], b?: number[]): boolean {
	const left = [...(a ?? [])].sort((x, y) => x - y);
	const right = [...(b ?? [])].sort((x, y) => x - y);

	return left.length === right.length && left.every((port, at) => port === right[at]);
}

/** Whether a draft still matches a baseline definition, overrides included. */
export function samePool(a: PortPool, b: PortPool): boolean {
	if (
		a.id !== b.id ||
		(a.label ?? '') !== (b.label ?? '') ||
		a.protocol !== b.protocol ||
		a.range[0] !== b.range[0] ||
		a.range[1] !== b.range[1] ||
		!sameReserved(a.reserved, b.reserved)
	) {
		return false;
	}

	const machines = new Set([
		...Object.keys(a.overrides ?? {}),
		...Object.keys(b.overrides ?? {})
	]);

	for (const machine of machines) {
		const left: PortPoolOverride = a.overrides?.[machine] ?? {};
		const right: PortPoolOverride = b.overrides?.[machine] ?? {};

		if (
			(left.range?.[0] ?? null) !== (right.range?.[0] ?? null) ||
			(left.range?.[1] ?? null) !== (right.range?.[1] ?? null) ||
			!sameReserved(left.reserved, right.reserved)
		) {
			return false;
		}
	}

	return true;
}

/** The catalog to PUT: every pool that departs from its built-in default. */
export function poolsPayload(catalog: PortPool[], defaults: PortPool[]): PortPool[] {
	return catalog.filter((pool) => {
		const fallback = defaults.find((entry) => entry.id === pool.id);

		return !fallback || !samePool(pool, fallback);
	});
}

/** Human line for a pool's consumers, from the API's consumers map. */
export function consumersLine(
	consumers: Record<string, Array<{ kind: string; name: string; protocol: string; portId?: string }>>,
	poolId: string
): string {
	const wanting = consumers[poolId] ?? [];

	if (!wanting.length) {
		return t('web.pools.noConsumers');
	}

	return wanting
		.map((consumer) =>
			consumer.kind === 'provision'
				? t('web.pools.provisionConsumer')
				: `${consumer.name} (${consumer.protocol}${consumer.portId ? ` · ${consumer.portId}` : ''})`
		)
		.join(', ');
}
