<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import { api, post } from '$lib/api';
	import { countryName, firewallHref, fmtSpan, looksLikeAddress, reasonLabel, ruleTitle } from '$lib/firewall';
	import { fmtDateTime } from '$lib/format';
	import { t } from '$lib/i18n.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import FirewallMatchers from '$lib/components/FirewallMatchers.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import GeoAttribution from '$lib/components/GeoAttribution.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { Column } from '$lib/components/table';
	import type { EndedBan, FirewallRule, FirewallVerdict } from '$shared/firewall';

	/**
	 * What the proxy would do with a connection from one address, step by step.
	 * Nothing is sent to the address; the proxy reads its own rules. The check
	 * lives in the address bar, so a shortcut from another screen lands on a
	 * result and Back returns to the last one.
	 */
	let {
		you = null,
		canBan,
		canConfigure,
		onopenrule,
		onban,
		onaddrule,
		onchange
	}: {
		you?: string | null;
		canBan: boolean;
		canConfigure: boolean;
		/** Open a rule's editor */
		onopenrule: (id: string) => void;
		onban: (address: string) => void;
		/** Open the rule editor for this address, as an allow rule or a deny rule */
		onaddrule: (address: string, action: 'allow' | 'deny') => void;
		/** A ban was lifted here: the page's own figures are stale */
		onchange: () => void;
	} = $props();

	const uid = $props.id();

	type Answer = FirewallVerdict & { geoCountry: string | null; history: EndedBan[] };

	interface Step {
		id: string;
		name: string;
		state: string;
		label: string;
		sentence: string;
		/** The check stopped before this step */
		skipped: boolean;
		rule?: FirewallRule;
	}

	const asked = $derived(page.url.searchParams.get('address')?.trim() ?? '');

	let address = $state('');
	let touched = $state(false);
	let result = $state<Answer | null>(null);
	let checking = $state(false);
	let error = $state('');
	let lifting = $state(false);
	let serial = 0;

	const bad = $derived.by((): string | null => {
		const typed = address.trim();

		if (!touched || typed === '') {
			return null;
		}

		if (typed.includes('/')) {
			return t('web.firewall.check.notPrefix');
		}

		return looksLikeAddress(typed)
			? null
			: t('web.firewall.check.badAddress');
	});

	// the form shows what the address bar asks for; a shortcut from another screen fills it
	$effect(() => {
		const wanted = asked;

		untrack(() => {
			address = wanted;
			touched = wanted !== '';
			void run(wanted);
		});
	});

	/** Ask the proxy; `quiet` is the page's background refresh, which never dims the result on screen. */
	async function run(wanted: string, quiet = false): Promise<void> {
		const mine = ++serial;

		error = '';

		if (wanted === '' || !looksLikeAddress(wanted)) {
			result = null;
			checking = false;

			return;
		}

		checking = !quiet;

		try {
			const answer = await api<Answer>(`/firewall/check?ip=${encodeURIComponent(wanted)}`);

			if (mine === serial) {
				result = answer;
			}
		} catch (err) {
			if (mine === serial) {
				result = null;
				error = (err as Error).message;
			}
		} finally {
			if (mine === serial) {
				checking = false;
			}
		}
	}

	/** Run the check in the address bar again; the page's refresh calls this. */
	export function load(): Promise<void> {
		return run(asked, true);
	}

	function submit(): void {
		touched = true;

		const wanted = address.trim();

		if (!looksLikeAddress(wanted)) {
			return;
		}

		const href = firewallHref('check', { address: wanted });

		// the same check asked again is run again rather than navigated to
		if (href === page.url.pathname + page.url.search) {
			void run(asked);

			return;
		}

		void goto(href, { keepFocus: true, noScroll: true });
	}

	async function lift(): Promise<void> {
		const ban = result?.ban;

		if (!ban) {
			return;
		}

		lifting = true;

		try {
			const { outcomes } = await post('/firewall/bans', { action: 'remove', ips: [ban.ip] });

			if (outcomes[0]?.ok) {
				Notify.success(t('web.firewall.bans.liftedOne', { address: ban.ip }));
			} else {
				Notify.error(t('web.firewall.bans.liftFailed'), { detail: outcomes[0]?.error });
			}
		} catch (err) {
			Notify.error(t('web.firewall.bans.liftFailed'), { detail: (err as Error).message });
		} finally {
			lifting = false;
		}

		await run(asked, true);
		onchange();
	}

	// the proxy's own order (ban, protected, allow, deny); it reports each
	// part, and the steps lay them out so the reader sees where it stopped
	const steps = $derived.by((): Step[] => {
		if (!result) {
			return [];
		}

		const out: Step[] = [];
		let stopped = false;

		const push = (step: Omit<Step, 'skipped'>, stops: boolean): void => {
			out.push({ ...step, skipped: stopped });

			if (stops) {
				stopped = true;
			}
		};

		const ban = result.ban;

		push({
			id: 'ban',
			name: t('web.firewall.check.stepBan'),
			state: ban ? 'failed' : 'ok',
			label: ban ? t('web.firewall.check.refused') : t('web.firewall.check.passes'),
			sentence: !ban
				? t('web.firewall.check.notBanned')
				: ban.expiresAtEpochMillis === 0
					? t('web.firewall.check.bannedForever', { by: banBy(ban.source, ban.actor) })
					: t('web.firewall.check.bannedUntil', { until: fmtDateTime(ban.expiresAtEpochMillis), by: banBy(ban.source, ban.actor) })
		}, !!ban);

		if (!result.enabled) {
			push({
				id: 'off',
				name: t('web.firewall.check.stepRules'),
				state: 'stopped',
				label: t('web.firewall.check.off'),
				sentence: t('web.firewall.check.firewallOff')
			}, true);

			return out;
		}

		push({
			id: 'protected',
			name: t('web.firewall.check.stepProtected'),
			state: result.protected ? 'ok' : 'stopped',
			label: result.protected ? t('web.firewall.check.letIn') : t('web.firewall.check.noMatch'),
			sentence: result.protected
				? t('web.firewall.check.isProtected')
				: t('web.firewall.check.notProtected')
		}, result.protected);

		const allow = result.allowedBy;

		push({
			id: 'allow',
			name: t('web.firewall.check.stepAllow'),
			state: allow ? 'ok' : 'stopped',
			label: allow ? t('web.firewall.check.letIn') : t('web.firewall.check.noMatch'),
			sentence: allow
				? t('web.firewall.check.allowMatch', { rule: ruleTitle(allow) })
				: t('web.firewall.check.noAllow'),
			rule: allow ?? undefined
		}, !!allow);

		const deny = result.deniedBy[0];

		push({
			id: 'deny',
			name: t('web.firewall.check.stepDeny'),
			state: deny ? 'failed' : 'ok',
			label: deny ? t('web.firewall.check.refused') : t('web.firewall.check.passes'),
			sentence: deny
				? t('web.firewall.check.denyMatch', { rule: ruleTitle(deny) })
				: t('web.firewall.check.noDeny'),
			rule: deny
		}, !!deny);

		push({
			id: 'detectors',
			name: t('web.firewall.check.stepDetectors'),
			state: 'ok',
			label: t('web.firewall.check.watched'),
			sentence: t('web.firewall.check.detectors')
		}, false);

		return out;
	});

	function banBy(source: string, actor: string): string {
		return source === 'manual'
			? actor || t('web.firewall.bans.manual')
			: reasonLabel(source);
	}

	const verdict = $derived.by((): { state: string; label: string } | null => {
		if (!result) {
			return null;
		}

		if (result.outcome === 'banned') {
			return { state: 'failed', label: t('web.firewall.check.verdictBanned') };
		}

		if (result.outcome === 'denied') {
			return { state: 'failed', label: t('web.firewall.check.verdictDenied') };
		}

		return result.allowedBy
			? { state: 'ok', label: t('web.firewall.check.verdictAllowRule') }
			: { state: 'ok', label: t('web.firewall.check.verdictAllowed') };
	});

	// the proxy counts every ban the address has had, the one in force included
	const strikesBefore = $derived(result
		? (result.ban ? result.strikes - 1 : result.strikes)
		: 0);

	const country = $derived(result?.geoCountry ?? result?.countries[0] ?? null);
	const title = $derived(result
		? country
			? `${result.ip} · ${country} ${countryName(country)}`
			: result.ip
		: asked);

	const matching = $derived(result
		? [...(result.allowedBy ? [result.allowedBy] : []), ...result.deniedBy]
		: []);

	const ruleColumns: Column[] = $derived([
		{ id: 'action', label: t('web.firewall.rules.col.action'), width: 110 },
		{ id: 'match', label: t('web.firewall.rules.col.matches'), minWidth: 240 },
		{ id: 'note', label: t('web.firewall.rules.col.note'), minWidth: 160 }
	]);

	const historyColumns: Column[] = $derived([
		{ id: 'created', label: t('web.firewall.bans.col.created'), width: 170 },
		{ id: 'length', label: t('web.firewall.bans.col.length'), width: 120 },
		{ id: 'source', label: t('web.firewall.bans.col.source'), width: 170 },
		{ id: 'ended', label: t('web.firewall.bans.col.ended'), minWidth: 180 },
		{ id: 'hits', label: t('web.firewall.bans.col.hits'), width: 150, align: 'right' }
	]);
