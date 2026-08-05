<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { api, post } from '$lib/api';
	import Checkbox from './Checkbox.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import Btn from './Btn.svelte';
	import MultiAddModal from './MultiAddModal.svelte';
	import Icon from './Icon.svelte';
	import DataTable from './DataTable.svelte';
	import type { Column } from './table';
	import type { ContextMenuItem } from './contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Addon-group selector + validation table, shared by the launch wizard and
	 * the instance configuration tab. The table re-validates on every selection
	 * or MC-version change and says exactly how each wanted plugin lands on this
	 * (prospective) instance: OK, no compatible version (with a download action
	 * when Modrinth has one), skipped (no build for the platform), or missing.
	 *
	 * A group carries packs as well as plugins, and those need no validation -
	 * they are listed under the picker so the selection's full effect is visible
	 * before it is saved.
	 *
	 * Per-instance overrides ride along: plugins can be force-added beyond the
	 * groups or disabled even when a group provides them. With `instance` set the
	 * override applies immediately (deploy/remove included); without it the
	 * choice accumulates in the bindable `overrides` for the create call.
	 */
	let {
		software,
		mcVersion,
		instance,
		selected = $bindable([]),
		overrides = $bindable({}),
		disabled = false
	}: {
		software: 'paper' | 'velocity';
		mcVersion?: string;
		/** existing instance; overrides apply immediately through the API */
		instance?: string;
		/** selected groups beside "default" (bindable) */
		selected?: string[];
		/** per-instance overrides, plugin → force-add/disable (bindable; prospective mode) */
		overrides?: Record<string, boolean>;
		disabled?: boolean;
	} = $props();

	interface GroupInfo {
		name: string;
		description: string;
		builtin: boolean;
		plugins: string[];
		respacks: string[];
		datapacks: string[];
		usedBy: string[];
	}

	interface CheckRow {
		plugin: string;
		groups: string[];
		manual?: boolean;
		disabled?: boolean;
		/** lockfile key of the matched build; what the download action fetches for */
		entry?: string;
		family?: string;
		status: 'ok' | 'unverified' | 'no-version' | 'skipped' | 'missing';
		version?: string;
		gameVersions?: string[];
		downloadable: boolean;
	}

	let groups: GroupInfo[] = $state([]);
	let pluginNames: string[] = $state([]);
	let rows: CheckRow[] = $state([]);
	let checking = $state(false);
	let fetching = $state('');
	let overriding = $state('');
	let addOpen = $state(false);

	async function loadGroups(): Promise<void> {
		const data = await api('/addons/groups');

		groups = data.groups;
		pluginNames = data.pluginNames;
	}

	async function validate(): Promise<void> {
		checking = true;

		try {
			const params = new URLSearchParams();

			params.set('groups', selected.join(','));
			params.set('software', software);

			if (mcVersion) {
				params.set('mcVersion', mcVersion);
			}

			if (instance) {
				params.set('instance', instance);
			} else if (Object.keys(overrides).length) {
				params.set('overrides', JSON.stringify(overrides));
			}

			rows = (await api(`/plugins/validate?${params}`)).rows;
		} catch (err) {
			Notify.error(t('web.groups.validateFailed'), {
				detail: (err as Error).message
			});
		}

		checking = false;
	}

	$effect(() => {
		void loadGroups();
	});

	// re-validate whenever the selection, an override or the prospective MC version moves
	$effect(() => {
		void selected;
		void mcVersion;
		void software;
		void overrides;
		void validate();
	});

	function toggle(name: string, on: boolean): void {
		if (on) {
			selected = [...selected, name];
		} else {
			selected = selected.filter((entry) => entry !== name);
		}
	}

	/**
	 * Apply one override: force-add (true), disable (false) or clear (null).
	 * Instance mode hits the API (which deploys or removes the jars); the
	 * prospective mode just updates the bound record.
	 */
	/** Force-add several plugins at once (the Add popup's confirm). */
	async function addPlugins(names: string[]): Promise<void> {
		if (!names.length) {
			return;
		}

		if (!instance) {
			const next = { ...overrides };

			for (const name of names) {
				next[name] = true;
			}

			overrides = next;

			return;
		}

		overriding = names[0]!;

		const note = Notify.loading(`Adding ${names.join(', ')} on ${instance}…`);
		const failures: string[] = [];

		for (const name of names) {
			try {
				await post(`/instances/${instance}/plugins`, { plugin: name, state: true });
			} catch (err) {
				failures.push(`${name}: ${(err as Error).message}`);
			}
		}

		if (failures.length) {
			note.set({
				level: 'error',
				message: `Could not add ${failures.length} plugin(s)`,
				detail: failures.join(' · '),
				closeable: true
			});
		} else {
			note.set({
				level: 'success',
				message: `Added ${names.join(', ')} on ${instance}`,
				detail: t('web.groups.aRunningServerLoadsThem'),
				closeable: true
			});
		}

		overriding = '';

		await validate();
	}

	async function setOverride(plugin: string, state: boolean | null): Promise<void> {
		if (!instance) {
			const next = { ...overrides };

			if (state === null) {
				delete next[plugin];
			} else {
				next[plugin] = state;
			}

			overrides = next;

			return;
		}

		overriding = plugin;

		const verbKey =
			state === true
				? 'web.groups.addingOn'
				: state === false
					? 'web.groups.disablingOn'
					: 'web.groups.reenablingOn';
		const note = Notify.loading(t(verbKey, { plugin, instance: instance ?? '' }));

		try {
			const result = await post(`/instances/${instance}/plugins`, { plugin, state });

			note.set({
				level: 'success',
				message: t(state === true ? 'web.groups.addedOn' : state === false ? 'web.groups.disabledOn' : 'web.groups.reenabledOn', { plugin, instance: instance ?? '' }),
				detail: result.removed?.length
					? t('web.groups.removedDetail', { names: result.removed.join(', ') })
					: result.deployed
						? t('web.groups.deployedDetail', { count: result.deployed })
						: '',
				closeable: true
			});

			await validate();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.groups.updateFailed', { plugin }),
				detail: (err as Error).message,
				closeable: true
			});
		}

		overriding = '';
	}

	async function download(row: CheckRow): Promise<void> {
		if (!row.entry) {
			return;
		}

		fetching = row.plugin;

		const note = Notify.loading(t('web.groups.downloading', { plugin: row.plugin, mc: mcVersion ?? '' }));

		try {
			const result = await post('/plugins/fetch', { plugin: row.entry, mcVersion });

			note.set({
				level: 'success',
				message: t('web.groups.pooled', { plugin: row.plugin, version: result.version, mc: mcVersion ?? '' }),
				closeable: true
			});

			await validate();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.groups.noCompatible', { plugin: row.plugin }),
				detail: (err as Error).message,
				closeable: true
			});
		}

		fetching = '';
	}

	const BADGES: Record<CheckRow['status'], { state: string; label: string }> = $derived({
		ok: { state: 'passed', label: t('web.groups.badgeOk') },
		unverified: { state: 'ok', label: t('web.groups.badgeUnverified') },
		'no-version': { state: 'warning', label: t('web.groups.badgeNoVersion') },
		skipped: { state: 'stopped', label: t('web.groups.badgeSkipped') },
		missing: { state: 'failed', label: t('web.groups.badgeMissing') }
	});

	const columns: Column[] = $derived([
		{ id: 'plugin', label: t('web.groups.colPlugin'), sortable: true },
		{ id: 'status', label: t('web.groups.colStatus'), width: 210 },
		{ id: 'family', label: t('web.groups.colFamily'), width: 110 },
		{ id: 'version', label: t('web.groups.colVersion') },
		{ id: 'groups', label: t('web.groups.colFrom') }
	]);

	/**
	 * One plugin's per-instance override, as the row's menu. A disabled row is
	 * dimmed and is precisely the one that needs "Enable", so the verbs live in
	 * the menu rather than in a column of buttons (see CLAUDE.md).
	 */
	function rowActions(row: CheckRow): ContextMenuItem[] {
		if (row.disabled) {
			return [
				{
					label: t('web.groups.enableHere'),
					icon: 'circleCheck',
					disabled,
					action: () => setOverride(row.plugin, null)
				}
			];
		}

		if (row.manual) {
			return [
				{
					label: t('web.groups.removeManual'),
					icon: 'trash',
					color: 'danger',
					disabled,
					action: () => setOverride(row.plugin, null)
				}
			];
		}

		if (row.status === 'skipped') {
			return [];
		}

		return [
			{
				label: t('web.groups.disableHere'),
				icon: 'ban',
				color: 'danger',
				disabled,
				hint: t('web.groups.disableHint'),
				action: () => setOverride(row.plugin, false)
			}
		];
	}

	const problems = $derived(
		rows.filter((row) => !row.disabled && (row.status === 'no-version' || row.status === 'missing'))
			.length
	);

	// plugins not already on the table are candidates for a force-add
	const addable = $derived(
		pluginNames.filter((name) => !rows.some((row) => row.plugin === name))
	);

	/** The groups in force: every builtin one, plus what is ticked. */
	const active = $derived(groups.filter((group) => group.builtin || selected.includes(group.name)));

	/** Packs the selection brings, deduplicated across groups. */
	const packs = $derived({
		respacks: [...new Set(active.flatMap((group) => group.respacks ?? []))].sort(),
		datapacks: [...new Set(active.flatMap((group) => group.datapacks ?? []))].sort()
	});
