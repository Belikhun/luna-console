<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import { fmtBytes, fmtDateTime, fmtDuration } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import BrandLink from '$lib/components/BrandLink.svelte';
	import { ADDON_PROVIDERS } from '$lib/components/addons';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One resource pack in full. The four sections answer the four questions an
	 * operator actually has when a pack misbehaves: is the file right (contents),
	 * can a client fetch it (delivery), who is supposed to get it (backends), and
	 * who actually has it (players + traffic).
	 *
	 * Each section comes from a different place and any of them can be
	 * unavailable; a stopped proxy, an unreadable access log, an older
	 * LunaPackLoader. Unavailable is rendered as unavailable, never as zero.
	 */

	/** How many characters of a digest identify it on screen. */
	const HASH_CHARS = 16;

	/** ms; under this, "3 seconds ago" is noise and the clocks may disagree anyway */
	const JUST_NOW_MS = 5_000;

	const key = $derived(page.params.key);

	let detail: any = $state(null);
	let tab = $state('overview');
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let busy = $state('');

	/**
	 * Reachability is the daemon's stored answer on every load; measuring it is
	 * an outbound request to the public pack host, which is not something a page
	 * tick should trigger. `retest` asks for a fresh measurement; the daemon also
	 * re-measures on its own when the proxy logs a failed load.
	 */
	async function load(retest = false): Promise<void> {
		loading = true;

		try {
			const res = await api(
				`/respacks/${encodeURIComponent(key ?? '')}/detail${retest ? '?retest=1' : ''}`
			);

			detail = res.detail;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.common.loadFailedNamed', { name: key ?? '' }), { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void load();
	});

	/** Re-measure the pack URL now, on the operator's say-so. */
	const retest = () =>
		run('retest', t('web.packDetail.testing', { url: detail?.url ?? key }), async () => {
			await load(true);

			const reach = detail.reachability;

			if (!reach.checked) {
				return reach.problem ?? 'there is nothing to test';
			}

			return reach.ok
				? `HTTP ${reach.status} in ${reach.elapsedMs}ms` +
						(reach.sizeMatches === false ? '; but the served size differs from the zip on disk' : '')
				: (reach.problem ?? `HTTP ${reach.status}`);
		});

	const pack = $derived(detail?.pack);

	/** The pack's headline state, as the header badge. */
	const stateBadge = $derived.by(() => {
		if (!pack) {
			return { state: 'unknown', label: t('web.packDetail.loading'), detail: undefined };
		}

		// a plugin's runtime registration is a registration: the pack is served,
		// there is simply no file of luna's behind it
		if (pack.registration === 'dynamic') {
			return {
				state: pack.enabled ? 'ok' : 'stopped',
				label: pack.enabled ? 'Enabled' : 'Disabled',
				detail:
					"registered by a plugin at runtime; its priority, rules and enablement are the plugin's"
			};
		}

		if (pack.registration === 'unknown') {
			return {
				state: 'unknown',
				label: t('web.packDetail.registrationUnknown'),
				detail:
					'no definition on disk, and the proxy is not answering; a plugin may register it at runtime'
			};
		}

		if (!pack.defFile) {
			return {
				state: 'warning',
				label: t('web.packDetail.unregistered'),
				detail: t('web.packDetail.theZipExistsButNo')
			};
		}

		if (!pack.present) {
			return {
				state: 'failed',
				label: t('web.packDetail.fileMissing'),
				detail: t('web.packDetail.missingFileDetail', { file: pack.filename })
			};
		}

		return pack.enabled
			? { state: 'ok', label: t('web.packDetail.enabled'), detail: undefined }
			: { state: 'stopped', label: t('web.packDetail.disabled'), detail: t('web.packDetail.theProxyDoesNotOffer') };
	});

	/** Run one pack operation behind a loading flash, then reload the view. */
	async function run(label: string, pending: string, fn: () => Promise<string>): Promise<void> {
		busy = label;

		const note = Notify.loading(pending);

		try {
			const message = await fn();

			note.set({ level: 'success', message, closeable: true });

			await load();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.catalog.opFailed', { operation: pending.replace(/…$/, '') }),
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = '';
	}

	/** Send the proxy a reload; the returned text feeds the notification. */
	async function sendReload(): Promise<string> {
		const res = await post('/respacks/reload');

		return res.sent
			? 'Reload sent to the proxy; the change is live.'
			: 'The proxy is not running; the change applies on its next boot.';
	}

	const doReload = () => run('reload', t('web.packs.reloading'), sendReload);

	/**
	 * Ask Modrinth whether this pack has a newer version. A named pack is checked
	 * even with auto-update off, so this works as a deliberate one-off look, and
	 * the answer carries the apply button rather than leaving it on screen.
	 */
	async function checkUpdate(): Promise<void> {
		busy = 'update';

		const note = Notify.loading(t('web.packDetail.checkingUpdates', { key: key ?? '' }));

		try {
			const res = await post('/respacks/update', { names: [key] });
			const update = res.updates[0];

			if (!update) {
				const skip = res.skipped?.find((entry: any) => entry.key === key);

				note.set({
					level: 'success',
					message: skip ? `${key}: ${skip.reason}` : `${key} is up to date`,
					closeable: true
				});
			} else {
				note.set({
					level: 'info',
					message: t('web.packDetail.updateAvailable', { key: key ?? '', from: update.from ?? '?', to: update.to }),
					detail: t('web.packDetail.published', { date: fmtDateTime(Date.parse(update.publishedAt)) }),
					closeable: true,
					actions: [{ label: t('web.packDetail.downloadIt'), run: () => void applyUpdate(update) }]
				});
			}
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not check ${key}`,
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = '';

		await load();
	}

	/** Download the offered update over the pack's zip, then reload the proxy. */
	const applyUpdate = (update: any) =>
		run('update', `Updating ${key} to ${update.to}…`, async () => {
			const res = await post('/respacks/update', { names: [key], apply: true });

			// the zip changed under the same URL, so the stored reachability answer
			// describes a file that is no longer there; measure the new one
			await load(true);

			return `${key} updated (${res.applied.length} file(s)). ${await sendReload()}`;
		});

	/** Serve, or stop serving, this pack on one backend. */
	const setInstance = (instance: string, on: boolean) =>
		run(instance, `${on ? 'Serving' : 'Withholding'} ${key} on ${instance}…`, async () => {
			const res = await post(`/respacks/${encodeURIComponent(key ?? '')}/instances`, {
				instance,
				on
			});

			const conflict = res.groupConflict
				? ` An addon group grants ${instance}; the exclusion overrides it.`
				: '';

			return (
				`${key} ${on ? 'now served on' : 'withheld from'} ${instance} ` +
				`(rules ${res.pack.servers.join(', ')}).${conflict}`
			);
		});

	const packActions: ContextMenuItem[] = $derived.by(() => {
		if (!pack) {
			return [];
		}

		return [
			{
				label: t('web.packDetail.configurePack'),
				icon: 'pen',
				action: () => goto(`/packs/${encodeURIComponent(pack.key)}/configure`)
			},
			{
				label: t('web.packDetail.checkForUpdate'),
				icon: 'download',
				disabled: !pack.remote || !!busy,
				hint: !pack.remote ? 'not identified with a provider' : undefined,
				action: checkUpdate
			},
			{
				label: t('web.packDetail.testReachability'),
				icon: 'rotate',
				disabled: !detail.url || !pack.present || !!busy,
				hint: !detail.url || !pack.present ? 'there is no URL to test' : undefined,
				action: retest
			},
			{
				label: t('web.packDetail.reloadOnProxy'),
				icon: 'rotate',
				action: doReload
			},
			{
				label: t('web.packDetail.manageAddonGroups'),
				icon: 'layerGroup',
				action: () => goto('/addons/groups')
			},
			{
				label: pack.remote ? `Open on ${pack.remote.provider}` : 'Open on provider',
				icon: 'externalLink',
				disabled: !pack.providerUrl,
				hint: !pack.providerUrl ? 'not identified with a provider' : undefined,
				action: () => {
					window.open(pack.providerUrl, '_blank', 'noreferrer');
				}
			},
			{ separator: true },
			{
				label: t('web.packDetail.allResourcePacks'),
				icon: 'image',
				action: () => goto('/packs')
			}
		];
	});

	// -- overview cells -------------------------------------------------------------

	const metaCells: InfoCell[] = $derived.by(() => {
		if (!detail) {
			return [];
		}

		const manifest = detail.manifest;

		return [
			{ label: t('web.packDetail.displayName'), value: pack.name },
			{ label: t('web.packDetail.registryKey'), value: pack.key, style: 'mono' },
			{ label: t('web.packDetail.zipFile'), value: pack.filename, copyable: true, style: 'mono' },
			{ label: t('web.packDetail.sizeOnDisk'), value: pack.present ? fmtBytes(pack.sizeBytes) : null },
			{
				label: t('web.packDetail.unpacked'),
				value: manifest.readable
					? `${fmtBytes(manifest.uncompressedBytes)} in ${manifest.entries} file(s)`
					: null
			},
			{ label: t('web.packDetail.packFormat'), value: manifest.packFormat ?? null },
			{ label: t('web.packDetail.supportedFormats'), value: manifest.supportedFormats ?? null },
			{ label: t('web.packDetail.namespaces'), value: manifest.namespaces.join(', ') || null },
			{ label: t('web.packDetail.modified'), value: detail.modifiedAt ? fmtDateTime(detail.modifiedAt) : null },
			{ id: 'source', label: t('web.packDetail.source') },
			{ label: t('web.packDetail.version'), value: pack.versionNumber ?? null, style: 'mono' },
			{
				label: t('web.packDetail.autoUpdate'),
				value: pack.remote ? `${pack.autoUpdate ? 'on' : 'off'} (${pack.channel ?? 'release'})` : null
			},
			{ id: 'groups', label: t('web.packDetail.addonGroups') },
			{
				label: t('web.packDetail.sha512'),
				value: detail.sha512 ? `${detail.sha512.slice(0, HASH_CHARS)}…` : null,
				style: 'mono',
				help: detail.modifiedSinceInstall
					? 'differs from the version recorded in packs.lock.json; the file was replaced by hand'
					: undefined
			},
			{
				label: t('web.packDetail.description'),
				value: manifest.description ?? null,
				colSpan: 2
			}
		];
	});

	const deliveryCells: InfoCell[] = $derived.by(() => {
		if (!detail) {
			return [];
		}

		const serve = detail.serve;
		const resolved = detail.resolution.resolved;

		return [
			{
				label: t('web.packDetail.baseUrl'),
				value: serve.builtIn ? 'built-in (proxy-local HTTP server)' : serve.baseUrl || null,
				style: 'mono'
			},
			{ id: 'url', label: t('web.packDetail.packUrl') },
			{ id: 'reach', label: t('web.packDetail.reachable'), colSpan: 2 },
			{ id: 'failures', label: t('web.packDetail.failedLoads') },
			{
				label: t('web.packDetail.servedFrom'),
				value: serve.packPath || null,
				style: 'mono',
				help: serve.managedPath
					? undefined
					: 'the proxy reads packs from somewhere other than the directory luna manages'
			},
			{ id: 'resolved', label: t('web.packDetail.onTheProxy'), colSpan: 2 },
			{ label:
				'Proxy sha1',
				value: resolved?.sha1 ? `${resolved.sha1.slice(0, HASH_CHARS)}…` : null,
				style: 'mono',
				colSpan: 2
			},
			{
				label: t('web.packDetail.proxySize'),
				value: resolved?.sizeBytes ? fmtBytes(resolved.sizeBytes) : null
			}
		];
	});

	/**
	 * The provider's own name, as the providers list spells it; "Modrinth", not
	 * the `modrinth` key the lockfile stores. A pack that came from nowhere in
	 * particular says so in the same voice.
	 */
	const sourceLabel = $derived.by(() => {
		if (!pack) {
			return '';
		}

		const provider = ADDON_PROVIDERS.find((entry) => entry.id === pack.source);

		return provider?.label ?? (pack.source === 'manual' ? 'Uploaded by hand' : pack.source);
	});

	/** How the current reachability answer came about, in words. */
	const measured = $derived.by(() => {
		const reach = detail?.reachability;

		if (!reach?.at) {
			return '';
		}

		const elapsed = Math.max(0, Date.now() - reach.at);

		if (elapsed < JUST_NOW_MS) {
			return 'measured just now';
		}

		const age = fmtDuration(elapsed);
		const why =
			reach.trigger === 'failure'
				? ', after a failed load'
				: reach.trigger === 'moved'
					? ', after the URL changed'
					: '';

		return `measured ${age} ago${why}`;
	});

	// -- backends --------------------------------------------------------------------

	const instanceCols: Column[] = $derived([
		{ id: 'name', label: t('web.packDetail.backend'), sortable: true },
		{ id: 'served', label: t('web.packDetail.getsThePack'), width: 170 },
		{ id: 'why', label: t('web.packDetail.why') },
		{ id: 'state', label: t('web.packDetail.instance'), width: 120 }
	]);

	const servedCount = $derived(detail?.instances.filter((row: any) => row.served).length ?? 0);

	/** One backend's verbs, seen from this pack. */
	function instanceActions(row: any): ContextMenuItem[] {
		const locked = row.granted && row.matched;

		return [
			{
				label: row.matched ? `Stop serving on ${row.name}` : `Serve on ${row.name}`,
				icon: row.matched ? 'toggleOff' : 'toggleOn',
				disabled: !!busy || locked,
				hint: locked ? 'an addon group grants this backend; edit the group instead' : undefined,
				action: () => setInstance(row.name, !row.matched)
			},
			{ separator: true },
			{
				label: t('web.packDetail.openInstance'),
				icon: 'server',
				action: () => goto(`/instances/${row.name}?tab=respacks`)
			}
		];
	}

	// -- players ----------------------------------------------------------------------

	const holderCols: Column[] = $derived([
		{ id: 'username', label: t('web.packDetail.player'), sortable: true },
		{ id: 'server', label: t('web.packDetail.onBackend'), sortable: true },
		{ id: 'state', label: t('web.packDetail.thisPack'), width: 150 },
		{ id: 'failure', label: t('web.packDetail.lastFailure') }
	]);

	/** Holders first; the answer to "who has it" should not need scrolling. */
	const holderRows = $derived.by(() => {
		const players = detail?.holders.players ?? [];

		return [...players].sort((left: any, right: any) => {
			const rank = (player: any) => (player.loaded ? 0 : player.pending ? 1 : 2);

			return rank(left) - rank(right) || left.username.localeCompare(right.username);
		});
	});

	// -- traffic ------------------------------------------------------------------------

	const trafficCols: Column[] = $derived([
		{ id: 'at', label: t('web.packDetail.when'), width: 190 },
		{ id: 'ip', label: t('web.packDetail.client'), width: 150 },
		{ id: 'status', label: t('web.packDetail.status'), width: 90 },
		{ id: 'bytes', label: t('web.packDetail.sent'), width: 110, align: 'right' },
		{ id: 'ua', label: t('web.packDetail.userAgent') }
	]);

	/**
	 * Newest first: the recent list is read from the top. The rows carry an
	 * index-derived id because two requests can share a second and a client, and
	 * a duplicate row key is a render error.
	 */
	const trafficRows = $derived(
		(detail?.traffic.recent ?? [])
			.map((row: any, index: number) => ({ ...row, id: `${index}` }))
			.reverse()
	);

	/** Daily download counts as a plot, one point per day in the log window. */
	const dailyPoints = $derived(
		(detail?.traffic.daily ?? []).map((day: any) => ({
			t: Date.parse(`${day.day}T12:00:00`),
			v: day.requests
		}))
	);

	const tabs = $derived([
		{ id: 'overview', label: t('web.packDetail.overview') },
		{ id: 'backends', label: `Backends (${detail?.instances.length ?? 0})` },
		{
			id: 'players',
			label: detail?.holders.available ? `Players (${detail.holders.loaded})` : 'Players'
		},
		{
			id: 'traffic',
			label: detail?.traffic.available ? `Traffic (${detail.traffic.requests})` : 'Traffic'
		}
	]);
</script>

<svelte:head><title>{key} | Luna Console</title></svelte:head>

{#if detail}
	<PageHeader title={pack.key} info>
		{#snippet extra()}
			<span class="crumb dim">{t('web.packDetail.resourcePackOn')} <a href="/packs">{t('web.packDetail.theProxy')}</a></span>
			<StatusBadge state={stateBadge.state} label={stateBadge.label} detail={stateBadge.detail} />
			{#if pack.required}
				<StatusBadge state="warning" label={t('web.packDetail.required')} detail="players cannot decline this pack" />
			{/if}
		{/snippet}
		{#snippet actions()}
			<RefreshControl
				onrefresh={() => load()}
				{lastUpdated}
				{loading}
				storageKey="respack-detail"
			/>
			<Dropdown label={t('web.packDetail.actions')} menu={packActions} />
			<Btn icon="rotate" loading={busy === 'reload'} disabled={!!busy} onclick={doReload}>
				{t('web.packDetail.reloadOnProxy')}
			</Btn>
			<Btn
				variant="primary"
				icon="pen"
				onclick={() => goto(`/packs/${encodeURIComponent(pack.key)}/configure`)}
			>
				Configure
			</Btn>
		{/snippet}
	</PageHeader>

	<OverviewBar>
		<OverviewCell label={t('web.packDetail.backendsServed')}>
			{servedCount} of {detail.instances.length}
			<span class="dim">· priority {pack.priority}</span>
		</OverviewCell>
		<OverviewCell label={t('web.packDetail.size')}>
			{pack.present ? fmtBytes(pack.sizeBytes) : '—'}
			{#if detail.manifest.readable}
				<span class="dim">· {detail.manifest.entries} files</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.packDetail.reachable')}>
			{#if detail.reachability.ok}
				<StatusBadge
					state="ok"
					label="HTTP {detail.reachability.status}"
					detail="{detail.reachability.elapsedMs}ms · {detail.reachability.sizeMatches === false
						? 'the served size differs from the zip on disk'
						: 'the served size matches the zip on disk'}"
				/>
			{:else if detail.reachability.checked}
				<StatusBadge
					state="failed"
					label={detail.reachability.status ? `HTTP ${detail.reachability.status}` : 'Unreachable'}
					detail={detail.reachability.problem}
				/>
			{:else}
				<StatusBadge state="unknown" label={t('web.packDetail.notChecked')} detail={detail.reachability.problem} />
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.packDetail.holdingItNow')}>
			{#if detail.holders.available}
				{detail.holders.loaded} of {detail.holders.online}
				<span class="dim">{t('web.packDetail.online')}</span>
			{:else}
				<StatusBadge state="unknown" label={t('web.packDetail.unavailable')} detail={detail.holders.problem} />
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.packDetail.downloads')}>
			{#if detail.traffic.available}
				{detail.traffic.requests}
				<span class="dim">· {fmtBytes(detail.traffic.bytes)}</span>
			{:else}
				<StatusBadge state="unknown" label={t('web.packDetail.unavailable')} detail={detail.traffic.problem} />
			{/if}
		</OverviewCell>
	</OverviewBar>

	<Tabs {tabs} bind:active={tab} />

	<div class="tabbody">
		{#if tab === 'overview'}
			<div class="stack">
				<Panel title={t('web.packDetail.pack')} description={t('web.packDetail.whatTheZipIsAnd')}>
					<div class="withicon">
						{#if detail.manifest.icon}
							<img class="icon" src={detail.manifest.icon} alt="{pack.key} pack icon" />
						{/if}
						<div class="iconside">
							<InfoGrid cells={metaCells}>
								{#snippet custom(cell)}
									{#if cell.id === 'source'}
										<BrandLink
											source={pack.source}
											href={pack.providerUrl}
											label={sourceLabel}
										/>
									{:else if cell.id === 'groups'}
										{#if pack.groups.length}
											{#each pack.groups as group, index (group)}
												{#if index > 0}<span class="dim">, </span>{/if}
												<a href="/addons/groups/{group}">{group}</a>
											{/each}
										{:else}
											<span class="dim">—</span>
										{/if}
									{/if}
								{/snippet}
							</InfoGrid>
						</div>
					</div>
					{#if detail.manifest.problem}
						<p class="warnnote">
							<Icon name="triangleExclamation" size="0.875rem" />
							{detail.manifest.problem}
						</p>
					{/if}
				</Panel>

				<Panel title={t('web.packDetail.delivery')} description={t('web.packDetail.whereClientsFetchThePack')}>
					<InfoGrid cells={deliveryCells}>
						{#snippet custom(cell)}
							{#if cell.id === 'url'}
								{#if detail.url}
									<a class="mono" href={detail.url} target="_blank" rel="noreferrer">
										{detail.url}
									</a>
									<Icon name="externalLink" size="0.625rem" />
								{:else}
									<span class="dim">{detail.serve.problem ?? '—'}</span>
								{/if}
							{:else if cell.id === 'reach'}
								<span class="reach">
									{#if detail.reachability.ok}
										<StatusBadge
											state="ok"
											label="HTTP {detail.reachability.status} in {detail.reachability.elapsedMs}ms"
										/>
										{#if detail.reachability.sizeMatches === false}
											<StatusBadge
												state="warning"
												label={t('web.packDetail.sizeDiffers')}
												detail="the URL serves {fmtBytes(
													detail.reachability.contentLength ?? 0
												)}, the zip on disk is {fmtBytes(
													pack.sizeBytes
												)}; the published copy is stale"
											/>
										{/if}
									{:else if detail.reachability.checked}
										<StatusBadge
											state="failed"
											label={detail.reachability.status
												? `HTTP ${detail.reachability.status}`
												: 'Unreachable'}
											detail={detail.reachability.problem}
										/>
									{:else}
										<StatusBadge
											state="unknown"
											label={t('web.packDetail.notTestable')}
											detail={detail.reachability.problem}
										/>
									{/if}
									{#if measured}
										<span class="dim when">{measured}</span>
									{/if}
									<Btn
										icon="rotate"
										loading={busy === 'retest'}
										disabled={!!busy || !detail.url || !pack.present}
										title={!detail.url || !pack.present
											? 'there is no URL to test'
											: 'Measure the pack URL again now'}
										onclick={retest}
									>
										Test
									</Btn>
								</span>
							{:else if cell.id === 'failures'}
								{#if !detail.failures.available}
									<span class="dim">{detail.failures.problem}</span>
								{:else if !detail.failures.failures.length}
									<span class="dim">{t('web.packDetail.noneInTheLive')}</span>
								{:else}
									{@const last = detail.failures.failures.at(-1)}
									<StatusBadge
										state="warning"
										label="{detail.failures.failures.length} recent"
										detail={detail.failures.failures
											.slice()
											.reverse()
											.map(
												(entry: any) =>
													`${fmtDateTime(entry.at)}; ${entry.player}: ${entry.status}`
											)}
									/>
									<span class="dim">last {last.player}: {last.status}</span>
								{/if}
							{:else if cell.id === 'resolved'}
								{#if !detail.resolution.available}
									<StatusBadge
										state="unknown"
										label={t('web.packDetail.unavailable')}
										detail={detail.resolution.problem}
									/>
								{:else if !detail.resolution.resolved}
									<StatusBadge
										state="warning"
										label={t('web.packDetail.notInTheRunningCatalog')}
										detail="the proxy has not loaded this definition; reload it"
									/>
								{:else if detail.resolution.resolved.available}
									<StatusBadge state="ok" label={t('web.packDetail.resolvedAndServing')} />
								{:else}
									<StatusBadge
										state="failed"
										label={t('web.packDetail.resolvedUnavailable')}
										detail={detail.resolution.resolved.unavailableReason}
									/>
								{/if}
							{/if}
						{/snippet}
					</InfoGrid>
					<p class="dim note">
						{t('web.packDetail.reachabilityIsMeasuredOnce')}
					</p>
					{#if detail.resolution.report}
						<p class="dim note">
							The proxy's catalog: {detail.resolution.report.resolvedAvailable} available of
							{detail.resolution.report.validDefinitions} valid definition(s)
							{#if detail.resolution.report.invalidDefinitions}
								· {detail.resolution.report.invalidDefinitions} invalid
							{/if}
							{#if detail.resolution.report.resolvedMissingFiles}
								· {detail.resolution.report.resolvedMissingFiles} missing file(s)
							{/if}
						</p>
					{/if}
				</Panel>
			</div>
		{:else if tab === 'backends'}
			<Panel
				title={t('web.packDetail.backends')}
				count={detail.instances.length}
				description={t('web.packDetail.whoTheServerRulesReach')}
				flush
			>
				<DataTable
					columns={instanceCols}
					rows={detail.instances}
					getId={(row) => row.name}
					rowActions={instanceActions}
					rowLabel={(row) => row.name}
					rowDim={(row) => !row.served}
				>
					{#snippet cell(row, col)}
						{#if col === 'name'}
							<a href="/instances/{row.name}?tab=respacks">{row.name}</a>
						{:else if col === 'served'}
							{#if row.served}
								<StatusBadge state="ok" label={t('web.packDetail.yes')} />
							{:else if row.matched}
								<StatusBadge
									state="stopped"
									label={t('web.packDetail.wouldIfEnabled')}
									detail="the rules match this backend, but the pack itself is disabled"
								/>
							{:else}
								<span class="dim">{t('web.packDetail.no')}</span>
							{/if}
						{:else if col === 'why'}
							{#if row.granted}
								<span class="dim">{t('web.packDetail.grantedByAnAddon')}</span>
							{:else if row.matched}
								<span class="mono">{pack.servers.join(', ')}</span>
							{:else}
								<span class="dim">{t('web.packDetail.noRuleMatches')}</span>
							{/if}
						{:else if col === 'state'}
							<StatusBadge
								state={row.running ? 'running' : 'stopped'}
								label={row.running ? 'Running' : 'Stopped'}
							/>
						{/if}
					{/snippet}
				</DataTable>
			</Panel>
			<p class="dim note">
				{t('web.packDetail.aRuleChangeReaches')}
			</p>
		{:else if tab === 'players'}
			{#if !detail.holders.available}
				<Panel title={t('web.packDetail.players')}>
					<p class="dim empty">{detail.holders.problem}</p>
				</Panel>
			{:else}
				<Panel
					title={t('web.packDetail.playersOnline')}
					count={detail.holders.online}
					description={t('web.packDetail.whatEachConnectedPlayerS')}
					flush
				>
					<DataTable
						columns={holderCols}
						rows={holderRows}
						getId={(row) => row.uuid}
						rowDim={(row) => !row.loaded && !row.pending}
					>
						{#snippet cell(row, col)}
							{#if col === 'username'}
								<a href="/players?q={encodeURIComponent(row.username)}">{row.username}</a>
							{:else if col === 'server'}
								{#if row.server}
									<a href="/instances/{row.server}">{row.server}</a>
								{:else}
									<span class="dim">—</span>
								{/if}
							{:else if col === 'state'}
								{#if row.loaded}
									<StatusBadge state="ok" label={t('web.packDetail.loaded')} />
								{:else if row.pending}
									<StatusBadge
										state="pending"
										label={t('web.packDetail.sent')}
										detail="the client was offered the pack and has not answered yet"
									/>
								{:else}
									<span class="dim">{t('web.packDetail.notLoaded')}</span>
								{/if}
							{:else if col === 'failure'}
								{#if row.lastFailure}
									<span class="fail">{row.lastFailure}</span>
								{:else}
									<span class="dim">—</span>
								{/if}
							{/if}
						{/snippet}
					</DataTable>
				</Panel>
			{/if}
		{:else if tab === 'traffic'}
			{#if !detail.traffic.available}
				<Panel title={t('web.packDetail.traffic')}>
					<p class="dim empty">{detail.traffic.problem}</p>
				</Panel>
			{:else}
				<Panel
					title={t('web.packDetail.downloads')}
					description={t('web.packDetail.getRequestsForThisPack')}
				>
					<div class="stats">
						<div class="stat">
							<span class="sv">{detail.traffic.requests}</span>
							<span class="sl dim">{t('web.packDetail.downloads')}</span>
						</div>
						<div class="stat">
							<span class="sv">{fmtBytes(detail.traffic.bytes)}</span>
							<span class="sl dim">{t('web.packDetail.served')}</span>
						</div>
						<div class="stat">
							<span class="sv">{detail.traffic.uniqueClients}</span>
							<span class="sl dim">{t('web.packDetail.distinctClients')}</span>
						</div>
						<div class="stat">
							<span class="sv">{detail.traffic.completed}</span>
							<span class="sl dim">{t('web.packDetail.completed')}</span>
						</div>
						{#if detail.traffic.missing}
							<div class="stat">
								<span class="sv bad">{detail.traffic.missing}</span>
								<span class="sl dim">404s</span>
							</div>
						{/if}
						<div class="stat">
							<span class="sv">
								{detail.traffic.lastAt ? fmtDateTime(detail.traffic.lastAt) : '—'}
							</span>
							<span class="sl dim">{t('web.packDetail.lastDownload')}</span>
						</div>
					</div>

					{#if dailyPoints.length > 1}
						<Sparkline points={dailyPoints} label={t('web.packDetail.downloadsPerDay')} />
					{/if}

					<p class="dim note">
						Read from {detail.traffic.sources.length} log file(s){#if detail.traffic.windowFrom}, covering
							{fmtDateTime(detail.traffic.windowFrom)} to {fmtDateTime(
								detail.traffic.windowTo
							)}{/if}. Clients cache packs by hash, so a quiet log means players already have
						{t('web.packDetail.thisOneNotThat')}
					</p>
				</Panel>

				<div class="gap"></div>

				<Panel title={t('web.packDetail.recentRequests')} count={trafficRows.length} flush>
					<DataTable columns={trafficCols} rows={trafficRows} getId={(row) => row.id}>
						{#snippet cell(row, col)}
							{#if col === 'at'}
								{fmtDateTime(row.at)}
							{:else if col === 'ip'}
								<span class="mono">{row.ip}</span>
							{:else if col === 'status'}
								<span class:bad={row.status >= 400}>{row.status}</span>
							{:else if col === 'bytes'}
								{fmtBytes(row.bytes)}
							{:else if col === 'ua'}
								<span class="ua dim">{row.userAgent || '—'}</span>
							{/if}
						{/snippet}
					</DataTable>
				</Panel>
			{/if}
		{/if}
	</div>
{/if}

<style lang="scss">
	.crumb {
		font-size: 0.875rem;
		font-weight: 400;
	}

	// the provider mark, its name and the external-link cue read as one link
	// badge + when it was measured + the Test button, on one baseline
	.reach {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.when {
		font-size: 0.75rem;
	}

	.tabbody {
		margin-top: 1rem;
	}

	.gap {
		height: 1rem;
	}

	// the two overview panels sit side by side where there is room, and stack
	// before either one has to squeeze its info grid into one column
	// one panel per row: side by side, each one's info grid had to fold its
	// columns to fit, which is what made "Namespaces" wrap into a stack
	.stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.withicon {
		display: flex;
		gap: 1rem;
		align-items: flex-start;
	}

	// pack.png is 128px art; rendering it larger than its own resolution only
	// blurs it, and image-rendering keeps the pixel edges where it is scaled
	.icon {
		width: 4rem;
		height: 4rem;
		flex: none;
		border-radius: var(--radius-input);
		image-rendering: pixelated;
		background: var(--bg-terminal);
	}

	.iconside {
		flex: 1;
		min-width: 0;
	}

	.warnnote {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.75rem 0 0;
		font-size: 0.8125rem;
		color: var(--warning);
	}

	.note {
		margin: 0.75rem 0 0;
		font-size: 0.8125rem;
	}

	.empty {
		margin: 0;
	}

	.stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem 2rem;
		margin-bottom: 1rem;
	}

	.stat {
		display: flex;
		flex-direction: column;
	}

	.sv {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--text-heading);
		font-variant-numeric: tabular-nums;

		&.bad {
			color: var(--error);
		}
	}

	.sl {
		font-size: 0.75rem;
	}

	.bad {
		color: var(--error);
	}

	.fail {
		color: var(--warning);
	}

	.ua {
		font-size: 0.75rem;
		@include ellipsis;
	}
</style>