</script>

<Panel title={t('web.firewall.check.title')} description={t('web.firewall.check.hint')}>
	<form
		class="form"
		onsubmit={(event) => {
			event.preventDefault();
			submit();
		}}
	>
		<!-- a field, not a label: the error and the button are not the control's name -->
		<div class="field address">
			<label class="lbl" for="{uid}-address">{t('web.firewall.check.address')}</label>
			<input
				id="{uid}-address"
				aria-describedby={bad ? `${uid}-address-error` : undefined}
				aria-invalid={!!bad}
				class="input mono"
				class:bad={!!bad}
				type="text"
				spellcheck="false"
				autocomplete="off"
				placeholder="198.51.100.9"
				bind:value={address}
			/>
			{#if bad}
				<span class="err" id="{uid}-address-error">{bad}</span>
			{/if}
			{#if you && address.trim() !== you}
				<span class="more">
					<Btn variant="link" onclick={() => (address = you ?? '')}>{t('web.firewall.check.useMine')}</Btn>
				</span>
			{/if}
		</div>

		<div class="go">
			<Btn variant="primary" icon="magnifyingGlass" type="submit" loading={checking}>{t('web.firewall.check.run')}</Btn>
		</div>
	</form>
</Panel>

{#if error}
	<Panel title={title}>
		<Flash kind="error">{t('web.firewall.check.failed', { message: error })}</Flash>
		<Btn icon="arrowRotateRight" loading={checking} onclick={() => void run(asked)}>{t('web.common.retry')}</Btn>
	</Panel>
{:else if !result && checking}
	<Panel title={title}>
		<ol class="layers" aria-busy="true" aria-label={t('web.firewall.check.layers')}>
			{#each [1, 2, 3, 4] as line (line)}
				<li class="layer ghost"><span class="bone"></span></li>
			{/each}
		</ol>
	</Panel>
{:else if result}
	<Panel title={title}>
		{#snippet actions()}
			{#if result?.ban}
				<Btn
					icon="handshake"
					loading={lifting}
					disabled={!canBan}
					title={canBan ? undefined : t('web.common.notAllowed', { action: 'player:Moderate' })}
					onclick={lift}
				>
					{t('web.firewall.bans.lift')}
				</Btn>
			{:else}
				<Btn
					icon="ban"
					disabled={!canBan}
					title={canBan ? undefined : t('web.common.notAllowed', { action: 'player:Moderate' })}
					onclick={() => onban(result!.ip)}
				>
					{t('web.firewall.ban.action')}
				</Btn>
			{/if}
			<Btn
				icon="plus"
				disabled={!canConfigure}
				title={canConfigure ? undefined : t('web.common.notAllowed', { action: 'firewall:Configure' })}
				onclick={() => onaddrule(result!.ip, result!.outcome === 'allowed' ? 'deny' : 'allow')}
			>
				{t('web.firewall.check.addRule')}
			</Btn>
		{/snippet}

		{#if verdict}
			<Flash kind={verdict.state === 'failed' ? 'error' : 'success'}>
				<b>{verdict.label}</b>
				{#if strikesBefore > 0}
					{t('web.firewall.check.strikes', { count: strikesBefore })}
				{/if}
			</Flash>
		{/if}

		<ol class="layers" class:stale={checking} aria-label={t('web.firewall.check.layers')}>
			{#each steps as row, index (row.id)}
				<li class="layer" class:skipped={row.skipped}>
					<span class="step" aria-hidden="true">{index + 1}</span>
					<span class="name"><b>{row.name}</b></span>
					<span class="state">
						{#if row.skipped}
							<StatusBadge state="stopped" label={t('web.firewall.check.notReached')} />
						{:else}
							<StatusBadge state={row.state} label={row.label} />
						{/if}
					</span>
					<span class="words">{row.sentence}</span>
					{#if row.rule}
						<span class="act">
							<Btn
								variant="link"
								disabled={!canConfigure}
								title={canConfigure ? undefined : t('web.common.notAllowed', { action: 'firewall:Configure' })}
								onclick={() => onopenrule(row.rule!.id)}
							>
								{t('web.firewall.check.openRule')}
							</Btn>
						</span>
					{/if}
				</li>
			{/each}
		</ol>

		{#if country}
			<p class="notes dim"><GeoAttribution /></p>
		{/if}
	</Panel>

	<Panel title={t('web.firewall.check.rulesTitle')} count={matching.length} flush>
		<DataTable
			tableId="network-firewall-check-rules"
			columns={ruleColumns}
			rows={matching}
			getId={(rule) => rule.id}
			rowLabel={(rule) => ruleTitle(rule)}
			rowDim={(rule) => !rule.enabled}
			rowActions={(rule) => [
				{
					label: t('web.firewall.rules.edit'),
					icon: 'pen',
					disabled: !canConfigure,
					action: () => onopenrule(rule.id)
				},
				{
					label: t('web.firewall.check.openInRules'),
					icon: 'arrowRight',
					action: () => goto(firewallHref('rules', { q: rule.id }))
				}
			]}
			emptyTitle={t('web.firewall.check.noRules')}
		>
			{#snippet cell(rule, col)}
				{#if col === 'action'}
					<StatusBadge state={rule.action === 'allow' ? 'ok' : 'failed'} label={t(`web.firewall.action.${rule.action}`)} />
				{:else if col === 'match'}
					<FirewallMatchers {rule} />
				{:else if col === 'note'}
					{#if rule.note}
						{rule.note}
					{:else}
						<span class="dim">–</span>
					{/if}
				{/if}
			{/snippet}
		</DataTable>
	</Panel>

	<Panel title={t('web.firewall.check.bansTitle')} count={result.history.length} flush>
		<DataTable
			tableId="network-firewall-check-bans"
			columns={historyColumns}
			rows={result.history}
			getId={(ban) => `${ban.ip}@${ban.createdAtEpochMillis}`}
			emptyTitle={result.ban ? t('web.firewall.bans.firstBan') : t('web.firewall.check.neverBanned')}
		>
			{#snippet cell(ban, col)}
				{#if col === 'created'}
					<DateTime at={ban.createdAtEpochMillis} text={fmtDateTime(ban.createdAtEpochMillis)} />
				{:else if col === 'length'}
					{ban.expiresAtEpochMillis === 0
						? t('web.firewall.bans.permanent')
						: fmtSpan(ban.expiresAtEpochMillis - ban.createdAtEpochMillis)}
				{:else if col === 'source'}
					{banBy(ban.source, ban.actor)}
				{:else if col === 'ended'}
					{ban.ended === 'lifted' && ban.endedBy
						? t('web.firewall.bans.liftedBy', { actor: ban.endedBy })
						: t(`web.firewall.bans.state.${ban.ended}`)}
				{:else if col === 'hits'}
					{ban.hits}
				{/if}
			{/snippet}
		</DataTable>
	</Panel>
{:else}
	<Panel>
		<div class="empty">
			<span class="glyph"><Icon name="magnifyingGlass" size="1.5rem" /></span>
			<b>{t('web.firewall.check.emptyTitle')}</b>
			<span class="dim">{t('web.firewall.check.emptyText')}</span>
		</div>
	</Panel>
{/if}

<style lang="scss">
	.form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0 1rem;

		.address {
			width: 22rem;
			max-width: 100%;
		}
	}

	.input.bad {
		border-color: var(--error);
		box-shadow: 0 0 0 0.1rem var(--error);
	}

	.more {
		display: block;
		margin-top: 0.375rem;
		font-size: 0.875rem;
	}

	// level with the field's control, under its label
	.go {
		padding-top: 1.5rem;

		@include below($bp-narrow) {
			padding-top: 0;
		}
	}

	.layers {
		margin: 0;
		padding: 0;
		list-style: none;

		&.stale {
			opacity: 0.6;
		}
	}

	// step mark, step, verdict, what it means, what to do about it
	.layer {
		display: grid;
		grid-template-columns: 2rem 12rem 9rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 0;
		font-size: 0.875rem;

		& + & {
			border-top: 0.1rem solid var(--border-divider);
		}

		&.skipped {
			opacity: 0.6;
		}

		// two lines when narrow: the step and its verdict, then the sentence and its action
		@include below($bp-medium) {
			grid-template-columns: 2rem minmax(0, 1fr) auto;

			.words {
				grid-column: 2 / -1;
			}

			.act {
				grid-column: 2 / -1;
				justify-self: start;
			}
		}
	}

	.step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border: 0.1rem solid var(--border);
		border-radius: 50%;
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.name,
	.words {
		min-width: 0;
	}

	.act {
		justify-self: end;
	}

	.ghost {
		display: block;
	}

	// a step's line at its own height while the answer is out
	.bone {
		display: block;
		height: 1.5rem;
		border-radius: 0.25rem;
		background: var(--bg-hover);
	}

	.notes {
		margin: 0.75rem 0 0;
		font-size: 0.875rem;
	}

	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.375rem;
		padding: 2rem 1rem;
		text-align: center;
		font-size: 0.875rem;

		b {
			color: var(--text-heading);
		}

		.glyph {
			color: var(--text-secondary);
		}
	}
</style>
