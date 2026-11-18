<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';

	import { post } from '$lib/api';
	import { banLadder, fmtSpan, looksLikeRange, parseList, sentenceParts } from '$lib/firewall';
	import { t } from '$lib/i18n.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import FirewallMatchers from '$lib/components/FirewallMatchers.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import { FIREWALL_DETECTORS, type FirewallDetector, type FirewallSettings } from '$shared/firewall';

	/**
	 * When the proxy bans an address by itself and for how long, plus the
	 * switches that apply to the whole firewall: one form, saved explicitly.
	 * The numbers are held as typed, so a half-typed one is marked rather than
	 * snapped to something else.
	 */
	let {
		settings,
		protectedRanges,
		canConfigure,
		you = null,
		dirty = $bindable(false),
		onsaved
	}: {
		/** The stored settings; null while the page's first read is out */
		settings: FirewallSettings | null;
		/** Ranges the proxy never refuses, whatever the form says */
		protectedRanges: string[];
		canConfigure: boolean;
		you?: string | null;
		/** Whether the form holds edits not saved yet, for the page's leave guard */
		dirty: boolean;
		onsaved: () => void;
	} = $props();

	interface Form {
		enabled: boolean;
		hidePingFromRefused: boolean;
		loginFlood: boolean;
		loginFloodPerMinute: string;
		pingScan: boolean;
		pingScanCount: string;
		pingScanMinutes: string;
		failedLogins: boolean;
		failedLoginCount: string;
		failedLoginMinutes: string;
		suspiciousNames: boolean;
		namePatterns: string;
		banMinutes: string;
		repeatMultiplier: string;
		maxBanDays: string;
		protect: string;
	}

	/** What a fresh proxy starts with; "reset to defaults" fills the form with these. */
	const DEFAULTS: Omit<Form, 'enabled' | 'protect'> = {
		hidePingFromRefused: true,
		loginFlood: false,
		loginFloodPerMinute: '20',
		pingScan: false,
		pingScanCount: '30',
		pingScanMinutes: '10',
		failedLogins: false,
		failedLoginCount: '8',
		failedLoginMinutes: '10',
		suspiciousNames: false,
		namePatterns: '',
		banMinutes: '60',
		repeatMultiplier: '4',
		maxBanDays: '30'
	};

	function formOf(from: FirewallSettings): Form {
		return {
			enabled: from.enabled,
			hidePingFromRefused: from.hidePingFromRefused,
			loginFlood: from.loginFlood,
			loginFloodPerMinute: String(from.loginFloodPerMinute),
			pingScan: from.pingScan,
			pingScanCount: String(from.pingScanCount),
			pingScanMinutes: String(from.pingScanMinutes),
			failedLogins: from.failedLogins,
			failedLoginCount: String(from.failedLoginCount),
			failedLoginMinutes: String(from.failedLoginMinutes),
			suspiciousNames: from.suspiciousNames,
			namePatterns: from.namePatterns.join('\n'),
			banMinutes: String(from.banMinutes),
			repeatMultiplier: String(from.repeatMultiplier),
			maxBanDays: String(from.maxBanDays),
			protect: from.protect.join('\n')
		};
	}

	let form = $state<Form>({ ...DEFAULTS, enabled: true, protect: '' });
	let saving = $state(false);

	// what the form is compared against: the stored settings as the form writes them
	let baseline = $state<Form | null>(null);

	const changed = $derived(baseline !== null && JSON.stringify(form) !== JSON.stringify(baseline));

	$effect(() => {
		dirty = changed;
	});

	// the form follows the stored settings until someone edits it
	$effect(() => {
		if (!settings) {
			return;
		}

		const from = formOf(settings);

		untrack(() => {
			const edited = changed;

			baseline = from;

			if (!edited) {
				form = formOf(settings);
			}
		});
	});

	/** Drop the edits and show the stored settings again. */
	export function discard(): void {
		if (baseline) {
			form = $state.snapshot(baseline);
		}
	}

	/** Add addresses to the protected list, unsaved, as a shortcut elsewhere on the screen asks. */
	export function protect(addresses: string[]): void {
		const have = new Set(parseList(form.protect));
		const added = addresses.filter((address) => !have.has(address));

		if (added.length === 0) {
			return;
		}

		form.protect = [form.protect.trimEnd(), ...added].filter((line) => line !== '').join('\n');
	}

	function reset(): void {
		form = { ...form, ...DEFAULTS };
	}

	/** A whole number inside a range, or null when the text is not one. */
	function whole(text: string, min: number, max: number): number | null {
		const value = Number(text.trim());

		return text.trim() !== '' && Number.isInteger(value) && value >= min && value <= max
			? value
			: null;
	}

	function decimal(text: string, min: number, max: number): number | null {
		const value = Number(text.trim());

		return text.trim() !== '' && Number.isFinite(value) && value >= min && value <= max
			? value
			: null;
	}

	const patterns = $derived(form.namePatterns.split('\n').map((line) => line.trim()).filter((line) => line !== ''));

	// the proxy compiles each line as a Java regular expression; the browser's
	// grammar agrees on everything a name pattern needs
	const badPattern = $derived.by((): { line: number; message: string } | null => {
		for (const [index, pattern] of patterns.entries()) {
			try {
				new RegExp(pattern, 'i');
			} catch (err) {
				return { line: index + 1, message: (err as Error).message };
			}
		}

		return null;
	});
	const matchesAll = $derived(patterns.findIndex((pattern) => {
		try {
			return new RegExp(pattern, 'i').test('');
		} catch {
			return false;
		}
	}));

	let tryName = $state('');

	const tried = $derived.by((): string | null => {
		const name = tryName.trim();

		if (name === '' || badPattern) {
			return null;
		}

		return patterns.find((pattern) => new RegExp(pattern, 'i').test(name)) ?? '';
	});

	const protectLines = $derived(parseList(form.protect));
	const badProtect = $derived(protectLines.find((line) => !looksLikeRange(line)));

	const numbers = $derived({
		loginFloodPerMinute: whole(form.loginFloodPerMinute, 2, 10_000),
		pingScanCount: whole(form.pingScanCount, 3, 100_000),
		pingScanMinutes: whole(form.pingScanMinutes, 1, 1440),
		failedLoginCount: whole(form.failedLoginCount, 2, 10_000),
		failedLoginMinutes: whole(form.failedLoginMinutes, 1, 1440),
		banMinutes: whole(form.banMinutes, 1, 525_600),
		repeatMultiplier: decimal(form.repeatMultiplier, 1, 100),
		maxBanDays: whole(form.maxBanDays, 1, 3650)
	});

	const badDetector = $derived<Record<FirewallDetector, boolean>>({
		loginFlood: numbers.loginFloodPerMinute === null,
		pingScan: numbers.pingScanCount === null || numbers.pingScanMinutes === null,
		failedLogins: numbers.failedLoginCount === null || numbers.failedLoginMinutes === null,
		suspiciousNames: badPattern !== null || matchesAll >= 0 || (form.suspiciousNames && patterns.length === 0)
	});

	const invalid = $derived(
		Object.values(numbers).some((value) => value === null) ||
		Object.values(badDetector).some((bad) => bad) ||
		badProtect !== undefined
	);

	// a player's client pings a few times a minute while the server list is open
	const pingTooLow = $derived(
		numbers.pingScanCount !== null &&
		numbers.pingScanMinutes !== null &&
		numbers.pingScanCount / numbers.pingScanMinutes < 4
	);

	const ladder = $derived(numbers.banMinutes !== null && numbers.repeatMultiplier !== null && numbers.maxBanDays !== null
		? banLadder({ banMinutes: numbers.banMinutes, repeatMultiplier: numbers.repeatMultiplier, maxBanDays: numbers.maxBanDays })
		: []);
	const firstTooLong = $derived(numbers.banMinutes !== null && numbers.maxBanDays !== null && numbers.banMinutes > numbers.maxBanDays * 1440);

	const locked = $derived(!canConfigure || !baseline);

	const saveReason = $derived(!canConfigure
		? t('web.common.notAllowed', { action: 'firewall:Configure' })
		: invalid
			? t('web.firewall.autoban.fixNumbers')
			: !changed
				? t('web.firewall.autoban.noChanges')
				: undefined);

	const detectorsOn = $derived(FIREWALL_DETECTORS.filter((id) => form[id]).length);

	async function save(): Promise<void> {
		if (saveReason !== undefined || saving) {
			return;
		}

		const turnedOff = FIREWALL_DETECTORS.some((id) => baseline?.[id] && !form[id]);

		saving = true;

		try {
			const result = await post('/firewall/settings', {
				values: {
					enabled: form.enabled,
					hidePingFromRefused: form.hidePingFromRefused,
					loginFlood: form.loginFlood,
					loginFloodPerMinute: numbers.loginFloodPerMinute,
					pingScan: form.pingScan,
					pingScanCount: numbers.pingScanCount,
					pingScanMinutes: numbers.pingScanMinutes,
					failedLogins: form.failedLogins,
					failedLoginCount: numbers.failedLoginCount,
					failedLoginMinutes: numbers.failedLoginMinutes,
					suspiciousNames: form.suspiciousNames,
					namePatterns: patterns,
					banMinutes: numbers.banMinutes,
					repeatMultiplier: numbers.repeatMultiplier,
					maxBanDays: numbers.maxBanDays,
					protect: protectLines
				}
			});

			// what the proxy kept is the form now, so nothing reads as unsaved
			baseline = formOf(result.settings);
			form = formOf(result.settings);
			Notify.success(t('web.firewall.autoban.saved'), {
				detail: turnedOff
					? t('web.firewall.autoban.savedOff')
					: undefined
			});
			onsaved();
		} catch (err) {
			Notify.error(t('web.firewall.autoban.saveFailed'), { detail: (err as Error).message });
		} finally {
			saving = false;
		}
	}

	function addMine(): void {
		if (you) {
			protect([you]);
		}
	}

	/** The numbers each detector's sentence holds, in the order its placeholders name them. */
	const SLOTS: Record<Exclude<FirewallDetector, 'suspiciousNames'>, Array<{ slot: string; key: keyof Form; min: number; max: number }>> = {
		loginFlood: [{ slot: 'count', key: 'loginFloodPerMinute', min: 2, max: 10_000 }],
		pingScan: [
			{ slot: 'count', key: 'pingScanCount', min: 3, max: 100_000 },
			{ slot: 'minutes', key: 'pingScanMinutes', min: 1, max: 1440 }
		],
		failedLogins: [
			{ slot: 'count', key: 'failedLoginCount', min: 2, max: 10_000 },
			{ slot: 'minutes', key: 'failedLoginMinutes', min: 1, max: 1440 }
		]
	};
