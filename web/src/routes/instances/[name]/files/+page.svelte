<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { api, post, put } from '$lib/api';
	import { followJob } from '$lib/jobs';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import type { EditorSelection } from '$lib/components/codeeditor';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * The instance file browser and config editor.
	 *
	 * A file is either plain; luna edits the bytes on disk and remembers nothing -
	 * or **managed**, in which case what this page edits is the *template*, and the
	 * file inside the instance is rendered from it on every start. Selecting a
	 * literal and naming it turns it into a `${VAR}` placeholder, which is what
	 * takes the file under management in the first place.
	 */

	const name = $derived(page.params.name!);

	interface DirEntry {
		name: string;
		path: string;
		kind: 'dir' | 'file';
		size: number;
		modified: number;
		editable: boolean;
		managed: boolean;
		drifted: boolean;
		noise: boolean;
	}

	interface FileContent {
		path: string;
		text: string;
		size: number;
		modified: number;
		managed: boolean;
		template?: string;
		drifted: boolean;
		placeholders: string[];
		missing: string[];
		description?: string;
	}

	let cwd = $state('');
	let entries: DirEntry[] = $state([]);
	let browsing = $state(false);
	let lastUpdated: number | null = $state(null);

	let current = $state<FileContent | null>(null);
	/** The editor's buffer; the template for a managed file, else the disk text */
	let buffer = $state('');
	/** What was loaded, so "unsaved" is a comparison rather than a flag to maintain */
	let pristine = $state('');
	let loadingFile = $state(false);
	let saving = $state(false);
	/** Show the rendered result instead of the template (managed files only) */
	let preview = $state(false);
	let renderedPreview = $state('');

	let selection: EditorSelection = $state({ text: '', line: 1, offset: 0 });
	let editorRef: CodeEditor | undefined = $state();

	let machines: Array<{ key: string; name: string; primary: boolean }> = $state([]);
	let resolved: Array<{ name: string; value: string; scope: string; secret: boolean }> = $state([]);

	let phOpen = $state(false);
	let phName = $state('');
	let phValue = $state('');
	let phScope = $state('global');
	let phMachine = $state('');
	let phAll = $state(true);
	let phSecret = $state(false);
	let phDescription = $state('');
	let phSaving = $state(false);

	const dirty = $derived(!!current && buffer !== pristine);
	const editingTemplate = $derived(!!current?.managed);

	/** Breadcrumb segments of the current directory, each with the path to reach it. */
	const crumbs = $derived.by(() => {
		const parts = cwd ? cwd.split('/') : [];
		const out: Array<{ label: string; path: string }> = [{ label: name, path: '' }];

		parts.forEach((part, index) => {
			out.push({ label: part, path: parts.slice(0, index + 1).join('/') });
		});

		return out;
	});

	async function browse(path: string): Promise<void> {
		browsing = true;

		try {
			const data = await api(`/instances/${name}/files?path=${encodeURIComponent(path)}`);

			cwd = data.path;
			entries = data.entries;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error('Could not list that directory', { detail: (err as Error).message });
		} finally {
			browsing = false;
		}
	}

	async function openFile(entry: DirEntry): Promise<void> {
		if (dirty && !confirm(`Discard unsaved changes to ${current?.path}?`)) {
			return;
		}

		loadingFile = true;
		preview = false;

		try {
			const data: FileContent = await api(
				`/instances/${name}/files?read=1&path=${encodeURIComponent(entry.path)}`
			);

			current = data;
			buffer = data.template ?? data.text;
			pristine = buffer;
			selection = { text: '', line: 1, offset: 0 };
		} catch (err) {
			Notify.error(`Could not open ${entry.name}`, { detail: (err as Error).message });
		} finally {
			loadingFile = false;
		}
	}

	async function save(): Promise<void> {
		if (!current || !dirty) {
			return;
		}

		saving = true;

		try {
			const result = await put(`/instances/${name}/files`, { path: current.path, text: buffer });

			pristine = buffer;
			Notify.success(`${current.path} saved`, {
				detail: result.managed
					? 'Template saved and rendered into the instance.'
					: 'Written to the instance directory.'
			});

			// the render may have changed placeholders/drift state
			await reopen();
			await browse(cwd);
		} catch (err) {
			Notify.error(`Could not save ${current.path}`, { detail: (err as Error).message });
		} finally {
			saving = false;
		}
	}

	/** Re-read the current file, keeping unsaved work out of the way. */
	async function reopen(): Promise<void> {
		if (!current) {
			return;
		}

		const data: FileContent = await api(
			`/instances/${name}/files?read=1&path=${encodeURIComponent(current.path)}`
		);

		current = data;

		if (!dirty) {
			buffer = data.template ?? data.text;
			pristine = buffer;
		}
	}

	/** One of the management actions on the current file. */
	async function manage(action: string, extra: Record<string, unknown> = {}): Promise<void> {
		if (!current) {
			return;
		}

		try {
			const result = await post(`/instances/${name}/files/manage`, {
				action,
				path: current.path,
				...extra
			});

			if (action === 'readopt') {
				Notify.success(`${current.path} re-adopted from disk`, {
					detail: result.kept?.length
						? `Placeholders kept: ${result.kept.join(', ')}`
						: 'No placeholder values matched; the template is now literal.'
				});
			} else {
				Notify.success(`${current.path}: ${action}`);
			}

			await reopen();
			await browse(cwd);
		} catch (err) {
			Notify.error(`Could not ${action} ${current.path}`, { detail: (err as Error).message });
		}
	}

	/** Re-render every managed file of this instance, following the job. */
	async function renderAll(): Promise<void> {
		const note = Notify.loading('Rendering managed config files…');

		try {
			const { job } = await post(`/instances/${name}/files/manage`, { action: 'render' });
			const finished = await followJob(job.id, () => {});
			const results = (finished.result as { results: Array<{ outcome: string }> })?.results ?? [];
			const changed = results.filter((entry) => entry.outcome !== 'unchanged').length;

			note.set({
				level: 'success',
				message: changed ? `${changed} file(s) re-rendered` : 'Every managed file already up to date',
				detail: `${results.length} managed file(s) checked.`,
				closeable: true
			});

			await reopen();
			await browse(cwd);
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.instanceFiles.renderingFailed'),
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	/** Open the placeholder dialog, seeded from whatever is selected. */
	function startPlaceholder(): void {
		phValue = selection.text.trim();
		phName = suggestName(phValue);
		phScope = 'global';
		phMachine = machines.find((machine) => !machine.primary)?.name ?? '';
		phAll = true;
		phSecret = false;
		phDescription = '';
		phOpen = true;
	}

	/**
	 * A first guess at a variable name from the selected text's *key*, not its
	 * value; the line `host: 10.0.0.10` should suggest `HOST`, and a bare IP
	 * suggests nothing worth typing over.
	 */
	function suggestName(value: string): string {
		const line = buffer.split('\n')[selection.line - 1] ?? '';
		const key = /^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[:=]/.exec(line);

		if (!key) {
			return '';
		}

		return key[1]!
			.replace(/[.-]/g, '_')
			.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
			.toUpperCase();
	}

	async function createPlaceholder(): Promise<void> {
		if (!current) {
			return;
		}

		phSaving = true;

		try {
			const result = await post(`/instances/${name}/files/manage`, {
				action: 'placeholder',
				path: current.path,
				name: phName,
				value: phValue,
				// the exact occurrence the user highlighted, unless they asked for all
				at: phAll ? undefined : selection.offset,
				all: phAll,
				secret: phSecret,
				description: phDescription,
				scope: phScope === 'instance' ? 'instance' : undefined,
				machine: phScope === 'machine' ? phMachine : undefined
			});

			Notify.success(`\${${result.name}} created`, {
				detail:
					`${result.replaced} occurrence(s) in ${result.path} now read the variable ` +
					`(${result.scope} scope). ` +
					(result.changedFile
						? 'The rendered file differs from what was there and was rewritten.'
						: 'The file on disk is unchanged.')
			});

			phOpen = false;

			// the file is managed now and the buffer must become the template
			const data: FileContent = await api(
				`/instances/${name}/files?read=1&path=${encodeURIComponent(current.path)}`
			);

			current = data;
			buffer = data.template ?? data.text;
			pristine = buffer;

			await Promise.all([browse(cwd), loadEnv()]);
		} catch (err) {
			Notify.error('Could not create the placeholder', { detail: (err as Error).message });
		} finally {
			phSaving = false;
		}
	}

	async function loadEnv(): Promise<void> {
		try {
			const data = await api(`/instances/${name}/env`);

			resolved = data.variables;
		} catch {
			// the panel just stays as it was; the editor is the point of this page
		}
	}

	/** Ask the server what the template renders to, without saving it. */
	async function togglePreview(): Promise<void> {
		if (preview) {
			preview = false;

			return;
		}

		// substitution is the same one the daemon does; doing it here keeps the
		// preview instant and needs no round trip for a value the page already has
		renderedPreview = buffer.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (token, varName: string) => {
			const found = resolved.find((entry) => entry.name === varName);

			if (!found) {
				return token;
			}

			return found.secret ? '••••••••' : found.value;
		});

		preview = true;
	}

	function fmtSize(bytes: number): string {
		if (bytes < 1024) {
			return `${bytes} B`;
		}

		if (bytes < 1024 * 1024) {
			return `${(bytes / 1024).toFixed(1)} KB`;
		}

		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	const fileActions: ContextMenuItem[] = $derived(
		!current
			? []
			: [
					{
						label: t('web.instanceFiles.createPlaceholderFromSelection'),
						icon: 'key',
						disabled: !selection.text.trim(),
						action: startPlaceholder
					},
					{
						label: current.managed ? 'Stop managing this file' : 'Manage as a template',
						icon: current.managed ? 'linkSlash' : 'link',
						action: () => manage(current!.managed ? 'unmanage' : 'manage')
					},
					{
						label: t('web.instanceFiles.reAdoptFromDisk'),
						icon: 'arrowDown',
						disabled: !current.managed,
						action: () => manage('readopt')
					},
					{ separator: true },
					{
						label: t('web.instanceFiles.discardDriftCopy'),
						icon: 'trash',
						disabled: !current.drifted,
						action: () => manage('discard-drift')
					}
				]
	);

	onMount(() => {
		void browse('');
		void loadEnv();

		void api('/env').then((data) => {
			machines = data.machines ?? [];
		});
	});

	/** Ctrl+S saves from anywhere on the page, not only inside the editor. */
	function onKeydown(event: KeyboardEvent): void {
		if ((event.ctrlKey || event.metaKey) && event.key === 's') {
			event.preventDefault();
			void save();
		}
	}
</script>

<svelte:head><title>{name} files | Luna Console</title></svelte:head>
<svelte:window onkeydown={onKeydown} />

<PageHeader
	title={t('web.instanceFiles.configFiles')}
	description="Browse {name}'s directory and edit its configuration; a managed file is rendered from its template on every start."
	info
>
	{#snippet extra()}
		{#if current?.managed}
			<StatusBadge state="ok" label={t('web.instanceFiles.managed')} />
		{/if}
		{#if current?.drifted}
			<StatusBadge
				state="warning"
				label={t('web.instanceFiles.drifted')}
				detail="This file was changed outside luna. The next start renders the template over it, keeping the current text as a .luna-drift copy."
			/>
		{/if}
	{/snippet}
	{#snippet actions()}
		<RefreshControl
			onrefresh={() => browse(cwd)}
			{lastUpdated}
			loading={browsing}
			storageKey="instance-files"
		/>
		<Dropdown label={t('web.instanceFiles.file')} disabled={!current} menu={fileActions} />
		<Btn icon="rotate" onclick={renderAll}>{t('web.instanceFiles.renderManagedFiles')}</Btn>
		<Btn variant="primary" icon="floppyDisk" loading={saving} disabled={!dirty} onclick={save}>
			Save
		</Btn>
	{/snippet}
</PageHeader>

<div class="split">
	<Panel title={t('web.instanceFiles.directory')} flush fill>
		<div class="crumbs">
			{#each crumbs as crumb, index (crumb.path)}
				{#if index > 0}<span class="sep dim">/</span>{/if}
				<button class="crumb" onclick={() => browse(crumb.path)}>{crumb.label}</button>
			{/each}
		</div>
		<div class="tree">
			{#if cwd}
				<button class="row up" onclick={() => browse(cwd.split('/').slice(0, -1).join('/'))}>
					<Icon name="arrowUp" size="0.75rem" style="solid" />
					<span class="dim">{t('web.instanceFiles.upOneLevel')}</span>
				</button>
			{/if}
			{#each entries as entry (entry.path)}
				<button
					class="row"
					class:active={current?.path === entry.path}
					class:dimmed={entry.noise || (entry.kind === 'file' && !entry.editable)}
					onclick={() => (entry.kind === 'dir' ? browse(entry.path) : openFile(entry))}
					disabled={entry.kind === 'file' && !entry.editable}
					title={entry.kind === 'file' && !entry.editable
						? 'not a text file, or larger than the 512 KB editing cap'
						: entry.path}
				>
					<Icon
						name={entry.kind === 'dir' ? 'folder' : entry.managed ? 'fileCode' : 'file'}
						size="0.75rem"
						style={entry.managed ? 'solid' : 'light'}
					/>
					<span class="nm">{entry.name}</span>
					{#if entry.managed}
						<span class="tag managed" title={t('web.instanceFiles.renderedFromATemplateOn')}>T</span>
					{/if}
					{#if entry.drifted}
						<span class="tag drift" title={t('web.instanceFiles.changedOutsideLuna')}>!</span>
					{/if}
					<span class="sz dim">{entry.kind === 'dir' ? '' : fmtSize(entry.size)}</span>
				</button>
			{/each}
			{#if !entries.length && !browsing}
				<p class="empty dim">{t('web.instanceFiles.thisDirectoryIsEmpty')}</p>
			{/if}
		</div>
	</Panel>

	<div class="editor">
		{#if !current}
			<Panel fill>
				<div class="nothing">
					<Icon name="fileCode" size="1.5rem" style="light" />
					<h3>{t('web.instanceFiles.pickAFileTo')}</h3>
					<p class="dim">
						{t('web.instanceFiles.configFilesPropertiesAnd')}
					</p>
				</div>
			</Panel>
		{:else}
			<Panel flush fill>
				<div class="ebar">
					<div class="left">
						<span class="mono">{current.path}</span>
						{#if editingTemplate}
							<span class="tag managed">{t('web.instanceFiles.template')}</span>
						{/if}
						{#if dirty}
							<span class="tag drift">{t('web.instanceFiles.unsaved')}</span>
						{/if}
					</div>
					<div class="right">
						{#if editingTemplate}
							<Btn
								icon={preview ? 'penToSquare' : 'eye'}
								onclick={togglePreview}
								title={preview ? 'Back to the template' : 'Preview the rendered file'}
							>
								{preview ? 'Edit template' : 'Preview render'}
							</Btn>
						{/if}
						<Btn
							icon="key"
							disabled={!selection.text.trim()}
							title={selection.text.trim()
								? 'Turn the selected value into an environment placeholder'
								: 'Select a value in the editor first'}
							onclick={startPlaceholder}
						>
							Placeholder
						</Btn>
					</div>
				</div>

				{#if current.missing.length}
					<div class="banner err">
						Undefined variable(s): <b>{current.missing.join(', ')}</b>; luna refuses to render this
						{t('web.instanceFiles.fileUntilTheyExist')}
					</div>
				{/if}

				{#if preview}
					<CodeEditor value={renderedPreview} path={current.path} readOnly height="100%" />
				{:else}
					<CodeEditor
						bind:this={editorRef}
						bind:value={buffer}
						path={current.path}
						readOnly={loadingFile}
						height="100%"
						onselect={(next) => (selection = next)}
						onsave={save}
					/>
				{/if}
			</Panel>

			{#if current.placeholders.length}
				<div class="gap"></div>
				<Panel
					title={t('web.instanceFiles.placeholdersInThisFile')}
					count={current.placeholders.length}
					description={t('web.instanceFiles.valuesLunaSubstitutesWhenIt')}
				>
					<div class="phs">
						{#each current.placeholders as placeholder (placeholder)}
							{@const found = resolved.find((entry) => entry.name === placeholder)}
							<div class="ph">
								<span class="mono nm">${'{'}{placeholder}{'}'}</span>
								{#if !found}
									<StatusBadge state="failed" label={t('web.instanceFiles.undefined')} />
								{:else}
									<span class="mono val">{found.secret ? '••••••••' : found.value}</span>
									<span class="scope dim">{found.scope}</span>
								{/if}
							</div>
						{/each}
					</div>
				</Panel>
			{/if}
		{/if}
	</div>
</div>

<Modal title={t('web.instanceFiles.createAPlaceholder')} bind:open={phOpen}>
	<p class="intro dim">
		The literal below is replaced by <span class="mono">${'{'}NAME{'}'}</span> in the template, and
		{t('web.instanceFiles.theValueMovesInto')}
	</p>
	<label class="field">
		<span class="lbl">{t('web.instanceFiles.variableName')}</span>
		<span class="hint">{t('web.instanceFiles.allUppercaseWithUnderscores')}</span>
		<input class="input mono" bind:value={phName} placeholder={t('web.instanceFiles.dbPassword')} />
	</label>
	<label class="field">
		<span class="lbl">{t('web.instanceFiles.valueItReplaces')}</span>
		<input class="input mono" bind:value={phValue} />
	</label>
	<div class="field">
		<span class="lbl">{t('web.instanceFiles.scope')}</span>
		<span class="hint">{t('web.instanceFiles.aNarrowerScopeOverrides')}</span>
		<Select
			bind:value={phScope}
			width="100%"
			options={[
				{ value: 'global', label: t('web.instanceFiles.globalEveryInstanceInThe') },
				{ value: 'machine', label: t('web.instanceFiles.machineEveryInstanceOnOne') },
				{ value: 'instance', label: `Instance; ${name} only` }
			]}
		/>
	</div>
	{#if phScope === 'machine'}
		<div class="field">
			<span class="lbl">{t('web.instanceFiles.machine')}</span>
			<Select
				bind:value={phMachine}
				width="100%"
				options={machines.map((machine) => ({
					value: machine.name,
					label: machine.primary ? `${machine.name} (primary)` : machine.name
				}))}
			/>
		</div>
	{/if}
	<label class="field">
		<span class="lbl">{t('web.instanceFiles.description')}</span>
		<input class="input" bind:value={phDescription} placeholder={t('web.instanceFiles.whatReadsThis')} />
	</label>
	<label class="check">
		<Checkbox checked={phAll} label={t('web.instanceFiles.replaceAll')} onchange={(on) => (phAll = on)} />
		{t('web.instanceFiles.replaceEveryOccurrenceIn')}
	</label>
	<label class="check">
		<Checkbox checked={phSecret} label={t('web.instanceFiles.secret')} onchange={(on) => (phSecret = on)} />
		{t('web.instanceFiles.secretMaskTheValue')}
	</label>
	{#snippet footer()}
		<Btn onclick={() => (phOpen = false)}>{t('web.instanceFiles.cancel')}</Btn>
		<Btn
			variant="primary"
			loading={phSaving}
			disabled={!phName || !phValue || (phScope === 'machine' && !phMachine)}
			onclick={createPlaceholder}
		>
			{t('web.instanceFiles.createPlaceholder')}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.split {
		display: grid;
		grid-template-columns: 17rem minmax(0, 1fr);
		gap: 0.75rem;
		align-items: stretch;

		// fills the viewport below the page chrome (top nav, breadcrumbs, page header)
		// and above the layout's bottom padding; measured, not guessed.
		// --split-bottom is the terminal drawer's own height, so opening the drawer
		// shortens this rather than covering the editor.
		height: calc(100vh - 13.75rem - var(--split-bottom));
		min-height: 24rem;

		// stacked, each half needs a height of its own again; a taller wrapped header
		// here just means the page scrolls, which on a narrow screen is expected
		@include below($bp-medium) {
			grid-template-columns: 1fr;
			grid-template-rows: 14rem minmax(0, 1fr);
		}
	}

	.crumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;

		flex-shrink: 0;
		padding: 0.375rem 0.625rem;
		border-bottom: 0.1rem solid var(--border-divider);
		font-size: 0.75rem;
	}

	.crumb {
		@include bare-button;

		color: var(--link);

		&:hover {
			text-decoration: underline;
		}
	}

	.tree {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.row {
		@include bare-button;

		display: flex;
		align-items: center;
		gap: 0.375rem;

		width: 100%;
		padding: 0.25rem 0.625rem;
		text-align: left;
		font-size: 0.75rem;
		color: var(--text);

		&:hover:not(:disabled) {
			background: var(--bg-hover);
		}

		&.active {
			background: var(--bg-selected);
		}

		// a non-text or oversized file is still listed; it just cannot be opened
		&.dimmed {
			color: var(--text-disabled);
		}

		&:disabled {
			cursor: default;
		}
	}

	.up {
		border-bottom: 0.1rem solid var(--border-divider);
	}

	.nm {
		@include ellipsis;

		flex: 1;
	}

	.sz {
		font-size: 0.6875rem;
		flex-shrink: 0;
	}

	.tag {
		flex-shrink: 0;

		padding: 0 0.25rem;
		border-radius: var(--radius-input);
		font-size: 0.625rem;
		font-weight: 700;
		line-height: 1.25rem;

		&.managed {
			background: var(--bg-bar);
			color: var(--link);
		}

		&.drift {
			background: #3a2f14;
			color: var(--warning);
		}
	}

	.empty {
		margin: 0;
		padding: 1rem 0.75rem;
		font-size: 0.8125rem;
	}

	.editor {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	.nothing {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;

		flex: 1;
		justify-content: center;
		padding: 2rem 1rem;
		text-align: center;

		h3 {
			margin: 0;
			font-size: 1rem;
		}

		p {
			margin: 0;
			max-width: 30rem;
			font-size: 0.8125rem;
		}
	}

	.ebar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;

		flex-shrink: 0;
		padding: 0.375rem 0.625rem;
		border-bottom: 0.1rem solid var(--border-divider);

		.left,
		.right {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		.left {
			font-size: 0.75rem;
			min-width: 0;
		}
	}

	.banner {
		flex-shrink: 0;
		padding: 0.375rem 0.625rem;
		font-size: 0.75rem;
		border-bottom: 0.1rem solid var(--border-divider);

		&.err {
			background: #2b1717;
			color: var(--error);
		}
	}

	.gap {
		height: 1rem;
	}

	.phs {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;

		// the editor is the point of the screen, so this panel scrolls itself rather
		// than growing until it starves it; the column has a fixed height now
		max-height: 11rem;
		overflow-y: auto;
	}

	.ph {
		display: flex;
		align-items: center;
		gap: 0.625rem;

		padding: 0.25rem 0;
		border-bottom: 0.1rem solid var(--border-divider);
		font-size: 0.8125rem;

		&:last-child {
			border-bottom: none;
		}

		.nm {
			flex: 0 0 14rem;
			color: var(--link);
		}

		.val {
			@include ellipsis;

			flex: 1;
		}

		.scope {
			flex-shrink: 0;
			font-size: 0.75rem;
		}
	}

	.intro {
		margin: 0 0 0.75rem;
		font-size: 0.8125rem;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
		font-size: 0.875rem;
	}
</style>
