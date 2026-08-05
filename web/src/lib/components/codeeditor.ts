/**
 * Types and language mapping for `CodeEditor.svelte`. Component `<script>`
 * blocks cannot export types, so anything a page needs to name lives here.
 */

/** A selection the editor hands back, for the placeholder flow. */
export interface EditorSelection {
	/** The selected text, empty when the caret is just sitting somewhere */
	text: string;
	/** 1-based line the selection starts on */
	line: number;
	/**
	 * Character offset of the selection's start in the whole buffer. This is what
	 * makes a placeholder replace the value the user actually highlighted, rather
	 * than the first identical string in the file; which for a value like a
	 * username also appearing inside a queue name is the wrong one.
	 */
	offset: number;
}

/**
 * Monaco language id for a config file, from its name. Server configs are
 * overwhelmingly yaml, so that is the fallback rather than plaintext; a
 * mis-highlighted comment is a smaller cost than no highlighting at all.
 */
export function languageFor(path: string): string {
	const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
	const dot = base.lastIndexOf('.');
	const ext = dot <= 0 ? '' : base.slice(dot + 1);

	switch (ext) {
		case 'json':
		case 'json5':
		case 'mcmeta':
			return 'json';

		case 'properties':
		case 'lang':
			return 'properties';

		case 'toml':
			return 'toml';

		case 'conf':
		case 'cfg':
		case 'ini':
			return 'ini';

		case 'sh':
		case 'bash':
		case 'env':
			return 'shell';

		case 'xml':
			return 'xml';

		case 'md':
			return 'markdown';

		case 'js':
			return 'javascript';

		case 'ts':
			return 'typescript';

		case 'css':
			return 'css';

		case 'html':
			return 'html';

		case 'txt':
		case 'log':
		case 'list':
			return 'plaintext';

		default:
			// `.luna-env`, extension-less server files, and every *.yml
			return base.startsWith('.luna-env') ? 'shell' : 'yaml';
	}
}
