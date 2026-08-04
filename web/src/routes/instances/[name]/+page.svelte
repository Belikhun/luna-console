<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post, patch, del } from '$lib/api';
	import { fmtDuration, fmtBytes, fmtDateTime } from '$lib/format';
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
	import Sparkline from '$lib/components/Sparkline.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import type { DistributionSegment } from '$lib/components/distribution';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import BrandLink from '$lib/components/BrandLink.svelte';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import SettingsForm from '$lib/components/SettingsForm.svelte';
	import ProgressTree from '$lib/components/ProgressTree.svelte';
	import GroupsField from '$lib/components/GroupsField.svelte';
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
	 * rides the refresh control's cadence rather than the fast header poll —
	 * a plugin report scans the instance's jars and its boot session, which is
	 * not something to do every four seconds.
	 */
	const REFRESHED_TABS = ['plugins', 'datapacks', 'respacks', 'monitoring', 'checks', 'logs'];

	const LOG_LINE_CHOICES = [100, 200, 500, 1000];

	/** a scroll further than this from the bottom is the user reading back */
	const LOG_FOLLOW_SLACK = 40;

	const LOG_FOLLOW_KEY = 'luna.logs.follow';

	/** Shared by the log tail and the addon stream — both are EventSources. */
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
	// operator will look for — the rows and the API behind them are the same
	const addonLabel = $derived(inst?.software === 'neoforge' ? 'Mods' : 'Plugins');

	let cfgData: any = $state(null);
	let cfgMemory = $state('');
	let cfgProfile = $state('');
	let cfgVersion = $state('');
	let cfgJavaArgs = $state('');
	let cfgSettings: Record<string, string> = $state({});
	let cfgAddonGroups: string[] = $state([]);
	let paperVersions: string[] = $state([]);
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
	 * stream that produced them — see `setLogFollow`.
	 */
	let logStream: string[] | null = $state(null);
	let logLive: 'off' | 'connecting' | 'live' | 'reconnecting' = $state('off');
	let logEl: HTMLElement | null = $state(null);

	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	/** name of the primary daemon — the machine an ownerless instance runs on */
	let hostName = $state('');

	/**
	 * Re-read the page. `tabData` also reloads whatever the open tab is showing —
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
			Notify.error(`Could not load ${name}`, { detail: (err as Error).message });
		} finally {
			loading = false;
		}

		// an operation already in flight for this instance — started elsewhere, or
		// before a reload — gets its flash card raised here; attached jobs dedupe,
		// so re-checking on every poll is safe
		try {
			const running = await api(`/jobs?target=${encodeURIComponent(name)}&state=running`);

			for (const job of running.jobs) {
				attachInstanceJobFlash(job);
			}
		} catch {
			// job discovery is best-effort — the page itself already refreshed
		}
	}

	/**
	 * Whether the addon stream is the authority for the tabs it feeds. Read
	 * through a call rather than inline, so a check after an await is not
	 * narrowed away — the stream connecting mid-request is the case it exists for.
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

		// absent for software with no world of its own — leave the tab as it was
		if (snapshot.datapacks) {
			instDatapacks = snapshot.datapacks.rows;
			datapackWorld = snapshot.datapacks.world;
		}
	}

	/** Each tab loads its own data the first time it is shown, and on refresh. */
	async function loadTab(which: string): Promise<void> {
		// The stream owns both of these tabs whenever it is up; this fetch is the
		// fallback for the moment before it connects, and for a browser that
		// cannot keep it open. The state is re-checked after the await too — the
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

		if (which === 'respacks') {
			// the catalog is proxy-global; this tab shows how it lands here
			instRespacks = (await api('/respacks')).packs;
		}

		if (which === 'monitoring' || which === 'checks') {
			metrics = await api(`/instances/${name}/metrics`);
		}

		// While following, the stream is the body of the view, and a refresh tick
		// re-reading it would fetch lines nobody looks at — except the first time,
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
			cfgJavaArgs = (cfgData.javaArgs ?? []).join(' ');
			cfgSettings = { ...cfgData.settings };
			cfgAddonGroups = [...(cfgData.addonGroups ?? [])];

			if (!paperVersions.length) {
				paperVersions = (await api('/paper')).versions;
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
	 * they scrolled to have to stay exactly where they are — re-reading the
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
	 * Scrolling back through the log turns following off — otherwise the next
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
	 * instance's latest.log on its own host and pipes it as SSE — the same
	 * stream the live console reads. Browser streaming here is always SSE and
	 * never a WebSocket (DESIGN.md §4); the WebSockets in luna are the
	 * daemon-to-daemon links, and a follower-owned instance's tail is tunnelled
	 * over one before reaching this EventSource.
	 *
	 * The stream owns the view while it is open — it opens with the daemon's own
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
			// top — both of them moving the text the reader just scrolled to.
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
	 * This is keyed on the tab alone — turning following off is not a dependency,
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
	 * Addon state is live for as long as the page is open — the distribution bars
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
			detail: `Paper build ${result.build}. Restart the instance to run it.`,
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

		const note = Notify.loading(`Saving configuration for ${name}…`);

		try {
			const body: any = {
				memory: cfgMemory,
				profile: cfgProfile,
				settings: settingEdits
			};

			if (javaArgsDirty) {
				body.javaArgs = cfgJavaArgs;
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
					message: `${res.incompatible.length} plugin(s) are incompatible with ${cfgVersion}`,
					detail: 'Review the conflict below before forcing the version change.',
					closeable: true
				});

				saving = false;

				return;
			}

			note.set({
				level: 'success',
				message: `Saved: ${res.changed.join(', ') || 'no changes'}`,
				detail: res.changed.length ? 'Applies on the next restart.' : '',
				closeable: true
			});

			// a version change downloads a jar, so the route handed back a job to watch
			if (res.job) {
				await trackVersionJob(res.job, Notify.loading(`Downloading paper ${cfgVersion}…`));
			} else {
				await refresh();
				await loadTab('config');
			}
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not save ${name}`,
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
				message: `Deployed plugins to ${name} — ${changed} change(s)`,
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
				message: `Deployed data packs to ${name} — ${changed} change(s)`,
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
				message: `Adopted ${res.name} — it now deploys from the pool`,
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
				detail: 'The server unloads it on its next restart.',
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
					? 'Reload sent to the proxy — the change is live.'
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
	 * rules are the only place that can say so, so the route rewrites them —
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
						? 'Reload sent to the proxy — players get the change on their next join or switch.'
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
			{ id: 'state', label: 'Instance state' },
			{ label: 'Software', value: `${inst.software} ${inst.mcVersion ?? ''}` },
			{ label: 'Ping version', value: inst.pingVersion },
			{ label: 'Game address', value: inst.address, copyable: true, style: 'mono' },
			{ label: 'Memory (heap)', value: inst.memory },
			{ label: 'Java profile', value: inst.profile },
			{
				label: 'Machine',
				value: inst.daemon ?? (hostName || 'primary'),
				href:
					(inst.daemon ?? hostName)
						? `/machines/${inst.daemon ?? hostName}`
						: undefined
			},
			{ label: 'Java PID', value: inst.javaPid },
			{ id: 'cpu', label: 'CPU utilization' },
			{ id: 'rss', label: 'Resident memory' },
			// heartbeat-only figures: the server's own tick rate and heap, which the
			// host-side /proc sampling above cannot see
			{ id: 'tps', label: 'Tick rate' },
			{ id: 'heap', label: 'JVM heap' },
			{ label: 'Uptime', value: fmtDuration(inst.uptimeMs) },
			{
				label: 'Players',
				value: inst.players ? `${inst.players.online}/${inst.players.max}` : null
			},
			{ label: 'Directory', value: inst.dir, copyable: true, style: 'mono' }
		];
	});

	const portCells: InfoCell[] = $derived.by(() => {
		if (!inst) {
			return [];
		}

		// the plugin allocations are bound on the same machine as the game port, so
		// they are shown at that machine's host too — a follower's voice-chat port
		// answers on the LAN, never on the console's own loopback
		const host = (inst.address ?? '').split(':')[0] ?? '';

		return [
			{
				label: 'Game port (tcp)',
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
				? [{ label: 'Try-list priority', value: String(inst.proxy.priority) }]
				: [];

		const forcedHosts = inst.proxy?.forcedHosts?.length
			? [{ label: 'Forced hosts', value: inst.proxy.forcedHosts.join(', ') }]
			: [];

		return [
			{ label: 'Registered in velocity', value: registered },
			...priority,
			...forcedHosts
		];
	});

	const pluginCols: Column[] = [
		{ id: 'name', label: 'Plugin', sortable: true },
		{ id: 'state', label: 'State', sortable: true, width: 130 },
		{ id: 'version', label: 'Version' },
		{ id: 'alerts', label: 'Alerts', sortable: true, width: 230 },
		{ id: 'origin', label: 'From', sortable: true },
		{ id: 'source', label: 'Source', sortable: true, minWidth: 140 },
		{ id: 'auto', label: 'Auto-update', hidden: true },
		{ id: 'assign', label: 'Assignment', hidden: true }
	];

	/**
	 * Badge look of each addon phase. "Disabled" is not a phase — it is the
	 * per-instance override, and it says why the log has nothing to report rather
	 * than what the log saw, so it is shown in place of the phase.
	 */
	const PLUGIN_STATE_BADGE: Record<string, { state: string; label: string }> = {
		running: { state: 'running', label: 'Running' },
		loading: { state: 'loading', label: 'Loading' },
		errored: { state: 'failed', label: 'Errored' },
		unknown: { state: 'unknown', label: 'Unknown' },
		disabled: { state: 'stopped', label: 'Disabled' }
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
			{ key: 'running', label: 'running', count: by('running'), color: 'var(--success)' },
			{ key: 'loading', label: 'loading', count: by('loading'), color: 'var(--warning)' },
			{ key: 'errored', label: 'errored', count: by('errored'), color: 'var(--error)' },
			{ key: 'unknown', label: 'unknown', count: by('unknown'), color: 'var(--bg-track)' },
			{
				key: 'disabled',
				label: 'disabled',
				count: instPlugins.filter((plugin) => plugin.disabled).length,
				color: 'var(--text-disabled)'
			},
			{
				key: 'unmanaged',
				label: 'unmanaged',
				count: instUnmanaged.length,
				color: 'var(--link)'
			}
		];
	});

	const addonTotal = $derived(addonSegments.reduce((sum, segment) => sum + segment.count, 0));

	/**
	 * Which bucket one data pack falls in — the same order the tab's own badges
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
			{ key: 'insync', label: 'in sync', count: count('insync'), color: 'var(--success)' },
			{ key: 'stale', label: 'stale', count: count('stale'), color: 'var(--warning)' },
			{
				key: 'missing',
				label: 'not deployed',
				count: count('missing'),
				color: 'var(--error)'
			},
			{
				key: 'untargeted',
				label: 'untargeted',
				count: count('untargeted'),
				color: 'var(--text-disabled)'
			},
			{ key: 'unmanaged', label: 'unmanaged', count: count('unmanaged'), color: 'var(--link)' }
		];
	});

	const datapackTotal = $derived(
		datapackSegments.reduce((sum, segment) => sum + segment.count, 0)
	);

	/** A plugin row's verbs on this instance. */
	function pluginActions(plugin: any): ContextMenuItem[] {
		return [
			{
				label: 'Open on this instance',
				icon: 'circleInfo',
				action: () => goto(`/instances/${name}/plugins/${plugin.plugin}`)
			},
			{
				label: 'Open the plugin',
				icon: 'plug',
				action: () => goto(`/plugins/${encodeURIComponent(plugin.plugin)}`)
			},
			{ separator: true },
			{
				label: 'Copy version',
				icon: 'copy',
				disabled: !plugin.version,
				action: () => navigator.clipboard?.writeText(plugin.version ?? '')
			}
		];
	}

	const datapackCols: Column[] = [
		{ id: 'file', label: 'Data pack', sortable: true },
		{ id: 'state', label: 'State', width: 150 },
		{ id: 'version', label: 'Version' },
		{ id: 'size', label: 'Size', width: 100, align: 'right' },
		{ id: 'source', label: 'Source', minWidth: 140 }
	];

	/** A data pack row's verbs on this instance. */
	function datapackActions(row: any): ContextMenuItem[] {
		return [
			{
				label: 'Manage in the pool',
				icon: 'box',
				disabled: !row.managed,
				hint: !row.managed ? 'not a pooled pack yet — adopt it first' : undefined,
				action: () => goto(`/datapacks?q=${encodeURIComponent(row.name ?? '')}`)
			},
			{
				label: 'Adopt into the pool',
				icon: 'inboxIn',
				disabled: row.managed,
				hint: row.managed ? 'already pooled' : undefined,
				action: () => adoptDatapack(row.file)
			},
			{ separator: true },
			{
				label: 'Remove from this instance',
				icon: 'trash',
				color: 'danger',
				disabled: !row.managed || !row.targeted,
				hint: !row.managed
					? 'unmanaged file — delete it from the world by hand, or adopt it first'
					: !row.targeted
						? 'not targeted here — a deploy already removes it'
						: undefined,
				action: () => removeDatapackHere(row.name)
			}
		];
	}

	const respackCols: Column[] = [
		{ id: 'name', label: 'Resource pack', sortable: true },
		{ id: 'applies', label: 'On this server', width: 150 },
		{ id: 'state', label: 'State', width: 130 },
		{ id: 'priority', label: 'Priority', width: 90, align: 'right' },
		{ id: 'servers', label: 'Server rules' },
		{ id: 'version', label: 'Version' }
	];

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
						? `granted by addon group ${row.groups.join(', ')} — edit the group instead`
						: undefined,
				action: () => setRespackHere(row.key, !here)
			},
			{ separator: true },
			{
				label: 'Pack details',
				icon: 'circleInfo',
				action: () => goto(`/packs/${encodeURIComponent(row.key)}`)
			},
			{
				label: 'Configure pack',
				icon: 'pen',
				action: () => goto(`/packs/${encodeURIComponent(row.key)}/configure`)
			},
			{
				label: row.enabled ? 'Disable everywhere' : 'Enable everywhere',
				icon: row.enabled ? 'ban' : 'circleCheck',
				action: () => setRespackEnabled(row.key, !row.enabled)
			},
			{
				label: 'Manage in Resource packs',
				icon: 'image',
				action: () => goto(`/packs?q=${encodeURIComponent(row.key)}`)
			}
		];
	}

	const eventCols: Column[] = [
		{ id: 'time', label: 'Time', width: 190 },
		{ id: 'kind', label: 'Type', width: 120 },
		{ id: 'message', label: 'Event' }
	];
	const propCols: Column[] = [
		{ id: 'key', label: 'Property', width: 300 },
		{ id: 'value', label: 'Value' }
	];
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
			<Btn onclick={() => goto(`/instances/${name}/console`)}>Connect</Btn>
			<Dropdown
				label="Instance state"
				items={[
					{
						label: 'Start instance',
						icon: 'play',
						disabled: inst.state !== 'stopped',
						action: () => stateAction('start')
					},
					{
						label: 'Stop instance',
						icon: 'stop',
						disabled: !isUp,
						action: () => stateAction('stop')
					},
					{
						label: 'Restart instance',
						icon: 'rotate',
						disabled: !isUp,
						action: () => stateAction('restart')
					},
					{ divider: true, label: '' },
					{
						label: 'Schedule an action…',
						icon: 'clock',
						action: () => {
							scheduleOpen = true;
						}
					}
				]}
			/>
			<Dropdown
				label="Actions"
				items={[
					{
						label: 'Serial console',
						icon: 'code',
						action: () => goto(`/instances/${name}/console`)
					},
					{ label: 'Deploy plugins here', icon: 'upload', action: () => deployPlugins() },
					{ divider: true, label: '' },
					{
						label: 'Delete instance',
						icon: 'trash',
						danger: true,
						disabled: inst.state !== 'stopped' || name === 'proxy',
						action: () => {
							deleteOpen = true;
						}
					}
				]}
			/>
		{/snippet}
	</PageHeader>

	<OverviewBar title="Instance overview">
		<OverviewCell label="Status">
			<StatusBadge state={inst.state} />
		</OverviewCell>
		<OverviewCell
			label="Status checks ({inst.checks.length})"
			progress={inst.state === 'stopped' ? 0 : checksPassed / inst.checks.length}
			progressColor={checksPassed === inst.checks.length ? 'var(--success)' : 'var(--warning)'}
		>
			{#if inst.state === 'stopped'}
				<span class="dim">instance stopped</span>
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
		<OverviewCell label="Software">
			{inst.software} {inst.mcVersion ?? ''}
		</OverviewCell>
		<OverviewCell label="Players">
			{inst.players ? `${inst.players.online} / ${inst.players.max}` : '–'}
		</OverviewCell>
		<OverviewCell label="Uptime">
			{fmtDuration(inst.uptimeMs)}
		</OverviewCell>
	</OverviewBar>

	<Tabs
		tabs={[
			{ id: 'details', label: 'Details' },
			{ id: 'checks', label: 'Status and alarms' },
			{ id: 'monitoring', label: 'Monitoring' },
			{ id: 'plugins', label: addonLabel },
			// the proxy has no world for data packs, and resource packs are ITS
			// catalog — the per-backend view only makes sense on a backend
			...(inst.software === 'velocity'
				? []
				: [
						{ id: 'datapacks', label: 'Data packs' },
						{ id: 'respacks', label: 'Resource packs' },
						{ id: 'access', label: 'Players & access' }
					]),
			{ id: 'network', label: 'Networking' },
			{ id: 'logs', label: 'Logs' },
			{ id: 'config', label: 'Configuration' }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'details'}
			<Panel title="Instance summary">
				<InfoGrid cells={summaryCells}>
					{#snippet custom(cell)}
						{#if cell.id === 'state'}
							<StatusBadge state={inst.state} />
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
								<span class="dim" title="LunaCore is not reporting for this instance">–</span>
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
				title="Launch command"
				description="Generated from cluster.json (profile + memory) on every start"
			>
				<code class="cmd mono">{inst.javaCommand}</code>
			</Panel>
		{:else if tab === 'checks'}
			<Panel title="Status checks">
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
				title="Events"
				count={metrics.events.length}
				description="State transitions and actions recorded this console session"
				flush
			>
				<ResourceTable
					tableId="instance-events"
					columns={eventCols}
					rows={metrics.events}
					getId={(event) => String(event.t) + event.message}
					searchValue={(event) => `${event.kind} ${event.message}`}
					searchPlaceholder="Find an event"
					searchWidth="20rem"
					noun="event"
					pageSize={20}
					emptyTitle="No recorded events this session"
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
				<Sparkline points={cpuPoints} label="CPU utilization" unit="%" color="#42b4ff" />
				<Sparkline points={memPoints} label="Memory (RSS)" unit=" MB" color="#bf7edb" />
				<Sparkline
					points={playerPoints}
					label="Players online"
					color="#2bb534"
					maxY={playerMax}
				/>
				{#if hasHeartbeatSeries}
					<Sparkline points={tpsPoints} label="Tick rate" unit=" TPS" color="#e0ca57" maxY={20} />
					<Sparkline points={heapPoints} label="JVM heap" unit=" MB" color="#ff9d5c" />
				{/if}
			</div>
			<p class="dim note">
				Sampled every 5s by the luna daemon (last hour kept in memory).
				{#if hasHeartbeatSeries}
					Tick rate and heap come from LunaCore's heartbeat.
				{/if}
			</p>
		{:else if tab === 'plugins'}
			<Panel title="{addonLabel} on {name}" count={instPlugins.length} flush>
				{#snippet actions()}
					<Alerts warnings={pluginTotals.warnings} errors={pluginTotals.errors} />
					{#if addonLive !== 'off'}
						<span class="live {addonLive}">{LOG_LIVE_LABEL[addonLive]}</span>
					{/if}
					<Btn icon="sync" onclick={() => loadTab('plugins')}>Refresh</Btn>
					<Btn icon="upload" onclick={deployPlugins}>Deploy to this instance</Btn>
				{/snippet}
				<ResourceTable
					tableId="instance-plugins"
					columns={pluginCols}
					rows={instPlugins}
					getId={(plugin) => plugin.plugin}
					searchValue={(plugin) =>
						`${plugin.plugin} ${plugin.displayName ?? ''} ${plugin.state} ${plugin.version ?? ''} ${plugin.source} ${(plugin.groups ?? []).join(' ')}`}
					searchPlaceholder="Find an addon on this instance"
					rowActions={pluginActions}
					rowLabel={(plugin) => plugin.plugin}
					noun="plugin"
					pageSize={25}
					rowDim={(plugin) => plugin.disabled}
					sortValue={(plugin, col) =>
						col === 'alerts'
							? plugin.errors * 1000 + plugin.warnings
							: ((plugin as any)[
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
							(plugin.disabled
								? PLUGIN_STATE_BADGE.disabled
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
								<span class="manual">manual</span>
							{:else}
								<span class="dim">explicit</span>
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
					The boot lines of this session have rotated out of the log window, so plugins with no
					later log activity read as Unknown.
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
					<Btn icon="sync" onclick={() => loadTab('datapacks')}>Refresh</Btn>
					<Btn icon="box" onclick={() => goto('/datapacks')}>Manage pool</Btn>
					<Btn icon="upload" onclick={deployDatapacks}>Deploy to this instance</Btn>
				{/snippet}
				<ResourceTable
					tableId="instance-datapacks"
					columns={datapackCols}
					rows={instDatapacks}
					getId={(row) => row.file}
					searchValue={(row) => `${row.file} ${row.name ?? ''} ${row.source ?? ''}`}
					searchPlaceholder="Find a data pack in this world"
					rowActions={datapackActions}
					rowLabel={(row) => row.file}
					noun="data pack"
					pageSize={25}
					rowDim={(row) => row.managed && !row.targeted}
					emptyTitle="No data packs"
					emptyText="Deploy pooled packs here, or drop zips into the world's datapacks folder."
				>
					{#snippet cell(row, col)}
						{#if col === 'file'}
							<span class="mono">{row.file}</span>
							{#if !row.managed}
								<span class="manual">unmanaged</span>
							{/if}
						{:else if col === 'state'}
							{#if !row.present}
								<StatusBadge
									state="warning"
									label="Not deployed"
									detail="targeted here but missing from the world — deploy to copy it in"
								/>
							{:else if row.stale}
								<StatusBadge
									state="warning"
									label="Stale"
									detail="the world's copy differs from the pool — deploy to update it"
								/>
							{:else if row.managed && !row.targeted}
								<StatusBadge
									state="stopped"
									label="Untargeted"
									detail="still in the world but no longer targeted — a deploy removes it"
								/>
							{:else}
								<StatusBadge state="ok" label="In sync" />
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
				A running server loads data pack changes on its next restart (or /minecraft:reload).
			</p>
		{:else if tab === 'respacks'}
			<Panel
				title="Resource packs"
				count={instRespacks.length}
				description="Every pack in the proxy's catalog, and whether {name} is in its rules — serving one here rewrites that pack's rules and reloads the proxy"
				flush
			>
				{#snippet actions()}
					<Btn icon="sync" onclick={() => loadTab('respacks')}>Refresh</Btn>
					<Btn icon="image" onclick={() => goto('/packs')}>Manage packs</Btn>
				{/snippet}
				<ResourceTable
					tableId="instance-respacks"
					columns={respackCols}
					rows={instRespacks}
					getId={(row) => row.key}
					searchValue={(row) => `${row.key} ${row.name} ${row.servers.join(' ')}`}
					searchPlaceholder="Find a resource pack"
					rowActions={respackActions}
					rowLabel={(row) => row.key}
					noun="pack"
					pageSize={25}
					rowDim={(row) => !row.matched.includes(name ?? '')}
					sortValue={(row, col) =>
						col === 'applies'
							? row.matched.includes(name ?? '')
								? 0
								: 1
							: ((row as any)[col === 'name' ? 'key' : col] ?? '')}
					emptyTitle="No resource packs"
					emptyText="The proxy's pack catalog is empty — add packs on the Resource packs screen."
				>
					{#snippet cell(row, col)}
						{#if col === 'name'}
							<a href="/packs/{encodeURIComponent(row.key)}">{row.key}</a>
							{#if row.name && row.name.toLowerCase() !== row.key}
								<span class="dim">({row.name})</span>
							{/if}
						{:else if col === 'applies'}
							{#if respackHere(row) && row.enabled}
								<StatusBadge state="ok" label="Applies" />
							{:else if respackHere(row)}
								<StatusBadge
									state="stopped"
									label="Would apply"
									detail="the server rules match, but the pack is disabled"
								/>
							{:else}
								<span class="dim">no</span>
							{/if}
						{:else if col === 'state'}
							{#if row.enabled}
								<StatusBadge state="ok" label="Enabled" />
							{:else}
								<StatusBadge state="stopped" label="Disabled" />
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
				Resource packs are served by the proxy: players get every enabled pack whose server rules
				match <b>{name}</b>, stacked by priority.
			</p>
		{:else if tab === 'access'}
			<AccessLists instance={name ?? ''} />
		{:else if tab === 'network'}
			<Panel title="Ports">
				<InfoGrid cells={portCells} />
			</Panel>
			<div class="gap"></div>
			<Panel title="Proxy registration">
				<InfoGrid cells={proxyCells} />
			</Panel>
		{:else if tab === 'logs'}
			<Panel title="latest.log" flush>
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
							label="Follow the log"
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
						title={logFollow ? 'Following — the log re-reads itself' : ''}
						onclick={() => showLogSnapshot()}
					>
						Refresh
					</Btn>
					<Btn icon="code" onclick={() => goto(`/instances/${name}/console`)}>Live console</Btn>
				{/snippet}
				<pre
					class="logview mono"
					bind:this={logEl}
					onscroll={onLogScroll}
				>{logStream ? logStream.join('\n') : logData.content || '(empty)'}</pre>
			</Panel>
			{#if logData.archives.length}
				<div class="gap"></div>
				<Panel title="Archived logs" count={logData.archives.length}>
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
					title="Instance configuration"
					description="Memory, profile and JVM flags apply on the next restart"
				>
					<div class="cfg">
						<label class="field">
							<span class="lbl">Memory (heap)</span>
							<span class="hint">-Xms/-Xmx, e.g. 2G</span>
							<input class="input" bind:value={cfgMemory} />
						</label>
						<div class="field">
							<span class="lbl">Java profile</span>
							<span class="hint">JVM flag set from cluster.json</span>
							<Select
								bind:value={cfgProfile}
								width="100%"
								options={cfgData.profiles.map((entry: string) => ({
									value: entry,
									label: entry
								}))}
							/>
						</div>
						<label class="field">
							<span class="lbl">Extra JVM arguments</span>
							<span class="hint">
								Appended after the profile's flags — see the resolved command on the Details
								tab. Space separated, flags only; -Xmx/-Xms come from the memory field above.
							</span>
							<input class="input mono" bind:value={cfgJavaArgs} placeholder="(none)" />
						</label>
						{#if inst.software === 'paper'}
							<div class="field">
								<span class="lbl">Minecraft version</span>
								<span class="hint">
									Downloads the latest Paper build for the chosen version (instance must be
									stopped). Plugin compatibility is checked first.
								</span>
								<Select
									bind:value={cfgVersion}
									width="100%"
									options={paperVersions.map((version: string) => ({
										value: version,
										label: version
									}))}
								/>
							</div>
						{/if}
						{#if versionConflict.length}
							<Flash kind="error">
								<b>Version change blocked — incompatible plugins:</b><br />
								{#each versionConflict as conflict}
									· {conflict.plugin} {conflict.version} (supports {conflict.gameVersions?.join(
										', '
									)})<br />
								{/each}
								<div class="conflict-actions">
									<Btn variant="danger" onclick={forceVersion}>Force anyway</Btn>
									<Btn onclick={() => (versionConflict = [])}>Cancel</Btn>
								</div>
							</Flash>
						{/if}
						<Btn variant="primary" loading={saving} onclick={saveConfig}>Save changes</Btn>
					</div>
				</Panel>
				{#if versionJob}
					<div class="gap"></div>
					<Panel title="Version change" description="Live from the same reporter the CLI renders">
						<ProgressTree root={versionJob.progress} state={versionJob.state} />
					</Panel>
				{/if}
				<div class="gap"></div>
				<Panel
					title="Addon groups"
					count={groupsDirty ? 'unsaved' : undefined}
					description="Groups applied to this instance (default always is) — saving pushes their plugins, resource pack rules and data packs immediately; a running server loads them on restart"
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
					title="Server settings"
					count={settingEditCount ? `${settingEditCount} unsaved` : undefined}
					description="server.properties, applied on the next restart — Save changes above writes them"
				>
					<SettingsForm
						schema={cfgData.schema}
						groups={cfgData.groups}
						bind:values={cfgSettings}
					/>
				</Panel>
				<div class="gap"></div>
				<Panel
					title="server.properties"
					description="Every key on disk, including the ones with no field above"
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
						searchPlaceholder="Find a property"
						searchWidth="20rem"
						noun="property"
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

	.conflict-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.625rem;
	}
</style>
