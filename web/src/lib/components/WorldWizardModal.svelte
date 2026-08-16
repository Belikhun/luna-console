<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import Checkbox from './Checkbox.svelte';
	import Flash from './Flash.svelte';
	import InfoGrid from './InfoGrid.svelte';
	import WizardModal from './WizardModal.svelte';
	import type { WizardStep } from './wizardmodal';
	import {
		findingKey,
		hasBlockingFinding,
		type StagedWorld,
		type WorldReplaceTarget
	} from './worldupload';
	import { formatBytes } from '$lib/upload';

	/**
	 * The validation half of the world upload flow: what was found in the
	 * archive, where it will land, and anything the operator should know before
	 * it does.
	 *
	 * Everything here is read-only except the level name. A world import is not
	 * a form to fill in; it is a set of facts to check, and the one decision
	 * worth offering is what the world gets called on this server.
	 *
	 * Two optional steps bracket those facts, so the same wizard serves both
	 * places a world is asked for. `source` prepends a step for picking the
	 * archive, which is what a caller opening this from a button needs and what
	 * an inline drop zone has already done by the time it opens this. `target`
	 * appends the confirmation for a world that is about to be overwritten.
	 */
	let {
		open = $bindable(false),
		step = $bindable(0),
		world = $bindable(),
		target = null,
		backupFirst = $bindable(true),
		confirmLabel,
		confirmWord = 'replace',
		busy = false,
		source,
		onconfirm,
		oncancel
	}: {
		open?: boolean;
		step?: number;
		/** Null until an archive has been staged, which only `source` allows */
		world: StagedWorld | null;
		/** The world this one would destroy; null when there is nothing to lose */
		target?: WorldReplaceTarget | null;
		/** Take a safety copy before installing; bindable so the caller acts on it */
		backupFirst?: boolean;
		confirmLabel: string;
		/** The word the operator types to confirm a destructive install */
		confirmWord?: string;
		busy?: boolean;
		/** The archive picker, as a leading step; omitted when one is already staged */
		source?: Snippet;
		onconfirm: () => void | Promise<void>;
		oncancel?: () => void;
	} = $props();

	const scan = $derived(world?.scan ?? null);
	const info = $derived(scan?.level_dat);
	const findings = $derived(scan?.plan.findings ?? []);
	const blocked = $derived(hasBlockingFinding(findings));

	/** Findings worth stopping on, and the rest, kept apart on the last step. */
	const errors = $derived(findings.filter((finding) => finding.level === 'error'));
	const warnings = $derived(findings.filter((finding) => finding.level === 'warning'));
	const notes = $derived(findings.filter((finding) => finding.level === 'info'));

	let acknowledged = $state(false);
	let typed = $state('');
	let lossUnderstood = $state(false);

	// a fresh archive is a fresh decision; an acknowledgement must never carry
	// over from the world the user looked at a minute ago
	$effect(() => {
		void world?.token;
		acknowledged = false;
	});

	// and neither may a destructive confirmation survive the dialog closing:
	// reopening it starts at the first step, so it must start at the first answer
	$effect(() => {
		if (open) {
			return;
		}

		typed = '';
		lossUnderstood = false;
		backupFirst = true;
	});

	// the picker step has done its job the moment the scan lands, and leaving the
	// operator on a spent drop zone is a step they have to work out how to leave
	$effect(() => {
		if (source && step === 0 && world?.phase === 'reviewing') {
			step = 1;
		}
	});

	const needsAck = $derived(warnings.length > 0);

	/** Why the picker step is not finished yet, in the operator's own terms. */
	const sourceBlocked = $derived.by(() => {
		if (!world) {
			return t('web.worldWizard.needAnArchive');
		}

		if (world.phase === 'uploading' || world.phase === 'scanning') {
			return t('web.worldWizard.stillReading');
		}

		if (!world.scan) {
			return t('web.worldWizard.needAnArchive');
		}

		return '';
	});

	/** Why the confirmation is not finished yet. */
	const confirmBlocked = $derived.by(() => {
		if (!backupFirst && !lossUnderstood) {
			return t('web.worldWizard.needLossAck');
		}

		if (typed.trim() !== confirmWord) {
			return t('web.worldWizard.typeToConfirm', { word: confirmWord });
		}

		return '';
	});

	const steps: WizardStep[] = $derived([
		...(source
			? [
					{
						id: 'source',
						label: t('web.worldWizard.stepSource'),
						description: t('web.worldWizard.stepSourceHint'),
						blocked: sourceBlocked
					}
				]
			: []),
		{
			id: 'archive',
			label: t('web.worldWizard.stepArchive'),
			description: t('web.worldWizard.stepArchiveHint')
		},
		{
			id: 'world',
			label: t('web.worldWizard.stepWorld'),
			description: t('web.worldWizard.stepWorldHint'),
			blocked: world?.level.trim() ? '' : t('web.worldWizard.needLevelName')
		},
		{
			id: 'layout',
			label: t('web.worldWizard.stepLayout'),
			description: t('web.worldWizard.stepLayoutHint')
		},
		{
			id: 'review',
			label: t('web.worldWizard.stepReview'),
			description: t('web.worldWizard.stepReviewHint'),
			blocked: blocked
				? t('web.worldWizard.blockedByError')
				: needsAck && !acknowledged
					? t('web.worldWizard.needAcknowledge')
					: ''
		},
		...(target
			? [
					{
						id: 'confirm',
						label: t('web.worldWizard.stepConfirm'),
						description: t('web.worldWizard.stepConfirmHint'),
						blocked: confirmBlocked
					}
				]
			: [])
	]);

	const ARCHIVE_LAYOUTS: Record<string, string> = $derived({
		nested: t('web.worldWizard.layoutNested'),
		split: t('web.worldWizard.layoutSplit'),
		'overworld-only': t('web.worldWizard.layoutOverworldOnly')
	});

	const GAME_TYPES: Record<number, string> = $derived({
		0: t('web.worldWizard.gameSurvival'),
		1: t('web.worldWizard.gameCreative'),
		2: t('web.worldWizard.gameAdventure'),
		3: t('web.worldWizard.gameSpectator')
	});

	/** A finding's sentence, with the server's own parameters filled in. */
	function say(finding: { code: string; params?: Record<string, string> }): string {
		return t(findingKey(finding.code), finding.params ?? {});
	}
