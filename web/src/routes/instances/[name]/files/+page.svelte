<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { api, post, put } from '$lib/api';
	import { followJob } from '$lib/jobs';
	import { fmtBytes, fmtDateTime } from '$lib/format';
	import { copyText } from '$lib/clipboard';
	import { matches } from '$lib/search/match';
	import {
		baseName,
		downloadUrl,
		fileIconOf,
		fileKindOf,
		filesFromDrop,
		filesFromInput,
		joinPath,
		parentOf,
		previewable,
		THUMBNAIL_MAX_BYTES,
		triggerDownload,
		validEntryName,
		type PickedFile
	} from '$lib/files';
	import { UploadQueue } from '$lib/uploads.svelte';
	import type { PathDetails, PathInfo } from '$core/instancefiles';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import SplitBtn from '$lib/components/SplitBtn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import ContextMenu from '$lib/components/ContextMenu.svelte';
	import SearchInput from '$lib/components/SearchInput.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import FilePreview from '$lib/components/FilePreview.svelte';
	import UploadQueuePanel from '$lib/components/UploadQueue.svelte';
	import type { EditorSelection } from '$lib/components/codeeditor';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import type { Column } from '$lib/components/table';
	import type { InfoCell } from '$lib/components/grid';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * The instance file manager.
	 *
	 * One screen in two modes. **Browsing** is the file manager proper: a
	 * listing of one directory (or a search below it) as a table or a grid,
	 * with multi-select, a context menu per entry, drag and drop (files from the
	 * desktop onto the listing or onto a folder; entries onto a folder to move
	 * them), cut/copy/paste, rename, new folder and file, details, download
	 * (a folder or a selection as one zip) and resumable chunked uploads that
	 * queue in a panel below the listing. **Editing** opens one text file in
	 * the code editor, where a file is either plain (luna edits the bytes and
	 * remembers nothing) or managed (this page edits the *template*, rendered
	 * into the instance on every start); anything the editor cannot take opens
	 * as a preview instead.
	 *
	 * Every byte and every verb goes to the daemon owning the instance, so the
	 * screen works the same on a follower's server as on the primary's own.
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

	/** A listing row: an entry, plus the directory it was found in when searching below the current one */
	interface FileRow extends DirEntry {
		dir: string;
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

	interface Outcome {
		path: string;
		ok: boolean;
		to?: string;
		error?: string;
	}

	type ViewMode = 'list' | 'grid';
	type NameMode = 'folder' | 'file' | 'rename' | 'moveTo' | 'copyTo';

	const VIEW_KEY = 'luna:files:view';
	const HIDDEN_KEY = 'luna:files:hidden';

	/** How long typing may pause before a search below the directory is sent. */
	const FIND_DEBOUNCE_MS = 300;

	/** Most names a confirmation dialog lists before summarising the rest. */
	const CONFIRM_LIST_MAX = 8;

	// ----- browsing -----
	let cwd = $state('');
	let entries: DirEntry[] = $state([]);
	let browsing = $state(false);
	let lastUpdated = $state<number | null>(null);

	let view: ViewMode = $state(untrack(() => readStored(VIEW_KEY, 'list') as ViewMode));
	let showHidden = $state(untrack(() => readStored(HIDDEN_KEY, 'yes') === 'yes'));

	let search = $state('');
	let deep = $state(false);
	let found = $state<PathInfo[] | null>(null);
	let finding = $state(false);
	let findTimer: ReturnType<typeof setTimeout> | undefined;

	let selected: Set<string> = $state(new Set());
	let clipboard = $state<{ mode: 'cut' | 'copy'; paths: string[] } | null>(null);

	/** entries being dragged inside the listing; a desktop drop carries none */
	let dragPaths: string[] = [];
	/** a desktop drag is over the listing (and not over a folder row) */
	let dropOver = $state(false);

	let pathEditing = $state(false);
	let pathDraft = $state('');
	let pathField: HTMLInputElement | undefined = $state();

	let fileInput: HTMLInputElement | undefined = $state();
	let folderInput: HTMLInputElement | undefined = $state();

	/** How far a press may travel before it is a box rather than a click, px */
	const MARQUEE_SLOP = 4;

	/** px from a scroller's edge within which a dragged box scrolls it */
	const MARQUEE_SCROLL_EDGE = 28;

	let browserEl: HTMLDivElement | undefined = $state();
	/** the selection box being dragged over the listing, in viewport px */
	let marquee = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
	/** the press that may become a box; the selection it started from, for an additive drag */
	let press: { x: number; y: number; base: Set<string>; additive: boolean; pointerId: number } | null = null;

	let gridMenu: ContextMenu | undefined = $state();
	let areaMenu: ContextMenu | undefined = $state();
	let menuRow = $state<FileRow | null>(null);
	/** the tile a shift-click extends the grid selection from */
	let anchorPath: string | null = null;

	const queue = new UploadQueue();
	let queueCollapsed = $state(false);

	// ----- editor -----
	let current = $state<FileContent | null>(null);
	/** The editor's buffer; the template for a managed file, else the disk text */
	let buffer = $state('');
	/** What was loaded, so "unsaved" is a comparison rather than a flag to maintain */
	let pristine = $state('');
	let loadingFile = $state(false);

	let discardOpen = $state(false);
	/** the file waiting behind the discard dialog; opened once the edit is let go */
	let pendingOpen = $state<DirEntry | null>(null);
	let saving = $state(false);
	/** Show the rendered result instead of the template (managed files only) */
	let preview = $state(false);
	let renderedPreview = $state('');

	let selection: EditorSelection = $state({ text: '', line: 1, offset: 0 });

	/** a non-text file open in the preview pane */
	let previewEntry = $state<DirEntry | null>(null);

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

	// ----- dialogs -----
	let nameMode: NameMode = $state('folder');
	let nameOpen = $state(false);
	let nameValue = $state('');
	let nameBusy = $state(false);
	let nameTargets: FileRow[] = $state([]);
	let nameField: HTMLInputElement | undefined = $state();

	let deleteOpen = $state(false);
	let deleteTargets: FileRow[] = $state([]);

	let detailsOpen = $state(false);
	let details = $state<PathDetails | null>(null);
	let detailsLoading = $state(false);

	const dirty = $derived(!!current && buffer !== pristine);
	const editingTemplate = $derived(!!current?.managed);
	const open = $derived(!!current || !!previewEntry);

	/** Breadcrumb segments of the current directory, each with the path to reach it. */
	const crumbs = $derived.by(() => {
		const parts = cwd ? cwd.split('/') : [];
		const out: Array<{ label: string; path: string }> = [{ label: name, path: '' }];

		parts.forEach((part, index) => {
			out.push({ label: part, path: parts.slice(0, index + 1).join('/') });
		});

		return out;
	});

	/** The listing: the directory's entries, or what a search below it found. */
	const rows: FileRow[] = $derived.by(() => {
		if (deep && found) {
			return found
				.filter((info) => info.kind !== 'other')
				.filter((info) => showHidden || !baseName(info.path).startsWith('.'))
				.map((info) => ({
					name: baseName(info.path),
					path: info.path,
					kind: info.kind as 'dir' | 'file',
					size: info.size,
					modified: info.modified,
					editable: info.kind === 'file' && fileKindOf(info.path) === 'text' && info.size <= 512 * 1024,
					managed: false,
					drifted: false,
					noise: false,
					dir: parentOf(info.path)
				}));
		}

		return entries
			.filter((entry) => showHidden || !entry.name.startsWith('.'))
			.filter((entry) => !search || matches(entry.name, search))
			.map((entry) => ({ ...entry, dir: cwd }));
	});

	const selectedRows = $derived(rows.filter((row) => selected.has(row.path)));

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.instanceFiles.colName'), sortable: true, minWidth: 220 },
		{ id: 'size', label: t('web.instanceFiles.colSize'), sortable: true, width: 110, align: 'right' },
		{ id: 'modified', label: t('web.instanceFiles.colModified'), sortable: true, width: 180 },
		{ id: 'type', label: t('web.instanceFiles.colType'), sortable: true, width: 120 }
	]);

	function readStored(key: string, fallback: string): string {
		if (typeof localStorage === 'undefined') {
			return fallback;
		}

		try {
			return localStorage.getItem(key) ?? fallback;
		} catch {
			return fallback;
		}
	}

	function store(key: string, value: string): void {
		try {
			localStorage.setItem(key, value);
		} catch {
			// a private window; the choice lasts for the page only
		}
	}

	function setView(next: ViewMode): void {
		view = next;
		store(VIEW_KEY, next);
	}

	function toggleHidden(): void {
		showHidden = !showHidden;
		store(HIDDEN_KEY, showHidden ? 'yes' : 'no');
	}

	/** What a row is, in the words of the type column. */
	function typeLabel(row: FileRow): string {
		if (row.kind === 'dir') {
			return t('web.instanceFiles.kindFolder');
		}

		if (row.managed) {
			return t('web.instanceFiles.kindManaged');
		}

		return t(`web.instanceFiles.kind.${fileKindOf(row.name)}`);
	}

	function iconOf(row: FileRow): string {
		if (row.kind === 'dir') {
			return row.noise ? 'folders' : 'folder';
		}

		return fileIconOf(fileKindOf(row.name), row.managed);
	}

	function sortValue(row: FileRow, column: string): string | number | null {
		switch (column) {
			case 'name':
				// folders stay ahead of files whichever way the names run
				return `${row.kind === 'dir' ? '0' : '1'}${row.name.toLowerCase()}`;
			case 'size':
				return row.kind === 'dir' ? -1 : row.size;
			case 'modified':
				return row.modified;
			case 'type':
				return typeLabel(row);
			default:
				return null;
		}
	}

	// ----- loading -----
	async function browse(path: string): Promise<void> {
		browsing = true;

		try {
			const data = await api(`/instances/${name}/files?path=${encodeURIComponent(path)}`);

			if (data.path !== cwd) {
				selected = new Set();
				search = '';
				found = null;
			}

			cwd = data.path;
			entries = data.entries;
			lastUpdated = Date.now();
			pathEditing = false;

			if (deep && search) {
				scheduleFind();
			}
		} catch (err) {
			Notify.error(t('web.instanceFiles.listFailed'), { detail: (err as Error).message });
		} finally {
			browsing = false;
		}
	}

	async function refresh(): Promise<void> {
		await browse(cwd);
	}

	/** A search below the directory, once typing pauses. */
	function scheduleFind(): void {
		clearTimeout(findTimer);

		if (!deep || search.trim().length < 2) {
			found = null;

			return;
		}

		findTimer = setTimeout(() => void runFind(), FIND_DEBOUNCE_MS);
	}

	async function runFind(): Promise<void> {
		const term = search.trim();

		if (!deep || term.length < 2) {
			found = null;

			return;
		}

		finding = true;

		try {
			const data = await api(
				`/instances/${name}/files?path=${encodeURIComponent(cwd)}&find=${encodeURIComponent(term)}`
			);

			// a slower answer for an older term must not overwrite a newer one
			if (search.trim() === term) {
				found = data.entries;

				if (data.truncated) {
					Notify.info(t('web.instanceFiles.findTruncated'));
				}
			}
		} catch (err) {
			Notify.error(t('web.instanceFiles.findFailed'), { detail: (err as Error).message });
		} finally {
			finding = false;
		}
	}

	$effect(() => {
		void search;
		void deep;
		untrack(() => scheduleFind());
	});

	// ----- opening -----
	function openRow(row: FileRow): void {
		if (row.kind === 'dir') {
			void browse(row.path);

			return;
		}

		if (row.editable) {
			openFile(row);

			return;
		}

		previewEntry = row;
	}

	function openFile(entry: DirEntry): void {
		if (dirty) {
			pendingOpen = entry;
			discardOpen = true;

			return;
		}

		void loadFile(entry);
	}

	async function loadFile(entry: DirEntry): Promise<void> {
		loadingFile = true;
		preview = false;
		previewEntry = null;

		try {
			const data: FileContent = await api(
				`/instances/${name}/files?read=1&path=${encodeURIComponent(entry.path)}`
			);

			current = data;
			buffer = data.template ?? data.text;
			pristine = buffer;
			selection = { text: '', line: 1, offset: 0 };
		} catch (err) {
			Notify.error(t('web.instanceFiles.openFailed', { name: entry.name }), { detail: (err as Error).message });
		} finally {
			loadingFile = false;
		}
	}

	/** Back to the listing; an unsaved edit asks first. */
	function closeFile(): void {
		if (dirty) {
			pendingOpen = null;
			discardOpen = true;

			return;
		}

		current = null;
		previewEntry = null;
	}

	/** The files beside the open one, for stepping through previews. */
	const siblings = $derived(rows.filter((row) => row.kind === 'file'));
	const openIndex = $derived(siblings.findIndex((row) => row.path === (previewEntry?.path ?? current?.path)));

	function step(delta: number): void {
		const next = siblings[openIndex + delta];

		if (next) {
			openRow(next);
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
			Notify.success(t('web.instanceFiles.saved', { path: current.path }), {
				detail: result.managed
					? t('web.instanceFiles.savedTemplate')
					: t('web.instanceFiles.savedFile')
			});

			// the render may have changed placeholders/drift state
			await reopen();
			await refresh();
		} catch (err) {
			Notify.error(t('web.instanceFiles.saveFailed', { path: current.path }), { detail: (err as Error).message });
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
				Notify.success(t('web.instanceFiles.readopted', { path: current.path }), {
					detail: result.kept?.length
						? t('web.instanceFiles.readoptKept', { names: result.kept.join(', ') })
						: t('web.instanceFiles.readoptLiteral')
				});
			} else {
				Notify.success(`${current.path}: ${action}`);
			}

			await reopen();
			await refresh();
		} catch (err) {
			Notify.error(t('web.instanceFiles.manageFailed', { action, path: current.path }), { detail: (err as Error).message });
		}
	}

	/** Re-render every managed file of this instance, following the job. */
	async function renderAll(): Promise<void> {
		const note = Notify.loading(t('web.instanceFiles.rendering'));

		try {
			const { job } = await post(`/instances/${name}/files/manage`, { action: 'render' });
			const finished = await followJob(job.id, () => {});
			const results = (finished.result as { results: Array<{ outcome: string }> })?.results ?? [];
			const changed = results.filter((entry) => entry.outcome !== 'unchanged').length;

			note.set({
				level: 'success',
				message: changed
					? t('web.instanceFiles.renderedCount', { count: changed })
					: t('web.instanceFiles.renderedUpToDate'),
				detail: t('web.instanceFiles.renderedChecked', { count: results.length }),
				closeable: true
			});

			await reopen();
			await refresh();
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

		if (!key || !value) {
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

			Notify.success(t('web.instanceFiles.placeholderCreated', { name: result.name }), {
				detail:
					t('web.instanceFiles.placeholderDetail', {
						count: result.replaced,
						path: result.path,
						scope: result.scope
					}) +
					' ' +
					(result.changedFile
						? t('web.instanceFiles.placeholderRewrote')
						: t('web.instanceFiles.placeholderUnchanged'))
			});

			phOpen = false;

			// the file is managed now and the buffer must become the template
			const data: FileContent = await api(
				`/instances/${name}/files?read=1&path=${encodeURIComponent(current.path)}`
			);

			current = data;
			buffer = data.template ?? data.text;
			pristine = buffer;

			await Promise.all([refresh(), loadEnv()]);
		} catch (err) {
			Notify.error(t('web.instanceFiles.placeholderFailed'), { detail: (err as Error).message });
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
	function togglePreview(): void {
		if (preview) {
			preview = false;

			return;
		}

		// substitution is the same one the daemon does; doing it here keeps the
		// preview instant and needs no round trip for a value the page already has
		renderedPreview = buffer.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (token, varName: string) => {
			const entry = resolved.find((item) => item.name === varName);

			if (!entry) {
				return token;
			}

			return entry.secret ? '••••••••' : entry.value;
		});

		preview = true;
	}

	// ----- verbs -----
	/** Download one entry (a file as itself, a folder as a zip) or a selection as one zip. */
	function download(targets: FileRow[]): void {
		if (targets.length === 1) {
			const [row] = targets as [FileRow];

			triggerDownload(downloadUrl(name, row.path, { format: row.kind === 'dir' ? 'zip' : 'raw' }));

			return;
		}

		const dir = targets[0]?.dir ?? cwd;

		triggerDownload(downloadUrl(name, dir, { format: 'zip', names: targets.map((row) => row.name) }));
	}

	/** Whether a selection can download as one zip: everything must sit in one directory. */
	function sameDir(targets: FileRow[]): boolean {
		return targets.length > 0 && targets.every((row) => row.dir === targets[0]!.dir);
	}

	function cut(targets: FileRow[]): void {
		clipboard = { mode: 'cut', paths: targets.map((row) => row.path) };
		Notify.info(t('web.instanceFiles.cutNote', { count: targets.length }));
	}

	function copy(targets: FileRow[]): void {
		clipboard = { mode: 'copy', paths: targets.map((row) => row.path) };
		Notify.info(t('web.instanceFiles.copyNote', { count: targets.length }));
	}

	/** Paste the clipboard into a directory; a cut is spent by it, a copy is not. */
	async function paste(dir: string): Promise<void> {
		if (!clipboard) {
			return;
		}

		const { mode, paths } = clipboard;

		await transfer(mode === 'cut' ? 'move' : 'copy', paths, dir);

		if (mode === 'cut') {
			clipboard = null;
		}
	}

	/** Move or copy paths into a directory, reporting per-target outcomes as one flash. */
	async function transfer(action: 'move' | 'copy', paths: string[], dir: string): Promise<void> {
		try {
			const result = await post<{ outcomes: Outcome[] }>(`/instances/${name}/files/ops`, {
				action,
				paths,
				to: dir
			});

			reportOutcomes(
				result.outcomes,
				action === 'move'
					? t('web.instanceFiles.movedCount', { count: result.outcomes.filter((outcome) => outcome.ok).length, dir: dir || '/' })
					: t('web.instanceFiles.copiedCount', { count: result.outcomes.filter((outcome) => outcome.ok).length, dir: dir || '/' })
			);
			await refresh();
		} catch (err) {
			Notify.error(t('web.instanceFiles.transferFailed'), { detail: (err as Error).message });
		}
	}

	function reportOutcomes(outcomes: Outcome[], message: string): void {
		const failed = outcomes.filter((outcome) => !outcome.ok);

		if (failed.length === 0) {
			Notify.success(message);

			return;
		}

		const detail = failed.map((outcome) => `${outcome.path}: ${outcome.error ?? ''}`).join('\n');

		if (failed.length === outcomes.length) {
			Notify.error(t('web.instanceFiles.nothingDone'), { detail });

			return;
		}

		Notify.warning(message, { detail: t('web.instanceFiles.someFailed', { count: failed.length }) + '\n' + detail });
	}

	function askDelete(targets: FileRow[]): void {
		deleteTargets = targets;
		deleteOpen = true;
	}

	async function deleteConfirmed(): Promise<void> {
		const paths = deleteTargets.map((row) => row.path);

		try {
			const result = await post<{ outcomes: Outcome[] }>(`/instances/${name}/files/ops`, { action: 'delete', paths });

			reportOutcomes(result.outcomes, t('web.instanceFiles.deletedCount', { count: result.outcomes.filter((outcome) => outcome.ok).length }));

			if (clipboard) {
				clipboard = { ...clipboard, paths: clipboard.paths.filter((path) => !paths.includes(path)) };
			}

			selected = new Set();
			await refresh();
		} catch (err) {
			Notify.error(t('web.instanceFiles.deleteFailed'), { detail: (err as Error).message });
		}
	}

	/** Open the one-field dialog: a new folder or file, a rename, or a destination. */
	function askName(mode: NameMode, targets: FileRow[] = []): void {
		nameMode = mode;
		nameTargets = targets;
		nameBusy = false;

		if (mode === 'rename') {
			nameValue = targets[0]?.name ?? '';
		} else if (mode === 'moveTo' || mode === 'copyTo') {
			nameValue = cwd;
		} else {
			nameValue = '';
		}

		nameOpen = true;
	}

	$effect(() => {
		if (!nameOpen || !nameField) {
			return;
		}

		const field = nameField;

		field.focus();

		// renaming selects the stem, so typing replaces the name and keeps the extension
		if (nameMode === 'rename') {
			const dot = field.value.lastIndexOf('.');

			field.setSelectionRange(0, dot > 0 ? dot : field.value.length);
		} else {
			field.select();
		}
	});

	const nameValid = $derived.by(() => {
		if (nameMode === 'moveTo' || nameMode === 'copyTo') {
			return true;
		}

		if (!validEntryName(nameValue)) {
			return false;
		}

		if (nameMode === 'rename') {
			return nameValue.trim() !== nameTargets[0]?.name;
		}

		return !entries.some((entry) => entry.name === nameValue.trim());
	});

	async function submitName(): Promise<void> {
		if (!nameValid || nameBusy) {
			return;
		}

		nameBusy = true;

		const value = nameValue.trim();

		try {
			if (nameMode === 'folder') {
				await post(`/instances/${name}/files/ops`, { action: 'mkdir', path: joinPath(cwd, value) });
				Notify.success(t('web.instanceFiles.folderCreated', { name: value }));
				nameOpen = false;
				await refresh();
			} else if (nameMode === 'file') {
				const result = await post<{ path: string }>(`/instances/${name}/files/ops`, { action: 'newfile', path: joinPath(cwd, value) });

				nameOpen = false;
				await refresh();

				const created = entries.find((entry) => entry.path === result.path);

				if (created) {
					openRow({ ...created, dir: cwd });
				}
			} else if (nameMode === 'rename') {
				const target = nameTargets[0]!;

				await post(`/instances/${name}/files/ops`, {
					action: 'rename',
					from: target.path,
					to: joinPath(target.dir, value)
				});
				Notify.success(t('web.instanceFiles.renamed', { from: target.name, to: value }));
				nameOpen = false;
				selected = new Set();
				await refresh();
			} else {
				const dir = value.replace(/^\/+|\/+$/g, '');

				nameOpen = false;
				await transfer(nameMode === 'moveTo' ? 'move' : 'copy', nameTargets.map((row) => row.path), dir);
			}
		} catch (err) {
			Notify.error(t('web.instanceFiles.nameFailed'), { detail: (err as Error).message });
		} finally {
			nameBusy = false;
		}
	}

	async function showDetails(row: FileRow): Promise<void> {
		detailsOpen = true;
		detailsLoading = true;
		details = null;

		try {
			details = await api(`/instances/${name}/files?details=1&path=${encodeURIComponent(row.path)}`);
		} catch (err) {
			detailsOpen = false;
			Notify.error(t('web.instanceFiles.detailsFailed'), { detail: (err as Error).message });
		} finally {
			detailsLoading = false;
		}
	}

	const detailCells: InfoCell[] = $derived(
		!details
			? []
			: [
					{ id: 'path', label: t('web.instanceFiles.detailPath'), value: details.path || '/', copyable: true, style: 'mono', colSpan: 'all' },
					{ id: 'type', label: t('web.instanceFiles.colType'), value: details.kind === 'dir' ? t('web.instanceFiles.kindFolder') : details.type },
					{
						id: 'size',
						label: t('web.instanceFiles.colSize'),
						value: details.kind === 'dir'
							? `${fmtBytes(details.totalSize)}${details.truncated ? '+' : ''}`
							: fmtBytes(details.size)
					},
					{ id: 'modified', label: t('web.instanceFiles.colModified'), value: fmtDateTime(details.modified) },
					...(details.kind === 'dir'
						? [
								{ id: 'files', label: t('web.instanceFiles.detailFiles'), value: `${details.files}${details.truncated ? '+' : ''}` },
								{ id: 'dirs', label: t('web.instanceFiles.detailFolders'), value: `${details.dirs}${details.truncated ? '+' : ''}` }
							]
						: []),
					...(details.link ? [{ id: 'link', label: t('web.instanceFiles.detailLink'), value: t('web.common.yes') }] : [])
				]
	);

	async function copyPath(row: FileRow): Promise<void> {
		if (await copyText(row.path)) {
			Notify.success(t('web.common.copied'));
		}
	}

	// ----- menus -----
	/** The verbs for what is selected; one entry's menu forwards the selection when it is inside it. */
	function selectionActions(targets: FileRow[]): ContextMenuItem[] {
		const one = targets.length === 1 ? targets[0]! : null;
		const none = targets.length === 0;

		return [
			{
				id: 'open',
				label: one?.kind === 'dir' ? t('web.instanceFiles.openFolder') : t('web.instanceFiles.open'),
				icon: one?.kind === 'dir' ? 'folder' : 'arrowUpRightFromSquare',
				disabled: !one,
				hint: none ? t('web.instanceFiles.hintSelectSomething') : t('web.instanceFiles.hintOneEntry'),
				action: () => openRow(one!)
			},
			{
				id: 'download',
				label: targets.length > 1 ? t('web.instanceFiles.downloadZip') : t('web.instanceFiles.download'),
				icon: 'download',
				disabled: none || !sameDir(targets),
				hint: none ? t('web.instanceFiles.hintSelectSomething') : t('web.instanceFiles.hintSameFolder'),
				action: () => download(targets)
			},
			{ separator: true },
			{
				id: 'rename',
				label: t('web.instanceFiles.rename'),
				icon: 'pen',
				disabled: !one,
				hint: none ? t('web.instanceFiles.hintSelectSomething') : t('web.instanceFiles.hintOneEntry'),
				action: () => askName('rename', targets)
			},
			{
				id: 'cut',
				label: t('web.instanceFiles.cut'),
				icon: 'scissors',
				disabled: none,
				hint: t('web.instanceFiles.hintSelectSomething'),
				action: () => cut(targets)
			},
			{
				id: 'copy',
				label: t('web.instanceFiles.copy'),
				icon: 'copy',
				disabled: none,
				hint: t('web.instanceFiles.hintSelectSomething'),
				action: () => copy(targets)
			},
			{
				id: 'pasteInto',
				label: t('web.instanceFiles.pasteInto'),
				icon: 'paste',
				disabled: !clipboard || one?.kind !== 'dir',
				hint: !clipboard ? t('web.instanceFiles.hintClipboardEmpty') : t('web.instanceFiles.hintOneFolder'),
				action: () => paste(one!.path)
			},
			{
				id: 'moveTo',
				label: t('web.instanceFiles.moveTo'),
				icon: 'rightToBracket',
				disabled: none,
				hint: t('web.instanceFiles.hintSelectSomething'),
				action: () => askName('moveTo', targets)
			},
			{
				id: 'copyTo',
				label: t('web.instanceFiles.copyTo'),
				icon: 'fileExport',
				disabled: none,
				hint: t('web.instanceFiles.hintSelectSomething'),
				action: () => askName('copyTo', targets)
			},
			{ separator: true },
			{
				id: 'details',
				label: t('web.instanceFiles.details'),
				icon: 'circleInfo',
				disabled: !one,
				hint: none ? t('web.instanceFiles.hintSelectSomething') : t('web.instanceFiles.hintOneEntry'),
				action: () => showDetails(one!)
			},
			{
				id: 'copyPath',
				label: t('web.instanceFiles.copyPath'),
				icon: 'clipboard',
				disabled: !one,
				hint: none ? t('web.instanceFiles.hintSelectSomething') : t('web.instanceFiles.hintOneEntry'),
				action: () => copyPath(one!)
			},
			{ separator: true },
			{
				id: 'delete',
				label: targets.length > 1 ? t('web.instanceFiles.deleteCount', { count: targets.length }) : t('web.common.delete'),
				icon: 'trash',
				color: 'danger',
				disabled: none,
				hint: t('web.instanceFiles.hintSelectSomething'),
				action: () => askDelete(targets)
			}
		];
	}

	function rowActions(row: FileRow): ContextMenuItem[] {
		const targets = selected.has(row.path) && selectedRows.length > 1 ? selectedRows : [row];

		return selectionActions(targets);
	}

	/** The menu for the listing's own background: what you can make or put here. */
	const areaActions: ContextMenuItem[] = $derived([
		{ id: 'newFolder', label: t('web.instanceFiles.newFolder'), icon: 'folderPlus', action: () => askName('folder') },
		{ id: 'newFile', label: t('web.instanceFiles.newFile'), icon: 'plus', action: () => askName('file') },
		{ separator: true },
		{ id: 'uploadFiles', label: t('web.instanceFiles.uploadFiles'), icon: 'fileArrowUp', action: () => fileInput?.click() },
		{ id: 'uploadFolder', label: t('web.instanceFiles.uploadFolder'), icon: 'folderArrowUp', action: () => folderInput?.click() },
		{ separator: true },
		{
			id: 'paste',
			label: t('web.instanceFiles.pasteHere'),
			icon: 'paste',
			disabled: !clipboard,
			hint: t('web.instanceFiles.hintClipboardEmpty'),
			action: () => paste(cwd)
		},
		{ id: 'selectAll', label: t('web.instanceFiles.selectAll'), icon: 'listCheck', action: () => (selected = new Set(rows.map((row) => row.path))) },
		{ separator: true },
		{ id: 'refresh', label: t('web.common.refresh'), icon: 'rotate', action: refresh }
	]);

	const viewActions: ContextMenuItem[] = $derived([
		{ id: 'list', label: t('web.instanceFiles.viewList'), icon: view === 'list' ? 'circleDot' : 'list', action: () => setView('list') },
		{ id: 'grid', label: t('web.instanceFiles.viewGrid'), icon: view === 'grid' ? 'circleDot' : 'grid2', action: () => setView('grid') },
		{ separator: true },
		{
			id: 'hidden',
			label: showHidden ? t('web.instanceFiles.hideHidden') : t('web.instanceFiles.showHidden'),
			icon: showHidden ? 'eyeSlash' : 'eye',
			action: toggleHidden
		}
	]);

	const fileActions: ContextMenuItem[] = $derived(
		!current
			? []
			: [
					{
						label: t('web.instanceFiles.createPlaceholderFromSelection'),
						icon: 'key',
						disabled: !selection.text.trim(),
						hint: t('web.instanceFiles.selectAValueFirst'),
						action: startPlaceholder
					},
					{
						label: current.managed ? t('web.instanceFiles.stopManaging') : t('web.instanceFiles.manageAsTemplate'),
						icon: current.managed ? 'linkSlash' : 'link',
						action: () => manage(current!.managed ? 'unmanage' : 'manage')
					},
					{
						label: t('web.instanceFiles.reAdoptFromDisk'),
						icon: 'arrowDown',
						disabled: !current.managed,
						hint: t('web.instanceFiles.hintNotManaged'),
						action: () => manage('readopt')
					},
					{ separator: true },
					{
						label: t('web.instanceFiles.download'),
						icon: 'download',
						action: () => triggerDownload(downloadUrl(name, current!.path))
					},
					{ separator: true },
					{
						label: t('web.instanceFiles.discardDriftCopy'),
						icon: 'trash',
						disabled: !current.drifted,
						hint: t('web.instanceFiles.hintNotDrifted'),
						action: () => manage('discard-drift')
					}
				]
	);

	function openAreaMenu(event: MouseEvent): void {
		// a row owns its own menu; only the background between rows gets this one
		if ((event.target as HTMLElement).closest('tbody tr, .tile')) {
			return;
		}

		event.preventDefault();
		void areaMenu?.openAt(event.clientX, event.clientY);
	}

	// ----- grid selection -----
	function tileClick(row: FileRow, event: MouseEvent): void {
		if (event.shiftKey && anchorPath) {
			const from = rows.findIndex((entry) => entry.path === anchorPath);
			const to = rows.findIndex((entry) => entry.path === row.path);
			const [lo, hi] = from < to ? [from, to] : [to, from];

			selected = new Set(rows.slice(lo, hi + 1).map((entry) => entry.path));

			return;
		}

		if (event.ctrlKey || event.metaKey) {
			const next = new Set(selected);

			if (next.has(row.path)) {
				next.delete(row.path);
			} else {
				next.add(row.path);
			}

			selected = next;
			anchorPath = row.path;

			return;
		}

		selected = new Set([row.path]);
		anchorPath = row.path;
	}

	async function tileContext(row: FileRow, event: MouseEvent): Promise<void> {
		event.preventDefault();

		if (!selected.has(row.path)) {
			selected = new Set([row.path]);
			anchorPath = row.path;
		}

		menuRow = row;
		await gridMenu?.openAt(event.clientX, event.clientY);
	}

	// ----- drag and drop -----
	function isFileDrag(event: DragEvent): boolean {
		return [...(event.dataTransfer?.types ?? [])].includes('Files');
	}

	function rowDragStart(row: FileRow, event: DragEvent): void {
		dragPaths = selected.has(row.path) ? selectedRows.map((entry) => entry.path) : [row.path];
		event.dataTransfer?.setData('text/plain', dragPaths.join('\n'));

		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'copyMove';
		}
	}

	/** A folder takes desktop files and other entries; never an entry being dragged, nor its own parent's selection. */
	function rowDropTarget(row: FileRow, event: DragEvent): boolean {
		if (row.kind !== 'dir') {
			return false;
		}

		if (isFileDrag(event)) {
			return true;
		}

		return dragPaths.length > 0 && !dragPaths.includes(row.path);
	}

	async function rowDrop(row: FileRow, event: DragEvent): Promise<void> {
		dropOver = false;

		if (isFileDrag(event) && event.dataTransfer) {
			await startUploads(await filesFromDrop(event.dataTransfer), row.path);

			return;
		}

		if (dragPaths.length > 0) {
			const paths = dragPaths;

			dragPaths = [];
			await transfer(event.ctrlKey || event.metaKey ? 'copy' : 'move', paths, row.path);
		}
	}

	/** Dropping on the parent crumb or the up row moves into the parent. */
	function upDropTarget(event: DragEvent): boolean {
		return cwd !== '' && (isFileDrag(event) || dragPaths.length > 0);
	}

	async function upDrop(event: DragEvent): Promise<void> {
		event.preventDefault();

		if (!upDropTarget(event)) {
			return;
		}

		const parent = parentOf(cwd);

		if (isFileDrag(event) && event.dataTransfer) {
			await startUploads(await filesFromDrop(event.dataTransfer), parent);

			return;
		}

		const paths = dragPaths;

		dragPaths = [];
		await transfer(event.ctrlKey || event.metaKey ? 'copy' : 'move', paths, parent);
	}

	function areaDragOver(event: DragEvent): void {
		if (!isFileDrag(event)) {
			return;
		}

		event.preventDefault();

		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'copy';
		}

		// over a folder row the row lights up instead, so the sheet steps back
		dropOver = !(event.target as HTMLElement).closest('tbody tr.drop-target, .tile.drop-target');
	}

	function areaDragLeave(event: DragEvent): void {
		if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
			dropOver = false;
		}
	}

	async function areaDrop(event: DragEvent): Promise<void> {
		if (!isFileDrag(event) || !event.dataTransfer) {
			dropOver = false;

			return;
		}

		event.preventDefault();
		dropOver = false;
		await startUploads(await filesFromDrop(event.dataTransfer), cwd);
	}

	// ----- marquee selection -----
	/**
	 * A press on the listing's own background starts a selection box, as a
	 * desktop file manager does; a press on an entry, a control or the toolbar
	 * is theirs. Holding Ctrl or Shift adds the boxed entries to the selection.
	 */
	function marqueeDown(event: PointerEvent): void {
		if (event.button !== 0 || !browserEl) {
			return;
		}

		const target = event.target as HTMLElement;

		if (target.closest('tr, .tile, button, input, a, label, .tb, .gridbar, .crumbbar, .dropsheet, [role="menu"]')) {
			return;
		}

		press = {
			x: event.clientX,
			y: event.clientY,
			base: event.ctrlKey || event.metaKey || event.shiftKey ? new Set(selected) : new Set(),
			additive: event.ctrlKey || event.metaKey || event.shiftKey,
			pointerId: event.pointerId
		};

		browserEl.setPointerCapture(event.pointerId);
	}

	function marqueeMove(event: PointerEvent): void {
		if (!press || !browserEl) {
			return;
		}

		if (!marquee && Math.hypot(event.clientX - press.x, event.clientY - press.y) < MARQUEE_SLOP) {
			return;
		}

		marquee = { x0: press.x, y0: press.y, x1: event.clientX, y1: event.clientY };

		autoScroll(event.clientY);
		applyMarquee();
	}

	function marqueeUp(event: PointerEvent): void {
		if (!press) {
			return;
		}

		browserEl?.releasePointerCapture(event.pointerId);

		// a press that never became a box is a click on the background: it
		// clears the selection, unless a modifier said to keep it
		if (!marquee && !press.additive) {
			selected = new Set();
		}

		press = null;
		marquee = null;
	}

	/** Select every entry whose element the box touches. */
	function applyMarquee(): void {
		if (!marquee || !press || !browserEl) {
			return;
		}

		const left = Math.min(marquee.x0, marquee.x1);
		const right = Math.max(marquee.x0, marquee.x1);
		const top = Math.min(marquee.y0, marquee.y1);
		const bottom = Math.max(marquee.y0, marquee.y1);
		const next = new Set(press.base);

		for (const element of browserEl.querySelectorAll<HTMLElement>('[data-path]')) {
			const box = (element.closest('tr') ?? element).getBoundingClientRect();

			if (box.right >= left && box.left <= right && box.bottom >= top && box.top <= bottom) {
				next.add(element.dataset.path!);
			}
		}

		selected = next;
	}

	/** Dragging the box against the scroller's edge scrolls it, so a box can reach rows out of view. */
	function autoScroll(clientY: number): void {
		const scroller = browserEl?.querySelector<HTMLElement>(view === 'grid' ? '.grid' : '.dt > .wrap');

		if (!scroller) {
			return;
		}

		const rect = scroller.getBoundingClientRect();

		if (clientY > rect.bottom - MARQUEE_SCROLL_EDGE) {
			scroller.scrollTop += 12;
		} else if (clientY < rect.top + MARQUEE_SCROLL_EDGE) {
			scroller.scrollTop -= 12;
		}
	}

	/** The box as a style, relative to the listing, since that is what it is drawn inside. */
	const marqueeStyle = $derived.by(() => {
		if (!marquee || !browserEl) {
			return '';
		}

		const host = browserEl.getBoundingClientRect();
		const left = Math.min(marquee.x0, marquee.x1) - host.left;
		const top = Math.min(marquee.y0, marquee.y1) - host.top;
		const width = Math.abs(marquee.x1 - marquee.x0);
		const height = Math.abs(marquee.y1 - marquee.y0);

		return `left: ${left}px; top: ${top}px; width: ${width}px; height: ${height}px;`;
	});

	// ----- uploads -----
	async function startUploads(picked: PickedFile[], dir: string): Promise<void> {
		if (picked.length === 0) {
			return;
		}

		queue.add(name, dir, picked);
		queueCollapsed = false;
	}

	function onPicked(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;

		void startUploads(filesFromInput(input.files), cwd);
		input.value = '';
	}

	queue.onplaced = (item) => {
		// a landed file shows up where it landed; another directory's arrival is not this listing's business
		if (parentOf(item.path) === cwd) {
			void refresh();
		}
	};

	// ----- keyboard -----
	function onKeydown(event: KeyboardEvent): void {
		const target = event.target as HTMLElement | null;
		const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

		if ((event.ctrlKey || event.metaKey) && event.key === 's') {
			event.preventDefault();
			void save();

			return;
		}

		if (typing || nameOpen || deleteOpen || detailsOpen || phOpen || discardOpen) {
			return;
		}

		if (open) {
			if (event.key === 'Escape') {
				closeFile();
			} else if (previewEntry && event.key === 'ArrowRight') {
				step(1);
			} else if (previewEntry && event.key === 'ArrowLeft') {
				step(-1);
			}

			return;
		}

		const targets = selectedRows;
		const meta = event.ctrlKey || event.metaKey;

		if (event.key === 'Delete' && targets.length > 0) {
			askDelete(targets);
		} else if (event.key === 'F2' && targets.length === 1) {
			askName('rename', targets);
		} else if (event.key === 'Enter' && targets.length === 1) {
			openRow(targets[0]!);
		} else if (event.key === 'Backspace' && cwd) {
			void browse(parentOf(cwd));
		} else if (event.key === 'Escape') {
			selected = new Set();
		} else if (meta && event.key === 'a') {
			selected = new Set(rows.map((row) => row.path));
		} else if (meta && event.key === 'x' && targets.length > 0) {
			cut(targets);
		} else if (meta && event.key === 'c' && targets.length > 0) {
			copy(targets);
		} else if (meta && event.key === 'v' && clipboard) {
			void paste(cwd);
		} else if (event.key === 'F5') {
			void refresh();
		} else {
			return;
		}

		event.preventDefault();
	}

	// ----- path bar -----
	function editPath(): void {
		pathDraft = cwd;
		pathEditing = true;
	}

	$effect(() => {
		if (pathEditing) {
			pathField?.focus();
			pathField?.select();
		}
	});

	function submitPath(): void {
		void browse(pathDraft.trim().replace(/^\/+|\/+$/g, ''));
	}

	onMount(() => {
		void browse('');
		void loadEnv();

		void api('/env').then((data) => {
			machines = data.machines ?? [];
		});

		return () => clearTimeout(findTimer);
	});