</script>

<div class="picker">
	{#each groups as group (group.name)}
		{@const on = group.builtin || selected.includes(group.name)}
		<label class="grp" class:on class:locked={group.builtin || disabled}>
			<span class="ghead">
				<Checkbox
					checked={on}
					disabled={group.builtin || disabled}
					label={group.name}
					onchange={(value) => toggle(group.name, value)}
				/>
				<a
					class="gname"
					href="/addons/groups/{group.name}"
					onclick={(event) => event.stopPropagation()}
				>
					{group.name}
				</a>
				<span class="gmeta">
					{t('web.groups.pluginCount', { count: group.plugins.length })}{group.respacks?.length
						? ` · ${t('web.groups.respackCount', { count: group.respacks.length })}`
						: ''}{group.datapacks?.length
						? ` · ${t('web.groups.datapackCount', { count: group.datapacks.length })}`
						: ''}{group.builtin ? ` · ${t('web.groups.alwaysApplied')}` : ''}
				</span>
			</span>
			{#if group.description}
				<span class="ghint">{group.description}</span>
			{/if}
		</label>
	{/each}
</div>

{#if packs.respacks.length || packs.datapacks.length}
	<div class="packs">
		{#if packs.respacks.length}
			<div class="prow">
				<Icon name="image" size="0.875rem" style="solid" />
				<b>{t('web.nav.resourcePacks')}</b>
				<span class="dim">{packs.respacks.join(', ')}</span>
			</div>
		{/if}
		{#if packs.datapacks.length}
			<div class="prow">
				<Icon name="box" size="0.875rem" style="solid" />
				<b>{t('web.nav.dataPacks')}</b>
				<span class="dim">
					{packs.datapacks.join(', ')}{software === 'velocity'
						? ` ${t('web.groups.proxyNoWorld')}`
						: ''}
				</span>
			</div>
		{/if}
	</div>
{/if}

<div class="addrow">
	<Btn icon="plus" disabled={disabled} onclick={() => (addOpen = true)}>{t('web.groups.addPlugin')}</Btn>
</div>

<MultiAddModal
	bind:open={addOpen}
	title={instance ? t('web.groups.addPluginsTo', { instance }) : t('web.groups.addPlugins')}
	description={t('web.groups.forceAddNote')}
	selectLabel={t('web.groups.colPlugin')}
	options={addable}
	busy={!!overriding}
	onconfirm={(names) => void addPlugins(names)}
/>

<div class="check" class:busy={checking}>
	<DataTable
		{columns}
		rows={rows}
		getId={(row) => row.plugin}
		{rowActions}
		rowLabel={(row) => row.plugin}
		rowDim={(row) => !!row.disabled}
		emptyTitle={t('web.groups.nothingToValidate')}
		emptyText={t('web.groups.noPluginsInGroups')}
	>
		{#snippet cell(row, col)}
			{#if col === 'plugin'}
				<b>{row.plugin}</b>
			{:else if col === 'status'}
				{#if row.disabled}
					<StatusBadge state="stopped" label={t('web.groups.badgeDisabled')} />
				{:else}
					<StatusBadge state={BADGES[row.status].state} label={BADGES[row.status].label} />
				{/if}
			{:else if col === 'family'}
				{#if row.family}
					{row.family}
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'version'}
				{#if row.status === 'no-version' && row.downloadable && !row.disabled}
					<Btn
						icon="download"
						loading={fetching === row.plugin}
						onclick={() => download(row)}
					>
						{t('web.groups.downloadFor', { mc: mcVersion ?? '' })}
					</Btn>
				{:else if row.status === 'skipped'}
					<span class="dim">{t('web.groups.noBuild', { software: software ?? '' })}</span>
				{:else if row.version}
					<span class="mono">{row.version}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'groups'}
				{#if row.manual}
					<span class="manual">{t('web.groups.manual')}</span>
				{:else}
					<span class="dim">{row.groups.join(', ')}</span>
				{/if}
			{/if}
		{/snippet}
	</DataTable>
	{#if problems}
		<p class="warn-note">
			{problems} plugin(s) will not deploy as selected; download a compatible build or adjust
			{t('web.groups.theGroups')}
		</p>
	{/if}
</div>

<style lang="scss">
	.picker {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-bottom: 1rem;
	}

	.grp {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding: 0.5rem 0.75rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
		cursor: pointer;

		&.on {
			border-color: var(--link);
		}

		&.locked {
			cursor: default;
		}

		&:hover:not(.locked) {
			background: var(--bg-hover);
		}
	}

	.ghead {
		display: flex;
		align-items: baseline;
		gap: 0.625rem;
	}

	.gname {
		font-weight: 700;
		color: var(--text-heading);
	}

	.gmeta {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	// the description wraps freely on its own line instead of stretching the header
	.ghint {
		margin-left: 1.625rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	// what the selection brings besides plugins; no validation, just the facts
	.packs {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-bottom: 1rem;
		padding: 0.625rem 0.75rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
		font-size: 0.8125rem;
	}

	.prow {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.addrow {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-bottom: 0.75rem;
	}

	// force-added entries stand apart from group-sourced ones
	.manual {
		color: var(--link);
		font-size: 0.8125rem;
	}

	// keep the previous table visible while a re-validation is in flight, just dimmed
	.check.busy {
		opacity: 0.6;
	}

	.warn-note {
		margin: 0.625rem 0 0;
		font-size: 0.8125rem;
		color: var(--warning);
	}
</style>
