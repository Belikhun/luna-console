// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Pure helpers for the instance file manager: what a name is (an image, a
 * jar, a config), how a path is spelled, and how a drop's folders are walked
 * into the files they hold. Nothing here touches the network; the page and
 * the upload queue both read from it.
 */

/** What a file is, as far as the console can tell from its name. */
export type FileKind =
	| 'image'
	| 'audio'
	| 'video'
	| 'pdf'
	| 'archive'
	| 'jar'
	| 'text'
	| 'other';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
const AUDIO = new Set(['ogg', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'opus']);
const VIDEO = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v']);
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz', 'xz', 'bz2', 'zst', '7z', 'rar', 'mrpack']);
const JAR = new Set(['jar']);
const TEXT = new Set([
	'yml', 'yaml', 'json', 'json5', 'properties', 'toml', 'conf', 'cfg', 'ini',
	'txt', 'md', 'sh', 'bash', 'env', 'xml', 'html', 'css', 'js', 'ts', 'csv',
	'tsv', 'log', 'lang', 'mcfunction', 'snbt', 'mcmeta', 'list', 'acf', 'lock'
]);

/**
 * Image bytes the grid view is willing to fetch for a thumbnail; past this a
 * tile shows the icon, since a 40 MB map render is not a thumbnail.
 */
export const THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024;

/** Lowercase extension of a name, without the dot; empty when it has none. */
export function extensionOf(name: string): string {
	const base = name.slice(name.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');

	return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Classify a file by its name. */
export function fileKindOf(name: string): FileKind {
	const ext = extensionOf(name);

	if (IMAGE.has(ext)) {
		return 'image';
	}

	if (AUDIO.has(ext)) {
		return 'audio';
	}

	if (VIDEO.has(ext)) {
		return 'video';
	}

	if (ext === 'pdf') {
		return 'pdf';
	}

	if (ARCHIVE.has(ext)) {
		return 'archive';
	}

	if (JAR.has(ext)) {
		return 'jar';
	}

	if (ext === '' || TEXT.has(ext)) {
		return 'text';
	}

	return 'other';
}

/** The Font Awesome glyph that stands for a kind of file. */
export function fileIconOf(kind: FileKind, managed = false): string {
	if (managed) {
		return 'fileCode';
	}

	switch (kind) {
		case 'image':
			return 'image';
		case 'audio':
			return 'fileMusic';
		case 'video':
			return 'film';
		case 'pdf':
			return 'filePdf';
		case 'archive':
			return 'box';
		case 'jar':
			return 'fileBinary';
		case 'text':
			return 'fileLines';
		default:
			return 'file';
	}
}

/** Whether the browser can show this kind of file on its own. */
export function previewable(kind: FileKind): boolean {
	return kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'pdf';
}

/** The last segment of a `/`-separated path. */
export function baseName(path: string): string {
	const clean = path.replace(/\/+$/, '');

	return clean.slice(clean.lastIndexOf('/') + 1);
}

/** Everything before the last segment; empty for a top-level path. */
export function parentOf(path: string): string {
	const clean = path.replace(/\/+$/, '');
	const slash = clean.lastIndexOf('/');

	return slash < 0 ? '' : clean.slice(0, slash);
}

/** Join path segments with single slashes, dropping empty ones. */
export function joinPath(...parts: string[]): string {
	return parts
		.flatMap((part) => part.split('/'))
		.filter((part) => part !== '' && part !== '.')
		.join('/');
}

/** Whether a typed entry name is a plain name: no slashes, not `.`/`..`. */
export function validEntryName(name: string): boolean {
	const trimmed = name.trim();

	return trimmed !== '' && trimmed !== '.' && trimmed !== '..' && !/[\\/\0]/.test(trimmed);
}

/** A file picked or dropped, with the path it should land at under the drop's directory. */
export interface PickedFile {
	file: File;
	/** `/`-separated path relative to the destination directory, the file name last */
	relPath: string;
}

/**
 * Every file a drop holds, folders walked. Browsers expose a dropped folder
 * only through `webkitGetAsEntry`, and a directory reader hands its entries
 * back a batch at a time until an empty batch, so the walk loops on it.
 */
export async function filesFromDrop(transfer: DataTransfer): Promise<PickedFile[]> {
	const items = [...(transfer.items ?? [])];
	const entries = items
		.map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
		.filter((entry): entry is FileSystemEntry => !!entry);

	if (entries.length === 0) {
		return [...transfer.files].map((file) => ({ file, relPath: file.name }));
	}

	const out: PickedFile[] = [];

	for (const entry of entries) {
		await walkEntry(entry, '', out);
	}

	return out;
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) => {
			(entry as FileSystemFileEntry).file(resolve, reject);
		});

		out.push({ file, relPath: joinPath(prefix, entry.name) });

		return;
	}

	if (!entry.isDirectory) {
		return;
	}

	const reader = (entry as FileSystemDirectoryEntry).createReader();

	for (;;) {
		const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
			reader.readEntries(resolve, reject);
		});

		if (batch.length === 0) {
			break;
		}

		for (const child of batch) {
			await walkEntry(child, joinPath(prefix, entry.name), out);
		}
	}
}

/**
 * Files from a file input, keeping the folder structure a `webkitdirectory`
 * picker reports through `webkitRelativePath`.
 */
export function filesFromInput(list: FileList | null): PickedFile[] {
	return [...(list ?? [])].map((file) => ({
		file,
		relPath: file.webkitRelativePath && file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name
	}));
}

/** The console's download URL for one path or a selection of an instance's entries. */
export function downloadUrl(
	instance: string,
	path: string,
	opts: { format?: 'raw' | 'zip' | 'tar'; names?: string[]; inline?: boolean } = {}
): string {
	const params = new URLSearchParams({ path });

	if (opts.format) {
		params.set('format', opts.format);
	}

	for (const name of opts.names ?? []) {
		params.append('name', name);
	}

	if (opts.inline) {
		params.set('inline', '1');
	}

	return `/api/instances/${encodeURIComponent(instance)}/files/download?${params.toString()}`;
}

/** Start a browser download of a URL without leaving the page. */
export function triggerDownload(url: string): void {
	const anchor = document.createElement('a');

	anchor.href = url;
	anchor.download = '';
	anchor.rel = 'noopener';
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
}
