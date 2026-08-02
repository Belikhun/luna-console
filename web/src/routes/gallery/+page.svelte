<script lang="ts">
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
	 * Component gallery — every UI component on one page, in every notable
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
		{ label: 'Manage', header: true },
		{ label: 'Start', icon: 'play', color: 'success', action: () => {} },
		{ label: 'Stop', icon: 'stop', disabled: true },
		{
			label: 'Open',
			icon: 'arrowUpRightFromSquare',
			submenu: [
				{ label: 'Details', icon: 'circleInfo', action: () => {} },
				{ label: 'Logs', icon: 'scroll', action: () => {} }
			]
		},
		{ separator: true },
		{
			label: 'Slow action (2s)',
			icon: 'hourglassClock',
			action: () => new Promise((resolve) => setTimeout(resolve, 2000))
		},
		{ label: 'Delete', icon: 'trash', color: 'danger', action: () => {} }
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
		{ label: 'Plain value', value: 'some value' },
		{ label: 'Copyable', value: '127.0.0.1:25565', copyable: true, style: 'mono' },
		{ label: 'With help', value: 'hover the icon', help: 'Explains what this field means.' },
		{ label: 'Empty', value: null },
		{ label: 'Heading style', value: '42', style: 'heading' },
		{ label: 'Code style', value: 'java -jar server.jar --nogui', style: 'code', colSpan: 3 }
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
	const COLUMNS: Column[] = [
		{ id: 'name', label: 'Name', sortable: true },
		{ id: 'state', label: 'State', sortable: true },
		{ id: 'kind', label: 'Kind', sortable: true },
		{ id: 'cpu', label: 'CPU', sortable: true },
		{ id: 'port', label: 'Port', sortable: true, align: 'right' }
	];
	const FILTERS: TableFilterGroup<DemoRow>[] = [
		{
			id: 'state',
			label: 'Filter state',
			options: [
				{ value: 'any', label: 'Any state' },
				{ value: 'running', label: 'Running', match: (row) => row.state === 'running' },
				{ value: 'stopped', label: 'Stopped', match: (row) => row.state === 'stopped' }
			]
		}
	];
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
			node('0.0.1', 'Download paper server', 0.58, 'info', 'build 87 — 31.4 / 54.0 MB'),
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
				note.set({ level: 'success', message: 'Slow work finished', closeable: true });
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

<svelte:head><title>Component gallery | Luna Console</title></svelte:head>

<PageHeader
	title="Component gallery"
	description="Every console component in every notable state — a dev surface for eyeballing changes. Talks to no APIs."
/>