</script>

{#if !canConfigure}
	<Flash kind="info">{t('web.firewall.autoban.readOnly')}</Flash>
{/if}

{#snippet saveBar()}
	<Btn disabled={locked} onclick={reset}>{t('web.firewall.autoban.reset')}</Btn>
	<Btn disabled={!changed} onclick={discard}>{t('web.common.discard')}</Btn>
	<Btn variant="primary" loading={saving} disabled={saveReason !== undefined} title={saveReason} onclick={save}>
		{t('web.common.save')}
	</Btn>
{/snippet}

<Panel title={t('web.firewall.autoban.title')} description={t('web.firewall.autoban.description')} actions={saveBar}>
	{#if !form.enabled}
		<Flash kind="warning">{t('web.firewall.autoban.firewallOff')}</Flash>
	{:else if detectorsOn === 0}
		<p class="offline dim">{t('web.firewall.autoban.noneOn')}</p>
	{/if}

	<div class="detectors" class:off={!form.enabled}>
		{#each FIREWALL_DETECTORS as id (id)}
			{@const name = t(`web.firewall.reasons.${id}`)}
			<div class="detector">
				<div class="line">
					<label class="pick">
						<Checkbox checked={form[id]} disabled={locked} onchange={(checked) => (form[id] = checked)} />
						<b>{name}</b>
					</label>
					{#if id !== 'suspiciousNames'}
						<span class="sentence">
							{#each sentenceParts(`web.firewall.autoban.${id}Sentence`, SLOTS[id].map((entry) => entry.slot)) as part, index (index)}
								{#if 'text' in part}
									<span>{part.text.trim()}</span>
								{:else}
									{@const spec = SLOTS[id].find((entry) => entry.slot === part.slot)!}
									<input
										class="input num"
										class:bad={whole(String(form[spec.key]), spec.min, spec.max) === null}
										type="text"
										inputmode="numeric"
										disabled={locked}
										aria-label={t(`web.firewall.autoban.slot.${part.slot}`, { detector: name })}
										value={form[spec.key] as string}
										oninput={(event) => {
											(form as unknown as Record<string, string>)[spec.key] = event.currentTarget.value;
										}}
									/>
								{/if}
							{/each}
						</span>
					{:else}
						<span class="sentence">{t('web.firewall.autoban.suspiciousNamesSentence')}</span>
					{/if}
				</div>
				<div class="about">
					<span class="dim">{t(`web.firewall.autoban.${id}Hint`)}</span>
					{#if id !== 'suspiciousNames' && badDetector[id]}
						<span class="err">{t('web.firewall.autoban.wholeRange')}</span>
					{/if}
					{#if id === 'pingScan' && pingTooLow && !badDetector.pingScan}
						<span class="warn">{t('web.firewall.autoban.pingTooLow')}</span>
					{/if}
					{#if id === 'suspiciousNames'}
						<div class="names">
							<label class="field">
								<span class="lbl">{t('web.firewall.autoban.patterns')}</span>
								<span class="hint">{t('web.firewall.autoban.patternsHint')}</span>
								<textarea
									class="input mono"
									class:bad={badPattern !== null || matchesAll >= 0}
									rows="5"
									spellcheck="false"
									disabled={locked}
									bind:value={form.namePatterns}
								></textarea>
								{#if badPattern}
									<span class="err">{t('web.firewall.autoban.badPattern', { line: badPattern.line, error: badPattern.message })}</span>
								{:else if matchesAll >= 0}
									<span class="err">{t('web.firewall.autoban.matchesAll', { line: matchesAll + 1 })}</span>
								{:else if form.suspiciousNames && patterns.length === 0}
									<span class="err">{t('web.firewall.autoban.needPattern')}</span>
								{/if}
							</label>
							<label class="field">
								<span class="lbl">{t('web.firewall.autoban.tryName')}</span>
								<span class="hint">{t('web.firewall.autoban.tryNameHint')}</span>
								<input class="input mono" type="text" spellcheck="false" autocomplete="off" bind:value={tryName} />
								{#if tried === ''}
									<span class="dim small">{t('web.firewall.autoban.noPatternMatches')}</span>
								{:else if tried}
									<span class="warn">{t('web.firewall.autoban.patternMatches', { pattern: tried })}</span>
								{/if}
							</label>
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</Panel>

<Panel title={t('web.firewall.autoban.lengthTitle')}>
	<FormGrid cols={3} aligned>
		<label class="field">
			<span class="lbl">{t('web.firewall.autoban.banMinutes')}</span>
			<span class="hint">{t('web.firewall.autoban.banMinutesHint')}</span>
			<input class="input" class:bad={numbers.banMinutes === null} type="text" inputmode="numeric" disabled={locked} bind:value={form.banMinutes} />
			{#if numbers.banMinutes === null}
				<span class="err">{t('web.firewall.autoban.wholeNumber')}</span>
			{/if}
		</label>

		<label class="field">
			<span class="lbl">{t('web.firewall.autoban.repeatMultiplier')}</span>
			<span class="hint">{t('web.firewall.autoban.repeatMultiplierHint')}</span>
			<input class="input" class:bad={numbers.repeatMultiplier === null} type="text" inputmode="decimal" disabled={locked} bind:value={form.repeatMultiplier} />
			{#if numbers.repeatMultiplier === null}
				<span class="err">{t('web.firewall.autoban.multiplierRange')}</span>
			{/if}
		</label>

		<label class="field">
			<span class="lbl">{t('web.firewall.autoban.maxBanDays')}</span>
			<span class="hint">{t('web.firewall.autoban.maxBanDaysHint')}</span>
			<input class="input" class:bad={numbers.maxBanDays === null} type="text" inputmode="numeric" disabled={locked} bind:value={form.maxBanDays} />
			{#if numbers.maxBanDays === null}
				<span class="err">{t('web.firewall.autoban.wholeNumber')}</span>
			{/if}
		</label>
	</FormGrid>

	{#if firstTooLong}
		<p class="err">{t('web.firewall.autoban.firstTooLong')}</p>
	{:else if ladder.length > 0}
		<div class="ladder">
			<InfoGrid
				cells={ladder.map((step) => ({
					label: step.capped && step.n > 1
						? t('web.firewall.autoban.ladderStepCap', { n: step.n })
						: t('web.firewall.autoban.ladderStep', { n: step.n }),
					value: fmtSpan(step.ms)
				}))}
				columns={[Math.min(6, Math.max(ladder.length, 4)), 3, 2]}
			/>
		</div>
	{/if}
</Panel>

<Panel title={t('web.firewall.autoban.protectTitle')} description={t('web.firewall.autoban.protectDescription')}>
	<div class="always">
		<span class="dim">{t('web.firewall.autoban.alwaysProtected')}</span>
		<FirewallMatchers rule={{ addresses: protectedRanges, countries: [] }} full />
	</div>

	<label class="field protect">
		<span class="lbl">{t('web.firewall.autoban.protectList')}</span>
		<span class="hint">{t('web.firewall.autoban.protectHint')}</span>
		<textarea
			class="input mono"
			class:bad={badProtect !== undefined}
			rows="5"
			spellcheck="false"
			disabled={locked}
			bind:value={form.protect}
		></textarea>
		{#if badProtect !== undefined}
			<span class="err">{t('web.firewall.editor.badAddress', { value: badProtect })}</span>
		{/if}
	</label>
	{#if you && !locked && !protectLines.includes(you)}
		<Btn variant="link" onclick={addMine}>{t('web.firewall.editor.addMine', { address: you })}</Btn>
	{/if}
</Panel>

<Panel title={t('web.firewall.autoban.generalTitle')}>
	<div class="switches">
		<div class="switch">
			<Toggle checked={form.enabled} disabled={locked} label={t('web.firewall.autoban.enable')} onchange={(value) => (form.enabled = value)} />
			<span>
				<b>{t('web.firewall.autoban.enable')}</b>
				<span class="dim">{t('web.firewall.autoban.enableHint')}</span>
			</span>
		</div>
		<div class="switch">
			<Toggle checked={form.hidePingFromRefused} disabled={locked} label={t('web.firewall.autoban.hidePing')} onchange={(value) => (form.hidePingFromRefused = value)} />
			<span>
				<b>{t('web.firewall.autoban.hidePing')}</b>
				<span class="dim">{t('web.firewall.autoban.hidePingHint')}</span>
			</span>
		</div>
	</div>
</Panel>

<div class="savebar">
	{@render saveBar()}
</div>

<style lang="scss">
	.switches {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.switch {
		display: flex;
		align-items: center;
		gap: 0.75rem;

		> span {
			display: flex;
			flex-direction: column;
			gap: 0.125rem;
		}

		.dim {
			font-size: 0.875rem;
		}
	}

	.offline {
		margin: 0 0 0.75rem;
		font-size: 0.875rem;
	}

	.detectors {
		display: flex;
		flex-direction: column;

		// dimmed, not disabled: the lines can be set before they count
		&.off {
			opacity: 0.6;
		}
	}

	.detector {
		padding: 0.75rem 0;
		border-top: 0.1rem solid var(--border-divider);

		&:first-child {
			border-top: 0;
			padding-top: 0;
		}
	}

	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1.5rem;
	}

	.pick {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 14rem;
		cursor: pointer;

		b {
			color: var(--text-heading);
		}
	}

	// "more than [20] logins a minute", in the translation's word order
	.sentence {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
	}

	.num {
		width: 4.5rem;
		text-align: right;
	}

	.input.bad {
		border-color: var(--error);
		box-shadow: 0 0 0 0.1rem var(--error);
	}

	// under the row, in line with its label rather than its checkbox
	.about {
		margin: 0.375rem 0 0 1.75rem;
		font-size: 0.875rem;

		.err,
		.warn {
			display: block;
			margin-top: 0.25rem;
			font-size: 0.75rem;
		}

		.err {
			color: var(--error);
		}
	}

	.warn {
		color: var(--warning);
	}

	.small {
		font-size: 0.75rem;
	}

	.names {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
		gap: 0 2rem;
		max-width: 48rem;
		margin-top: 0.75rem;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}

		textarea {
			display: block;
			padding: 0.375rem 0.75rem;
			resize: vertical;
		}
	}

	// what the three numbers above come to: one cell per ban, growing to the cap
	.ladder {
		margin-top: 1.25rem;
	}

	.always {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.375rem;
		margin-bottom: 1rem;
		font-size: 0.875rem;
	}

	.protect {
		max-width: 32rem;

		textarea {
			display: block;
			padding: 0.375rem 0.75rem;
			resize: vertical;
		}
	}

	.savebar {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
