<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import SplitButton from '$lib/components/SplitButton.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Select from '$lib/components/Select.svelte';
	import SearchInput from '$lib/components/SearchInput.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import ShellGlyph from '$lib/components/ShellGlyph.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import PagingBar from '$lib/components/PagingBar.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ContextMenu from '$lib/components/ContextMenu.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import ProgressTree from '$lib/components/ProgressTree.svelte';
	import Slider from '$lib/components/Slider.svelte';
	import type { ProgressSnapshot } from '$core/progress';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { InfoCell } from '$lib/components/grid';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import { tooltip } from '$lib/tooltip.svelte';

	/**
	 * Component gallery; every UI component on one page, in every notable
	 * state, for eyeballing changes and debugging. Dev/debug surface only: it
	 * talks to no APIs and mutates nothing.
	 */

	// ----- interactive state -----
	let checked = $state(true);
	let toggled = $state(true);
	let search = $state('');
	let selectValue = $state('any');
	let activeTab = $state('one');
	let page = $state(3);
	let modalOpen = $state(false);
	let wideModalOpen = $state(false);
	let progressDemo = $state(35);
	let sliderStep = $state(10);
	let sliderCoarse = $state(100);
	let refreshStamp: number | null = $state(Date.now());
	let refreshing = $state(false);

	let menu: ContextMenu | undefined = $state();
	let menuButton: HTMLSpanElement | undefined = $state();

	const MENU_ITEMS: ContextMenuItem[] = [
		{ label: t('web.gallery.manage'), header: true },
		{ label: t('web.gallery.start'), icon: 'play', color: 'success', action: () => {} },
		{ label: t('web.gallery.stop'), icon: 'stop', disabled: true },
		{
			label: t('web.gallery.open'),
			icon: 'arrowUpRightFromSquare',
			submenu: [
				{ label: t('web.gallery.details'), icon: 'circleInfo', action: () => {} },
				{ label: t('web.gallery.logs'), icon: 'scroll', action: () => {} }
			]
		},
		{ separator: true },
		{
			label: t('web.gallery.slowAction2s'),
			icon: 'hourglassClock',
			action: () => new Promise((resolve) => setTimeout(resolve, 2000))
		},
		{ label: t('web.gallery.delete'), icon: 'trash', color: 'danger', action: () => {} }
	];

	// ----- sample data -----
	const BADGE_STATES = [
		'running',
		'stopped',
		'starting',
		'stopping',
		'restarting',
		'passed',
		'warning',
		'failed',
		'pending',
		'unknown',
		'external'
	];

	const ICON_WEIGHTS = ['thin', 'light', 'regular', 'solid'] as const;

	const CELLS: InfoCell[] = [
		{ label: t('web.gallery.plainValue'), value: 'some value' },
		{ label: t('web.gallery.copyable'), value: '127.0.0.1:25565', copyable: true, style: 'mono' },
		{ label: t('web.gallery.withHelp'), value: 'hover the icon', help: 'Explains what this field means.' },
		{ label: t('web.gallery.empty'), value: null },
		{ label: t('web.gallery.headingStyle'), value: '42', style: 'heading' },
		{ label: t('web.gallery.codeStyle'), value: 'java -jar server.jar --nogui', style: 'code', colSpan: 3 }
	];

	interface DemoRow {
		name: string;
		state: string;
		kind: string;
		cpu: number;
		port: number;
	}
	const ROWS: DemoRow[] = [
		{ name: 'alpha', state: 'running', kind: 'paper', cpu: 12, port: 32561 },
		{ name: 'bravo', state: 'running', kind: 'paper', cpu: 64, port: 32562 },
		{ name: 'charlie', state: 'stopped', kind: 'paper', cpu: 0, port: 32563 },
		{ name: 'delta', state: 'warning', kind: 'velocity', cpu: 91, port: 25565 },
		{ name: 'echo', state: 'stopped', kind: 'paper', cpu: 0, port: 32564 },
		{ name: 'foxtrot', state: 'running', kind: 'velocity', cpu: 33, port: 25566 }
	];
	const COLUMNS: Column[] = $derived([
		{ id: 'name', label: t('web.gallery.name'), sortable: true },
		{ id: 'state', label: t('web.gallery.state'), sortable: true },
		{ id: 'kind', label: t('web.gallery.kind'), sortable: true },
		{ id: 'cpu', label: t('web.gallery.cpu'), sortable: true },
		{ id: 'port', label: t('web.gallery.port'), sortable: true, align: 'right' }
	]);
	const FILTERS: TableFilterGroup<DemoRow>[] = $derived([
		{
			id: 'state',
			label: t('web.gallery.filterState'),
			options: [
				{ value: 'any', label: t('web.gallery.anyState') },
				{ value: 'running', label: t('web.gallery.running'), match: (row) => row.state === 'running' },
				{ value: 'stopped', label: t('web.gallery.stopped'), match: (row) => row.state === 'stopped' }
			]
		}
	]);
	let tableSelected: Set<string> = $state(new Set(['bravo']));

	// a smooth-ish wave with a little jitter, sampled like the real metric history
	const SPARK_POINTS = Array.from({ length: 40 }, (_unused, i) => ({
		t: Date.now() - (40 - i) * 5000,
		v: Math.round(30 + 25 * Math.sin(i / 4) + (i % 7) * 2)
	}));

	// the reporting holes a heartbeat-sourced series really has, one of each shape:
	// missing at the start, a stretch in the middle, an isolated sample, no tail
	const SPARK_HOLES: Array<[number, number]> = [
		[0, 4],
		[12, 18],
		[20, 25],
		[37, 39]
	];

	const SPARK_GAPS = SPARK_POINTS.map((point, i) => ({
		t: point.t,
		v: SPARK_HOLES.some(([from, to]) => i >= from && i <= to) ? undefined : point.v
	}));

	/** Build one node of a fake progress tree, so the states below stay readable. */
	function node(
		id: string,
		name: string,
		progress: number,
		status: ProgressSnapshot['status'],
		message: string,
		children: ProgressSnapshot[] = []
	): ProgressSnapshot {
		return {
			id,
			name,
			level: id.split('.').length,
			status,
			message,
			progress,
			done: progress >= 1,
			children
		};
	}

	// a create-instance tree part-way through its download, the shape the console
	// actually renders while a job runs
	const JOB_RUNNING: ProgressSnapshot = node('0', 'Create bedwars', 0.44, 'info', '', [
		node('0.0', 'Server files', 0.62, 'info', '', [
			node('0.0.0', 'Validate request', 1, 'okay', 'request looks good'),
			node('0.0.1', 'Download paper server', 0.58, 'info', 'build 87; 31.4 / 54.0 MB'),
			node('0.0.2', 'Write instance files', 0, 'info', '')
		]),
		node('0.1', 'Plugins', 0, 'info', ''),
		node('0.2', 'Port allocations', 0, 'info', ''),
		node('0.3', 'Proxy registration', 0, 'info', '')
	]);

	// the same tree after a failure: the step that broke, a step that finished with a
	// warning, and the steps that never got their turn
	const JOB_FAILED: ProgressSnapshot = node('0', 'Create bedwars', 0.31, 'error', '', [
		node('0.0', 'Server files', 0.44, 'error', '', [
			node('0.0.0', 'Validate request', 1, 'okay', 'request looks good'),
			node('0.0.1', 'Download paper server', 0.4, 'error', 'could not download paper 26.2'),
			node('0.0.2', 'Write instance files', 0, 'info', '')
		]),
		node('0.1', 'Plugins', 1, 'warn', 'none target this instance'),
		node('0.2', 'Port allocations', 0, 'info', ''),
		node('0.3', 'Proxy registration', 0, 'info', '')
	]);

	/** Raise a loading notification that walks itself to completion. */
	function raiseLoading(withProgress: boolean): void {
		const note = Notify.loading('Working on something slow…', withProgress ? { progress: 0 } : {});
		let pct = 0;

		const timer = setInterval(() => {
			pct += 10;

			if (withProgress) {
				note.set({ progress: pct });
			}

			if (pct >= 100) {
				clearInterval(timer);
				note.set({ level: 'success', message: t('web.gallery.slowWorkFinished'), closeable: true });
			}
		}, 400);
	}

	/** Raise several identical flashes, to exercise the collapsed stack. */
	function raiseStack(): void {
		for (let i = 0; i < 5; i++) {
			Notify.success('The description for luna/admin-password is updated.');
		}
	}
