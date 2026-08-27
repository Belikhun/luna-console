<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post, patch, del } from '$lib/api';
	import { fmtDuration, fmtBytes, fmtDateTime, cpuCeiling, fmtCpuPct } from '$lib/format';
	import SoftwareLabel from '$lib/components/SoftwareLabel.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import AccessLists from '$lib/components/AccessLists.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Select from '$lib/components/Select.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import type { OverviewDetail, OverviewNode } from '$lib/components/nodeoverview';
	import type { ThreadReport, ThreadSample } from '$client/daemon';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import UnmanagedAddonLog from '$lib/components/UnmanagedAddonLog.svelte';
	import {
		DEFAULT_INSTANCE_TAB,
		INSTANCE_TABS,
		INSTANCE_TAB_LABELS,
		instanceTabPath,
		isInstanceTab
	} from '$lib/components/instancetabs';
	import DeleteInstanceModal from '$lib/components/DeleteInstanceModal.svelte';
	import ProxyRegistrationModal from '$lib/components/ProxyRegistrationModal.svelte';
	import ServerProperties from '$lib/components/ServerProperties.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { familyForDir, hasProvider, traitsOf } from '$core/software';
	import InstanceAddonAdd from '$lib/components/InstanceAddonAdd.svelte';
	import SplitBtn from '$lib/components/SplitBtn.svelte';
	import type { AddonSource, InstanceAddonKind } from '$lib/components/instanceaddon';
	import { ADDON_PROVIDERS, type AddonKindType } from '$lib/components/addons';
	import type { PluginFamily } from '$core/types';
	import { formatMemoryGb, formatMemoryMb } from '$core/memory';
	import type { BuildCheck } from '$core/serverbuilds';
	import type { UnmanagedAddonRow } from '$core/pluginstate';
	import { channelOf } from '$lib/components/software';
	import type { Software } from '$core/types';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import NodeOverview from '$lib/components/NodeOverview.svelte';
	import UptimeTimeline from '$lib/components/UptimeTimeline.svelte';
	import type { UptimeSeries } from '$core/uptime';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import type { DistributionSegment } from '$lib/components/distribution';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import BrandLink from '$lib/components/BrandLink.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import SettingsForm from '$lib/components/SettingsForm.svelte';
	import ProgressTree from '$lib/components/ProgressTree.svelte';
	import GroupsField from '$lib/components/GroupsField.svelte';
	import WorldUpload from '$lib/components/WorldUpload.svelte';
	import WorldWizardModal from '$lib/components/WorldWizardModal.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import type { StagedWorld, WorldReplaceTarget } from '$lib/components/worldupload';
	import type { WorldJournal, WorldReport } from '$core/world';
	import type { BackupEntry } from '$core/backups';
	import {
		backupWorldJob,
		deleteBackup as deleteBackupEntry,
		replaceWorldJob,
		resetWorldJob,
		restoreWorldJob,
		updateBackup as updateBackupEntry,
		verifyBackupJob
	} from '$lib/worldjobs';
	import InstanceRuntimeFields from '$lib/components/InstanceRuntimeFields.svelte';
	import Alerts from '$lib/components/Alerts.svelte';
	import ScheduleQuickModal from '$lib/components/ScheduleQuickModal.svelte';
	import { followJob, type JobView } from '$lib/jobs';
	import { instanceStateJob, attachInstanceJobFlash, type StateAction } from '$lib/instancejobs';

	/** how often the header's status is re-read */
	const POLL_MS = 4000;

	/**
	 * Tabs whose data the refresh control re-reads along with the header.
	 *
	 * `config` is deliberately absent: it is a form, and reloading it under the
	 * user would discard whatever they were typing. It is also why the tab data
	 * rides the refresh control's cadence rather than the fast header poll -
	 * a plugin report scans the instance's jars and its boot session, which is
	 * not something to do every four seconds.
	 */
	const REFRESHED_TABS = ['plugins', 'datapacks', 'respacks', 'monitoring', 'checks', 'logs', 'environment', 'world'];

	const LOG_LINE_CHOICES = [100, 200, 500, 1000];

	/** a scroll further than this from the bottom is the user reading back */
	const LOG_FOLLOW_SLACK = 40;

	const LOG_FOLLOW_KEY = 'luna.logs.follow';

	/** Shared by the log tail and the addon stream; both are EventSources. */
	const LOG_LIVE_LABEL = {
		off: '',
		connecting: 'connecting…',
		live: 'live',
		reconnecting: 'reconnecting…'
	};


	/** headroom over the busiest sample, so the player chart never clips */
	const PLAYER_HEADROOM = 1.2;

	const name = $derived(page.params.name);

	let inst: any = $state(null);
	/**
	 * The open tab, which is the last path segment.
	 *
	 * Derived rather than held: the URL is the single source of truth, so the back
	 * button, a pasted link and a middle-clicked tab all land on the same place. An
	 * unknown segment falls back to the default rather than 404ing, because the tab
	 * set depends on the software - a proxy has no world - and a link that was valid
	 * for one instance should not be a dead end on another.
	 */
	const tab = $derived.by(() => {
		const wanted = page.params.tab;

		if (!isInstanceTab(wanted)) {
			return DEFAULT_INSTANCE_TAB;
		}

		// Which tabs exist depends on the software, and that is not known until the
		// instance loads - so until it does the URL is taken at its word rather than
		// bounced to the default and back. Once it is known, a tab that does not
		// apply here falls back: `/instances/proxy/world` renders Details, because a
		// proxy has no world.
		if (inst && !instanceTabs.some((entry) => entry.id === wanted)) {
			return DEFAULT_INSTANCE_TAB;
		}

		return wanted;
	});

	/**
	 * Put the URL back in step when the tab it names does not apply here.
	 *
	 * The fallback above fixes what is *rendered*; this fixes what the address bar
	 * and the breadcrumb say, which would otherwise still claim "World & Backup" on
	 * a proxy. `replaceState` because the bad URL is not a place worth going back
	 * to - it was a link that did not fit this instance.
	 */
	$effect(() => {
		const wanted = page.params.tab;

		if (!name || !inst || wanted === undefined || tab === wanted) {
			return;
		}

		void goto(instanceTabPath(name, tab), { replaceState: true, noScroll: true });
	});

	/** The addon directories this software keeps; every addon noun follows from them. */
	const addonDirs = $derived(
		inst ? traitsOf(inst.software as Software).addonDirs : ['plugins']
	);

	/** Whether every addon here is a mod, which is what a lone `mods/` means. */
	const modsOnly = $derived(addonDirs.length === 1 && addonDirs[0] === 'mods');

	/** Whether this one runs both ecosystems, and so cannot be named after either. */
	const hybrid = $derived(addonDirs.length > 1);

	// a mod loader keeps its addons in mods/, so the tab is called what the
	// operator will look for; a hybrid runs both ecosystems and says so. The rows
	// and the API behind them are the same either way.
	const addonLabel = $derived(
		hybrid
			? t('web.instanceDetail.addonsBoth')
			: modsOnly
				? t('web.instanceDetail.addonsMods')
				: t('web.instanceDetail.addonsPlugins')
	);

	/**
	 * The tab bar, each entry carrying its own path.
	 *
	 * `$derived` because the labels are `t()` calls, which have to be re-read when
	 * the locale changes, and because which tabs exist depends on the software: a
	 * proxy and an external server have no world, so the world-scoped tabs do not
	 * apply to them.
	 */
	/** Tabs that only exist on something with a world of its own. */
	const WORLD_TABS = new Set<string>(['world', 'datapacks', 'respacks', 'access']);

	const instanceTabs = $derived.by(() => {
		const worldless = !inst || traitsOf(inst.software as Software).isProxy || inst.external;

		return INSTANCE_TABS.filter(
			(id) => !worldless || !WORLD_TABS.has(id)
		).map((id) => ({
			id,
			// the addon tab is the one whose name depends on the software
			label: id === 'plugins' ? addonLabel : t(INSTANCE_TAB_LABELS[id]),
			href: instanceTabPath(name ?? '', id)
		}));
	});


	/**
	 * The unmanaged panel names the kind it actually lists.
	 *
	 * "Addons" is the word for the tab, not for the thing in the directory: on a
	 * mod loader every row here is a mod, and the heading is what an operator
	 * scans before deciding the panel is about something else.
	 */
	const unmanagedTitle = $derived(
		hybrid
			? t('web.instanceDetail.unmanagedBoth')
			: modsOnly
				? t('web.instanceDetail.unmanagedMods')
				: t('web.instanceDetail.unmanagedPlugins')
	);

	/** Singular noun for the unmanaged table's own search and empty copy. */
	const unmanagedNoun = $derived(
		modsOnly ? t('web.catalogKinds.mod') : t('web.catalogKinds.plugin')
	);

	/** Whether java profiles, runtimes and JVM flags mean anything for this one. */
	const usesJava = $derived(!inst || traitsOf(inst.software as Software).usesJava);

	/** Whether this instance's version can be changed from here at all. */
	const versionChangeable = $derived.by(() => {
		if (!inst) {
			return false;
		}

		const software = inst.software as Software;

		return hasProvider(software) && traitsOf(software).carriesMcRequirement;
	});

	let cfgData: any = $state(null);
	let cfgMemory = $state('');
	let cfgProfile = $state('');
	let cfgVersion = $state('');
	let cfgRuntime = $state('');
	let cfgJavaArgs = $state('');
	let cfgJavaAgents: string[] = $state([]);
	let cfgAutoRestart = $state(true);
	let cfgRestartDelay = $state(3);
	let cfgSettings: Record<string, string> = $state({});
	let cfgAddonGroups: string[] = $state([]);
	let serverVersions: string[] = $state([]);
	let saving = $state(false);
	let versionJob: JobView | null = $state(null);
	let versionJobOpen = $state(false);
	let deleteOpen = $state(false);
	let scheduleOpen = $state(false);
	let versionConflict: any[] = $state([]);

	let addonUploadOpen = $state(false);
	let datapackUploadOpen = $state(false);
	let addonSource = $state<AddonSource>('pool');
	let datapackSource = $state<AddonSource>('pool');
	let addonProvider = $state('modrinth');
	let datapackProvider = $state('modrinth');

	/** Open the add dialog on one source; the caret picks, the dialog does not. */
	function openAddon(source: AddonSource, provider = 'modrinth'): void {
		addonSource = source;
		addonProvider = provider;
		addonUploadOpen = true;
	}

	function openDatapack(source: AddonSource, provider = 'modrinth'): void {
		datapackSource = source;
		datapackProvider = provider;
		datapackUploadOpen = true;
	}

	/**
	 * The caret's alternatives: a file, then one entry per provider that hosts this
	 * kind. Named per provider rather than one "from a provider" entry, so the
	 * operator lands in the right search instead of picking twice; the same shape
	 * the pool screens' Install button uses.
	 */
	function sourceMenu(
		kind: AddonKindType,
		open: (source: AddonSource, provider?: string) => void
	): ContextMenuItem[] {
		return [
			{
				label: t('web.instanceAddon.menuUpload'),
				icon: 'fileArrowUp',
				action: () => open('upload')
			},
			{ separator: true, label: '' },
			...ADDON_PROVIDERS.filter((entry) => entry.types.includes(kind)).map((entry) => ({
				label: t('web.instanceAddon.menuProvider', { provider: entry.label }),
				brand: entry.id,
				action: () => open('provider', entry.id)
			}))
		];
	}


	/**
	 * Platform families this instance can be handed a build for.
	 *
	 * Derived from its own addon directories, so a paper backend is offered paper
	 * (and universal, which is a jar carrying both descriptors) while a modpack is
	 * offered its loader. A hybrid running both gets both.
	 */
	const uploadFamilies = $derived.by((): PluginFamily[] => {
		if (!inst) {
			return ['paper'];
		}

		const dirs = traitsOf(inst.software as Software).addonDirs;
		const own = dirs.map((dir) => familyForDir(inst.software as Software, dir));

		return [...own, 'universal'];
	});

	/** Whether this instance's addons are plugins or mods, for the dialog's wording. */
	const uploadKind = $derived<InstanceAddonKind>(
		inst && traitsOf(inst.software as Software).addonDirs.includes('mods') ? 'mod' : 'plugin'
	);

	const addonSourceMenu = $derived(
		sourceMenu(uploadKind === 'mod' ? 'mod' : 'plugin', openAddon)
	);
	const datapackSourceMenu = $derived(sourceMenu('datapack', openDatapack));

	/** Last answer from the build check; null until the operator asks for one. */
	let buildCheck: BuildCheck | null = $state(null);
	let buildChecking = $state(false);
	let buildUpdating = $state(false);

	let instPlugins: any[] = $state([]);
	let pluginTotals = $state({ warnings: 0, errors: 0, sessionComplete: true });
	let instDatapacks: any[] = $state([]);
	let datapackWorld = $state('');
	/** addon jars in the instance's directory that luna does not manage */
	let instUnmanaged: UnmanagedAddonRow[] = $state([]);
	/** addon stream state, in the same vocabulary the log stream uses */
	let addonLive: 'off' | 'connecting' | 'live' | 'reconnecting' = $state('off');
	/**
	 * Whether an addon report has arrived yet.
	 *
	 * Separate from `addonLive`, which describes the *connection*: the stream can
	 * be open for the second or two it takes the owning daemon to parse a boot
	 * session, and until the first frame lands `instPlugins` is empty. Without
	 * this the screen filled that gap by rendering the empty array as fact - the
	 * overview said "Mods (0) · none installed" and the tab showed an empty table
	 * on a server with 322 mods, which reads as an answer rather than as a wait.
	 */
	let addonsLoaded = $state(false);
	/**
	 * The addon stream's indicator.
	 *
	 * `addonLive` describes the socket, and the socket opens well before the first
	 * frame: the owning daemon has a boot session to parse first. Saying "live"
	 * during that gap claims data the screen does not have, which is the same lie
	 * the empty tables used to tell, so the first report is what earns the word.
	 */
	const addonLiveLabel = $derived(
		addonStreamOwnsView() && !addonsLoaded
			? t('web.instanceDetail.loadingShort')
			: LOG_LIVE_LABEL[addonLive]
	);
	let instRespacks: any[] = $state([]);

	/**
	 * Every variable this instance resolves, with the scope that won. Builtins are
	 * in here too; they are computed per instance, so this is the only screen that
	 * can show them at all.
	 */
	interface EnvVar {
		name: string;
		value: string;
		scope: 'builtin' | 'global' | 'machine' | 'instance';
		secret: boolean;
		description: string;
		shadowed: Array<{ scope: string; value: string }>;
	}

	let envVars: EnvVar[] = $state([]);
	/** Secrets revealed this session, dropped on reload */
	let envRevealed: Record<string, string> = $state({});

	/**
	 * The instance name as a definite string.
	 *
	 * `page.params.name` is optional to the type system even though this route
	 * cannot match without it, and the world verbs pass it as an argument rather
	 * than only interpolating it.
	 */
	const worldName = $derived(name ?? '');

	let worldReport: WorldReport | null = $state(null);
	let backups: BackupEntry[] = $state([]);
	/** The world operation holding this instance, as the daemon reports it */
	let worldLock: WorldJournal | null = $state(null);
	let worldStage: StagedWorld | null = $state(null);
	let replaceOpen = $state(false);
	let replaceStep = $state(0);
	let replaceBackupFirst = $state(true);
	let backupSelection: Set<string> = $state(new Set());
	let restoreTarget: BackupEntry | null = $state(null);
	let restoreOpen = $state(false);
	let restoreBackupFirst = $state(true);
	let restoreLossAck = $state(false);
	let renameTarget: BackupEntry | null = $state(null);
	let renameOpen = $state(false);
	let renameValue = $state('');
	let deleteTargets: BackupEntry[] = $state([]);
	let deleteBackupsOpen = $state(false);
	let resetOpen = $state(false);
	let resetConfirm = $state('');
	let resetBackupFirst = $state(true);


	/** Pack key whose per-instance rule edit is in flight, for the row's button. */
	let respackBusy = $state('');
	let metrics: { history: any[]; events: any[]; uptime?: UptimeSeries } = $state({
		history: [],
		events: []
	});
	/**
	 * Per-thread CPU of the running process; null until the first report lands.
	 *
	 * Held apart from `metrics` on purpose: a report is a rate, so the daemon has
	 * to hold the call open for the length of its window, and the charts beside it
	 * must not wait a second on something they do not read.
	 */
	let threads: ThreadReport | null = $state(null);
	let threadsPending = $state(false);
	/** Why there is no report, when the owner had something to say about it. */
	let threadsReason: string | null = $state(null);
	let logData: { content: string; archives: any[] } = $state({ content: '', archives: [] });
	/** whether the snapshot behind the log view has been read at least once */
	let logSnapshotRead = $state(false);
	let logLines = $state(200);
	let logFollow = $state(false);
	/**
	 * Streamed lines; null when the snapshot is what is shown. They outlive the
	 * stream that produced them; see `setLogFollow`.
	 */
	let logStream: string[] | null = $state(null);
	let logLive: 'off' | 'connecting' | 'live' | 'reconnecting' = $state('off');
	let logEl: HTMLElement | null = $state(null);

	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	/** name of the primary daemon; the machine an ownerless instance runs on */
	let hostName = $state('');

	/**
	 * Re-read the page. `tabData` also reloads whatever the open tab is showing -
	 * what the refresh control asks for, so the plugins table and the charts are
	 * as current as the header above them; the fast poll leaves them alone.
	 */
	async function refresh(opts: { tabData?: boolean } = {}): Promise<void> {
		// the poll can outlive the route by a tick during a client-side navigation,
		// at which point page.params.name is already gone
		if (!name) {
			return;
		}

		loading = true;

		try {
			inst = await api(`/instances/${name}`);

			if (opts.tabData && REFRESHED_TABS.includes(tab)) {
				await loadTab(tab);
			}

			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.common.loadFailedNamed', { name }), { detail: (err as Error).message });
		} finally {
			loading = false;
		}

		// an operation already in flight for this instance; started elsewhere, or
		// before a reload; gets its flash card raised here; attached jobs dedupe,
		// so re-checking on every poll is safe
		try {
			const running = await api(`/jobs?target=${encodeURIComponent(name)}&state=running`);

			for (const job of running.jobs) {
				attachInstanceJobFlash(job);
			}
		} catch {
			// job discovery is best-effort; the page itself already refreshed
		}
	}

	/**
	 * Whether the addon stream is the authority for the tabs it feeds. Read
	 * through a call rather than inline, so a check after an await is not
	 * narrowed away; the stream connecting mid-request is the case it exists for.
	 */
	function addonStreamOwnsView(): boolean {
		return addonLive === 'live';
	}

	/** Fold one frame of the addon stream into the summary and the tabs it feeds. */
	function applyAddonSnapshot(snapshot: any): void {
		addonsLoaded = true;
		instPlugins = snapshot.plugins;
		instUnmanaged = snapshot.unmanaged ?? [];
		pluginTotals = {
			warnings: snapshot.warnings,
			errors: snapshot.errors,
			sessionComplete: snapshot.sessionComplete
		};

		// absent for software with no world of its own; leave the tab as it was
		if (snapshot.datapacks) {
			instDatapacks = snapshot.datapacks.rows;
			datapackWorld = snapshot.datapacks.world;
		}
	}

	/**
	 * Read a fresh thread report.
	 *
	 * Guarded against overlap: the call outlives a fast refresh tick, and two in
	 * flight at once would double the /proc walking to show one of the answers.
	 */
	async function loadThreads(): Promise<void> {
		if (threadsPending) {
			return;
		}

		threadsPending = true;

		try {
			const data = await api(`/instances/${name}/threads`);

			threads = data.report;
			threadsReason = data.reason ?? null;
		} catch (err) {
			// a stopped instance or an unreachable owner; the panel says so itself
			threads = null;
			threadsReason = err instanceof Error ? err.message : null;
		} finally {
			threadsPending = false;
		}
	}

	/** Each tab loads its own data the first time it is shown, and on refresh. */
	async function loadTab(which: string): Promise<void> {
		// The stream owns both of these tabs whenever it is up; this fetch is the
		// fallback for the moment before it connects, and for a browser that
		// cannot keep it open. The state is re-checked after the await too; the
		// stream can go live mid-request, and a late snapshot must not paint an
		// older state over a newer frame.
		if (which === 'plugins' && !addonStreamOwnsView()) {
			const data = await api(`/instances/${name}/plugins`);

			if (!addonStreamOwnsView()) {
				addonsLoaded = true;
				instPlugins = data.plugins;
				pluginTotals = {
					warnings: data.warnings,
					errors: data.errors,
					sessionComplete: data.sessionComplete
				};
			}
		}

		if (which === 'datapacks' && !addonStreamOwnsView()) {
			const data = await api(`/instances/${name}/datapacks`);

			if (!addonStreamOwnsView()) {
				instDatapacks = data.rows;
				datapackWorld = data.world;
			}
		}

		if (which === 'environment') {
			const data = await api(`/instances/${name}/env`);

			envVars = data.variables;
		}

		if (which === 'respacks') {
			// the catalog is proxy-global; this tab shows how it lands here
			instRespacks = (await api('/respacks')).packs;
		}

		if (which === 'world') {
			const data = await api(`/instances/${name}/world`);

			worldReport = data.world;
			backups = data.backups;
			// the lock comes from the daemon rather than from this page's own job
			// list: a backup started in another tab, by the CLI or by a schedule
			// holds the instance just as firmly, and a tab that only knew its own
			// work would offer verbs the server is about to refuse
			worldLock = data.lock;
		}

		if (which === 'monitoring' || which === 'checks') {
			metrics = await api(`/instances/${name}/metrics`);
		}

		// deliberately not awaited: the thread report is measured over a window, so it
		// lands about a second after everything else on the tab, and the charts have
		// no reason to hold for it
		if (which === 'monitoring') {
			void loadThreads();
		}

		// While following, the stream is the body of the view, and a refresh tick
		// re-reading it would fetch lines nobody looks at; except the first time,
		// because the archive list shown beside the log comes with the snapshot.
		//
		// This deliberately never touches `logStream`. Auto-refresh runs every ten
		// seconds by default, and replacing the body resets the scroll: doing it
		// here would yank a reader back to the top of the log a few seconds after
		// they scrolled down to read something. Only `showLogSnapshot` swaps the
		// body, and only because someone asked it to.
		if (which === 'logs' && (!followingLog() || !logSnapshotRead)) {
			logData = await api(`/instances/${name}/logs?lines=${logLines}`);
			logSnapshotRead = true;
		}

		if (which === 'config') {
			cfgData = await api(`/instances/${name}/config`);
			cfgMemory = cfgData.memory;
			cfgProfile = cfgData.profile;
			cfgVersion = cfgData.mcVersion ?? '';
			cfgRuntime = cfgData.runtime ?? '';
			cfgJavaArgs = (cfgData.javaArgs ?? []).join(' ');
			cfgJavaAgents = [...(cfgData.javaAgents ?? [])];
			cfgAutoRestart = cfgData.autoRestart !== false;
			cfgRestartDelay = cfgData.restartDelay ?? 3;
			cfgSettings = { ...cfgData.settings };
			cfgAddonGroups = [...(cfgData.addonGroups ?? [])];

			if (!serverVersions.length && versionChangeable) {
				serverVersions = (await api(`/software/${inst?.software}/versions`)).mcVersions;
			}
		}
	}

	/** Pin the log view to its newest line, once the new content is in the DOM. */
	async function pinLogToBottom(): Promise<void> {
		await tick();

		if (logEl) {
			logEl.scrollTop = logEl.scrollHeight;
		}
	}

	/**
	 * Whether the log stream is the authority for the view. Read through a call
	 * so a check after an await is not narrowed away.
	 */
	function followingLog(): boolean {
		return logFollow;
	}

	/**
	 * Put the snapshot back in the body of the log view, dropping whatever lines a
	 * closed stream left there. This resets the scroll to the top, which is why it
	 * is only ever reached from a control the reader actually used.
	 */
	async function showLogSnapshot(): Promise<void> {
		logStream = null;
		logSnapshotRead = false;

		await loadTab('logs');
	}

	/**
	 * Turn following on or off, remembering the choice for the next visit.
	 *
	 * Turning it *off* deliberately does nothing to the view. The usual way it
	 * happens is the reader scrolling back to look at something, so the lines
	 * they scrolled to have to stay exactly where they are; re-reading the
	 * snapshot here would swap the whole body of the view and throw them back to
	 * the top of the log, which is the opposite of what scrolling up asked for.
	 * The lines the stream left behind stay on screen until something the reader
	 * actually asked for replaces them (Refresh, a line-count change, or leaving
	 * the tab).
	 */
	function setLogFollow(on: boolean): void {
		logFollow = on;

		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(LOG_FOLLOW_KEY, on ? '1' : '0');
		}

		if (on) {
			void pinLogToBottom();
		}
	}

	/**
	 * Scrolling back through the log turns following off; otherwise the next
	 * streamed line would yank the view away from whatever is being read. Our
	 * own pin lands at the bottom, so it never trips this.
	 */
	function onLogScroll(): void {
		if (!logFollow || !logEl) {
			return;
		}

		if (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight > LOG_FOLLOW_SLACK) {
			setLogFollow(false);
		}
	}

	/**
	 * Following is a real stream, not a poll: the daemon already tails the
	 * instance's latest.log on its own host and pipes it as SSE; the same
	 * stream the live console reads. Browser streaming here is always SSE and
	 * never a WebSocket (DESIGN.md §4); the WebSockets in luna are the
	 * daemon-to-daemon links, and a follower-owned instance's tail is tunnelled
	 * over one before reaching this EventSource.
	 *
	 * The stream owns the view while it is open; it opens with the daemon's own
	 * backlog and grows from there, so there is no snapshot to splice it onto and
	 * no chance of showing a line twice.
	 *
	 * Closing it leaves those lines on screen. They are the newest the page has,
	 * and more to the point the view is a single text node: replacing its content
	 * resets the scroll, and following usually stops *because* someone scrolled
	 * back to read something. `loadTab` is what swaps them for a snapshot again.
	 */
	$effect(() => {
		if (tab !== 'logs' || !logFollow) {
			return;
		}

		const keep = logLines;
		const stream = new EventSource(`/api/instances/${name}/console`);

		logStream = [];
		logLive = 'connecting';

		stream.onopen = () => (logLive = 'live');

		// EventSource reconnects on its own; saying so beats a view that has
		// quietly stopped moving
		stream.onerror = () => (logLive = 'reconnecting');

		stream.onmessage = (event) => {
			// A line can arrive between the reader scrolling away and this effect
			// tearing the stream down a tick later. Taking it would pin the view
			// back to the bottom, and trimming to `keep` would drop lines off the
			// top; both of them moving the text the reader just scrolled to.
			if (!followingLog()) {
				return;
			}

			logStream = [...(logStream ?? []), String(JSON.parse(event.data))].slice(-keep);

			void pinLogToBottom();
		};

		return () => {
			stream.close();
			logLive = 'off';
		};
	});

	/**
	 * Lines a closed stream left in the view belong to the visit that produced
	 * them, so leaving the logs tab drops them and coming back starts from a
	 * fresh snapshot.
	 *
	 * This is keyed on the tab alone; turning following off is not a dependency,
	 * which is the whole point: that is the one case where the lines have to stay.
	 */
	$effect(() => {
		if (tab !== 'logs') {
			return;
		}

		return () => {
			logStream = null;
			logSnapshotRead = false;
		};
	});

	/**
	 * Addon state is live for as long as the page is open; the distribution bars
	 * in the summary sit above the tabs, so this is not something a tab can own.
	 *
	 * It has to be a stream rather than the page's poll: the interesting window
	 * is a restart, where every addon's state changes twice in a few seconds and
	 * a poll would show a stale "running" for most of it. The server sends a
	 * frame only when the snapshot actually differs, and slows down on its own
	 * once the instance settles, so an idle page costs nothing to keep open.
	 */
	$effect(() => {
		const stream = new EventSource(`/api/instances/${name}/addons/stream`);

		addonLive = 'connecting';

		stream.onopen = () => (addonLive = 'live');

		// EventSource reconnects on its own; saying so beats a table that has
		// quietly stopped moving
		stream.onerror = () => (addonLive = 'reconnecting');

		stream.onmessage = (event) => {
			addonLive = 'live';
			applyAddonSnapshot(JSON.parse(event.data));
		};

		return () => {
			stream.close();
			addonLive = 'off';
		};
	});

	onMount(() => {
		logFollow = localStorage.getItem(LOG_FOLLOW_KEY) === '1';

		void refresh();

		void api('/host')
			.then((host) => (hostName = host.name ?? ''))
			.catch(() => {});

		const poll = setInterval(refresh, POLL_MS);

		return () => clearInterval(poll);
	});

	$effect(() => {
		void tab;
		void loadTab(tab);
	});

	async function stateAction(action: StateAction): Promise<void> {
		if (!name) {
			return;
		}

		// the flash card follows the job's log-derived progress on its own; the
		// page just re-reads its header once the transition settles
		await instanceStateJob(name, action);
		await refresh();
	}

	/** Only settings the user actually moved are sent, so a save says what it changed. */
	const settingEdits = $derived.by(() => {
		const out: Record<string, string> = {};

		for (const spec of (cfgData?.schema ?? []) as any[]) {
			const value = cfgSettings[spec.key];

			if (!spec.managed && value !== undefined && value !== cfgData.settings[spec.key]) {
				out[spec.key] = value;
			}
		}

		return out;
	});

	const settingEditCount = $derived(Object.keys(settingEdits).length);

	const javaArgsDirty = $derived(cfgData !== null && cfgJavaArgs.trim() !== (cfgData.javaArgs ?? []).join(' '));

	const javaAgentsDirty = $derived(
		cfgData !== null && cfgJavaAgents.join(' ') !== (cfgData.javaAgents ?? []).join(' ')
	);

	const runtimeDirty = $derived(cfgData !== null && cfgRuntime !== (cfgData.runtime ?? ''));

	const autoRestartDirty = $derived(
		cfgData !== null && cfgAutoRestart !== (cfgData.autoRestart !== false)
	);

	const restartDelayDirty = $derived(
		cfgData !== null && Number(cfgRestartDelay) !== (cfgData.restartDelay ?? 3)
	);

	/**
	 * Runtimes this instance's own machine holds, plus whatever it is already
	 * pinned to. A runtime the machine has not installed yet stays pickable and
	 * is labelled as such: starting the instance installs it, which is the point.
	 */
	const runtimeOptions = $derived.by(() => {
		if (!cfgData) {
			return [{ value: '', label: t('web.instanceDetail.profileDefault') }];
		}

		const installed = (cfgData.machineRuntimes ?? []) as Array<{ id: string }>;
		const options = [
			{ value: '', label: t('web.instanceDetail.profileDefault') },
			...installed.map((runtime) => ({ value: runtime.id, label: runtime.id }))
		];

		if (cfgRuntime && !installed.some((runtime) => runtime.id === cfgRuntime)) {
			options.push({
				value: cfgRuntime,
				label: `${cfgRuntime} · ${t('web.instanceDetail.installsOnStart')}`
			});
		}

		return options;
	});

	/** What the instance actually resolves today, and which level decided it. */
	const runtimeHint = $derived.by(() => {
		const selection = cfgData?.selection as
			| { kind: string; id?: string; path?: string; source?: string }
			| undefined;

		if (!selection || selection.kind === 'default') {
			return t('web.instanceDetail.runtimeDefaultHint');
		}

		if (selection.kind === 'path') {
			return t('web.instanceDetail.runtimePathHint', {
				path: selection.path ?? '',
				source: selection.source ?? ''
			});
		}

		return t('web.instanceDetail.runtimeIdHint', {
			id: selection.id ?? '',
			source: selection.source ?? ''
		});
	});

	const groupsDirty = $derived.by(() => {
		if (!cfgData) {
			return false;
		}

		const before: string[] = cfgData.addonGroups ?? [];

		return (
			before.length !== cfgAddonGroups.length ||
			cfgAddonGroups.some((group) => !before.includes(group))
		);
	});

	/** Follow a version-change job to its end, keeping its tree in the progress dialog. */
	async function trackVersionJob(job: JobView, note: ReturnType<typeof Notify.loading>): Promise<void> {
		versionJob = job;
		versionJobOpen = true;

		const done = await followJob(job.id, (view) => {
			versionJob = view;
			note.set({ progress: Math.round(view.progress.progress * 100) });
		});

		// a build id is a string for every provider: a paper build number, a forge
		// loader version, a pumpkin release tag
		const result = done.result as { from: string | null; to: string; build: string };

		note.set({
			level: 'success',
			message: `${name}: ${result.from ?? '?'} → ${result.to}`,
			detail: t('web.instanceDetail.paperBuildRestart', { build: result.build }),
			progress: null,
			closeable: true
		});

		await refresh();
		await loadTab('config');
	}

	/**
	 * Ask whether a newer build of this instance's own version exists.
	 *
	 * Never automatic. The answer costs a provider round trip and is only ever
	 * acted on deliberately, so nagging every page load would spend requests to
	 * tell an operator something they did not ask about.
	 */
	async function checkBuild(): Promise<void> {
		buildChecking = true;

		try {
			buildCheck = await api(`/instances/${name}/build`);
		} catch (err) {
			Notify.error(t('web.instanceDetail.buildCheckFailed'), {
				detail: (err as Error).message
			});
		} finally {
			buildChecking = false;
		}
	}

	/** Install the offered build, following the same progress tree a version change uses. */
	async function applyBuild(): Promise<void> {
		buildUpdating = true;

		const note = Notify.loading(
			t('web.instanceDetail.installingBuild', { build: buildCheck?.update?.to ?? '' })
		);

		try {
			const res = await post(`/instances/${name}/build`, {});

			await trackVersionJob(res.job, note);
			await checkBuild();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.instanceDetail.buildInstallFailed'),
				detail: (err as Error).message,
				progress: null,
				closeable: true
			});
		} finally {
			buildUpdating = false;
		}
	}

	async function saveConfig(): Promise<void> {
		saving = true;
		versionConflict = [];
		versionJob = null;
		versionJobOpen = false;

		const note = Notify.loading(t('web.instanceDetail.savingConfig', { name: name ?? '' }));

		try {
			const body: any = {
				memory: cfgMemory,
				profile: cfgProfile,
				settings: settingEdits
			};

			if (javaArgsDirty) {
				body.javaArgs = cfgJavaArgs;
			}

			if (javaAgentsDirty) {
				body.javaAgents = cfgJavaAgents;
			}

			if (runtimeDirty) {
				body.runtime = cfgRuntime;
			}

			if (autoRestartDirty) {
				body.autoRestart = cfgAutoRestart;
			}

			if (restartDelayDirty) {
				body.restartDelay = Number(cfgRestartDelay);
			}

			if (groupsDirty) {
				body.addonGroups = cfgAddonGroups;
			}

			if (cfgVersion && cfgVersion !== cfgData.mcVersion) {
				body.mcVersion = cfgVersion;
			}

			const res = await patch(`/instances/${name}/config`, body);

			// a 409 with `incompatible` is the server-version gate, not a failure
			if (res.ok === false && res.incompatible) {
				versionConflict = res.incompatible;

				note.set({
					level: 'warning',
					message: t('web.instanceDetail.incompatiblePlugins', { count: res.incompatible.length, version: cfgVersion }),
					detail: t('web.instanceDetail.reviewTheConflictBelowBefore'),
					closeable: true
				});

				saving = false;

				return;
			}

			note.set({
				level: 'success',
				message: t('web.instanceDetail.savedChanges', { changes: res.changed.join(', ') || t('web.instanceDetail.noChanges') }),
				detail: res.changed.length ? 'Applies on the next restart.' : '',
				closeable: true
			});

			// a version change downloads a jar, so the route handed back a job to watch
			if (res.job) {
				await trackVersionJob(res.job, Notify.loading(t('web.instanceDetail.downloadingPaper', { version: cfgVersion })));
			} else {
				await refresh();
				await loadTab('config');
			}
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.instanceDetail.saveFailed', { name: name ?? '' }),
				detail: (err as Error).message,
				progress: null,
				closeable: true
			});
		}

		saving = false;
	}

	async function forceVersion(): Promise<void> {
		saving = true;

		const note = Notify.loading(`Switching ${name} to ${cfgVersion}…`);

		try {
			const res = await patch(`/instances/${name}/config`, {
				mcVersion: cfgVersion,
				forceVersion: true
			});

			versionConflict = [];

			if (res.job) {
				await trackVersionJob(res.job, note);
			} else {
				note.set({ level: 'success', message: `Saved: ${res.changed.join(', ')}`, closeable: true });

				await refresh();
			}
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not change the version of ${name}`,
				detail: (err as Error).message,
				progress: null,
				closeable: true
			});
		}

		saving = false;
	}

	async function deployPlugins(): Promise<void> {
		const note = Notify.loading(`Deploying plugins to ${name}…`);

		try {
			const res = await post('/plugins/deploy', { instances: [name] });
			const changed = res.actions.filter((action: any) => action.action !== 'unchanged').length;

			note.set({
				level: 'success',
				message: `Deployed plugins to ${name}; ${changed} change(s)`,
				detail: res.needRestart?.length ? 'Restart the instance to load them.' : '',
				closeable: true
			});

			await loadTab('plugins');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not deploy plugins to ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	/** Sync this instance's world from the data pack pool. */
	async function deployDatapacks(): Promise<void> {
		const note = Notify.loading(`Deploying data packs to ${name}…`);

		try {
			const res = await post(`/instances/${name}/datapacks`, { action: 'deploy' });
			const changed = res.actions.filter((action: any) => action.action !== 'unchanged').length;

			note.set({
				level: 'success',
				message: `Deployed data packs to ${name}; ${changed} change(s)`,
				detail: changed ? 'The server loads them on its next restart (or /minecraft:reload).' : '',
				closeable: true
			});

			await loadTab('datapacks');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not deploy data packs to ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	/** Pull a hand-dropped world zip into the shared pool. */
	async function adoptDatapack(file: string): Promise<void> {
		const note = Notify.loading(`Adopting ${file} into the pool…`);

		try {
			const res = await post(`/instances/${name}/datapacks`, { action: 'adopt', file });

			note.set({
				level: 'success',
				message: `Adopted ${res.name}; it now deploys from the pool`,
				closeable: true
			});

			await loadTab('datapacks');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not adopt ${file}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	/** Remove a managed data pack from this instance's world only. */
	async function removeDatapackHere(pack: string): Promise<void> {
		const note = Notify.loading(`Removing ${pack} from ${name}…`);

		try {
			await del(`/datapacks/${encodeURIComponent(pack)}?from=${encodeURIComponent(name ?? '')}`);

			note.set({
				level: 'success',
				message: `${pack} no longer targets ${name}`,
				detail: t('web.instanceDetail.theServerUnloadsItOn'),
				closeable: true
			});

			await loadTab('datapacks');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not remove ${pack}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	/** Flip a resource pack's enabled flag and reload the proxy's catalog. */
	async function setRespackEnabled(key: string, enabled: boolean): Promise<void> {
		const note = Notify.loading(`${enabled ? 'Enabling' : 'Disabling'} ${key}…`);

		try {
			await patch(`/respacks/${encodeURIComponent(key)}`, { enabled });

			const reload = await post('/respacks/reload');

			note.set({
				level: 'success',
				message: `${key} ${enabled ? 'enabled' : 'disabled'}`,
				detail: reload.sent
					? 'Reload sent to the proxy; the change is live.'
					: 'The proxy is not running; the change applies on its next boot.',
				closeable: true
			});

			await loadTab('respacks');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not update ${key}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	/**
	 * Serve, or stop serving, one pack on *this* instance. The pack's server
	 * rules are the only place that can say so, so the route rewrites them -
	 * which is why disabling here does not touch the pack's global enabled flag
	 * and does not affect any other backend.
	 */
	async function setRespackHere(key: string, on: boolean): Promise<void> {
		respackBusy = key;

		const note = Notify.loading(`${on ? 'Serving' : 'Withholding'} ${key} on ${name}…`);

		try {
			const res = await post(`/respacks/${encodeURIComponent(key)}/instances`, {
				instance: name,
				on
			});

			note.set({
				level: 'success',
				message: `${key} ${on ? 'now served on' : 'withheld from'} ${name}`,
				detail:
					`Rules: ${res.pack.servers.join(', ')}. ` +
					(res.groupConflict
						? `An addon group grants ${name}; the exclusion overrides it, but leaving the group is cleaner. `
						: '') +
					(res.reloaded
						? 'Reload sent to the proxy; players get the change on their next join or switch.'
						: 'The proxy is not running; the change applies on its next boot.'),
				closeable: true
			});

			await loadTab('respacks');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not update ${key} for ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}

		respackBusy = '';
	}

	const isUp = $derived(inst && (inst.state === 'running' || inst.state === 'starting'));
	const checksPassed = $derived(inst ? inst.checks.filter((check: any) => check.ok).length : 0);

	/** The long uptime record; absent until the first metrics fetch lands. */
	const uptime = $derived(metrics.uptime ?? null);

	const cpuPoints = $derived(metrics.history.map((sample: any) => ({ t: sample.t, v: sample.cpu })));
	const memPoints = $derived(
		metrics.history.map((sample: any) => ({ t: sample.t, v: sample.rssMb }))
	);
	const playerPoints = $derived(
		metrics.history.map((sample: any) => ({ t: sample.t, v: sample.players }))
	);

	const playerMax = $derived(
		Math.max(5, ...playerPoints.map((point: any) => point.v ?? 0)) * PLAYER_HEADROOM
	);

	// heartbeat-sourced series: only present for samples where LunaCore was reporting
	const tpsPoints = $derived(metrics.history.map((sample: any) => ({ t: sample.t, v: sample.tps })));
	const heapPoints = $derived(
		metrics.history.map((sample: any) => ({ t: sample.t, v: sample.heapUsedMb }))
	);

	const hasHeartbeatSeries = $derived(
		tpsPoints.some((point: any) => point.v != null) ||
			heapPoints.some((point: any) => point.v != null)
	);

	const msptPoints = $derived(metrics.history.map((sample: any) => ({ t: sample.t, v: sample.msptMean })));
	const chunkPoints = $derived(metrics.history.map((sample: any) => ({ t: sample.t, v: sample.chunks })));
	const entityPoints = $derived(
		metrics.history.map((sample: any) => ({
			t: sample.t,
			// summed only when at least one half was measured, so a backend that
			// reports neither leaves a gap rather than a line along zero
			v:
				sample.tickingEntities == null && sample.nonTickingEntities == null
					? undefined
					: (sample.tickingEntities ?? 0) + (sample.nonTickingEntities ?? 0)
		}))
	);

	/**
	 * Whether this backend reports what its ticks cost.
	 *
	 * Only a plugin new enough to measure them does, so the whole group is hidden
	 * rather than drawn empty: an operator on an older backend should see the
	 * charts that exist, not five blank ones telling them something is broken.
	 */
	const hasTickSeries = $derived(msptPoints.some((point: any) => point.v != null));
	const hasWorldSeries = $derived(
		chunkPoints.some((point: any) => point.v != null) || entityPoints.some((point: any) => point.v != null)
	);

	const worlds = $derived((inst?.worlds ?? []) as Array<Record<string, number | string | null>>);

	// $derived, not a plain array: the headers are t() calls, and a constant would
	// keep whichever locale it was first built in
	/** Entities in one world's row, for the share each column shows. */
	function worldEntities(world: Record<string, number | string | null>): number {
		return Number(world.tickingEntities ?? 0) + Number(world.nonTickingEntities ?? 0);
	}

	const worldCols: Column[] = $derived([
		{ id: 'name', label: t('web.instanceDetail.world') },
		{ id: 'loadedChunks', label: t('web.instanceDetail.loadedChunks'), align: 'right' },
		{ id: 'tickingEntities', label: t('web.instanceDetail.ticking'), width: 220 },
		{ id: 'nonTickingEntities', label: t('web.instanceDetail.nonTicking'), width: 220 }
	]);

	/** 0-1 indices read better as percentages; absent stays absent. */
	const apdexPct = $derived(inst?.apdex == null ? null : inst.apdex * 100);
	const miseryPct = $derived(inst?.misery == null ? null : inst.misery * 100);

	const hostMemMb = $derived(inst?.hostMemMb ?? 0);

	/**
	 * Heap ceiling for the machine this instance runs on, MB: its physical memory
	 * plus its swap. Undefined when that machine has not reported a sample, which
	 * leaves the memory field a text box rather than capping against a guess.
	 */
	const memoryCapMb = $derived(hostMemMb ? hostMemMb + (inst?.hostSwapMb ?? 0) : undefined);

	// a primary-owned instance has no `daemon`, and the primary is the machine the
	// console itself runs beside, so "this machine" is the honest name for it
	const memoryCapNote = $derived(
		memoryCapMb
			? t('web.instanceFields.memoryCapOn', {
					machine: inst?.daemon ?? t('web.instanceFields.thisMachine'),
					cap: formatMemoryGb(memoryCapMb)
				})
			: undefined
	);

	/**
	 * How a `/proc` state letter is named and shaded in the thread grid.
	 *
	 * Keys rather than translated text, so one entry serves every locale; the
	 * renderer calls t() on the label. Sleeping and idle stay track-coloured
	 * because they are the normal case for most of a JVM's threads and colouring
	 * them would drown out the few that are actually spending CPU.
	 */
	const THREAD_STATES: Record<string, { label: string; color: string }> = {
		R: { label: 'web.threads.stateRunning', color: 'var(--link)' },
		S: { label: 'web.threads.stateSleeping', color: 'var(--bg-track)' },
		D: { label: 'web.threads.stateBlocked', color: 'var(--warning)' },
		Z: { label: 'web.threads.stateZombie', color: 'var(--error)' },
		T: { label: 'web.threads.stateStopped', color: 'var(--warning)' },
		t: { label: 'web.threads.stateTraced', color: 'var(--warning)' },
		I: { label: 'web.threads.stateIdle', color: 'var(--bg-track)' }
	};

	/**
	 * Cool to hot across one core. The scale is fixed at 0-100 rather than derived
	 * from the data: a thread cannot pass a single core, and a relative scale would
	 * repaint an idle server's busiest thread bright red.
	 */
	const THREAD_RAMP = ['var(--bg-track)', 'var(--link)', 'var(--warning)', 'var(--error)'];

	/** A thread at or above this is worth naming in the busiest list. */
	const THREAD_BUSY_PCT = 1;

	/** Nanoseconds at the scale a scheduling figure actually lands on. */
	function fmtNs(value: number | null): string {
		if (value === null) {
			return '–';
		}

		if (value < 1_000_000) {
			return `${(value / 1000).toFixed(0)} µs`;
		}

		return `${(value / 1_000_000).toFixed(1)} ms`;
	}

	const threadNodes: OverviewNode[] = $derived.by(() => {
		if (!threads) {
			return [];
		}

		return threads.threads.map((thread) => {
			const state = THREAD_STATES[thread.state] ?? {
				label: 'web.threads.stateUnknown',
				color: 'var(--bg-track)'
			};

			const details: OverviewDetail[] = [
				{ key: t('web.threads.threadId'), value: String(thread.tid), mono: true },
				{
					key: t('web.threads.userSystem'),
					value: `${thread.userCpu.toFixed(1)}% / ${thread.systemCpu.toFixed(1)}%`
				},
				{
					key: t('web.threads.lastCore'),
					value: thread.lastCore === null ? '–' : `#${thread.lastCore}`
				},
				{ key: t('web.threads.onCpu'), value: fmtNs(thread.runNs) },
				{ key: t('web.threads.waited'), value: fmtNs(thread.waitNs) },
				{
					key: t('web.threads.ctxSwitches'),
					value:
						thread.voluntaryCtx === null
							? '–'
							: t('web.threads.ctxPair', {
									voluntary: String(thread.voluntaryCtx),
									involuntary: String(thread.involuntaryCtx ?? 0)
								})
				},
				{ key: t('web.threads.priority'), value: `${thread.priority} / ${thread.nice}` },
				{ key: t('web.threads.aliveFor'), value: fmtDuration(thread.lifetimeMs) }
			];

			// only when there were any: a zero row on every one of a few hundred cards
			// is noise, and a fault count that is not zero is the interesting case
			if (thread.minorFaults > 0 || thread.majorFaults > 0) {
				details.push({
					key: t('web.threads.pageFaults'),
					value: `${thread.minorFaults} / ${thread.majorFaults}`
				});
			}

			return {
				label: thread.name,
				value: thread.cpu,
				status: t(state.label),
				statusColor: state.color,
				details
			};
		});
	});

	const busiestThreads: ThreadSample[] = $derived.by(() => {
		if (!threads) {
			return [];
		}

		return threads.threads.filter((thread) => thread.cpu >= THREAD_BUSY_PCT);
	});

	/** Full CPU of the machine this instance runs on; see cpuCeiling(). */
	const cpuMax = $derived(cpuCeiling(inst?.cpuCores));

	const summaryCells: InfoCell[] = $derived.by(() => {
		if (!inst) {
			return [];
		}

		return [
			{ id: 'state', label: t('web.instanceDetail.instanceState') },
			{ id: 'software', label: t('web.instanceDetail.software') },
			{ label: t('web.instanceDetail.pingVersion'), value: inst.pingVersion },
			{ label: t('web.instanceDetail.gameAddress'), value: inst.address, copyable: true, style: 'mono' },
			{ label: t('web.instanceDetail.memoryHeap'), value: inst.memory },
			...(usesJava ? [{ label: t('web.instanceDetail.javaProfile'), value: inst.profile }] : []),
			{
				label: t('web.instanceDetail.machine'),
				value: inst.daemon ?? (hostName || 'primary'),
				href:
					(inst.daemon ?? hostName)
						? `/machines/${inst.daemon ?? hostName}`
						: undefined
			},
			{ label: t('web.instanceDetail.javaPid'), value: inst.javaPid },
			{ id: 'cpu', label: t('web.instanceDetail.cpuUtilization') },
			{ id: 'rss', label: t('web.instanceDetail.residentMemory') },
			// heartbeat-only figures: the server's own tick rate and heap, which the
			// host-side /proc sampling above cannot see
			{ id: 'tps', label: t('web.instanceDetail.tickRate') },
			{ id: 'heap', label: t('web.instanceDetail.jvmHeap') },
			{ label: t('web.instanceDetail.uptime'), value: fmtDuration(inst.uptimeMs) },
			{
				label: t('web.instanceDetail.players'),
				value: inst.players ? `${inst.players.online}/${inst.players.max}` : null
			},
			{ label: t('web.instanceDetail.directory'), value: inst.dir, copyable: true, style: 'mono' }
		];
	});

	const portCells: InfoCell[] = $derived.by(() => {
		if (!inst) {
			return [];
		}

		// the plugin allocations are bound on the same machine as the game port, so
		// they are shown at that machine's host too; a follower's voice-chat port
		// answers on the LAN, never on the console's own loopback
		const host = (inst.address ?? '').split(':')[0] ?? '';

		return [
			{
				label: t('web.instanceDetail.gamePortTcp'),
				value: inst.address,
				copyable: true,
				style: 'mono'
			},
			...Object.entries(inst.ports).map(([key, port]) => ({
				label: key,
				value: host ? `${host}:${port}` : String(port),
				copyable: true,
				style: 'mono' as const
			}))
		];
	});

	// the registration dialog behind the network tab's edit action
	let proxyEditOpen = $state(false);

	const proxyCells: InfoCell[] = $derived.by(() => {
		if (!inst) {
			return [];
		}

		// the proxy has no registration of its own; every other row shows its
		// three registration facts, dashed when unset, so an edit has visible
		// feedback
		if (name === 'proxy') {
			return [
				{
					label: t('web.instanceDetail.registeredInVelocity'),
					value: t('web.instanceDetail.isTheProxy')
				}
			];
		}

		return [
			{
				label: t('web.instanceDetail.registeredInVelocity'),
				value: inst.proxy?.register
					? t('web.instanceDetail.registeredYes')
					: t('web.instanceDetail.registeredNo')
			},
			{
				label: t('web.instanceDetail.tryListPriority'),
				value: inst.proxy?.priority !== undefined ? String(inst.proxy.priority) : null
			},
			{
				label: t('web.instanceDetail.forcedHosts'),
				value: inst.proxy?.forcedHosts?.length ? inst.proxy.forcedHosts.join(', ') : null
			}
		];
	});

	const pluginCols: Column[] = $derived([
		{ id: 'name', label: t('web.instanceDetail.plugin2'), sortable: true },
		{ id: 'state', label: t('web.instanceDetail.state'), sortable: true, width: 130 },
		{ id: 'version', label: t('web.instanceDetail.version') },
		{ id: 'alerts', label: t('web.instanceDetail.alerts'), sortable: true, width: 230 },
		{ id: 'origin', label: t('web.instanceDetail.from'), sortable: true },
		{ id: 'source', label: t('web.instanceDetail.source'), sortable: true, minWidth: 140 },
		{ id: 'auto', label: t('web.instanceDetail.autoUpdate'), hidden: true },
		{ id: 'assign', label: t('web.instanceDetail.assignment'), hidden: true }
	]);

	const unmanagedCols: Column[] = $derived([
		{ id: 'name', label: t('web.instanceDetail.addon'), sortable: true },
		{ id: 'state', label: t('web.instanceDetail.state'), sortable: true, width: 130 },
		{ id: 'dir', label: t('web.instanceDetail.directory'), sortable: true, width: 130 },
		{ id: 'version', label: t('web.instanceDetail.version'), width: 140 },
		// hidden by default: an author list is the widest and least scannable thing a
		// descriptor carries, and showing it pushed the alerts column off the panel
		{ id: 'authors', label: t('web.addonDetail.authors'), minWidth: 140, hidden: true },
		{ id: 'size', label: t('web.instanceDetail.size'), sortable: true, width: 110 },
		// 230 like the managed table's, not 200: it is the last column, and the
		// eight characters that do not fit are the ones naming the count
		{ id: 'alerts', label: t('web.instanceDetail.alerts'), sortable: true, width: 230 }
	]);

	/** The unmanaged addon whose boot-session log is open, if any. */
	let unmanagedLogRow = $state<UnmanagedAddonRow | null>(null);
	let unmanagedLogOpen = $state(false);

	/**
	 * An unmanaged addon's verbs.
	 *
	 * Only one so far, and it is the one the table could not answer before: these
	 * rows carry a warning and error count with no way to see what produced it. A
	 * context menu rather than a column, like every other table here.
	 */
	function unmanagedActions(row: UnmanagedAddonRow): ContextMenuItem[] {
		return [
			{
				label: t('web.instanceDetail.viewLogActivity'),
				icon: 'fileLines',
				action: () => {
					unmanagedLogRow = row;
					unmanagedLogOpen = true;
				}
			}
		];
	}

	/** Sort keys for the unmanaged table's columns that render as more than text. */
	function unmanagedSortValue(row: UnmanagedAddonRow, col: string): string | number | null {
		if (col === 'name') {
			return row.displayName;
		}

		if (col === 'size') {
			return row.sizeBytes;
		}

		// errors before warnings before silence, which is the reason to sort here
		if (col === 'alerts') {
			return row.errors * 1000 + row.warnings;
		}

		return (row as unknown as Record<string, string>)[col] ?? '';
	}

	/**
	 * Badge look of each addon phase. "Disabled" is not a phase; it is the
	 * per-instance override, and it says why the log has nothing to report rather
	 * than what the log saw, so it is shown in place of the phase.
	 */
	// $derived, not a plain const: these labels are t() calls, and a record built
	// once keeps the locale it was first rendered in
	const PLUGIN_STATE_BADGE: Record<string, { state: string; label: string }> = $derived({
		running: { state: 'running', label: t('web.instanceDetail.running') },
		loading: { state: 'loading', label: t('web.instanceDetail.loading') },
		errored: { state: 'failed', label: t('web.instanceDetail.errored') },
		// deployed, the server listed what it loaded, and this was not in the list;
		// a warning rather than a failure, because nothing reported an error
		missing: { state: 'warning', label: t('web.instanceDetail.notLoaded') },
		// the server is down, so nothing is loaded. Knowledge, not ignorance, and
		// the reason a stopped instance no longer reports every addon as unknown
		stopped: { state: 'stopped', label: t('web.instanceDetail.serverStopped') },
		unknown: { state: 'unknown', label: t('web.instanceDetail.unknown') },
		disabled: { state: 'stopped', label: t('web.instanceDetail.disabled') }
	});

	/**
	 * The addon phases as a distribution, in the order they read as a lifecycle:
	 * working, coming up, broken, then the ones luna is not speaking for.
	 * "Unmanaged" is counted here rather than left out, because a modpack's own
	 * mods are most of what is in the directory and a bar that ignored them would
	 * claim the instance runs six mods when it runs two hundred.
	 */
	const addonSegments: DistributionSegment[] = $derived.by(() => {
		const by = (state: string): number =>
			instPlugins.filter((plugin) => !plugin.disabled && plugin.state === state).length;

		return [
			{ key: 'running', label: t('web.instanceDetail.running2'), count: by('running'), color: 'var(--success)' },
			{ key: 'loading', label: t('web.instanceDetail.loading2'), count: by('loading'), color: 'var(--warning)' },
			{ key: 'errored', label: t('web.instanceDetail.errored2'), count: by('errored'), color: 'var(--error)' },
			// its own band rather than folded into unknown: "deployed and never
			// loaded" is the one an operator has to act on, and it used to be
			// indistinguishable from "luna cannot tell"
			{ key: 'missing', label: t('web.instanceDetail.notLoaded2'), count: by('missing'), color: 'var(--primary)' },
			// its own band for the same reason `missing` has one: on a stopped
			// instance this is every row, and calling that "unknown" told the
			// operator luna could not tell when the answer was simply "nothing is
			// loaded, the server is down"
			{
				key: 'stopped',
				label: t('web.instanceDetail.stopped2'),
				count: by('stopped'),
				color: 'var(--text-secondary)'
			},
			{ key: 'unknown', label: t('web.instanceDetail.unknown2'), count: by('unknown'), color: 'var(--bg-track)' },
			{
				key: 'disabled',
				label: t('web.instanceDetail.disabled2'),
				count: instPlugins.filter((plugin) => plugin.disabled).length,
				color: 'var(--text-disabled)'
			},
			{
				key: 'unmanaged',
				label: t('web.instanceDetail.unmanaged'),
				count: instUnmanaged.length,
				color: 'var(--link)'
			}
		];
	});

	const addonTotal = $derived(addonSegments.reduce((sum, segment) => sum + segment.count, 0));

	/**
	 * Which bucket one data pack falls in; the same order the tab's own badges
	 * decide in, so the bar and the table never disagree.
	 *
	 * An if-chain rather than one predicate per bucket: the conditions genuinely
	 * overlap (a pack can be both untargeted and stale), and counting each bucket
	 * independently would tally that pack twice and inflate the total.
	 */
	function datapackBucket(row: any): string {
		if (!row.managed) {
			return 'unmanaged';
		}

		if (!row.present) {
			return 'missing';
		}

		if (row.stale) {
			return 'stale';
		}

		if (!row.targeted) {
			return 'untargeted';
		}

		return 'insync';
	}

	/** Data pack distribution, using the same vocabulary as the tab's own badges. */
	const datapackSegments: DistributionSegment[] = $derived.by(() => {
		const count = (bucket: string): number =>
			instDatapacks.filter((row) => datapackBucket(row) === bucket).length;

		return [
			{ key: 'insync', label: t('web.instanceDetail.inSync2'), count: count('insync'), color: 'var(--success)' },
			{ key: 'stale', label: t('web.instanceDetail.stale2'), count: count('stale'), color: 'var(--warning)' },
			{
				key: 'missing',
				label: t('web.instanceDetail.notDeployed2'),
				count: count('missing'),
				color: 'var(--error)'
			},
			{
				key: 'untargeted',
				label: t('web.instanceDetail.untargeted2'),
				count: count('untargeted'),
				color: 'var(--text-disabled)'
			},
			{ key: 'unmanaged', label: t('web.instanceDetail.unmanaged'), count: count('unmanaged'), color: 'var(--link)' }
		];
	});

	const datapackTotal = $derived(
		datapackSegments.reduce((sum, segment) => sum + segment.count, 0)
	);

	/** A plugin row's verbs on this instance. */
	function pluginActions(plugin: any): ContextMenuItem[] {
		return [
			{
				label: t('web.instanceDetail.openOnThisInstance'),
				icon: 'circleInfo',
				action: () => goto(`/instances/${name}/plugins/${plugin.plugin}`)
			},
			{
				label: t('web.instanceDetail.openThePlugin'),
				icon: 'plug',
				action: () => goto(`/plugins/${encodeURIComponent(plugin.plugin)}`)
			},
			{ separator: true },
			{
				label: t('web.instanceDetail.copyVersion'),
				icon: 'copy',
				disabled: !plugin.version,
				action: () => navigator.clipboard?.writeText(plugin.version ?? '')
			}
		];
	}

	// --- world & backups -------------------------------------------------------

	/** Whether a world verb can run at all right now, and why not when it cannot. */
	const worldBlockedReason = $derived.by(() => {
		if (worldLock) {
			return t('web.instanceWorld.lockedBy', { kind: worldLock.kind });
		}

		if (inst && inst.state !== 'stopped') {
			return t('web.instanceWorld.stopFirst', { name: worldName });
		}

		return '';
	});

	const backupCols: Column[] = $derived([
		{ id: 'label', label: t('web.instanceWorld.colBackup'), sortable: true, minWidth: 180 },
		{ id: 'createdAt', label: t('web.instanceWorld.colTaken'), sortable: true, width: 170 },
		{ id: 'sizeBytes', label: t('web.instanceWorld.colSize'), sortable: true, width: 110, align: 'right' },
		{ id: 'level', label: t('web.instanceWorld.colLevel'), width: 130 },
		{ id: 'mcVersion', label: t('web.instanceWorld.colVersion'), width: 110 },
		{ id: 'trigger', label: t('web.instanceWorld.colSource'), width: 130 },
		{ id: 'files', label: t('web.instanceWorld.colFiles'), width: 100, align: 'right', hidden: true },
		{ id: 'checksum', label: t('web.instanceWorld.colChecksum'), hidden: true },
		{ id: 'note', label: t('web.instanceWorld.colNote'), hidden: true }
	]);

	/** The selection a row's menu acts on: the whole selection when it is in it. */
	function backupTargets(row: BackupEntry): BackupEntry[] {
		if (backupSelection.has(row.id) && backupSelection.size > 1) {
			return backups.filter((entry) => backupSelection.has(entry.id));
		}

		return [row];
	}

	/**
	 * A backup's verbs, declared once for both the row menu and the panel's
	 * Actions dropdown.
	 *
	 * A verb that cannot apply is disabled with the reason rather than removed,
	 * and a single-target verb stays in the menu as the selection grows so the
	 * list does not shift under the cursor.
	 */
	function backupActions(rows: BackupEntry[]): ContextMenuItem[] {
		const one = rows.length === 1 ? rows[0] : undefined;
		const pickOne = t('web.instanceWorld.pickOne');

		return [
			{
				label: t('web.instanceWorld.restoreThis'),
				icon: 'rotateLeft',
				disabled: !one || !!worldBlockedReason,
				hint: !one ? pickOne : worldBlockedReason,
				action: () => restoreBackup(one!)
			},
			{
				label: t('web.instanceWorld.download'),
				icon: 'download',
				disabled: !one,
				hint: one ? t('web.instanceWorld.downloadHint', { size: fmtBytes(one.sizeBytes) }) : pickOne,
				action: () => downloadBackup(one!)
			},
			{
				label: one?.pinned ? t('web.instanceWorld.unpin') : t('web.instanceWorld.pin'),
				icon: 'thumbtack',
				disabled: !one,
				hint: !one ? pickOne : t('web.instanceWorld.pinHint'),
				action: () => void setPinned(one!, !one!.pinned)
			},
			{
				label: t('web.instanceWorld.rename'),
				icon: 'pen',
				disabled: !one,
				hint: pickOne,
				action: () => renameBackup(one!)
			},
			{
				label: t('web.instanceWorld.verify'),
				icon: 'shieldCheck',
				disabled: rows.length === 0,
				hint: t('web.instanceWorld.verifyHint'),
				action: () => void verifyBackups(rows)
			},
			{ separator: true },
			{
				label: t('web.instanceWorld.delete'),
				icon: 'trash',
				color: 'danger',
				disabled: rows.length === 0,
				action: () => removeBackups(rows)
			}
		];
	}

	/** Take a backup now. Allowed while the server runs; the daemon freezes saves. */
	async function backupNow(): Promise<void> {
		await backupWorldJob(worldName);
		await loadTab('world');
	}

	/** Ask before putting a backup back; the answer is what the dialog collects. */
	function restoreBackup(entry: BackupEntry): void {
		restoreTarget = entry;
		restoreBackupFirst = true;
		restoreLossAck = false;
		restoreOpen = true;
	}

	async function doRestore(): Promise<void> {
		const entry = restoreTarget;

		if (!entry) {
			return;
		}

		restoreOpen = false;

		await restoreWorldJob(worldName, entry.id, restoreBackupFirst && !!replaceTarget);
		await refresh({ tabData: true });
	}

	/**
	 * A download navigates rather than fetches.
	 *
	 * `fetch` plus an object URL is the reflex here and it would hold the whole
	 * archive in the tab's memory; these run to tens of gigabytes.
	 */
	function downloadBackup(entry: BackupEntry): void {
		window.location.assign(`/api/instances/${worldName}/world/backups/${entry.id}/download`);
	}

	async function setPinned(entry: BackupEntry, pinned: boolean): Promise<void> {
		await updateBackupEntry(worldName, entry.id, { pinned });
		await loadTab('world');
	}

	function renameBackup(entry: BackupEntry): void {
		renameTarget = entry;
		renameValue = entry.label;
		renameOpen = true;
	}

	async function doRename(): Promise<void> {
		const entry = renameTarget;

		if (!entry || !renameValue.trim()) {
			return;
		}

		renameOpen = false;

		await updateBackupEntry(worldName, entry.id, { label: renameValue.trim() });
		await loadTab('world');
	}

	async function verifyBackups(rows: BackupEntry[]): Promise<void> {
		for (const entry of rows) {
			await verifyBackupJob(worldName, entry.id);
		}

		await loadTab('world');
	}

	function removeBackups(rows: BackupEntry[]): void {
		deleteTargets = rows;
		deleteBackupsOpen = true;
	}

	/** Delete every backup the dialog listed, then report the outcome once. */
	async function doRemove(): Promise<void> {
		const rows = deleteTargets;

		deleteBackupsOpen = false;

		let done = 0;

		for (const entry of rows) {
			try {
				await deleteBackupEntry(worldName, entry.id);
				done++;
			} catch (err) {
				Notify.error((err as Error).message);
			}
		}

		if (done > 0) {
			Notify.success(t('web.instanceWorld.deleted', { count: String(done) }));
		}

		backupSelection = new Set();

		await loadTab('world');
	}

	/**
	 * What a replace would destroy, or null when there is nothing there yet.
	 *
	 * A first world on an empty instance destroys nothing, and a confirmation
	 * that claims otherwise is the kind operators learn to click through.
	 */
	const replaceTarget = $derived.by((): WorldReplaceTarget | null => {
		if (!worldReport || worldReport.dimensions.length === 0) {
			return null;
		}

		return {
			instance: worldName,
			dirs: worldReport.dimensions.map((entry) => entry.path),
			sizeBytes: worldReport.sizeBytes
		};
	});

	/** Open the replace wizard on its first step, with nothing carried over. */
	function openReplace(): void {
		worldStage = null;
		replaceStep = 0;
		replaceBackupFirst = true;
		replaceOpen = true;
	}

	/** The upload has been confirmed in the wizard; install it. */
	async function replaceFromStage(): Promise<void> {
		const staged = worldStage;

		if (!staged) {
			return;
		}

		replaceOpen = false;

		await replaceWorldJob(worldName, staged.token, {
			level: staged.level,
			source: staged.fileName,
			// nothing to copy when the instance has no world yet, and asking the
			// daemon for one would fail the replace over an empty directory
			backupFirst: replaceBackupFirst && !!replaceTarget
		});

		worldStage = null;

		await refresh({ tabData: true });
	}

	async function doReset(): Promise<void> {
		resetOpen = false;
		resetConfirm = '';

		await resetWorldJob(worldName, resetBackupFirst);
		await refresh({ tabData: true });
	}

	// `state` is the deploy question (did luna put it there, is it current) and
	// `loaded` the runtime one (could the server read it). They are separate
	// columns because they fail independently: a pack can be perfectly in sync and
	// still be a pack the server threw out.
	const datapackCols: Column[] = $derived([
		{ id: 'file', label: t('web.instanceDetail.dataPack2'), sortable: true },
		{ id: 'state', label: t('web.instanceDetail.state'), width: 150 },
		{ id: 'loaded', label: t('web.instanceDetail.loaded'), width: 150 },
		{ id: 'version', label: t('web.instanceDetail.version') },
		{ id: 'size', label: t('web.instanceDetail.size'), width: 100, align: 'right' },
		{ id: 'source', label: t('web.instanceDetail.source'), minWidth: 140 }
	]);

	/** A data pack row's verbs on this instance. */
	function datapackActions(row: any): ContextMenuItem[] {
		return [
			{
				label: t('web.instanceDetail.manageInThePool'),
				icon: 'box',
				disabled: !row.managed,
				hint: !row.managed ? 'not a pooled pack yet; adopt it first' : undefined,
				action: () => goto(`/datapacks?q=${encodeURIComponent(row.name ?? '')}`)
			},
			{
				label: t('web.instanceDetail.adoptIntoThePool'),
				icon: 'inboxIn',
				disabled: row.managed,
				hint: row.managed ? 'already pooled' : undefined,
				action: () => adoptDatapack(row.file)
			},
			{ separator: true },
			{
				label: t('web.instanceDetail.removeFromThisInstance'),
				icon: 'trash',
				color: 'danger',
				disabled: !row.managed || !row.targeted,
				hint: !row.managed
					? 'unmanaged file; delete it from the world by hand, or adopt it first'
					: !row.targeted
						? 'not targeted here; a deploy already removes it'
						: undefined,
				action: () => removeDatapackHere(row.name)
			}
		];
	}

	const respackCols: Column[] = $derived([
		{ id: 'name', label: t('web.instanceDetail.resourcePack'), sortable: true },
		{ id: 'applies', label: t('web.instanceDetail.onThisServer'), width: 150 },
		{ id: 'state', label: t('web.instanceDetail.state'), width: 130 },
		{ id: 'priority', label: t('web.instanceDetail.priority'), width: 90, align: 'right' },
		{ id: 'servers', label: t('web.instanceDetail.serverRules') },
		{ id: 'version', label: t('web.instanceDetail.version') }
	]);

	/** Whether this instance is in a pack's rule set right now. */
	function respackHere(row: any): boolean {
		return row.matched.includes(name ?? '');
	}

	/** A resource pack row's verbs, seen from this instance. */
	function respackActions(row: any): ContextMenuItem[] {
		const here = respackHere(row);
		const granted = row.granted.includes(name ?? '');

		return [
			{
				label: here ? `Stop serving on ${name}` : `Serve on ${name}`,
				icon: here ? 'toggleOff' : 'toggleOn',
				disabled: !!respackBusy || (granted && here),
				hint:
					granted && here
						? `granted by addon group ${row.groups.join(', ')}; edit the group instead`
						: undefined,
				action: () => setRespackHere(row.key, !here)
			},
			{ separator: true },
			{
				label: t('web.instanceDetail.packDetails'),
				icon: 'circleInfo',
				action: () => goto(`/packs/${encodeURIComponent(row.key)}`)
			},
			{
				label: t('web.instanceDetail.configurePack'),
				icon: 'pen',
				action: () => goto(`/packs/${encodeURIComponent(row.key)}/configure`)
			},
			{
				label: row.enabled ? 'Disable everywhere' : 'Enable everywhere',
				icon: row.enabled ? 'ban' : 'circleCheck',
				action: () => setRespackEnabled(row.key, !row.enabled)
			},
			{
				label: t('web.instanceDetail.manageInResourcePacks'),
				icon: 'image',
				action: () => goto(`/packs?q=${encodeURIComponent(row.key)}`)
			}
		];
	}

	// -- environment ---------------------------------------------------------------

	const envCols: Column[] = $derived([
		{ id: 'name', label: t('web.instanceDetail.variable2'), sortable: true, width: 240 },
		{ id: 'value', label: t('web.instanceDetail.valueOnThisInstance') },
		{ id: 'source', label: t('web.instanceDetail.source'), sortable: true, width: 120 },
		{ id: 'shadowed', label: t('web.instanceDetail.shadows') }
	]);

	const envFilters: TableFilterGroup<EnvVar>[] = $derived([
		{
			id: 'source',
			label: t('web.instanceDetail.filterSourceScope'),
			options: [
				{ value: 'any', label: t('web.instanceDetail.anySource') },
				{ value: 'instance', label: t('web.instanceDetail.thisInstanceOnly'), match: (row) => row.scope === 'instance' },
				{ value: 'machine', label: t('web.instanceDetail.fromItsMachine'), match: (row) => row.scope === 'machine' },
				{ value: 'global', label: t('web.instanceDetail.clusterWide'), match: (row) => row.scope === 'global' },
				{ value: 'builtin', label: t('web.instanceDetail.builtin'), match: (row) => row.scope === 'builtin' }
			]
		}
	]);

	/**
	 * Reveal one secret for this instance. The scope that won decides where the
	 * value lives, so that is the scope the reveal asks for; a builtin secret
	 * (the forwarding secret) is computed and has nothing to reveal.
	 */
	async function revealEnv(row: EnvVar): Promise<void> {
		try {
			const result = await post(`/env/${encodeURIComponent(row.name)}/reveal`, {
				machine: row.scope === 'machine' ? (inst?.daemon ?? '') : undefined,
				instance: row.scope === 'instance' ? name : undefined
			});

			envRevealed = { ...envRevealed, [row.name]: result.value };
		} catch (err) {
			Notify.error(`Could not reveal ${row.name}`, { detail: (err as Error).message });
		}
	}

	function hideEnv(varName: string): void {
		const next = { ...envRevealed };

		delete next[varName];
		envRevealed = next;
	}

	function envActions(row: EnvVar): ContextMenuItem[] {
		const builtin = row.scope === 'builtin';

		return [
			{
				label: t('web.instanceDetail.openVariableDetails'),
				icon: 'circleInfo',
				disabled: builtin,
				action: () => goto(`/environment/${encodeURIComponent(row.name)}`)
			},
			{
				label: row.scope === 'instance' ? 'Edit this value' : 'Override for this instance',
				icon: row.scope === 'instance' ? 'pen' : 'layerGroup',
				disabled: builtin,
				action: () =>
					goto(`/environment/new?name=${encodeURIComponent(row.name)}&instance=${name}`)
			},
			{
				label: envRevealed[row.name] !== undefined ? 'Hide value' : 'Reveal value',
				icon: envRevealed[row.name] !== undefined ? 'eyeSlash' : 'eye',
				// a builtin's value is computed, so there is no stored secret to reveal
				disabled: !row.secret || builtin,
				action: () =>
					envRevealed[row.name] !== undefined ? hideEnv(row.name) : revealEnv(row)
			},
			{
				label: t('web.instanceDetail.copyValue'),
				icon: 'copy',
				disabled: row.secret && envRevealed[row.name] === undefined,
				action: () => navigator.clipboard?.writeText(envRevealed[row.name] ?? row.value)
			}
		];
	}

	const eventCols: Column[] = $derived([
		{ id: 'time', label: t('web.instanceDetail.time'), width: 190 },
		{ id: 'kind', label: t('web.instanceDetail.type'), width: 120 },
		{ id: 'message', label: t('web.instanceDetail.event2') }
	]);