<div class="gallery">
	<Panel title="Buttons">
		<div class="row">
			<Btn>Normal</Btn>
			<Btn variant="primary">Primary</Btn>
			<Btn variant="danger">Danger</Btn>
			<Btn variant="link">Link</Btn>
			<Btn variant="tool" icon="sync" title="Tool" />
			<Btn variant="icon" icon="gear" title="Icon" />
			<Btn icon="download" caret>Icon + caret</Btn>
			<Btn loading>Loading</Btn>
			<Btn disabled>Disabled</Btn>
			<Btn variant="primary" disabled>Primary disabled</Btn>
		</div>
		<div class="row">
			<SplitButton
				label="Launch instance"
				onclick={() => Notify.info('Primary action clicked')}
				items={[
					{ label: 'From template', icon: 'copy', action: () => {} },
					{ label: 'Import', icon: 'download', action: () => {} }
				]}
			/>
			<SplitButton
				label="Outline split"
				primary={false}
				onclick={() => {}}
				items={[{ label: 'Item', action: () => {} }]}
			/>
			<Dropdown
				label="Actions"
				items={[
					{ label: 'Edit', icon: 'pen', action: () => {} },
					{ label: 'Disabled', icon: 'ban', disabled: true },
					{ divider: true, label: '' },
					{ label: 'Delete', icon: 'trash', danger: true, action: () => {} }
				]}
			/>
			<Dropdown label="Primary dropdown" primary items={[{ label: 'Item', action: () => {} }]} />
		</div>
	</Panel>

	<Panel title="Inputs & selection controls">
		<div class="row">
			<SearchInput bind:value={search} placeholder="Find resources" width="18rem" />
			<Select
				label="Filter state"
				bind:value={selectValue}
				width="14rem"
				options={[
					{ value: 'any', label: 'Any state' },
					{ value: 'running', label: 'Running' },
					{ value: 'stopped', label: 'Stopped' }
				]}
			/>
			<Select
				bind:value={selectValue}
				width="12rem"
				options={[
					{ value: 'any', label: 'No label variant' },
					{ value: 'running', label: 'Running' }
				]}
			/>
		</div>
		<div class="row">
			<label class="demo-check">
				<Checkbox checked={checked} label="Checked" onchange={(value) => (checked = value)} />
				Checkbox
			</label>
			<label class="demo-check">
				<Checkbox indeterminate label="Indeterminate" /> Indeterminate
			</label>
			<label class="demo-check"><Checkbox disabled label="Disabled" /> Disabled</label>
			<label class="demo-check">
				<Checkbox checked disabled label="Checked disabled" /> Checked + disabled
			</label>
			<label class="demo-check">
				<Toggle checked={toggled} label="Toggle" onchange={(value) => (toggled = value)} />
				Toggle
			</label>
			<label class="demo-check"><Toggle disabled label="Toggle disabled" /> Disabled</label>
		</div>
		<div class="row">
			<input class="input" style="width: 16rem" placeholder="Bare .input field" />
			<label class="demo-check"><input type="radio" name="g-radio" checked /> Radio</label>
			<label class="demo-check"><input type="radio" name="g-radio" /> Radio</label>
		</div>
		<div class="cols2">
			<div class="field">
				<span class="lbl">Stepped slider</span>
				<span class="hint">A tick per step, and the range's ends labelled</span>
				<Slider
					value={sliderStep}
					min={3}
					max={32}
					step={1}
					unit=" chunks"
					label="Stepped slider"
					onchange={(value) => (sliderStep = value)}
				/>
			</div>
			<div class="field">
				<span class="lbl">Coarse slider</span>
				<span class="hint">49 steps — the tick scale thins out when the field narrows</span>
				<Slider
					value={sliderCoarse}
					min={10}
					max={500}
					step={10}
					unit="%"
					label="Coarse slider"
					onchange={(value) => (sliderCoarse = value)}
				/>
			</div>
			<div class="field">
				<span class="lbl">Disabled</span>
				<span class="hint">Managed values render read-only</span>
				<Slider value={12} min={0} max={64} step={4} disabled label="Disabled slider" />
			</div>
		</div>
	</Panel>

	<Panel title="Status badges">
		<div class="row">
			{#each BADGE_STATES as state}
				<StatusBadge {state} />
			{/each}
		</div>
		<div class="row">
			<StatusBadge
				state="passed"
				label="3/3 checks passed"
				detail={[
					{
						state: 'passed',
						label: 'Process check',
						detail: 'java process 1980133 inside screen session'
					},
					{ state: 'passed', label: 'Port reachability', detail: 'TCP 127.0.0.1:25565' },
					{ state: 'passed', label: 'Server ping', detail: 'responding — 0/64 players' }
				]}
			/>
			<StatusBadge
				state="warning"
				label="1/3 checks failed"
				detail={[
					{
						state: 'passed',
						label: 'Process check',
						detail: 'java process 1980133 inside screen session'
					},
					{ state: 'failed', label: 'Port reachability', detail: 'TCP 127.0.0.1:25565 refused' },
					{ state: 'pending', label: 'Server ping', detail: 'waiting for the port check' }
				]}
			/>
			<StatusBadge state="warning" label="plain text detail" detail="Single-line detail popover." />
		</div>
	</Panel>

	<Panel title="Progress & loading">
		<div class="cols3">
			<ProgressBar value={progressDemo} left="Default" />
			<ProgressBar value={progressDemo} color="success" left="Success" />
			<ProgressBar value={82} color="auto" left="Auto (warning zone)" />
			<ProgressBar value={97} color="auto" left="Auto (danger zone)" />
			<ProgressBar compact value={progressDemo} right="{progressDemo}%" />
			<ProgressBar compact value={64} color="auto" right="1.9 GB" />
		</div>
		<div class="row">
			<Btn onclick={() => (progressDemo = (progressDemo + 20) % 120)}>Bump progress</Btn>
			<Spinner size="1rem" />
			<Spinner size="1.5rem" color="var(--primary)" />
			<Icon name="rotate" spin size="1rem" />
		</div>
	</Panel>

	<Panel
		title="Progress tree"
		description="What a long-running task reports back: one row per step of a ProgressReporter tree"
	>
		<h4>Mid-flight</h4>
		<ProgressTree root={JOB_RUNNING} state="running" />
		<h4>Failed, with the steps that never ran</h4>
		<ProgressTree root={JOB_FAILED} state="failed" />
	</Panel>

	<Panel title="Icons & glyphs">
		<div class="row">
			{#each ICON_WEIGHTS as weight}
				<span class="demo-check">
					<Icon name="gear" style={weight} size="1.25rem" />
					{weight}
				</span>
			{/each}
			<span class="demo-check"><ShellGlyph size="1.25rem" /> ShellGlyph</span>
			<span class="demo-check"><Icon name="sortDown" style="light" /> sort idle</span>
			<span class="demo-check"><Icon name="sortDown" style="solid" color="var(--link)" /> sort active</span>
		</div>
	</Panel>

	<Panel title="Tooltips">
		<div class="row">
			<Btn onclick={() => {}} title="">
				<span use:tooltip={{ content: 'Tooltip on top' }}>top</span>
			</Btn>
			<Btn onclick={() => {}}>
				<span use:tooltip={{ content: 'Tooltip below', position: 'bottom' }}>bottom</span>
			</Btn>
			<Btn onclick={() => {}}>
				<span use:tooltip={{ content: 'Tooltip left', position: 'left' }}>left</span>
			</Btn>
			<Btn onclick={() => {}}>
				<span use:tooltip={{ content: 'Tooltip right', position: 'right' }}>right</span>
			</Btn>
			<span
				class="dim"
				use:tooltip={{
					content:
						'A long tooltip that has quite a lot of text in it, enough to wrap onto several lines inside the card without overflowing.'
				}}
			>
				long content (hover)
			</span>
		</div>
	</Panel>

	<Panel title="Notifications (flashbar)">
		<div class="row">
			<Btn onclick={() => Notify.success('The description for luna/admin-password is updated.')}>
				Success
			</Btn>
			<Btn onclick={() => Notify.info('A new console version is available.')}>Info</Btn>
			<Btn
				onclick={() =>
					Notify.warning('Plugin deploy finished with holdbacks.', {
						detail: 'grimac-bukkit held back on survival (needs MC 1.21.11).'
					})}
			>
				Warning
			</Btn>
			<Btn
				variant="danger"
				onclick={() =>
					Notify.error('Could not stop instance', {
						detail: 'screen session luna.event did not answer within 60s',
						closeable: true
					})}
			>
				Error
			</Btn>
			<Btn onclick={() => raiseLoading(false)}>Loading</Btn>
			<Btn onclick={() => raiseLoading(true)}>Loading + progress</Btn>
			<Btn variant="link" onclick={raiseStack}>Raise 5 (stack)</Btn>
		</div>
		<Flash kind="info">Inline Flash — info. Static, lives in the page flow rather than the flashbar.</Flash>
		<Flash kind="success">Inline Flash — success.</Flash>
		<Flash kind="warning">Inline Flash — warning.</Flash>
		<Flash kind="error" dismiss={() => {}}>Inline Flash — error, dismissable.</Flash>
	</Panel>

	<Panel title="Menus">
		<div class="row">
			<span bind:this={menuButton}>
				<Btn onclick={() => menuButton && menu?.openAtElement(menuButton)}>
					Open context menu
				</Btn>
			</span>
			<span class="dim">…or right-click anywhere in this panel</span>
		</div>
		<div
			class="ctx-zone"
			role="presentation"
			oncontextmenu={(event) => {
				event.preventDefault();
				menu?.openAt(event.clientX, event.clientY);
			}}
		>
			right-click zone (headers, separators, submenu, async spinner row, danger tint)
		</div>
		<ContextMenu bind:this={menu} items={MENU_ITEMS} header="demo-instance" />
	</Panel>

	<Panel title="Tabs, paging & refresh">
		<Tabs
			tabs={[
				{ id: 'one', label: 'Details' },
				{ id: 'two', label: 'Monitoring' },
				{ id: 'three', label: 'Logs' }
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

	<Panel title="Info grid">
		<InfoGrid cells={CELLS} columns={[4, 3, 2]} />
	</Panel>

	<Panel title="Metric chart">
		<div class="cols2">
			<Sparkline points={SPARK_POINTS} label="CPU utilization" unit="%" maxY={100} />
			<Sparkline points={SPARK_GAPS} label="Tick rate (with gaps)" unit=" TPS" maxY={100} />
			<Sparkline points={[]} label="No data" unit="%" />
		</div>
	</Panel>

	<Panel title="Modals">
		<div class="row">
			<Btn onclick={() => (modalOpen = true)}>Open modal</Btn>
			<Btn onclick={() => (wideModalOpen = true)}>Open wide modal</Btn>
		</div>
	</Panel>

	<Panel title="Data table" flush>
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
				<SearchInput value="" placeholder="Find demo rows" width="16rem" />
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

<Modal title="Demo modal" bind:open={modalOpen}>
	<p>Standard modal body. Escape or the overlay closes it.</p>
	{#snippet footer()}
		<Btn variant="link" onclick={() => (modalOpen = false)}>Cancel</Btn>
		<Btn variant="primary" onclick={() => (modalOpen = false)}>Confirm</Btn>
	{/snippet}
</Modal>

<Modal title="Wide demo modal" bind:open={wideModalOpen} wide>
	<p>Wide variant, as used by the table preferences dialog.</p>
	<Select
		label="Select inside a modal"
		value="a"
		width="16rem"
		options={[
			{ value: 'a', label: 'Renders above the modal' },
			{ value: 'b', label: 'Option B' },
			{ value: 'c', label: 'Option C' }
		]}
	/>
	{#snippet footer()}
		<Btn variant="primary" onclick={() => (wideModalOpen = false)}>Close</Btn>
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