</script>

<svelte:head><title>{t('web.gallery.componentGalleryLunaConsole')}</title></svelte:head>

<PageHeader
	title={t('web.gallery.componentGallery')}
	description={t('web.gallery.everyConsoleComponentInEvery')}
/>

<div class="gallery">
	<Panel title={t('web.gallery.buttons')}>
		<div class="row">
			<Btn>{t('web.gallery.normal')}</Btn>
			<Btn variant="primary">{t('web.gallery.primary')}</Btn>
			<Btn variant="danger">{t('web.gallery.danger')}</Btn>
			<Btn variant="link">{t('web.gallery.link')}</Btn>
			<Btn variant="tool" icon="sync" title={t('web.gallery.tool')} />
			<Btn variant="icon" icon="gear" title={t('web.gallery.icon')} />
			<Btn icon="download" caret>{t('web.gallery.iconCaret')}</Btn>
			<Btn loading>{t('web.gallery.loading')}</Btn>
			<Btn disabled>{t('web.gallery.disabled')}</Btn>
			<Btn variant="primary" disabled>{t('web.gallery.primaryDisabled')}</Btn>
		</div>
		<div class="row">
			<SplitButton
				label={t('web.gallery.launchInstance')}
				onclick={() => Notify.info('Primary action clicked')}
				items={[
					{ label: t('web.gallery.fromTemplate'), icon: 'copy', action: () => {} },
					{ label: t('web.gallery.import'), icon: 'download', action: () => {} }
				]}
			/>
			<SplitButton
				label={t('web.gallery.outlineSplit')}
				primary={false}
				onclick={() => {}}
				items={[{ label: t('web.gallery.item'), action: () => {} }]}
			/>
			<Dropdown
				label={t('web.gallery.actions')}
				items={[
					{ label: t('web.gallery.edit'), icon: 'pen', action: () => {} },
					{ label: t('web.gallery.disabled'), icon: 'ban', disabled: true },
					{ divider: true, label: '' },
					{ label: t('web.gallery.delete'), icon: 'trash', danger: true, action: () => {} }
				]}
			/>
			<Dropdown label={t('web.gallery.primaryDropdown')} primary items={[{ label: t('web.gallery.item'), action: () => {} }]} />
		</div>
	</Panel>

	<Panel title={t('web.gallery.inputsSelectionControls')}>
		<div class="row">
			<SearchInput bind:value={search} placeholder={t('web.gallery.findResources')} width="18rem" />
			<Select
				label={t('web.gallery.filterState')}
				bind:value={selectValue}
				width="14rem"
				options={[
					{ value: 'any', label: t('web.gallery.anyState') },
					{ value: 'running', label: t('web.gallery.running') },
					{ value: 'stopped', label: t('web.gallery.stopped') }
				]}
			/>
			<Select
				bind:value={selectValue}
				width="12rem"
				options={[
					{ value: 'any', label: t('web.gallery.noLabelVariant') },
					{ value: 'running', label: t('web.gallery.running') }
				]}
			/>
		</div>
		<div class="row">
			<label class="demo-check">
				<Checkbox checked={checked} label={t('web.gallery.checked')} onchange={(value) => (checked = value)} />
				Checkbox
			</label>
			<label class="demo-check">
				<Checkbox indeterminate label={t('web.gallery.indeterminate')} /> Indeterminate
			</label>
			<label class="demo-check"><Checkbox disabled label={t('web.gallery.disabled')} /> {t('web.gallery.disabled')}</label>
			<label class="demo-check">
				<Checkbox checked disabled label={t('web.gallery.checkedDisabled')} /> Checked + disabled
			</label>
			<label class="demo-check">
				<Toggle checked={toggled} label={t('web.gallery.toggle')} onchange={(value) => (toggled = value)} />
				Toggle
			</label>
			<label class="demo-check"><Toggle disabled label={t('web.gallery.toggleDisabled')} /> {t('web.gallery.disabled')}</label>
		</div>
		<div class="row">
			<input class="input" style="width: 16rem" placeholder={t('web.gallery.bareInputField')} />
			<label class="demo-check"><input type="radio" name="g-radio" checked /> {t('web.gallery.radio')}</label>
			<label class="demo-check"><input type="radio" name="g-radio" /> {t('web.gallery.radio')}</label>
		</div>
		<div class="cols2">
			<div class="field">
				<span class="lbl">{t('web.gallery.steppedSlider')}</span>
				<span class="hint">{t('web.gallery.aTickPerStep')}</span>
				<Slider
					value={sliderStep}
					min={3}
					max={32}
					step={1}
					unit=" chunks"
					label={t('web.gallery.steppedSlider')}
					onchange={(value) => (sliderStep = value)}
				/>
			</div>
			<div class="field">
				<span class="lbl">{t('web.gallery.coarseSlider')}</span>
				<span class="hint">{t('web.gallery.49StepsTheTick')}</span>
				<Slider
					value={sliderCoarse}
					min={10}
					max={500}
					step={10}
					unit="%"
					label={t('web.gallery.coarseSlider')}
					onchange={(value) => (sliderCoarse = value)}
				/>
			</div>
			<div class="field">
				<span class="lbl">{t('web.gallery.disabled')}</span>
				<span class="hint">{t('web.gallery.managedValuesRenderRead')}</span>
				<Slider value={12} min={0} max={64} step={4} disabled label={t('web.gallery.disabledSlider')} />
			</div>
		</div>
	</Panel>

	<Panel title={t('web.gallery.statusBadges')}>
		<div class="row">
			{#each BADGE_STATES as state}
				<StatusBadge {state} />
			{/each}
		</div>
		<div class="row">
			<StatusBadge
				state="passed"
				label={t('web.gallery.33ChecksPassed')}
				detail={[
					{
						state: 'passed', label: t('web.gallery.processCheck'), detail: t('web.gallery.javaProcess1980133InsideScreen')
					},
					{ state: 'passed', label: t('web.gallery.portReachability'), detail: t('web.gallery.tcp127001') },
					{ state: 'passed', label: t('web.gallery.serverPing'), detail: t('web.gallery.responding064Players') }
				]}
			/>
			<StatusBadge
				state="warning"
				label={t('web.gallery.13ChecksFailed')}
				detail={[
					{
						state: 'passed', label: t('web.gallery.processCheck'), detail: t('web.gallery.javaProcess1980133InsideScreen')
					},
					{ state: 'failed', label: t('web.gallery.portReachability'), detail: t('web.gallery.tcp1270012') },
					{ state: 'pending', label: t('web.gallery.serverPing'), detail: t('web.gallery.waitingForThePortCheck') }
				]}
			/>
			<StatusBadge state="warning" label={t('web.gallery.plainTextDetail')} detail="Single-line detail popover." />
		</div>
	</Panel>

	<Panel title={t('web.gallery.progressLoading')}>
		<div class="cols3">
			<ProgressBar value={progressDemo} left={t('web.gallery.default')} />
			<ProgressBar value={progressDemo} color="success" left={t('web.gallery.success')} />
			<ProgressBar value={82} color="auto" left={t('web.gallery.autoWarningZone')} />
			<ProgressBar value={97} color="auto" left={t('web.gallery.autoDangerZone')} />
			<ProgressBar compact value={progressDemo} right="{progressDemo}%" />
			<ProgressBar compact value={64} color="auto" right={t('web.gallery.19Gb')} />
		</div>
		<div class="row">
			<Btn onclick={() => (progressDemo = (progressDemo + 20) % 120)}>{t('web.gallery.bumpProgress')}</Btn>
			<Spinner size="1rem" />
			<Spinner size="1.5rem" color="var(--primary)" />
			<Icon name="rotate" spin size="1rem" />
		</div>
	</Panel>

	<Panel
		title={t('web.gallery.progressTree')}
		description={t('web.gallery.whatALongRunningTask')}
	>
		<h4>{t('web.gallery.midFlight')}</h4>
		<ProgressTree root={JOB_RUNNING} state="running" />
		<h4>{t('web.gallery.failedWithTheSteps')}</h4>
		<ProgressTree root={JOB_FAILED} state="failed" />
	</Panel>

	<Panel title={t('web.gallery.iconsGlyphs')}>
		<div class="row">
			{#each ICON_WEIGHTS as weight}
				<span class="demo-check">
					<Icon name="gear" style={weight} size="1.25rem" />
					{weight}
				</span>
			{/each}
			<span class="demo-check"><ShellGlyph size="1.25rem" /> {t('web.gallery.shellglyph')}</span>
			<span class="demo-check"><Icon name="sortDown" style="light" /> {t('web.gallery.sortIdle')}</span>
			<span class="demo-check"><Icon name="sortDown" style="solid" color="var(--link)" /> {t('web.gallery.sortActive')}</span>
		</div>
	</Panel>

	<Panel title={t('web.gallery.tooltips')}>
		<div class="row">
			<Btn onclick={() => {}} title="">
				<span use:tooltip={{ content: 'Tooltip on top' }}>{t('web.gallery.top')}</span>
			</Btn>
			<Btn onclick={() => {}}>
				<span use:tooltip={{ content: 'Tooltip below', position: 'bottom' }}>{t('web.gallery.bottom')}</span>
			</Btn>
			<Btn onclick={() => {}}>
				<span use:tooltip={{ content: 'Tooltip left', position: 'left' }}>{t('web.gallery.left')}</span>
			</Btn>
			<Btn onclick={() => {}}>
				<span use:tooltip={{ content: 'Tooltip right', position: 'right' }}>{t('web.gallery.right')}</span>
			</Btn>
			<span
				class="dim"
				use:tooltip={{
					content:
						t('web.gallery.aLongTooltipThat')
				}}
			>
				{t('web.gallery.longContentHover')}
			</span>
		</div>
	</Panel>

	<Panel title={t('web.gallery.notificationsFlashbar')}>
		<div class="row">
			<Btn onclick={() => Notify.success('The description for luna/admin-password is updated.')}>
				Success
			</Btn>
			<Btn onclick={() => Notify.info('A new console version is available.')}>{t('web.gallery.info')}</Btn>
			<Btn
				onclick={() =>
					Notify.warning('Plugin deploy finished with holdbacks.', {
						detail: t('web.gallery.grimacBukkitHeldBackOn')
					})}
			>
				Warning
			</Btn>
			<Btn
				variant="danger"
				onclick={() =>
					Notify.error('Could not stop instance', {
						detail: t('web.gallery.screenSessionLunaEventDid'), closeable: true
					})}
			>
				Error
			</Btn>
			<Btn onclick={() => raiseLoading(false)}>{t('web.gallery.loading')}</Btn>
			<Btn onclick={() => raiseLoading(true)}>{t('web.gallery.loadingProgress')}</Btn>
			<Btn variant="link" onclick={raiseStack}>{t('web.gallery.raise5Stack')}</Btn>
		</div>
		<Flash kind="info">{t('web.gallery.inlineFlashInfoStatic')}</Flash>
		<Flash kind="success">{t('web.gallery.inlineFlashSuccess')}</Flash>
		<Flash kind="warning">{t('web.gallery.inlineFlashWarning')}</Flash>
		<Flash kind="error" dismiss={() => {}}>{t('web.gallery.inlineFlashErrorDismissable')}</Flash>
	</Panel>

	<Panel title={t('web.gallery.menus')}>
		<div class="row">
			<span bind:this={menuButton}>
				<Btn onclick={() => menuButton && menu?.openAtElement(menuButton)}>
					{t('web.gallery.openContextMenu')}
				</Btn>
			</span>
			<span class="dim">{t('web.gallery.orRightClickAnywhere')}</span>
		</div>
		<div
			class="ctx-zone"
			role="presentation"
			oncontextmenu={(event) => {
				event.preventDefault(); menu?.openAt(event.clientX, event.clientY);
			}}
		>
			{t('web.gallery.rightClickZoneHeaders')}
		</div>
		<ContextMenu bind:this={menu} items={MENU_ITEMS} header="demo-instance" />
	</Panel>

	<Panel title={t('web.gallery.tabsPagingRefresh')}>
		<Tabs
			tabs={[
				{ id: 'one', label: t('web.gallery.details') },
				{ id: 'two', label: t('web.gallery.monitoring') },
				{ id: 'three', label: t('web.gallery.logs') }
			]}
			bind:active={activeTab}
		/>
		<div class="row" style="margin-top: 0.75rem">
			<span class="dim">active: {activeTab}</span>
		</div>
		<div class="row">
			<PagingBar bind:page max={20} />
			<span class="dim">page {page} / 20</span>
		</div>
		<div class="row">
			<RefreshControl
				storageKey="gallery"
				lastUpdated={refreshStamp}
				loading={refreshing}
				onrefresh={async () => {
					refreshing = true;
					await new Promise((resolve) => setTimeout(resolve, 800));
					refreshStamp = Date.now();
					refreshing = false;
				}}
			/>
		</div>
	</Panel>

	<Panel title={t('web.gallery.infoGrid')}>
		<InfoGrid cells={CELLS} columns={[4, 3, 2]} />
	</Panel>

	<Panel title={t('web.gallery.metricChart')}>
		<div class="cols2">
			<Sparkline points={SPARK_POINTS} label={t('web.gallery.cpuUtilization')} unit="%" maxY={100} />
			<Sparkline points={SPARK_GAPS} label={t('web.gallery.tickRateWithGaps')} unit=" TPS" maxY={100} />
			<Sparkline points={[]} label={t('web.gallery.noData')} unit="%" />
		</div>
	</Panel>

	<Panel title={t('web.gallery.modals')}>
		<div class="row">
			<Btn onclick={() => (modalOpen = true)}>{t('web.gallery.openModal')}</Btn>
			<Btn onclick={() => (wideModalOpen = true)}>{t('web.gallery.openWideModal')}</Btn>
		</div>
	</Panel>

	<Panel title={t('web.gallery.dataTable')} flush>
		<DataTable
			tableId="gallery"
			columns={COLUMNS}
			rows={ROWS}
			getId={(row) => row.name}
			selectable="multi"
			bind:selected={tableSelected}
			filters={FILTERS}
			paging
			pageSize={5}
			sortValue={(row, col) =>
				col === 'cpu' || col === 'port' ? (row as any)[col] : String((row as any)[col])}
			onRowContextMenu={(_row, event) => menu?.openAt(event.clientX, event.clientY)}
		>
			{#snippet toolbar()}
				<SearchInput value="" placeholder={t('web.gallery.findDemoRows')} width="16rem" />
			{/snippet}
			{#snippet cell(row, col)}
				{#if col === 'name'}
					<a href="/gallery" onclick={(event) => event.stopPropagation()}>{row.name}</a>
				{:else if col === 'state'}
					<StatusBadge state={row.state} />
				{:else if col === 'cpu'}
					<ProgressBar compact value={row.cpu} color="auto" right="{row.cpu}%" />
				{:else if col === 'port'}
					<span class="mono">:{row.port}</span>
				{:else}
					{(row as any)[col]}
				{/if}
			{/snippet}
		</DataTable>
	</Panel>
</div>

<Modal title={t('web.gallery.demoModal')} bind:open={modalOpen}>
	<p>{t('web.gallery.standardModalBodyEscape')}</p>
	{#snippet footer()}
		<Btn variant="link" onclick={() => (modalOpen = false)}>{t('web.gallery.cancel')}</Btn>
		<Btn variant="primary" onclick={() => (modalOpen = false)}>{t('web.gallery.confirm')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.gallery.wideDemoModal')} bind:open={wideModalOpen} wide>
	<p>{t('web.gallery.wideVariantAsUsed')}</p>
	<Select
		label={t('web.gallery.selectInsideAModal')}
		value="a"
		width="16rem"
		options={[
			{ value: 'a', label: t('web.gallery.rendersAboveTheModal') },
			{ value: 'b', label: t('web.gallery.optionB') },
			{ value: 'c', label: t('web.gallery.optionC') }
		]}
	/>
	{#snippet footer()}
		<Btn variant="primary" onclick={() => (wideModalOpen = false)}>{t('web.gallery.close')}</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.gallery {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.75rem;

		// the panel supplies the trailing padding
		&:last-child {
			margin-bottom: 0;
		}
	}

	.cols3 {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1rem;
		margin-bottom: 0.75rem;
	}
	.cols2 {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}
	// caption above a variant inside a panel that shows several of them
	h4 {
		margin: 0 0 0.625rem;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-secondary);

		& + :global(.tree) {
			margin-bottom: 1.25rem;
		}
	}

	.demo-check {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		cursor: pointer;
	}
	.ctx-zone {
		padding: 1.5rem;
		border: 0.1rem dashed var(--border);
		border-radius: 0.5rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
		text-align: center;
		user-select: none;
	}
</style>
