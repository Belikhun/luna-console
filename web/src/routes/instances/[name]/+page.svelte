<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post, patch, del } from '$lib/api';
	import { fmtDuration, fmtBytes, fmtDateTime } from '$lib/format';
	import SoftwareLabel from '$lib/components/SoftwareLabel.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import AccessLists from '$lib/components/AccessLists.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Select from '$lib/components/Select.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import DeleteInstanceModal from '$lib/components/DeleteInstanceModal.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { hasProvider, traitsOf } from '$core/software';
	import { channelOf } from '$lib/components/software';
	import type { Software } from '$core/types';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import type { DistributionSegment } from '$lib/components/distribution';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import BrandLink from '$lib/components/BrandLink.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import SettingsForm from '$lib/components/SettingsForm.svelte';
	import ProgressTree from '$lib/components/ProgressTree.svelte';
	import GroupsField from '$lib/components/GroupsField.svelte';
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
	const REFRESHED_TABS = ['plugins', 'datapacks', 'respacks', 'monitoring', 'checks', 'logs', 'environment'];

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
	let tab = $state('details');

	// a mod loader keeps its addons in mods/, so the tab is called what the
	// operator will look for; a hybrid runs both ecosystems and says so. The rows
	// and the API behind them are the same either way.
	const addonLabel = $derived.by(() => {
		const dirs = inst ? traitsOf(inst.software as Software).addonDirs : ['plugins'];
		const names = dirs.map((dir) => (dir === 'mods' ? 'Mods' : 'Plugins'));

		return names.join(' & ') || 'Plugins';
	});

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
	let deleteOpen = $state(false);
	let scheduleOpen = $state(false);
	let versionConflict: any[] = $state([]);

	let instPlugins: any[] = $state([]);
	let pluginTotals = $state({ warnings: 0, errors: 0, sessionComplete: true });
	let instDatapacks: any[] = $state([]);
	let datapackWorld = $state('');
	/** addon jars in the instance's directory that luna does not manage */
	let instUnmanaged: string[] = $state([]);
	/** addon stream state, in the same vocabulary the log stream uses */
	let addonLive: 'off' | 'connecting' | 'live' | 'reconnecting' = $state('off');
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


	/** Pack key whose per-instance rule edit is in flight, for the row's button. */
	let respackBusy = $state('');
	let metrics: { history: any[]; events: any[] } = $state({ history: [], events: [] });
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

		if (which === 'monitoring' || which === 'checks') {
			metrics = await api(`/instances/${name}/metrics`);
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

		// the instances table deep-links into a tab
		const urlTab = page.url.searchParams.get('tab');

		if (urlTab) {
			tab = urlTab;
		}

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

	/** Follow a version-change job to its end, keeping its tree on screen. */
	async function trackVersionJob(job: JobView, note: ReturnType<typeof Notify.loading>): Promise<void> {
		versionJob = job;

		const done = await followJob(job.id, (view) => {
			versionJob = view;
			note.set({ progress: Math.round(view.progress.progress * 100) });
		});

		const result = done.result as { from: string | null; to: string; build: number };

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

	async function saveConfig(): Promise<void> {
		saving = true;
		versionConflict = [];
		versionJob = null;

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

	const hostMemMb = $derived(inst?.hostMemMb ?? 0);

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

	const proxyCells: InfoCell[] = $derived.by(() => {
		if (!inst) {
			return [];
		}

		const registered = inst.proxy?.register
			? 'yes'
			: name === 'proxy'
				? '(is the proxy)'
				: 'no';

		const priority =
			inst.proxy?.priority !== undefined
				? [{ label: t('web.instanceDetail.tryListPriority'), value: String(inst.proxy.priority) }]
				: [];

		const forcedHosts = inst.proxy?.forcedHosts?.length
			? [{ label: t('web.instanceDetail.forcedHosts'), value: inst.proxy.forcedHosts.join(', ') }]
			: [];

		return [
			{ label: t('web.instanceDetail.registeredInVelocity'), value: registered },
			...priority,
			...forcedHosts
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

	/**
	 * Badge look of each addon phase. "Disabled" is not a phase; it is the
	 * per-instance override, and it says why the log has nothing to report rather
	 * than what the log saw, so it is shown in place of the phase.
	 */
	const PLUGIN_STATE_BADGE: Record<string, { state: string; label: string }> = {
		running: { state: 'running', label: t('web.instanceDetail.running') },
		loading: { state: 'loading', label: t('web.instanceDetail.loading') },
		errored: { state: 'failed', label: t('web.instanceDetail.errored') },
		unknown: { state: 'unknown', label: t('web.instanceDetail.unknown') },
		disabled: { state: 'stopped', label: t('web.instanceDetail.disabled') }
	};

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

	const datapackCols: Column[] = $derived([
		{ id: 'file', label: t('web.instanceDetail.dataPack2'), sortable: true },
		{ id: 'state', label: t('web.instanceDetail.state'), width: 150 },
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
	const propCols: Column[] = $derived([
		{ id: 'key', label: t('web.instanceDetail.property2'), width: 300 },
		{ id: 'value', label: t('web.instanceDetail.value') }
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
			label="{addonLabel} ({addonTotal})"
			segments={addonSegments}
			segmentsEmpty="none installed"
		/>
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

	<Tabs
		tabs={[
			{ id: 'details', label: t('web.instanceDetail.details') },
			{ id: 'checks', label: t('web.instanceDetail.statusAndAlarms') },
			{ id: 'monitoring', label: t('web.instanceDetail.monitoring') },
			{ id: 'plugins', label: addonLabel },
			// a proxy has no world, so the world-scoped tabs do not apply to it
			...(traitsOf(inst.software as Software).isProxy
				? []
				: [
						{ id: 'datapacks', label: t('web.instanceDetail.dataPacks') },
						{ id: 'respacks', label: t('web.instanceDetail.resourcePacks') },
						{ id: 'access', label: t('web.instanceDetail.playersAccess') }
					]),
			{ id: 'network', label: t('web.instanceDetail.networking') },
			{ id: 'environment', label: t('web.instanceDetail.environment') },
			{ id: 'logs', label: t('web.instanceDetail.logs') },
			{ id: 'config', label: t('web.instanceDetail.configuration') }
		]}
		bind:active={tab}
	/>

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
								<ProgressBar compact value={inst.cpu} color="auto" width="10rem" />
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
			</div>
			<p class="dim note">
				{t('web.instanceDetail.sampledEvery5sBy')}
				{#if hasHeartbeatSeries}
					{t('web.instanceDetail.tickRateAndHeap')}
				{/if}
			</p>
		{:else if tab === 'plugins'}
			<Panel title="{addonLabel} on {name}" count={instPlugins.length} flush>
				{#snippet actions()}
					<Alerts warnings={pluginTotals.warnings} errors={pluginTotals.errors} />
					{#if addonLive !== 'off'}
						<span class="live {addonLive}">{LOG_LIVE_LABEL[addonLive]}</span>
					{/if}
					<Btn icon="sync" onclick={() => loadTab('plugins')}>{t('web.instanceDetail.refresh')}</Btn>
					<Btn icon="upload" onclick={deployPlugins}>{t('web.instanceDetail.deployToThisInstance')}</Btn>
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
		{:else if tab === 'datapacks'}
			<Panel
				title="Data packs in {datapackWorld || 'the world'}"
				count={instDatapacks.length}
				flush
			>
				{#snippet actions()}
					{#if addonLive !== 'off'}
						<span class="live {addonLive}">{LOG_LIVE_LABEL[addonLive]}</span>
					{/if}
					<Btn icon="sync" onclick={() => loadTab('datapacks')}>{t('web.instanceDetail.refresh')}</Btn>
					<Btn icon="box" onclick={() => goto('/datapacks')}>{t('web.instanceDetail.managePool')}</Btn>
					<Btn icon="upload" onclick={deployDatapacks}>{t('web.instanceDetail.deployToThisInstance')}</Btn>
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
					emptyTitle={t('web.instanceDetail.noDataPacks')}
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
				<InfoGrid cells={proxyCells} />
			</Panel>
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
				{#if versionJob}
					<div class="gap"></div>
					<Panel title={t('web.instanceDetail.versionChange')} description={t('web.instanceDetail.liveFromTheSameReporter')}>
						<ProgressTree root={versionJob.progress} state={versionJob.state} />
					</Panel>
				{/if}
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
				<Panel
					title={t('web.instanceDetail.serverProperties')}
					description={t('web.instanceDetail.everyKeyOnDiskIncluding')}
					flush
				>
					<ResourceTable
						tableId="instance-properties"
						columns={propCols}
						rows={Object.entries(cfgData.serverProperties).map(([key, value]) => ({
							key,
							value: String(value)
						}))}
						getId={(row) => row.key}
						searchValue={(row) => `${row.key} ${row.value}`}
						searchPlaceholder={t('web.instanceDetail.findAProperty')}
						searchWidth="20rem"
						noun={t('web.instanceDetail.property')}
						paging={false}
						maxHeight="20rem"
					>
						{#snippet cell(row, col)}
							{#if col === 'key'}
								<span class="mono">{row.key}</span>
							{:else}
								<span class="mono dim">{row.value}</span>
							{/if}
						{/snippet}
					</ResourceTable>
				</Panel>
			{/if}
		{/if}
	</div>
{/if}

<ScheduleQuickModal bind:open={scheduleOpen} instances={name ? [name] : []} />

<!-- deleting from here has nowhere to stay: the page it is on is about to stop
     existing, so the list is where the job's card is followed from -->
<DeleteInstanceModal
	bind:open={deleteOpen}
	name={name ?? ''}
	ondeleted={() => void goto('/instances')}
/>

<style lang="scss">
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

	.manual {
		color: var(--link);
		font-size: 0.8125rem;
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
</style>