</script>

<WizardModal
	bind:open
	bind:step
	title={t('web.worldWizard.title')}
	{steps}
	{confirmLabel}
	{busy}
	dismissable={!busy}
	{onconfirm}
	{oncancel}
>
	{#snippet children(current)}
		{#if current.id === 'source'}
			{@render source?.()}
		{:else if !world}
			<p class="dim">{t('web.worldWizard.needAnArchive')}</p>
		{:else if current.id === 'archive'}
			<InfoGrid
				cells={[
					{ label: t('web.worldWizard.file'), value: world.fileName },
					{ label: t('web.worldWizard.archiveSize'), value: formatBytes(world.fileSizeBytes) },
					{
						label: t('web.worldWizard.uncompressed'),
						value: scan ? formatBytes(scan.totalBytes) : '–'
					},
					{ label: t('web.worldWizard.files'), value: String(scan?.fileCount ?? 0) },
					{
						label: t('web.worldWizard.detectedLayout'),
						value: ARCHIVE_LAYOUTS[scan?.archiveLayout ?? ''] ?? '–'
					},
					{
						label: t('web.worldWizard.worldRoot'),
						value: scan?.rootPath || t('web.worldWizard.archiveRoot'),
						style: 'mono',
						copyable: true
					}
				]}
			/>
		{:else if current.id === 'world'}
			<InfoGrid
				cells={[
					{ label: t('web.worldWizard.originalName'), value: info?.levelName ?? '–' },
					{ label: t('web.worldWizard.mcVersion'), value: info?.mcVersion ?? t('web.worldWizard.unknown') },
					{ label: t('web.worldWizard.dataVersion'), value: info?.dataVersion ? String(info.dataVersion) : '–' },
					{ label: t('web.worldWizard.seed'), value: info?.seed ?? '–', style: 'mono', copyable: true },
					{
						label: t('web.worldWizard.gameType'),
						value: info?.gameType === undefined ? '–' : (GAME_TYPES[info.gameType] ?? String(info.gameType))
					},
					{ label: t('web.worldWizard.hardcore'), value: info?.hardcore ? t('web.common.yes') : t('web.common.no') },
					{
						label: t('web.worldWizard.writtenBy'),
						value: info?.serverBrands?.join(', ') || '–'
					},
					{
						label: t('web.worldWizard.lastPlayed'),
						value: info?.lastPlayed ? new Date(info.lastPlayed).toLocaleString() : '–'
					}
				]}
			/>

			<label class="field level">
				<span class="lbl">{t('web.worldWizard.installAs')}</span>
				<span class="hint">{t('web.worldWizard.installAsHint')}</span>
				<input class="input" bind:value={world.level} disabled={busy} />
			</label>
		{:else if current.id === 'layout'}
			<p class="dim">{t('web.worldWizard.layoutExplain')}</p>

			<table class="moves">
				<thead>
					<tr>
						<th>{t('web.worldWizard.dimension')}</th>
						<th>{t('web.worldWizard.fromArchive')}</th>
						<th>{t('web.worldWizard.toInstance')}</th>
					</tr>
				</thead>
				<tbody>
					{#each scan?.plan.moves ?? [] as move (move.kind + move.to)}
						<tr>
							<td>{t(`web.worldWizard.dim.${move.kind}`)}</td>
							<td class="mono">{move.from || t('web.worldWizard.archiveRoot')}</td>
							<td class="mono">{move.to}</td>
						</tr>
					{:else}
						<tr><td colspan="3" class="dim">{t('web.worldWizard.noDimensions')}</td></tr>
					{/each}
				</tbody>
			</table>

			{#if (scan?.plan.replaces ?? []).length > 0}
				<p class="dim replaces">
					{t('web.worldWizard.replaces', { dirs: (scan?.plan.replaces ?? []).join(', ') })}
				</p>
			{/if}
		{:else if current.id === 'review'}
			{#if (scan?.datapacks ?? []).length > 0}
				<div class="block">
					<h4>{t('web.worldWizard.dataPacks')}</h4>
					<p class="dim">{t('web.worldWizard.dataPacksHint')}</p>
					<ul class="packs">
						{#each scan?.datapacks ?? [] as pack (pack)}
							<li class="mono">{pack}</li>
						{/each}
					</ul>
				</div>
			{/if}

			<div class="block">
				<h4>{t('web.worldWizard.checks')}</h4>

				{#each errors as finding (finding.code)}
					<Flash kind="error">{say(finding)}</Flash>
				{/each}
				{#each warnings as finding (finding.code)}
					<Flash kind="warning">{say(finding)}</Flash>
				{/each}
				{#each notes as finding (finding.code)}
					<Flash kind="info">{say(finding)}</Flash>
				{/each}

				{#if findings.length === 0}
					<Flash kind="success">{t('web.worldWizard.noProblems')}</Flash>
				{/if}
			</div>

			{#if needsAck && !blocked}
				<label class="ack">
					<input type="checkbox" bind:checked={acknowledged} disabled={busy} />
					<span>{t('web.worldWizard.acknowledge')}</span>
				</label>
			{/if}
		{:else if current.id === 'confirm' && target}
			<Flash kind="error">
				{t('web.worldWizard.destroyLead', {
					name: target.instance,
					dirs: target.dirs.join(', '),
					size: formatBytes(target.sizeBytes)
				})}
			</Flash>

			<p class="dim destroy-note">{t('web.worldWizard.destroyNote')}</p>

			<label class="opt">
				<Checkbox
					checked={backupFirst}
					disabled={busy}
					label={t('web.worldWizard.backUpFirst')}
					onchange={(value) => (backupFirst = value)}
				/>
				<span>
					{t('web.worldWizard.backUpFirst')}
					<span class="dim">{t('web.worldWizard.backUpFirstHint')}</span>
				</span>
			</label>

			{#if !backupFirst}
				<Flash kind="warning">{t('web.worldWizard.noBackupWarning')}</Flash>

				<label class="opt">
					<Checkbox
						checked={lossUnderstood}
						disabled={busy}
						label={t('web.worldWizard.lossAck')}
						onchange={(value) => (lossUnderstood = value)}
					/>
					<span>{t('web.worldWizard.lossAck')}</span>
				</label>
			{/if}

			<label class="field type">
				<span class="lbl">{t('web.worldWizard.typeToConfirm', { word: confirmWord })}</span>
				<input class="input" bind:value={typed} placeholder={confirmWord} disabled={busy} />
			</label>
		{/if}
	{/snippet}
</WizardModal>

<style lang="scss">
	.level {
		margin-top: 1.25rem;
	}

	.moves {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8125rem;

		th,
		td {
			padding: 0.375rem 0.5rem;
			border-bottom: 0.1rem solid var(--border-divider);
			text-align: left;
		}

		th {
			color: var(--text-dim);
			font-weight: 400;
		}
	}

	.mono {
		font-family: var(--font-mono);
	}

	.replaces {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
	}

	.block {
		& + & {
			margin-top: 1.25rem;
		}

		h4 {
			margin: 0 0 0.25rem;
			font-size: 0.875rem;
		}

		p {
			margin: 0 0 0.5rem;
			font-size: 0.8125rem;
		}
	}

	.packs {
		margin: 0;
		padding-left: 1.25rem;
		font-size: 0.8125rem;
	}

	.destroy-note {
		margin: 0.75rem 0 0;
		font-size: 0.8125rem;
	}

	// the two answers the confirmation asks for; a checkbox with no words beside
	// it is a control nobody can act on
	.opt {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin-top: 1rem;
		font-size: 0.8125rem;
		cursor: pointer;

		.dim {
			display: block;
		}
	}

	.type {
		margin-top: 1.25rem;
	}

	// the acknowledgement is the last thing before a destructive confirm, so it
	// sits apart from the findings rather than reading as one more of them
	.ack {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 0.1rem solid var(--border-divider);
		font-size: 0.8125rem;
		cursor: pointer;
	}
</style>