</script>

<svelte:head><title>{name} | Luna Console</title></svelte:head>

{#if inst}
	<PageHeader title={name ?? ''} info>
		{#snippet extra()}<StatusBadge state={inst.state} />{/snippet}
		{#snippet actions()}
			<RefreshControl
				onrefresh={() => refresh({ tabData: true })}
				{lastUpdated}
				{loading}
				storageKey="instance"
			/>
			<Btn onclick={() => goto(`/instances/${name}/console`)}>{t('web.instanceDetail.connect')}</Btn>
			<Dropdown
				label={t('web.instanceDetail.instanceState')}
				items={[
					{
						label: t('web.instanceDetail.startInstance'), icon: 'play',
						disabled: inst.state !== 'stopped',
						action: () => stateAction('start')
					},
					{
						label: t('web.instanceDetail.stopInstance'), icon: 'stop', disabled: !isUp,
						action: () => stateAction('stop')
					},
					{
						label: t('web.instanceDetail.restartInstance'), icon: 'rotate', disabled: !isUp,
						action: () => stateAction('restart')
					},
					{ divider: true, label: '' },
					{
						label: t('web.instanceDetail.scheduleAnAction'), icon: 'clock',
						action: () => {
							scheduleOpen = true;
						}
					}
				]}
			/>
			<Dropdown
				label={t('web.instanceDetail.actions')}
				items={[
					{
						label: t('web.instanceDetail.serialConsole'), icon: 'code',
						action: () => goto(`/instances/${name}/console`)
					},
					{
						label: t('web.instanceDetail.configFiles'), icon: 'fileCode',
						action: () => goto(`/instances/${name}/files`)
					},
					{ label: t('web.instanceDetail.deployPluginsHere'), icon: 'upload', action: () => deployPlugins() },
					{ divider: true, label: '' },
					{
						label: t('web.instanceDetail.deleteInstance'), icon: 'trash', danger: true,
						disabled: inst.state !== 'stopped' || name === 'proxy',
						action: () => {
							deleteOpen = true;
						}
					}
				]}
			/>
		{/snippet}
	</PageHeader>

	<OverviewBar title={t('web.instanceDetail.instanceOverview')}>
		<OverviewCell label={t('web.instanceDetail.status')}>
			<StatusBadge state={inst.state} />
		</OverviewCell>
		<OverviewCell
			label="Status checks ({inst.checks.length})"
			progress={inst.state === 'stopped' ? 0 : checksPassed / inst.checks.length}
			progressColor={checksPassed === inst.checks.length ? 'var(--success)' : 'var(--warning)'}
		>
			{#if inst.state === 'stopped'}
				<span class="dim">{t('web.instanceDetail.instanceStopped')}</span>
			{:else}
				<span style="color:var(--success)">{checksPassed} passed</span>
				<span class="dim">|</span>
				<span class="dim">{inst.checks.length - checksPassed} pending</span>
			{/if}
		</OverviewCell>
		<OverviewCell
			label={addonsLoaded ? `${addonLabel} (${addonTotal})` : addonLabel}
			segments={addonsLoaded ? addonSegments : undefined}
			segmentsEmpty={t('web.instanceDetail.noneInstalled')}
		>
			{#if !addonsLoaded}
				<span class="loading-line">
					<Spinner size="0.75rem" />
					<span class="dim">{t('web.instanceDetail.readingBootLog')}</span>
				</span>
			{/if}
		</OverviewCell>
		<!-- not shown while loading: an instance with no world never gets one, and a
		     cell that appears only to vanish a second later is worse than a late one -->
		{#if datapackTotal > 0}
			<OverviewCell label="Data packs ({datapackTotal})" segments={datapackSegments} />
		{/if}
		<OverviewCell label={t('web.instanceDetail.software')}>
			<SoftwareLabel
				software={inst.software}
				version={inst.mcVersion}
				channel={channelOf(inst.mcVersion)}
			/>
		</OverviewCell>
		<OverviewCell label={t('web.instanceDetail.players')}>
			{inst.players ? `${inst.players.online} / ${inst.players.max}` : '–'}
		</OverviewCell>
		<OverviewCell label={t('web.instanceDetail.uptime')}>
			{fmtDuration(inst.uptimeMs)}
		</OverviewCell>
	</OverviewBar>

	<Tabs tabs={instanceTabs} active={tab} />

	<div class="tabbody">
		{#if tab === 'details'}
			<Panel title={t('web.instanceDetail.instanceSummary')}>
				<InfoGrid cells={summaryCells}>
					{#snippet custom(cell)}
						{#if cell.id === 'state'}
							<StatusBadge state={inst.state} />
						{:else if cell.id === 'software'}
							<SoftwareLabel
								software={inst.software}
								version={inst.mcVersion}
								channel={channelOf(inst.mcVersion)}
							/>
						{:else if cell.id === 'cpu'}
							{#if inst.cpu == null}
								<span class="dim">–</span>
							{:else}
								<ProgressBar
									compact
									value={inst.cpu}
									max={cpuMax}
									color="auto"
									right={fmtCpuPct(inst.cpu)}
									width="10rem"
								/>
							{/if}
						{:else if cell.id === 'rss'}
							{#if inst.rssMb == null}
								<span class="dim">–</span>
							{:else}
								<ProgressBar
									compact
									value={inst.rssMb}
									max={hostMemMb || inst.rssMb}
									color="auto"
									right="{(inst.rssMb / 1024).toFixed(1)} GB"
									width="10rem"
								/>
							{/if}
						{:else if cell.id === 'tps'}
							{#if inst.tps == null}
								<span class="dim" title={t('web.instanceDetail.lunacoreIsNotReportingFor')}>–</span>
							{:else}
								<!-- an explicit tone: color="auto" reads a full bar as danger, which is
								     backwards for TPS, where full is healthy -->
								<ProgressBar
									compact
									value={inst.tps}
									max={20}
									color={inst.tps >= 19 ? 'success' : inst.tps >= 15 ? 'warning' : 'danger'}
									right="{inst.tps.toFixed(2)} TPS"
									width="10rem"
								/>
							{/if}
						{:else if cell.id === 'heap'}
							{#if inst.heapUsedMb == null || inst.heapMaxMb == null}
								<span class="dim">–</span>
							{:else}
								<ProgressBar
									compact
									value={inst.heapUsedMb}
									max={inst.heapMaxMb}
									color="auto"
									right="{inst.heapUsedMb} / {inst.heapMaxMb} MB"
									width="10rem"
								/>
							{/if}
						{/if}
					{/snippet}
				</InfoGrid>
			</Panel>
			<div class="gap"></div>
			<Panel
				title={t('web.instanceDetail.launchCommand')}
				description={t('web.instanceDetail.generatedFromClusterJsonProfile')}
			>
				<code class="cmd mono">{inst.javaCommand}</code>
			</Panel>
		{:else if tab === 'checks'}
			<Panel title={t('web.instanceDetail.statusChecks')}>
				{#each inst.checks as check}
					<div class="checkrow">
						<StatusBadge
							state={check.ok === undefined ? 'unknown' : check.ok ? 'passed' : 'failed'}
						/>
						<b>{check.name}</b>
						<span class="dim">{check.detail}</span>
					</div>
				{/each}
			</Panel>
			<div class="gap"></div>
			<Panel
				title={t('web.instanceDetail.events')}
				count={metrics.events.length}
				description={t('web.instanceDetail.stateTransitionsAndActionsRecorded')}
				flush
			>
				<ResourceTable
					tableId="instance-events"
					columns={eventCols}
					rows={metrics.events}
					getId={(event) => String(event.t) + event.message}
					searchValue={(event) => `${event.kind} ${event.message}`}
					searchPlaceholder={t('web.instanceDetail.findAnEvent')}
					searchWidth="20rem"
					noun={t('web.instanceDetail.event')}
					pageSize={20}
					emptyTitle={t('web.instanceDetail.noRecordedEventsThisSession')}
					maxHeight="40vh"
				>
					{#snippet cell(event, col)}
						{#if col === 'time'}
							<span class="mono dim">{fmtDateTime(event.t)}</span>
						{:else if col === 'kind'}
							<StatusBadge
								state={event.kind === 'error'
									? 'failed'
									: event.kind === 'state'
										? 'warning'
										: 'ok'}
								label={event.kind}
							/>
						{:else}
							{event.message}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
		{:else if tab === 'monitoring'}
			<!-- the charts below are one hour and die with the daemon; this is the
			     long record, and the only thing that can answer "was it up on
			     Tuesday" -->
			<Panel
				title={t('web.instanceDetail.uptimeHistory')}
				description={t('web.instanceDetail.uptimeHistoryDesc')}
			>
				{#if uptime}
					<UptimeTimeline days={uptime.days} pct={uptime.pct} height="2rem" />
				{:else}
					<p class="dim">{t('web.instanceDetail.uptimeLoading')}</p>
				{/if}
			</Panel>
			<div class="gap"></div>
			<div class="charts">
				<Sparkline points={cpuPoints} label={t('web.instanceDetail.cpuUtilization')} unit="%" color="#42b4ff" />
				<Sparkline points={memPoints} label={t('web.instanceDetail.memoryRss')} unit=" MB" color="#bf7edb" />
				<Sparkline
					points={playerPoints}
					label={t('web.instanceDetail.playersOnline')}
					color="#2bb534"
					maxY={playerMax}
				/>
				{#if hasHeartbeatSeries}
					<Sparkline points={tpsPoints} label={t('web.instanceDetail.tickRate')} unit=" TPS" color="#e0ca57" maxY={20} />
					<Sparkline points={heapPoints} label={t('web.instanceDetail.jvmHeap')} unit=" MB" color="#ff9d5c" />
				{/if}
				{#if hasTickSeries}
					<Sparkline points={msptPoints} label={t('web.instanceDetail.tickDuration')} unit=" ms" color="#ff7a7a" />
				{/if}
				{#if hasWorldSeries}
					<Sparkline points={chunkPoints} label={t('web.instanceDetail.loadedChunks')} color="#7ec8e3" />
					<Sparkline points={entityPoints} label={t('web.instanceDetail.entities')} color="#c9a227" />
				{/if}
			</div>

			<!-- the whole-process CPU above says how much; this says what is spending it,
			     which is the difference between a busy server and a broken one -->
			{#if !inst.external}
				<div class="gap"></div>
				<Panel title={t('web.threads.title')} description={t('web.threads.description')}>
					{#if threads}
						<div class="threadbar">
							<span class="stat">
								<b>{threads.threadCount}</b>
								{t('web.threads.threadsWord')}
							</span>
							<span class="sep">·</span>
							<span class="stat">
								<b>{fmtCpuPct(threads.totalCpu)}</b>
								{t('web.threads.ofCeiling', { ceiling: fmtCpuPct(threads.cores * 100) })}
							</span>
							<span class="sep">·</span>
							<span class="stat">
								<b>{busiestThreads.length}</b>
								{t('web.threads.abovePct', { pct: String(THREAD_BUSY_PCT) })}
							</span>
							<span class="sep">·</span>
							<span class="stat dim">
								{t('web.threads.sampledOver', { ms: String(threads.windowMs) })}
							</span>
						</div>
						<NodeOverview
							nodes={threadNodes}
							min={0}
							max={100}
							ramp={THREAD_RAMP}
							legendFormat={(value) => `${value}%`}
							empty={t('web.threads.none')}
						/>
						{#if busiestThreads.length > 0}
							<div class="busiest">
								<div class="busiesthead">{t('web.threads.busiest')}</div>
								{#each busiestThreads as thread (thread.tid)}
									<div class="busiestrow">
										<span class="tname">{thread.name}</span>
										<span class="tid mono dim">#{thread.tid}</span>
										<ProgressBar
											compact
											value={thread.cpu}
											max={100}
											color="auto"
											right={fmtCpuPct(thread.cpu)}
										/>
									</div>
								{/each}
							</div>
						{/if}
						<p class="dim hint">{t('web.threads.nameHint')}</p>
					{:else if threadsPending}
						<p class="dim">{t('web.threads.sampling')}</p>
					{:else}
						<p class="dim">{t('web.threads.unavailable')}</p>
						{#if threadsReason}
							<!-- the owner's own words: on a fleet mid-upgrade this is what says
							     which machine still needs the new build -->
							<p class="dim hint mono">{threadsReason}</p>
						{/if}
					{/if}
				</Panel>
			{/if}

			{#if hasTickSeries || worlds.length}
				<div class="gap"></div>
				<Panel
					title={t('web.instanceDetail.serverLoad')}
					description={t('web.instanceDetail.serverLoadDesc')}
				>
					{#if apdexPct !== null || miseryPct !== null}
						<div class="indices">
							{#if apdexPct !== null}
								<div class="index">
									<ProgressBar
										value={apdexPct}
										left={t('web.instanceDetail.apdex')}
										right={(apdexPct / 100).toFixed(3)}
										segmented
										height="2rem"
										color={apdexPct >= 95 ? 'success' : apdexPct >= 85 ? 'warning' : 'danger'}
									/>
									<p class="dim">{t('web.instanceDetail.apdexHint')}</p>
								</div>
							{/if}
							{#if miseryPct !== null}
								<div class="index">
									<!-- the one bar on this page where full is bad, so the tone runs
									     the other way rather than through `auto` -->
									<ProgressBar
										value={miseryPct}
										left={t('web.instanceDetail.misery')}
										right={`${miseryPct.toFixed(1)}%`}
										segmented
										height="2rem"
										color={miseryPct <= 2 ? 'success' : miseryPct <= 10 ? 'warning' : 'danger'}
									/>
									<p class="dim">{t('web.instanceDetail.miseryHint')}</p>
								</div>
							{/if}
						</div>
					{/if}

					{#if worlds.length}
						<DataTable columns={worldCols} rows={worlds} getId={(world: any) => String(world.name)}>
							{#snippet cell(world: any, col: string)}
								{#if col === 'name'}
									{world.name}
								{:else if world[col] === null || world[col] === undefined}
									<span class="dim">–</span>
								{:else if col === 'tickingEntities' || col === 'nonTickingEntities'}
									<!-- against this world's own entities, not the fleet's: the
									     question the column answers is how much of what this world
									     is holding actually costs tick time -->
									{@const total = worldEntities(world)}
									{#if total > 0}
										<ProgressBar
											compact
											value={world[col]}
											max={total}
											left={world[col].toLocaleString()}
											color={col === 'tickingEntities' ? 'accent' : 'success'}
										/>
									{:else}
										{world[col].toLocaleString()}
									{/if}
								{:else}
									{world[col].toLocaleString()}
								{/if}
							{/snippet}
						</DataTable>
					{/if}
				</Panel>
			{/if}
			<p class="dim note">
				{t('web.instanceDetail.sampledEvery5sBy')}
				{#if hasHeartbeatSeries}
					{t('web.instanceDetail.tickRateAndHeap')}
				{/if}
			</p>
		{:else if tab === 'plugins'}
			<Panel title="{addonLabel} on {name}" count={addonsLoaded ? instPlugins.length : undefined} flush>
				{#snippet actions()}
					<Alerts warnings={pluginTotals.warnings} errors={pluginTotals.errors} />
					{#if addonLive !== 'off'}
						{#if !addonsLoaded}<Spinner size="0.75rem" />{/if}
						<span class="live {addonsLoaded ? addonLive : 'connecting'}">{addonLiveLabel}</span>
					{/if}
					<Btn icon="sync" onclick={() => loadTab('plugins')}>{t('web.instanceDetail.refresh')}</Btn>
					<Btn icon="upload" onclick={deployPlugins}>{t('web.instanceDetail.deployToThisInstance')}</Btn>
					<!-- primary click is the pool, because that is where most of what an
					     operator wants already is; the other two sources are the caret -->
					<SplitBtn
						label={t('web.instanceDetail.addAddon')}
						icon="plus"
						primary
						onclick={() => openAddon('pool')}
						menu={addonSourceMenu}
					/>
				{/snippet}
				<ResourceTable
					tableId="instance-plugins"
					columns={pluginCols}
					rows={instPlugins}
					getId={(plugin) => plugin.plugin}
					searchValue={(plugin) =>
						`${plugin.plugin} ${plugin.displayName ?? ''} ${plugin.state} ${plugin.version ?? ''} ${plugin.source} ${(plugin.groups ?? []).join(' ')}`}
					searchPlaceholder={t('web.instanceDetail.findAnAddonOnThis')}
					rowActions={pluginActions}
					rowLabel={(plugin) => plugin.plugin}
					noun={t('web.instanceDetail.plugin')}
					pageSize={25}
					rowDim={(plugin) => plugin.disabled}
					sortValue={(plugin, col) =>
						col === 'alerts'
							? plugin.errors * 1000 + plugin.warnings : ((plugin as any)[
									col === 'auto' ? 'autoUpdate' : col === 'name' ? 'plugin' : col
								] ?? '')}
					onRowClick={(plugin) => goto(`/instances/${name}/plugins/${plugin.plugin}`)}
					emptyTitle={addonsLoaded
						? t('web.instanceDetail.noManagedAddons')
						: t('web.instanceDetail.readingBootLog')}
					emptyText={addonsLoaded ? '' : t('web.instanceDetail.stateComesFromThe')}
				>
					{#snippet cell(plugin, col)}
						{#if col === 'name'}
							<a
								href="/instances/{name}/plugins/{plugin.plugin}"
								onclick={(event) => event.stopPropagation()}
							>
								{plugin.plugin}
							</a>
							{#if plugin.displayName && plugin.displayName !== plugin.plugin}
								<span class="dim">({plugin.displayName})</span>
							{/if}
						{:else if col === 'state'}
							{@const badge =
							(plugin.disabled ? PLUGIN_STATE_BADGE.disabled
								: PLUGIN_STATE_BADGE[plugin.state]) ?? PLUGIN_STATE_BADGE.unknown}
							<StatusBadge state={badge.state} label={badge.label} />
						{:else if col === 'version'}
							<span class="mono">{plugin.version ?? '?'}</span>
						{:else if col === 'alerts'}
							<Alerts warnings={plugin.warnings} errors={plugin.errors} />
						{:else if col === 'origin'}
							{#if plugin.origin === 'group'}
								<span class="dim">{plugin.groups.join(', ')}</span>
							{:else if plugin.origin === 'manual'}
								<span class="manual">{t('web.instanceDetail.manual')}</span>
							{:else}
								<span class="dim">{t('web.instanceDetail.explicit')}</span>
							{/if}
						{:else if col === 'source'}
							<BrandLink source={plugin.source} short />
						{:else if col === 'auto'}
							<StatusBadge
								state={plugin.autoUpdate ? 'ok' : 'stopped'}
								label={plugin.autoUpdate ? 'On' : 'Off'}
							/>
						{:else if col === 'assign'}
							{plugin.pinned ? 'pinned' : plugin.variant ? 'variant (auto)' : 'primary'}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
			{#if !pluginTotals.sessionComplete}
				<p class="dim note">
					{t('web.instanceDetail.theBootLinesOf')}
				</p>
			{/if}
			<!-- a second table rather than rows in the first: these have no version,
			     no origin and no source, and merging them would add four columns that
			     are blank for half the rows. They are still addons, and until now the
			     screen counted them in the bar and then never named one. -->
			{#if instUnmanaged.length}
				<div class="gap"></div>
				<Panel
					title={unmanagedTitle}
					count={String(instUnmanaged.length)}
					description={t('web.instanceDetail.unmanagedAddonsHint')}
					flush
				>
					<ResourceTable
						tableId="instance-unmanaged"
						columns={unmanagedCols}
						rows={instUnmanaged}
						getId={(row) => `${row.dir}/${row.file}`}
						searchValue={(row) =>
							`${row.displayName} ${row.file} ${row.dir} ${row.state} ${row.meta?.version ?? ''} ${(row.meta?.authors ?? []).join(' ')}`}
						searchPlaceholder={t('web.instanceDetail.findUnmanaged', { noun: unmanagedNoun })}
						noun={unmanagedNoun}
						pageSize={25}
						sortValue={unmanagedSortValue}
						rowActions={unmanagedActions}
						rowLabel={(row: UnmanagedAddonRow) => row.displayName}
						onRowClick={(row: UnmanagedAddonRow) => {
							unmanagedLogRow = row;
							unmanagedLogOpen = true;
						}}
					>
						{#snippet cell(row: UnmanagedAddonRow, col: string)}
							{#if col === 'name'}
								<b>{row.displayName}</b>
								<span class="dim">{row.file}</span>
							{:else if col === 'state'}
								{@const badge = PLUGIN_STATE_BADGE[row.state] ?? PLUGIN_STATE_BADGE.unknown}
								<StatusBadge state={badge.state} label={badge.label} />
							{:else if col === 'dir'}
								<span class="mono dim">{row.dir}</span>
							{:else if col === 'version'}
								<span class="mono">{row.meta?.version ?? '—'}</span>
							{:else if col === 'authors'}
								<span class="dim">{row.meta?.authors?.join(', ') ?? '—'}</span>
							{:else if col === 'size'}
								{fmtBytes(row.sizeBytes)}
							{:else if col === 'alerts'}
								<Alerts warnings={row.warnings} errors={row.errors} />
							{/if}
						{/snippet}
					</ResourceTable>
				</Panel>
			{/if}
		{:else if tab === 'world'}
			{#if worldLock}
				<Flash kind="warning">
					{t('web.instanceWorld.lockedBanner', { kind: worldLock.kind, phase: worldLock.phase })}
				</Flash>
				<div class="gap"></div>
			{:else if inst.state !== 'stopped'}
				<Flash kind="info">{t('web.instanceWorld.runningBanner', { name: worldName })}</Flash>
				<div class="gap"></div>
			{/if}

			<Panel title={t('web.instanceWorld.currentWorld')}>
				{#snippet actions()}
					<Btn icon="sync" onclick={() => loadTab('world')}>{t('web.instanceDetail.refresh')}</Btn>
					<Btn
						icon="eraser"
						variant="danger"
						disabled={!!worldBlockedReason}
						title={worldBlockedReason}
						onclick={() => (resetOpen = true)}
					>
						{t('web.instanceWorld.resetWorld')}
					</Btn>
					<Btn
						icon="upload"
						variant="danger"
						disabled={!!worldBlockedReason}
						title={worldBlockedReason}
						onclick={openReplace}
					>
						{t('web.instanceWorld.replaceWorld')}
					</Btn>
					<Btn icon="download" variant="primary" onclick={() => void backupNow()}>
						{t('web.instanceWorld.backUpNow')}
					</Btn>
				{/snippet}

				{#if worldReport}
					<InfoGrid
						cells={[
							{ label: t('web.instanceWorld.levelName'), value: worldReport.level, style: 'mono', copyable: true },
							{ label: t('web.instanceWorld.layout'), value: t(`web.instanceWorld.layout_${worldReport.layout}`) },
							{ label: t('web.instanceWorld.totalSize'), value: fmtBytes(worldReport.sizeBytes) },
							{ label: t('web.instanceWorld.fileCount'), value: worldReport.fileCount.toLocaleString() },
							{
								label: t('web.instanceWorld.mcVersion'),
								value: worldReport.level_dat?.mcVersion ?? t('web.worldWizard.unknown')
							},
							{ label: t('web.instanceWorld.seed'), value: worldReport.level_dat?.seed ?? '–', style: 'mono', copyable: true },
							{
								label: t('web.instanceWorld.freeSpace'),
								value: worldReport.freeBytes ? fmtBytes(worldReport.freeBytes) : '–'
							},
							{
								label: t('web.instanceWorld.lastModified'),
								value: worldReport.modifiedAt ? fmtDateTime(worldReport.modifiedAt) : '–'
							}
						]}
					/>

					{#if worldReport.dimensions.length > 0}
						<div class="dims">
							{#each worldReport.dimensions as dim (dim.path)}
								<div class="dim-row">
									<span class="dim-name">{t(`web.worldWizard.dim.${dim.kind}`)}</span>
									<span class="mono dim-path">{dim.path}</span>
									<span class="dim-meta dim">
										{t('web.instanceWorld.dimMeta', {
											size: fmtBytes(dim.sizeBytes),
											regions: dim.regionFiles.toLocaleString()
										})}
									</span>
								</div>
							{/each}
						</div>
					{:else}
						<p class="dim note">{t('web.instanceWorld.noWorldYet')}</p>
					{/if}
				{:else}
					<p class="dim">{t('web.common.loading')}</p>
				{/if}
			</Panel>

			<div class="gap"></div>

			<Panel title={t('web.instanceWorld.backups')} count={backups.length} flush>
				{#snippet actions()}
					<Dropdown
						label={t('web.instanceWorld.actions')}
						disabled={backupSelection.size === 0}
						menu={backupActions(backups.filter((entry) => backupSelection.has(entry.id)))}
					/>
				{/snippet}

				<ResourceTable
					tableId="instance-backups"
					columns={backupCols}
					rows={backups}
					getId={(row) => row.id}
					selectable="multi"
					bind:selected={backupSelection}
					searchValue={(row) => `${row.label} ${row.level} ${row.mcVersion ?? ''} ${row.note ?? ''}`}
					searchPlaceholder={t('web.instanceWorld.findABackup')}
					rowActions={(row) => backupActions(backupTargets(row))}
					rowLabel={(row) => row.label}
					noun={t('web.instanceWorld.backupNoun')}
					sortValue={(row, col) => (col === 'createdAt' ? row.createdAt : col === 'sizeBytes' ? row.sizeBytes : row.label)}
					pageSize={25}
					emptyTitle={t('web.instanceWorld.noBackups')}
					emptyText={t('web.instanceWorld.noBackupsHint')}
				>
					{#snippet cell(row, col)}
						{#if col === 'label'}
							{row.label}
							{#if row.pinned}
								<span class="manual">{t('web.instanceWorld.pinned')}</span>
							{/if}
							{#if (row.warnings ?? []).length > 0}
								<span class="manual warn">{t('web.instanceWorld.tornWarning')}</span>
							{/if}
						{:else if col === 'createdAt'}
							{fmtDateTime(row.createdAt)}
						{:else if col === 'sizeBytes'}
							{fmtBytes(row.sizeBytes)}
						{:else if col === 'level'}
							<span class="mono">{row.level}</span>
						{:else if col === 'mcVersion'}
							{row.mcVersion ?? '–'}
						{:else if col === 'trigger'}
							{t(`web.instanceWorld.trigger_${row.trigger}`)}
						{:else if col === 'files'}
							{row.fileCount.toLocaleString()}
						{:else if col === 'checksum'}
							<span class="mono">{row.checksum ? row.checksum.slice(0, 16) : '–'}</span>
						{:else if col === 'note'}
							{row.note ?? '–'}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>

		{:else if tab === 'datapacks'}
			<Panel
				title="Data packs in {datapackWorld || 'the world'}"
				count={instDatapacks.length}
				flush
			>
				{#snippet actions()}
					{#if addonLive !== 'off'}
						{#if !addonsLoaded}<Spinner size="0.75rem" />{/if}
						<span class="live {addonsLoaded ? addonLive : 'connecting'}">{addonLiveLabel}</span>
					{/if}
					<Btn icon="sync" onclick={() => loadTab('datapacks')}>{t('web.instanceDetail.refresh')}</Btn>
					<Btn icon="box" onclick={() => goto('/datapacks')}>{t('web.instanceDetail.managePool')}</Btn>
					<Btn icon="upload" onclick={deployDatapacks}>{t('web.instanceDetail.deployToThisInstance')}</Btn>
					<SplitBtn
						label={t('web.instanceDetail.addDataPack')}
						icon="plus"
						primary
						onclick={() => openDatapack('pool')}
						menu={datapackSourceMenu}
					/>
				{/snippet}
				<ResourceTable
					tableId="instance-datapacks"
					columns={datapackCols}
					rows={instDatapacks}
					getId={(row) => row.file}
					searchValue={(row) => `${row.file} ${row.name ?? ''} ${row.source ?? ''}`}
					searchPlaceholder={t('web.instanceDetail.findADataPackIn')}
					rowActions={datapackActions}
					rowLabel={(row) => row.file}
					noun={t('web.instanceDetail.dataPack')}
					pageSize={25}
					rowDim={(row) => row.managed && !row.targeted}
					emptyTitle={addonsLoaded
						? t('web.instanceDetail.noDataPacks')
						: t('web.instanceDetail.readingBootLog')}
					emptyText={t('web.instanceDetail.deployPooledPacksHereOr')}
				>
					{#snippet cell(row, col)}
						{#if col === 'file'}
							<span class="mono">{row.file}</span>
							{#if !row.managed}
								<span class="manual">{t('web.instanceDetail.unmanaged')}</span>
							{/if}
						{:else if col === 'state'}
							{#if !row.present}
								<StatusBadge
									state="warning"
									label={t('web.instanceDetail.notDeployed')}
									detail="targeted here but missing from the world; deploy to copy it in"
								/>
							{:else if row.stale}
								<StatusBadge
									state="warning"
									label={t('web.instanceDetail.stale')}
									detail="the world's copy differs from the pool; deploy to update it"
								/>
							{:else if row.managed && !row.targeted}
								<StatusBadge
									state="stopped"
									label={t('web.instanceDetail.untargeted')}
									detail="still in the world but no longer targeted; a deploy removes it"
								/>
							{:else}
								<StatusBadge state="ok" label={t('web.instanceDetail.inSync')} />
							{/if}
						{:else if col === 'loaded'}
							{@const badge = PLUGIN_STATE_BADGE[row.state] ?? PLUGIN_STATE_BADGE.unknown}
							<StatusBadge
								state={badge.state}
								label={badge.label}
								detail={row.state === 'errored'
									? row.errors
										? t('web.instanceDetail.packContentBroken')
										: t('web.instanceDetail.packRefused')
									: row.state === 'unknown' && row.present
										? t('web.instanceDetail.packNotRead')
										: undefined}
							/>
							{#if row.errors}
								<span class="manual">{row.errors} {t('web.instanceDetail.packContentErrors')}</span>
							{/if}
						{:else if col === 'version'}
							<span class="mono">{row.versionNumber ?? '–'}</span>
						{:else if col === 'size'}
							{row.present ? fmtBytes(row.sizeBytes) : '–'}
						{:else if col === 'source'}
							{#if row.source}
								<BrandLink source={row.source} short />
							{:else}
								<span class="dim">–</span>
							{/if}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
			<p class="dim note">
				{t('web.instanceDetail.aRunningServerLoads')}
			</p>
		{:else if tab === 'respacks'}
			<Panel
				title={t('web.instanceDetail.resourcePacks')}
				count={instRespacks.length}
				description="Every pack in the proxy's catalog, and whether {name} is in its rules; serving one here rewrites that pack's rules and reloads the proxy"
				flush
			>
				{#snippet actions()}
					<Btn icon="sync" onclick={() => loadTab('respacks')}>{t('web.instanceDetail.refresh')}</Btn>
					<Btn icon="image" onclick={() => goto('/packs')}>{t('web.instanceDetail.managePacks')}</Btn>
				{/snippet}
				<ResourceTable
					tableId="instance-respacks"
					columns={respackCols}
					rows={instRespacks}
					getId={(row) => row.key}
					searchValue={(row) => `${row.key} ${row.name} ${row.servers.join(' ')}`}
					searchPlaceholder={t('web.instanceDetail.findAResourcePack')}
					rowActions={respackActions}
					rowLabel={(row) => row.key}
					noun={t('web.instanceDetail.pack')}
					pageSize={25}
					rowDim={(row) => !row.matched.includes(name ?? '')}
					sortValue={(row, col) =>
						col === 'applies'
							? row.matched.includes(name ?? '')
								? 0
								: 1
							: ((row as any)[col === 'name' ? 'key' : col] ?? '')}
					emptyTitle={t('web.instanceDetail.noResourcePacks')}
					emptyText={t('web.instanceDetail.theProxySPackCatalog')}
				>
					{#snippet cell(row, col)}
						{#if col === 'name'}
							<a href="/packs/{encodeURIComponent(row.key)}">{row.key}</a>
							{#if row.name && row.name.toLowerCase() !== row.key}
								<span class="dim">({row.name})</span>
							{/if}
						{:else if col === 'applies'}
							{#if respackHere(row) && row.enabled}
								<StatusBadge state="ok" label={t('web.instanceDetail.applies')} />
							{:else if respackHere(row)}
								<StatusBadge
									state="stopped"
									label={t('web.instanceDetail.wouldApply')}
									detail="the server rules match, but the pack is disabled"
								/>
							{:else}
								<span class="dim">{t('web.instanceDetail.no')}</span>
							{/if}
						{:else if col === 'state'}
							{#if row.enabled}
								<StatusBadge state="ok" label={t('web.instanceDetail.enabled')} />
							{:else}
								<StatusBadge state="stopped" label={t('web.instanceDetail.disabled')} />
							{/if}
						{:else if col === 'priority'}
							{row.priority}
						{:else if col === 'servers'}
							<span class="mono">{row.servers.join(', ') || '–'}</span>
							{#if row.granted.includes(name ?? '')}
								<span class="dim">· from {row.groups.join(', ')}</span>
							{/if}
						{:else if col === 'version'}
							<span class="mono">{row.versionNumber ?? '–'}</span>
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
			<p class="dim note">
				{t('web.instanceDetail.resourcePacksAreServed')}
				match <b>{name}</b>, stacked by priority.
			</p>
		{:else if tab === 'access'}
			<AccessLists instance={name ?? ''} />
		{:else if tab === 'network'}
			<Panel title={t('web.instanceDetail.ports')}>
				<InfoGrid cells={portCells} />
			</Panel>
			<div class="gap"></div>
			<Panel title={t('web.instanceDetail.proxyRegistration')}>
				{#snippet actions()}
					{#if name !== 'proxy'}
						<Btn icon="route" onclick={() => (proxyEditOpen = true)}>
							{t('web.instanceDetail.editRegistration')}
						</Btn>
					{/if}
				{/snippet}
				<InfoGrid cells={proxyCells} />
			</Panel>
			<ProxyRegistrationModal
				bind:open={proxyEditOpen}
				instance={name ?? ''}
				oncommitted={() => void refresh()}
			/>
		{:else if tab === 'environment'}
			<Panel
				title={t('web.instanceDetail.environment')}
				count={envVars.length}
				description={t('web.instanceDetail.everyVariableThisInstanceExports')}
				flush
			>
				{#snippet actions()}
					<Btn icon="key" href="/environment">{t('web.instanceDetail.allVariables')}</Btn>
					<Btn
						variant="primary"
						icon="plus"
						href="/environment/new?instance={encodeURIComponent(name ?? '')}"
					>
						{t('web.instanceDetail.addAnOverride')}
					</Btn>
				{/snippet}

				<ResourceTable
					tableId="instance-environment"
					columns={envCols}
					filters={envFilters}
					rows={envVars}
					getId={(row) => row.name}
					searchValue={(row) =>
						`${row.name} ${row.secret ? 'secret' : row.value} ${row.scope} ${row.description}`}
					searchPlaceholder={t('web.instanceDetail.findAVariable')}
					rowActions={envActions}
					rowLabel={(row) => row.name}
					noun={t('web.instanceDetail.variable')}
					emptyTitle={t('web.instanceDetail.nothingResolved')}
					emptyText={t('web.instanceDetail.thisInstanceResolvesNoVariables')}
				>
					{#snippet cell(row, col)}
						{#if col === 'name'}
							{#if row.scope === 'builtin'}
								<span class="mono"><b>{row.name}</b></span>
							{:else}
								<a class="mono" href="/environment/{encodeURIComponent(row.name)}">
									<b>{row.name}</b>
								</a>
							{/if}
						{:else if col === 'value'}
							{#if !row.secret}
								<span class="mono">{row.value || '(empty)'}</span>
							{:else if envRevealed[row.name] !== undefined}
								<span class="mono">{envRevealed[row.name] || '(empty)'}</span>
								<button class="peek" onclick={() => hideEnv(row.name)}>{t('web.instanceDetail.hide')}</button>
							{:else}
								<StatusBadge state="warning" label={t('web.instanceDetail.secret')} />
								<span class="dim">••••••••</span>
								{#if row.scope !== 'builtin'}
									<button
										class="peek"
										title={t('web.instanceDetail.revealThisValueTheRead')}
										onclick={() => revealEnv(row)}
									>
										reveal
									</button>
								{/if}
							{/if}
						{:else if col === 'source'}
							<span class="envscope {row.scope}">{row.scope}</span>
						{:else if col === 'shadowed'}
							{#if row.shadowed.length}
								<span class="dim">
									overrides {row.shadowed.map((prev) => prev.scope).join(', ')}
								</span>
							{:else if row.description}
								<span class="dim">{row.description}</span>
							{:else}
								<span class="dim">–</span>
							{/if}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
		{:else if tab === 'logs'}
			<Panel title={t('web.instanceDetail.latestLog')} flush>
				{#snippet actions()}
					<Select
						value={String(logLines)}
						width="9rem"
						options={LOG_LINE_CHOICES.map((count) => ({
							value: String(count),
							label: `${count} lines`
						}))}
						onchange={(value) => {
							// a different window of the log is a different snapshot
							logLines = Number(value);
							void showLogSnapshot();
						}}
					/>
					<label class="follow">
						<Toggle
							checked={logFollow}
							label={t('web.instanceDetail.followTheLog')}
							onchange={(value) => setLogFollow(value)}
						/>
						Follow
						{#if logLive !== 'off'}
							<span class="live {logLive}">{LOG_LIVE_LABEL[logLive]}</span>
						{/if}
					</label>
					<Btn
						icon="sync"
						disabled={logFollow}
						title={logFollow ? 'Following; the log re-reads itself' : ''}
						onclick={() => showLogSnapshot()}
					>
						Refresh
					</Btn>
					<Btn icon="code" onclick={() => goto(`/instances/${name}/console`)}>{t('web.instanceDetail.liveConsole')}</Btn>
				{/snippet}
				<pre
					class="logview mono"
					bind:this={logEl}
					onscroll={onLogScroll}
				>{logStream ? logStream.join('\n') : logData.content || '(empty)'}</pre>
			</Panel>
			{#if logData.archives.length}
				<div class="gap"></div>
				<Panel title={t('web.instanceDetail.archivedLogs')} count={logData.archives.length}>
					{#each logData.archives as archive}
						<div class="checkrow">
							<span class="mono">{archive.file}</span>
							<span class="dim">{fmtBytes(archive.sizeBytes)}</span>
						</div>
					{/each}
				</Panel>
			{/if}
		{:else if tab === 'config'}
			{#if cfgData}
				<Panel
					title={t('web.instanceDetail.instanceConfiguration')}
					description={t('web.instanceDetail.memoryProfileAndJvmFlags')}
				>
					<div class="cfg">
						<InstanceRuntimeFields
							{usesJava}
							profiles={cfgData.profiles}
							{runtimeOptions}
							{runtimeHint}
							instance={name}
							binaryName={cfgData.binaryName}
							addons={cfgData.addons ?? []}
							{memoryCapMb}
							{memoryCapNote}
							bind:memory={cfgMemory}
							bind:profile={cfgProfile}
							bind:runtime={cfgRuntime}
							bind:javaArgs={cfgJavaArgs}
							bind:javaAgents={cfgJavaAgents}
							bind:autoRestart={cfgAutoRestart}
							bind:restartDelay={cfgRestartDelay}
						/>
						{#if versionChangeable}
							<div class="field">
								<span class="lbl">{t('web.instanceDetail.minecraftVersion')}</span>
								<span class="hint">
									{t('web.instanceDetail.downloadsTheNewestBuild', { software: inst.software })}
								</span>
								<Select
									bind:value={cfgVersion}
									width="100%"
									options={serverVersions.map((version: string) => ({
										value: version, label: version
									}))}
								/>
							</div>
							<!-- the build is a separate row from the version on purpose: taking a
							     newer build is the routine act and changing version is not, so the
							     one that happens weekly does not need the version picker touched -->
							<div class="field">
								<span class="lbl">{t('web.instanceDetail.serverBuild')}</span>
								<span class="hint">{t('web.instanceDetail.serverBuildHint')}</span>
								<div class="build">
									<span class="buildnow">
										{#if buildCheck?.update}
											<span class="dim">{buildCheck.update.from ?? '—'}</span>
											<!-- `right`, not `arrowRight`: the latter is the chevron, and a
											     from/to transition wants the long arrow -->
											<Icon name="right" size="0.75rem" />
											<b>{buildCheck.update.to}</b>
										{:else if buildCheck?.current}
											{buildCheck.current}
											<span class="dim">{t('web.instanceDetail.buildUpToDate')}</span>
										{:else if buildCheck?.skipped}
											<span class="dim">{buildCheck.skipped}</span>
										{:else}
											<span class="dim">—</span>
										{/if}
									</span>
									<Btn icon="sync" loading={buildChecking} onclick={checkBuild}>
										{t('web.instanceDetail.checkForBuild')}
									</Btn>
									{#if buildCheck?.update}
										<Btn
											variant="primary"
											icon="download"
											loading={buildUpdating}
											disabled={inst.state !== 'stopped'}
											title={inst.state === 'stopped'
												? undefined
												: t('web.instanceDetail.buildNeedsStop')}
											onclick={applyBuild}
										>
											{t('web.instanceDetail.installBuild')}
										</Btn>
									{/if}
								</div>
							</div>
						{/if}
						{#if versionConflict.length}
							<Flash kind="error">
								<b>{t('web.instanceDetail.versionChangeBlockedIncompatible')}</b><br />
								{#each versionConflict as conflict}
									· {conflict.plugin} {conflict.version} (supports {conflict.gameVersions?.join(
										', '
									)})<br />
								{/each}
								<div class="conflict-actions">
									<Btn variant="danger" onclick={forceVersion}>{t('web.instanceDetail.forceAnyway')}</Btn>
									<Btn onclick={() => (versionConflict = [])}>{t('web.instanceDetail.cancel')}</Btn>
								</div>
							</Flash>
						{/if}
						<Btn variant="primary" loading={saving} onclick={saveConfig}>{t('web.instanceDetail.saveChanges')}</Btn>
					</div>
				</Panel>
				<div class="gap"></div>
				<Panel
					title={t('web.instanceDetail.addonGroups')}
					count={groupsDirty ? 'unsaved' : undefined}
					description={t('web.instanceDetail.groupsAppliedToThisInstance')}
				>
					<GroupsField
						software={cfgData.software}
						mcVersion={cfgData.mcVersion ?? undefined}
						instance={name}
						bind:selected={cfgAddonGroups}
					/>
				</Panel>
				<div class="gap"></div>
				<Panel
					title={t('web.instanceDetail.serverSettings')}
					count={settingEditCount ? `${settingEditCount} unsaved` : undefined}
					description={t('web.instanceDetail.serverPropertiesAppliedOnThe')}
				>
					<SettingsForm
						schema={cfgData.schema}
						groups={cfgData.groups}
						bind:values={cfgSettings}
					/>
				</Panel>
				<div class="gap"></div>
				<!-- the raw table owns its own reads and writes; the reload keeps the
				     settings form above it honest when a key they share is edited -->
				<ServerProperties instance={name ?? ''} onchanged={() => void loadTab('config')} />
			{/if}
		{/if}
	</div>
{/if}

<ScheduleQuickModal bind:open={scheduleOpen} instances={name ? [name] : []} />

<!-- one modal, two jobs: the tree is identical and the title should not claim a
     version moved when only the build did -->
<Modal
	title={versionJob?.kind === 'instance-build'
		? t('web.instanceDetail.buildChange')
		: t('web.instanceDetail.versionChange')}
	bind:open={versionJobOpen}
>
	<ProgressTree root={versionJob?.progress ?? null} state={versionJob?.state} />
</Modal>

<!-- deleting from here has nowhere to stay: the page it is on is about to stop
     existing, so the list is where the job's card is followed from -->
<DeleteInstanceModal
	bind:open={deleteOpen}
	name={name ?? ''}
	ondeleted={() => void goto('/instances')}
/>

<!-- the log of an addon luna does not manage. Its state vocabulary is passed in
     rather than duplicated, so the badge in the dialog is the badge in the row -->
<UnmanagedAddonLog
	bind:open={unmanagedLogOpen}
	instance={name ?? ''}
	row={unmanagedLogRow}
	stateBadge={PLUGIN_STATE_BADGE}
/>

<!-- one per kind rather than one dialog with a kind picker: the tab the operator
     opened it from has already answered which kind this is -->
<InstanceAddonAdd
	bind:open={addonUploadOpen}
	instance={name ?? ''}
	kind={uploadKind}
	families={uploadFamilies}
	source={addonSource}
	bind:provider={addonProvider}
	ondone={() => loadTab('plugins')}
/>

<InstanceAddonAdd
	bind:open={datapackUploadOpen}
	instance={name ?? ''}
	kind="datapack"
	source={datapackSource}
	bind:provider={datapackProvider}
	ondone={() => loadTab('datapacks')}
/>

<!-- Replacing a world is upload, check, then destroy, and it is one dialog for
     all three: the upload is the wizard's first step rather than a control on the
     page, so nothing is staged until somebody has set out to replace something -->
<WorldWizardModal
	bind:open={replaceOpen}
	bind:step={replaceStep}
	bind:world={worldStage}
	bind:backupFirst={replaceBackupFirst}
	target={replaceTarget}
	confirmLabel={t('web.instanceWorld.replaceWorld')}
	onconfirm={() => void replaceFromStage()}
	oncancel={() => (worldStage = null)}
>
	{#snippet source()}
		<WorldUpload
			bind:value={worldStage}
			instance={worldName}
			popup={false}
			disabled={!!worldBlockedReason}
			disabledReason={worldBlockedReason}
		/>
	{/snippet}
</WorldWizardModal>

<!-- Restore overwrites the live world with an older one, so it asks the same
     question the replace wizard's last step asks, in the same order -->
<Modal title={t('web.instanceWorld.restoreTitle', { name: worldName })} bind:open={restoreOpen}>
	{#if restoreTarget}
		<p>
			{t('web.instanceWorld.restoreLead', {
				label: restoreTarget.label,
				taken: fmtDateTime(restoreTarget.createdAt),
				name: worldName
			})}
		</p>

		{#if replaceTarget}
			<p class="dim">
				{t('web.instanceWorld.resetConsequence', {
					dirs: replaceTarget.dirs.join(', '),
					size: fmtBytes(replaceTarget.sizeBytes)
				})}
			</p>

			<label class="resetopt">
				<Checkbox
					checked={restoreBackupFirst}
					label={t('web.instanceWorld.backUpFirst')}
					onchange={(checked) => (restoreBackupFirst = checked)}
				/>
				<span>{t('web.instanceWorld.backUpFirst')}</span>
			</label>

			{#if !restoreBackupFirst}
				<Flash kind="warning">{t('web.worldWizard.noBackupWarning')}</Flash>

				<label class="resetopt">
					<Checkbox
						checked={restoreLossAck}
						label={t('web.worldWizard.lossAck')}
						onchange={(checked) => (restoreLossAck = checked)}
					/>
					<span>{t('web.worldWizard.lossAck')}</span>
				</label>
			{/if}
		{/if}
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (restoreOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn
			variant="danger"
			disabled={!restoreBackupFirst && !restoreLossAck}
			title={!restoreBackupFirst && !restoreLossAck ? t('web.worldWizard.needLossAck') : ''}
			onclick={() => void doRestore()}
		>
			{t('web.instanceWorld.restoreThis')}
		</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.instanceWorld.renameTitle')} bind:open={renameOpen}>
	<label class="field">
		<span class="lbl">{t('web.instanceWorld.renamePrompt')}</span>
		<input class="input" bind:value={renameValue} />
	</label>

	{#snippet footer()}
		<Btn onclick={() => (renameOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" disabled={!renameValue.trim()} onclick={() => void doRename()}>
			{t('web.common.save')}
		</Btn>
	{/snippet}
</Modal>

<Modal
	title={t('web.instanceWorld.deleteTitle', { count: String(deleteTargets.length) })}
	bind:open={deleteBackupsOpen}
>
	<p>{t('web.instanceWorld.deleteLead')}</p>

	<ul class="dellist">
		{#each deleteTargets as entry (entry.id)}
			<li>
				{entry.label}
				<span class="dim">{fmtBytes(entry.sizeBytes)}</span>
				{#if entry.pinned}
					<span class="manual">{t('web.instanceWorld.pinned')}</span>
				{/if}
			</li>
		{/each}
	</ul>

	{#snippet footer()}
		<Btn onclick={() => (deleteBackupsOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="danger" onclick={() => void doRemove()}>{t('web.common.delete')}</Btn>
	{/snippet}
</Modal>

<!-- Reset destroys a world and produces nothing, which is why it is the one verb
     here that asks the operator to type the word and offers a backup first -->
<Modal title={t('web.instanceWorld.resetTitle', { name: worldName })} bind:open={resetOpen}>
	<p>{t('web.instanceWorld.resetLead', { name: worldName })}</p>

	{#if worldReport}
		<p class="dim">
			{t('web.instanceWorld.resetConsequence', {
				dirs: worldReport.dimensions.map((entry) => entry.path).join(', '),
				size: fmtBytes(worldReport.sizeBytes)
			})}
		</p>
	{/if}

	<p class="dim">{t('web.instanceWorld.resetSeedNote')}</p>

	<label class="resetopt">
		<Checkbox
			checked={resetBackupFirst}
			label={t('web.instanceWorld.backUpFirst')}
			onchange={(checked) => (resetBackupFirst = checked)}
		/>
		<span>{t('web.instanceWorld.backUpFirst')}</span>
	</label>

	<label class="field">
		<span class="lbl">{t('web.instanceWorld.typeToConfirm', { word: 'reset' })}</span>
		<input class="input" bind:value={resetConfirm} placeholder="reset" />
	</label>

	{#snippet footer()}
		<Btn onclick={() => (resetOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="danger" disabled={resetConfirm.trim() !== 'reset'} onclick={() => void doReset()}>
			{t('web.instanceWorld.resetWorld')}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	// one dimension per line: the three are a set, and a grid would let the end
	// (which is usually tiny) claim as much width as the overworld
	.dims {
		margin-top: 1.25rem;
		border-top: 0.1rem solid var(--border-divider);
	}

	.dim-row {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		padding: 0.5rem 0;
		border-bottom: 0.1rem solid var(--border-divider);
		font-size: 0.8125rem;
	}

	.dim-name {
		width: 6rem;
		flex: none;
		font-weight: 700;
	}

	.dim-path {
		@include ellipsis;

		flex: 1;
	}

	.dim-meta {
		flex: none;
		font-variant-numeric: tabular-nums;
	}

	.resetopt {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 1rem 0;
		cursor: pointer;
	}

	.warn {
		color: var(--warning);
	}

	.tabbody {
		margin-top: 1rem;
	}

	// panels inside one tab are separated by an explicit spacer element
	// one colour per layer, matching the environment screens
	.envscope {
		font-size: 0.75rem;

		&.builtin {
			color: var(--text-secondary);
		}

		&.global {
			color: var(--link);
		}

		&.machine {
			color: var(--warning);
		}

		&.instance {
			color: var(--success);
		}
	}

	.peek {
		@include bare-button;

		margin-left: 0.5rem;
		color: var(--link);
		font-size: 0.75rem;

		&:hover {
			text-decoration: underline;
		}
	}

	.gap {
		height: 1rem;
	}

	// stands in for an overview cell's value line while its report is in flight
	.loading-line {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.checkrow {
		display: flex;
		gap: 0.875rem;
		align-items: baseline;
		padding: 0.5rem 0;
		border-bottom: 0.1rem solid var(--border-divider);

		&:last-child {
			border-bottom: none;
		}
	}

	.charts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: 1rem;
	}

	.threadbar {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.375rem;
		margin-bottom: 0.75rem;
		font-size: 0.8125rem;
		color: var(--text-secondary);

		b {
			color: var(--text);
			font-variant-numeric: tabular-nums;
		}

		.sep {
			color: var(--border);
		}
	}

	.busiest {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-top: 1rem;
	}

	.busiesthead {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05rem;
	}

	// name, id and bar on one line: the grid above answers "what is the shape", this
	// answers "what are they called", and a wrapping row would lose the pairing
	.busiestrow {
		display: grid;
		grid-template-columns: minmax(6rem, 12rem) 5rem 1fr;
		align-items: center;
		gap: 0.75rem;

		.tname {
			font-size: 0.8125rem;
			color: var(--text);

			@include ellipsis;
		}

		.tid {
			font-size: 0.75rem;
		}
	}

	.hint {
		margin-top: 0.75rem;
		margin-bottom: 0;
		font-size: 0.75rem;
	}

	.indices {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: 1.25rem 2rem;
		margin-bottom: 1.25rem;

		.index p {
			margin: 0.375rem 0 0;
			font-size: 0.75rem;
		}
	}

	.manual {
		color: var(--link);
		font-size: 0.8125rem;
	}

	// the archives a delete is about to take, so the count in the title is not
	// the only thing standing between the operator and the wrong ones
	.dellist {
		margin: 0.75rem 0 0;
		padding-left: 1.25rem;
		font-size: 0.8125rem;

		li + li {
			margin-top: 0.25rem;
		}

		.dim {
			margin-left: 0.5rem;
		}
	}

	.note {
		margin-top: 0.625rem;
	}

	.cmd {
		display: block;
		white-space: pre-wrap;
		word-break: break-all;
		padding: 0.75rem 1rem;
		background: var(--bg-terminal);
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
		font-size: 0.75rem;
		line-height: 1.6;
	}
	// the toggle reads as one control with its word, and lines up with the
	// buttons beside it in the panel's action row
	.follow {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
		cursor: pointer;
		user-select: none;
	}

	// stream state, in the same colours the status badges use: green while the
	// lines are arriving, amber while EventSource is retrying
	.live {
		font-size: 0.75rem;

		&.live {
			color: var(--success);
		}

		&.connecting,
		&.reconnecting {
			color: var(--warning);
		}
	}

	.logview {
		margin: 0;
		padding: 0.75rem 1rem;
		max-height: 55vh;
		overflow: auto;
		font-size: 0.75rem;
		line-height: 1.5;
		background: var(--bg-terminal);
		white-space: pre-wrap;
		word-break: break-all;
	}
	.cfg {
		max-width: 30rem;
	}

	// the switch reads as a field like the others, with its current meaning spelled
	// out beside it rather than left to the knob's position
	.toggleRow {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.conflict-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.625rem;
	}

	// the build row is a readout plus its verbs, so it wraps rather than squeezing
	// the "luna does not know which build is installed" sentence into a column
	.build {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.buildnow {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		flex: 1;
		font-variant-numeric: tabular-nums;
	}
</style>