</script>

<svelte:head><title>{name} files | Luna Console</title></svelte:head>
<svelte:window onkeydown={onKeydown} />

<PageHeader
	title={t('web.instanceFiles.title')}
	description={t('web.instanceFiles.description', { name })}
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
				detail={t('web.instanceFiles.driftedDetail')}
			/>
		{/if}
	{/snippet}
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} loading={browsing} storageKey="instance-files" />
		{#if open}
			<Dropdown label={t('web.instanceFiles.file')} disabled={!current} menu={fileActions} />
			<Btn icon="rotate" onclick={renderAll}>{t('web.instanceFiles.renderManagedFiles')}</Btn>
			<Btn variant="primary" icon="floppyDisk" loading={saving} disabled={!dirty} onclick={save}>
				{t('web.common.save')}
			</Btn>
		{:else}
			<Dropdown label={t('web.common.actions')} menu={selectionActions(selectedRows)} />
			<Dropdown label={t('web.instanceFiles.view')} menu={viewActions} />
			<Btn icon="rotate" onclick={renderAll}>{t('web.instanceFiles.renderManagedFiles')}</Btn>
			<Dropdown
				label={t('web.instanceFiles.new')}
				menu={[
					{ id: 'folder', label: t('web.instanceFiles.newFolder'), icon: 'folderPlus', action: () => askName('folder') },
					{ id: 'file', label: t('web.instanceFiles.newFile'), icon: 'plus', action: () => askName('file') }
				]}
			/>
			<SplitBtn
				label={t('web.instanceFiles.upload')}
				icon="upload"
				primary
				onclick={() => fileInput?.click()}
				menu={[
					{ id: 'files', label: t('web.instanceFiles.uploadFiles'), icon: 'fileArrowUp', action: () => fileInput?.click() },
					{ id: 'folder', label: t('web.instanceFiles.uploadFolder'), icon: 'folderArrowUp', action: () => folderInput?.click() }
				]}
			/>
		{/if}
	{/snippet}
</PageHeader>

<input class="hidden" type="file" multiple bind:this={fileInput} onchange={onPicked} />
<input class="hidden" type="file" multiple webkitdirectory bind:this={folderInput} onchange={onPicked} />

<div class="stack">
	{#if current}
		<Panel flush fill>
			<div class="ebar">
				<div class="left">
					<Btn variant="icon" icon="arrowLeft" title={t('web.instanceFiles.backToFiles')} onclick={closeFile} />
					<span class="mono path">{current.path}</span>
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
							title={preview ? t('web.instanceFiles.backToTemplate') : t('web.instanceFiles.previewRenderedFile')}
						>
							{preview ? t('web.instanceFiles.editTemplate') : t('web.instanceFiles.previewRender')}
						</Btn>
					{/if}
					<Btn
						icon="key"
						disabled={!selection.text.trim()}
						title={selection.text.trim()
							? t('web.instanceFiles.turnSelectionIntoPlaceholder')
							: t('web.instanceFiles.selectAValueFirst')}
						onclick={startPlaceholder}
					>
						{t('web.instanceFiles.placeholder')}
					</Btn>
				</div>
			</div>

			{#if current.missing.length}
				<div class="banner err">
					{t('web.instanceFiles.undefinedVariables', { names: current.missing.join(', ') })}
				</div>
			{/if}

			{#if preview}
				<CodeEditor value={renderedPreview} path={current.path} readOnly height="100%" />
			{:else}
				<CodeEditor
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
			<Panel
				title={t('web.instanceFiles.placeholdersInThisFile')}
				count={current.placeholders.length}
				description={t('web.instanceFiles.valuesLunaSubstitutesWhenIt')}
			>
				<div class="phs">
					{#each current.placeholders as placeholder (placeholder)}
						{@const entry = resolved.find((item) => item.name === placeholder)}
						<div class="ph">
							<span class="mono nm">${'{'}{placeholder}{'}'}</span>
							{#if !entry}
								<StatusBadge state="failed" label={t('web.instanceFiles.undefined')} />
							{:else}
								<span class="mono val">{entry.secret ? '••••••••' : entry.value}</span>
								<span class="scope dim">{entry.scope}</span>
							{/if}
						</div>
					{/each}
				</div>
			</Panel>
		{/if}
	{:else if previewEntry}
		<Panel flush fill>
			<div class="ebar">
				<div class="left">
					<Btn variant="icon" icon="arrowLeft" title={t('web.instanceFiles.backToFiles')} onclick={closeFile} />
					<span class="mono path">{previewEntry.path}</span>
					<span class="dim size">{fmtBytes(previewEntry.size)}</span>
				</div>
				<div class="right">
					<Btn variant="icon" icon="left" title={t('web.instanceFiles.previousFile')} disabled={openIndex <= 0} onclick={() => step(-1)} />
					<span class="dim size">{openIndex + 1} / {siblings.length}</span>
					<Btn variant="icon" icon="right" title={t('web.instanceFiles.nextFile')} disabled={openIndex < 0 || openIndex >= siblings.length - 1} onclick={() => step(1)} />
					<Btn icon="download" onclick={() => triggerDownload(downloadUrl(name, previewEntry!.path))}>
						{t('web.instanceFiles.download')}
					</Btn>
				</div>
			</div>
			<FilePreview
				instance={name}
				path={previewEntry.path}
				name={previewEntry.name}
				kind={fileKindOf(previewEntry.name)}
				size={previewEntry.size}
				modified={previewEntry.modified}
				note={fileKindOf(previewEntry.name) === 'text' || !previewable(fileKindOf(previewEntry.name)) && previewEntry.size > 512 * 1024
					? t('web.instanceFiles.tooLargeToEdit')
					: ''}
			/>
		</Panel>
	{:else}
		<Panel flush fill>
			<div class="crumbbar">
				{#if pathEditing}
					<input
						class="input mono pathinput"
						bind:this={pathField}
						bind:value={pathDraft}
						placeholder="/"
						onkeydown={(event) => {
							if (event.key === 'Enter') {
								submitPath();
							} else if (event.key === 'Escape') {
								pathEditing = false;
							}
						}}
						onblur={() => (pathEditing = false)}
					/>
				{:else}
					<div class="crumbs" role="presentation" ondblclick={editPath}>
						{#each crumbs as crumb, index (crumb.path)}
							{#if index > 0}<span class="sep dim">/</span>{/if}
							<button
								class="crumb"
								class:here={index === crumbs.length - 1}
								onclick={() => browse(crumb.path)}
								ondragover={(event) => {
									if (index < crumbs.length - 1 && (isFileDrag(event) || dragPaths.length > 0)) {
										event.preventDefault();
									}
								}}
								ondrop={async (event) => {
									if (index >= crumbs.length - 1) {
										return;
									}

									event.preventDefault();

									if (isFileDrag(event) && event.dataTransfer) {
										await startUploads(await filesFromDrop(event.dataTransfer), crumb.path);
									} else if (dragPaths.length > 0) {
										const paths = dragPaths;

										dragPaths = [];
										await transfer(event.ctrlKey || event.metaKey ? 'copy' : 'move', paths, crumb.path);
									}
								}}
							>
								{#if index === 0}<Icon name="home" size="0.75rem" style="solid" />{/if}
								{crumb.label}
							</button>
						{/each}
						<button class="editpath" title={t('web.instanceFiles.editPath')} onclick={editPath}>
							<Icon name="pen" size="0.625rem" />
						</button>
					</div>
				{/if}
				<div class="bar-right">
					{#if clipboard}
						<span class="clip dim" title={clipboard.paths.join('\n')}>
							<Icon name={clipboard.mode === 'cut' ? 'scissors' : 'copy'} size="0.75rem" />
							{t('web.instanceFiles.clipboardCount', { count: clipboard.paths.length })}
						</span>
						<Btn variant="link" onclick={() => paste(cwd)}>{t('web.instanceFiles.pasteHere')}</Btn>
						<Btn variant="icon" icon="close" title={t('web.instanceFiles.clearClipboard')} onclick={() => (clipboard = null)} />
					{/if}
					{#if selectedRows.length}
						<span class="dim">{t('web.instanceFiles.selectedCount', { count: selectedRows.length })}</span>
					{/if}
				</div>
			</div>

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="browser"
				class:over={dropOver}
				class:boxing={!!marquee}
				bind:this={browserEl}
				ondragover={areaDragOver}
				ondragleave={areaDragLeave}
				ondrop={areaDrop}
				oncontextmenu={openAreaMenu}
				onpointerdown={marqueeDown}
				onpointermove={marqueeMove}
				onpointerup={marqueeUp}
				onpointercancel={marqueeUp}
			>
				{#if view === 'list'}
					<div class="list">
						<DataTable
							tableId="instance-files"
							{columns}
							{rows}
							getId={(row) => row.path}
							selectable="multi"
							bind:selected
							{sortValue}
							{rowActions}
							rowLabel={(row) => row.name}
							rowDim={(row) => row.noise || row.name.startsWith('.')}
							onRowDblClick={openRow}
							rowDraggable={() => true}
							onRowDragStart={rowDragStart}
							{rowDropTarget}
							onRowDrop={rowDrop}
							loading={browsing || finding}
							emptyTitle={deep && found
								? t('web.instanceFiles.nothingFound')
								: search
									? t('web.instanceFiles.nothingMatches')
									: t('web.instanceFiles.thisDirectoryIsEmpty')}
							emptyText={deep || search ? '' : t('web.instanceFiles.emptyHint')}
						>
							{#snippet toolbar()}
								{@render searchbar()}
							{/snippet}
							{#snippet cell(row, col)}
								{#if col === 'name'}
									<span class="namecell" data-path={row.path}>
										<Icon name={iconOf(row)} size="0.875rem" style={row.kind === 'dir' || row.managed ? 'solid' : 'light'} />
										<button class="open" onclick={(event) => { event.stopPropagation(); openRow(row); }} ondblclick={(event) => event.stopPropagation()}>
											{row.name}
										</button>
										{#if deep && found && row.dir !== cwd}
											<span class="where dim mono">{row.dir ? row.dir.slice(cwd ? cwd.length + 1 : 0) : ''}</span>
										{/if}
										{#if row.managed}
											<span class="tag managed" title={t('web.instanceFiles.renderedFromATemplateOn')}>T</span>
										{/if}
										{#if row.drifted}
											<span class="tag drift" title={t('web.instanceFiles.changedOutsideLuna')}>!</span>
										{/if}
									</span>
								{:else if col === 'size'}
									{#if row.kind === 'dir'}<span class="dim">–</span>{:else}{fmtBytes(row.size)}{/if}
								{:else if col === 'modified'}
									<span class="dim">{row.modified ? fmtDateTime(row.modified) : '–'}</span>
								{:else if col === 'type'}
									<span class="dim">{typeLabel(row)}</span>
								{/if}
							{/snippet}
						</DataTable>
					</div>
				{:else}
					<div class="gridbar">
						{@render searchbar()}
					</div>
					<div class="grid" role="listbox" aria-multiselectable="true" tabindex="-1">
						{#if cwd && !(deep && found)}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="tile up"
								role="option"
								aria-selected="false"
								tabindex="-1"
								ondblclick={() => browse(parentOf(cwd))}
								onkeydown={(event) => event.key === 'Enter' && browse(parentOf(cwd))}
								ondragover={(event) => upDropTarget(event) && event.preventDefault()}
								ondrop={upDrop}
							>
								<Icon name="folderArrowUp" size="2rem" style="light" />
								<span class="tname">..</span>
							</div>
						{/if}
						{#each rows as row (row.path)}
							{@const kind = row.kind === 'dir' ? null : fileKindOf(row.name)}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="tile"
								class:selected={selected.has(row.path)}
								class:dim={row.noise || row.name.startsWith('.')}
								role="option"
								aria-selected={selected.has(row.path)}
								tabindex="-1"
								draggable="true"
								data-path={row.path}
								title={row.path}
								onclick={(event) => tileClick(row, event)}
								ondblclick={() => openRow(row)}
								onkeydown={(event) => event.key === 'Enter' && openRow(row)}
								oncontextmenu={(event) => tileContext(row, event)}
								ondragstart={(event) => rowDragStart(row, event)}
								ondragover={(event) => {
									if (rowDropTarget(row, event)) {
										event.preventDefault();
										(event.currentTarget as HTMLElement).classList.add('drop-target');
									}
								}}
								ondragleave={(event) => (event.currentTarget as HTMLElement).classList.remove('drop-target')}
								ondrop={(event) => {
									(event.currentTarget as HTMLElement).classList.remove('drop-target');

									if (rowDropTarget(row, event)) {
										event.preventDefault();
										event.stopPropagation();
										void rowDrop(row, event);
									}
								}}
							>
								{#if kind === 'image' && row.size <= THUMBNAIL_MAX_BYTES}
									<img class="thumb" src={downloadUrl(name, row.path, { inline: true })} alt={row.name} loading="lazy" draggable="false" />
								{:else}
									<Icon name={iconOf(row)} size="2rem" style={row.kind === 'dir' || row.managed ? 'solid' : 'light'} />
								{/if}
								<span class="tname" title={row.name}>{row.name}</span>
								{#if deep && found && row.dir !== cwd}
									<span class="tsize where dim mono" title={row.dir}>{row.dir.slice(cwd ? cwd.length + 1 : 0)}/</span>
								{/if}
								<span class="tsize dim">{row.kind === 'dir' ? typeLabel(row) : fmtBytes(row.size)}</span>
							</div>
						{/each}
						{#if !rows.length && !browsing && !finding}
							<p class="empty dim">
								{deep && found
									? t('web.instanceFiles.nothingFound')
									: search
										? t('web.instanceFiles.nothingMatches')
										: t('web.instanceFiles.thisDirectoryIsEmpty')}
							</p>
						{/if}
					</div>
				{/if}

				{#if dropOver}
					<div class="dropsheet">
						<Icon name="cloudArrowUp" size="2rem" style="light" />
						<span>{t('web.instanceFiles.dropToUpload', { dir: cwd || name })}</span>
					</div>
				{/if}

				{#if marquee}
					<div class="marquee" style={marqueeStyle}></div>
				{/if}
			</div>
		</Panel>
	{/if}

</div>

{#if queue.items.length}
	<UploadQueuePanel {queue} bind:collapsed={queueCollapsed} />
{/if}

{#snippet searchbar()}
	<div class="searchbar">
		<div class="sfield">
			<SearchInput bind:value={search} placeholder={t('web.instanceFiles.searchPlaceholder')} width="18rem" />
		</div>
		<label class="deep">
			<Checkbox checked={deep} label={t('web.instanceFiles.includeSubfolders')} onchange={(on) => (deep = on)} />
			<span>{t('web.instanceFiles.includeSubfolders')}</span>
		</label>
		{#if cwd && !(deep && found) && view === 'list'}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<button
				class="upbtn"
				onclick={() => browse(parentOf(cwd))}
				ondragover={(event) => upDropTarget(event) && event.preventDefault()}
				ondrop={upDrop}
				title={t('web.instanceFiles.upOneLevel')}
			>
				<Icon name="folderArrowUp" size="0.75rem" style="solid" />
				<span>{t('web.instanceFiles.upOneLevel')}</span>
			</button>
		{/if}
	</div>
{/snippet}

<ContextMenu
	bind:this={gridMenu}
	items={menuRow ? rowActions(menuRow) : []}
	header={menuRow?.name}
	minWidth="14rem"
/>
<ContextMenu bind:this={areaMenu} items={areaActions} header={cwd || name} minWidth="14rem" />

<Modal
	title={nameMode === 'folder'
		? t('web.instanceFiles.newFolder')
		: nameMode === 'file'
			? t('web.instanceFiles.newFile')
			: nameMode === 'rename'
				? t('web.instanceFiles.renameTitle', { name: nameTargets[0]?.name ?? '' })
				: nameMode === 'moveTo'
					? t('web.instanceFiles.moveCountTitle', { count: nameTargets.length })
					: t('web.instanceFiles.copyCountTitle', { count: nameTargets.length })}
	bind:open={nameOpen}
>
	<label class="field">
		<span class="lbl">
			{nameMode === 'moveTo' || nameMode === 'copyTo' ? t('web.instanceFiles.destinationFolder') : t('web.common.name')}
		</span>
		{#if nameMode === 'moveTo' || nameMode === 'copyTo'}
			<span class="hint">{t('web.instanceFiles.destinationHint')}</span>
		{:else if nameMode !== 'rename'}
			<span class="hint">{t('web.instanceFiles.createdIn', { dir: cwd || '/' })}</span>
		{/if}
		<input
			class="input mono"
			bind:this={nameField}
			bind:value={nameValue}
			placeholder={nameMode === 'moveTo' || nameMode === 'copyTo' ? '/' : ''}
			onkeydown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					void submitName();
				}
			}}
		/>
		{#if nameValue.trim() && !nameValid && nameMode !== 'moveTo' && nameMode !== 'copyTo' && nameValue.trim() !== nameTargets[0]?.name}
			<span class="hint warn">
				{validEntryName(nameValue) ? t('web.instanceFiles.nameTaken') : t('web.instanceFiles.nameInvalid')}
			</span>
		{/if}
	</label>
	{#if nameMode === 'moveTo' || nameMode === 'copyTo'}
		<ul class="targets mono">
			{#each nameTargets.slice(0, CONFIRM_LIST_MAX) as row (row.path)}
				<li>{row.path}</li>
			{/each}
			{#if nameTargets.length > CONFIRM_LIST_MAX}
				<li class="dim">{t('web.instanceFiles.andMore', { count: nameTargets.length - CONFIRM_LIST_MAX })}</li>
			{/if}
		</ul>
	{/if}
	{#snippet footer()}
		<Btn onclick={() => (nameOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" loading={nameBusy} disabled={!nameValid} onclick={submitName}>
			{nameMode === 'rename'
				? t('web.instanceFiles.rename')
				: nameMode === 'moveTo'
					? t('web.instanceFiles.move')
					: nameMode === 'copyTo'
						? t('web.instanceFiles.copy')
						: t('web.common.create')}
		</Btn>
	{/snippet}
</Modal>

<ConfirmModal
	bind:open={deleteOpen}
	title={t('web.instanceFiles.deleteTitle', { count: deleteTargets.length })}
	lead={deleteTargets.length === 1
		? t('web.instanceFiles.deleteLeadOne', { name: deleteTargets[0]?.name ?? '' })
		: t('web.instanceFiles.deleteLeadMany', { count: deleteTargets.length })}
	notes={[t('web.instanceFiles.deleteNote')]}
	confirmLabel={t('web.common.delete')}
	onconfirm={() => void deleteConfirmed()}
>
	<ul class="targets mono">
		{#each deleteTargets.slice(0, CONFIRM_LIST_MAX) as row (row.path)}
			<li>
				<Icon name={iconOf(row)} size="0.75rem" />
				{row.path}
			</li>
		{/each}
		{#if deleteTargets.length > CONFIRM_LIST_MAX}
			<li class="dim">{t('web.instanceFiles.andMore', { count: deleteTargets.length - CONFIRM_LIST_MAX })}</li>
		{/if}
	</ul>
</ConfirmModal>

<Modal title={details?.name ?? t('web.instanceFiles.details')} bind:open={detailsOpen} wide>
	{#if detailsLoading}
		<p class="dim">{t('web.common.loading')}</p>
	{:else if details}
		<InfoGrid cells={detailCells} columns={[3, 2, 1]} />
		{#if details.truncated}
			<p class="dim small">{t('web.instanceFiles.detailsTruncated')}</p>
		{/if}
	{/if}
	{#snippet footer()}
		{#if details}
			<Btn icon="download" onclick={() => triggerDownload(downloadUrl(name, details!.path, { format: details!.kind === 'dir' ? 'zip' : 'raw' }))}>
				{t('web.instanceFiles.download')}
			</Btn>
		{/if}
		<Btn variant="primary" onclick={() => (detailsOpen = false)}>{t('web.common.close')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.instanceFiles.createAPlaceholder')} bind:open={phOpen}>
	<p class="intro dim">
		{t('web.instanceFiles.placeholderIntro')}
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
				{ value: 'instance', label: t('web.instanceFiles.instanceOnly', { name }) }
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
		<span class="lbl">{t('web.instanceFiles.fieldDescription')}</span>
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
		<Btn onclick={() => (phOpen = false)}>{t('web.common.cancel')}</Btn>
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

<ConfirmModal
	bind:open={discardOpen}
	title={t('web.instanceFiles.discardTitle')}
	lead={t('web.instanceFiles.discardLead', { path: current?.path ?? '' })}
	confirmLabel={t('web.common.discard')}
	onconfirm={() => {
		if (pendingOpen) {
			void loadFile(pendingOpen);
		} else {
			pristine = buffer;
			current = null;
		}
	}}
/>

<style lang="scss">
	.hidden {
		display: none;
	}

	// fills the viewport below the page chrome (top nav, breadcrumbs, page header)
	// and above the layout's bottom padding; measured, not guessed.
	// --split-bottom is the terminal drawer's own height, so opening the drawer
	// shortens this rather than covering the listing.
	.stack {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;

		height: calc(100vh - 13.75rem - var(--split-bottom));
		min-height: 24rem;

		> :global(.panel.fill) {
			flex: 1;
			min-height: 0;
		}
	}

	.crumbbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;

		flex-shrink: 0;
		min-height: 2.25rem;
		padding: 0.25rem 0.75rem;
		border-bottom: 0.1rem solid var(--border-divider);
		font-size: 0.8125rem;
	}

	.crumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;

		min-width: 0;
	}

	.crumb {
		@include bare-button;

		display: inline-flex;
		align-items: center;
		gap: 0.375rem;

		padding: 0.125rem 0.25rem;
		border-radius: var(--radius-input);
		color: var(--link);

		&:hover {
			text-decoration: underline;
		}

		&.here {
			color: var(--text-heading);
			font-weight: 700;
			text-decoration: none;
		}
	}

	.editpath {
		@include bare-button;

		padding: 0.125rem 0.25rem;
		color: var(--text-secondary);

		&:hover {
			color: var(--text);
		}
	}

	.pathinput {
		flex: 1;
		max-width: 40rem;
		height: 1.75rem;
		font-size: 0.8125rem;
	}

	.bar-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;

		flex-shrink: 0;
		font-size: 0.75rem;
	}

	.clip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}

	.browser {
		position: relative;

		display: flex;
		flex-direction: column;

		flex: 1;
		min-height: 0;

		&.over {
			outline: 0.1rem dashed var(--primary);
			outline-offset: -0.25rem;
		}

		// a box being dragged must not also sweep text into a text selection
		&.boxing {
			user-select: none;
			cursor: crosshair;
		}
	}

	// the selection box; the position is written inline from measured pixels
	.marquee {
		position: absolute;
		z-index: 2;

		border: 0.1rem solid var(--link);
		background: color-mix(in srgb, var(--link) 15%, transparent);
		pointer-events: none;
	}

	// the table fills the panel and scrolls inside it, where DataTable on its
	// own would grow with its rows and scroll the page instead
	.list {
		display: flex;
		flex-direction: column;

		flex: 1;
		min-height: 0;

		> :global(.dt) {
			display: flex;
			flex-direction: column;

			flex: 1;
			min-height: 0;
		}

		:global(.dt > .wrap) {
			flex: 1;
			min-height: 0;
		}

		:global(.dt > .tb) {
			padding: 0.5rem 0.75rem;
		}
	}

	// takes the toolbar's width rather than its own content's: as a content-sized
	// flex item it would measure the search input at its intrinsic width, then
	// grow the field past that and wrap the checkbox under it
	.searchbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;

		flex: 1 1 auto;
		min-width: 0;
	}

	// the search box would otherwise claim the whole row and push its
	// neighbours under it
	.sfield {
		flex: 0 1 18rem;
		min-width: 10rem;
	}

	.deep {
		display: flex;
		align-items: center;
		gap: 0.375rem;

		font-size: 0.75rem;
		cursor: pointer;
	}

	.upbtn {
		@include bare-button;

		display: inline-flex;
		align-items: center;
		gap: 0.375rem;

		padding: 0.25rem 0.5rem;
		border: 0.1rem solid var(--border-input);
		border-radius: var(--radius-input);
		font-size: 0.75rem;
		color: var(--text-secondary);

		&:hover {
			color: var(--text);
			background: var(--bg-hover);
		}
	}

	.namecell {
		display: flex;
		align-items: center;
		gap: 0.5rem;

		min-width: 0;
	}

	.open {
		@include bare-button;
		@include ellipsis;

		color: var(--link);
		text-decoration: underline;
		text-decoration-color: transparent;

		&:hover {
			text-decoration-color: currentColor;
		}
	}

	.where {
		@include ellipsis;

		max-width: 100%;
		font-size: 0.6875rem;
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

	.gridbar {
		flex-shrink: 0;
		padding: 0.5rem 0.75rem;
		border-bottom: 0.1rem solid var(--border-divider);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
		gap: 0.5rem;
		align-content: start;

		flex: 1;
		min-height: 0;
		padding: 0.75rem;
		overflow-y: auto;
		outline: none;
	}

	.tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.375rem;

		padding: 0.75rem 0.5rem 0.5rem;
		border: 0.1rem solid transparent;
		border-radius: var(--radius-input);
		text-align: center;
		cursor: default;
		user-select: none;

		&:hover {
			background: var(--bg-hover);
		}

		&.selected {
			background: var(--bg-selected);
			border-color: var(--link);
		}

		&.dim {
			color: var(--text-secondary);
		}

		// `.drop-target` is toggled by hand on the element during a drag; a class
		// bound to state would repaint every tile on every dragover event
		&:global(.drop-target) {
			border-color: var(--link);
			border-style: dashed;
		}

		:global(icon) {
			height: 3rem;
			display: flex;
			align-items: center;
		}
	}

	.thumb {
		width: 100%;
		height: 3rem;
		object-fit: contain;
		image-rendering: pixelated;
		pointer-events: none;
	}

	.tname {
		@include ellipsis;

		width: 100%;
		font-size: 0.75rem;
	}

	.tsize {
		font-size: 0.6875rem;
	}

	.empty {
		grid-column: 1 / -1;
		margin: 0;
		padding: 1rem 0.75rem;
		font-size: 0.8125rem;
	}

	.dropsheet {
		@include fill;

		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;

		background: color-mix(in srgb, var(--bg-panel) 85%, transparent);
		color: var(--primary);
		font-size: 0.875rem;
		font-weight: 700;
		pointer-events: none;
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

		.path {
			@include ellipsis;
		}

		.size {
			font-size: 0.75rem;
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

	.targets {
		margin: 0.5rem 0 0;
		padding: 0;
		list-style: none;
		font-size: 0.75rem;

		li {
			display: flex;
			align-items: center;
			gap: 0.375rem;

			padding: 0.125rem 0;
		}
	}

	.hint.warn {
		color: var(--warning);
	}

	.small {
		font-size: 0.75rem;
	}
</style>
