/**
 * Monaco setup, isolated in a module that is only ever **dynamically** imported
 * from the browser (`CodeEditor.svelte`'s `onMount`). Monaco touches `self`,
 * `document` and `window` at import time, so a static import would break SSR
 * for every page that renders the editor.
 *
 * Only the languages a server config is written in are pulled in — importing
 * `monaco-editor` wholesale would add its TypeScript, HTML and CSS language
 * services, several megabytes of worker no config file needs.
 */

// paths go through the package's own exports map (`monaco-editor/*` →
// `esm/vs/*.js`), which is why none of them name `esm/vs` themselves
import * as monaco from 'monaco-editor/editor/editor.api';

// the editor's own contributions: find/replace, folding, bracket matching,
// comments, multi-cursor — everything that makes it an editor rather than a box.
// `editor.main` would pull in all ~90 languages with them, which is the bulk of
// monaco's weight and none of what a server config needs.
import 'monaco-editor/features/register.all.js';

// syntax only (Monarch tokenizers), no language server behind them
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/definitions/ini/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/html/register.js';

// json is the one config format worth a real language service: a plugin config
// with a trailing comma is a server that will not boot, and this reports it
// in-editor rather than at the next restart. Imported from `languages/features`
// rather than the `language/json` compatibility shim, which ships no typings.
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js';

import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';

/** The console's own theme, built from the tokens in `app.scss`. */
const LUNA_THEME = 'luna-dark';

let ready = false;

/**
 * Monaco's `properties` tokenizer. It ships an `ini` one, which is close but
 * treats `[section]` as the only structure and misses that a Minecraft
 * properties file escapes its separators (`level-type=minecraft\:flat`).
 */
function registerProperties(): void {
	monaco.languages.register({ id: 'properties', extensions: ['.properties', '.lang'] });

	monaco.languages.setMonarchTokensProvider('properties', {
		tokenizer: {
			root: [
				[/^[#!].*$/, 'comment'],
				[/^[^=:\r\n]+(?=[=:])/, 'key'],
				[/[=:]/, 'delimiter'],
				[/\\./, 'string.escape'],
				[/.+$/, 'string']
			]
		}
	});

	monaco.languages.setLanguageConfiguration('properties', {
		comments: { lineComment: '#' }
	});
}

/**
 * Load Monaco once and return its API. Repeat calls are cheap — the theme and
 * the language registrations are idempotent by construction, but doing them
 * twice would still reset an open editor's colours.
 */
export async function loadMonaco(): Promise<typeof monaco> {
	if (ready) {
		return monaco;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(self as any).MonacoEnvironment = {
		getWorker(_id: string, label: string) {
			if (label === 'json') {
				return new JsonWorker();
			}

			return new EditorWorker();
		}
	};

	registerProperties();

	jsonDefaults.setDiagnosticsOptions({
		validate: true,
		// a plugin's config is not described by a schema we hold, so "unknown
		// property" would be noise on every file
		allowComments: true,
		schemaValidation: 'ignore'
	});

	monaco.editor.defineTheme(LUNA_THEME, {
		base: 'vs-dark',
		inherit: true,
		rules: [
			{ token: '', foreground: 'c6c6cd' },
			{ token: 'comment', foreground: '5f6b7a', fontStyle: 'italic' },
			{ token: 'key', foreground: '42b4ff' },
			{ token: 'type', foreground: '42b4ff' },
			{ token: 'string', foreground: 'c6c6cd' },
			{ token: 'string.yaml', foreground: 'c6c6cd' },
			{ token: 'string.escape', foreground: 'e0ca57' },
			{ token: 'number', foreground: 'ff9900' },
			{ token: 'keyword', foreground: 'e0ca57' },
			{ token: 'delimiter', foreground: 'a4a4ad' },
			{ token: 'tag', foreground: '42b4ff' },
			{ token: 'attribute.name', foreground: '42b4ff' },
			{ token: 'attribute.value', foreground: 'c6c6cd' }
		],
		colors: {
			'editor.background': '#0b0f14',
			'editor.foreground': '#c6c6cd',
			'editorLineNumber.foreground': '#3d4757',
			'editorLineNumber.activeForeground': '#a4a4ad',
			'editor.lineHighlightBackground': '#131920',
			'editor.selectionBackground': '#213a59',
			'editor.inactiveSelectionBackground': '#1a2330',
			'editorCursor.foreground': '#ff9900',
			'editorIndentGuide.background1': '#1f2733',
			'editorIndentGuide.activeBackground1': '#414d5c',
			'editorWidget.background': '#161d26',
			'editorWidget.border': '#232b37',
			'editorSuggestWidget.background': '#1b232d',
			'editorSuggestWidget.selectedBackground': '#232b37',
			'editorHoverWidget.background': '#1b232d',
			'input.background': '#0f1b2a',
			'input.border': '#7d8998',
			'scrollbarSlider.background': '#47546a55',
			'scrollbarSlider.hoverBackground': '#47546a88',
			'scrollbarSlider.activeBackground': '#47546aaa',
			'editorOverviewRuler.border': '#232b37',
			'editorGutter.background': '#0b0f14',
			'editorError.foreground': '#ff7a7a',
			'editorWarning.foreground': '#e0ca57'
		}
	});

	ready = true;

	return monaco;
}

export { LUNA_THEME };
export type Monaco = typeof monaco;
export type StandaloneEditor = monaco.editor.IStandaloneCodeEditor;
