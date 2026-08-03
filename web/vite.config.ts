import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/** every `<style lang="scss">` block gets the shared partial for free */
const STYLE_ROOT = resolve(import.meta.dirname, 'src/lib/styles');

/**
 * The dev server keeps its generated route manifest in its own directory.
 * `vite build` and `svelte-check` both regenerate SvelteKit's `outDir`, and
 * doing that underneath a running dev server leaves its client node table
 * pointing at the wrong `+page.svelte` — pages then load as unrelated routes
 * until it is restarted. Separate directories make the two safe to run at once.
 */
export default defineConfig(({ command }) => ({
	plugins: [
		sveltekit({
			outDir: command === 'serve' ? '.svelte-kit-dev' : '.svelte-kit',
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			preprocess: vitePreprocess(),
			alias: {
				// routes talk to the daemon: $core is the client bridge mirroring
				// the core modules over the daemon socket (DESIGN.md §4.3)
				$core: resolve(import.meta.dirname, '../src/client/core'),
				$client: resolve(import.meta.dirname, '../src/client'),
				// pure logic both sides need — safe to import from a component, unlike
				// $core, which reaches the daemon over a unix socket
				$shared: resolve(import.meta.dirname, '../src/shared')
			}
		})
	],

	build: {
		// Vite leaves SSR output unminified by default, which is wrong for us: the
		// server bundle is what ships inside the container image, and unminified it
		// carries every JSDoc block, every `//` comment and a `//#region src/…`
		// marker per module — the source tree's layout and intent, published.
		minify: true
	},

	css: {
		preprocessorOptions: {
			scss: {
				loadPaths: [STYLE_ROOT],
				additionalData: '@use \'shared\' as *;\n'
			}
		}
	},

	server: {
		fs: {
			// allow the dev server to import ../src/core
			allow: [resolve(import.meta.dirname, '..')]
		}
	}
}));
