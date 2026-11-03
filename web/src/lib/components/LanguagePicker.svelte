<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { LANGUAGES, currentLanguage, switchLanguage } from '$lib/i18n.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import type { ContextMenuItem } from './contextmenu';
	import Icon from './Icon.svelte';

	/**
	 * The console's language picker: the current language as a quiet trigger
	 * opening the console's own menu rather than the browser's select, so it
	 * looks the same in both themes and on every platform. The status bar
	 * opens it upwards; the sign-in page, which has it at the top, downwards.
	 */
	let { placement = 'top' }: { placement?: 'top' | 'bottom' } = $props();

	let menu: ContextMenu | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();

	const items: ContextMenuItem[] = $derived(
		LANGUAGES.map((lang) => ({
			id: lang.code,
			label: lang.label,
			// the check marks the language in effect, exactly as Select marks its row
			icon: lang.code === currentLanguage() ? 'check' : undefined,
			action: () => switchLanguage(lang.code)
		}))
	);

	async function toggle(event: MouseEvent): Promise<void> {
		event.stopPropagation();

		if (menu?.isOpen()) {
			menu.close();

			return;
		}

		if (trigger) {
			await menu?.openAtElement(trigger, placement);
		}
	}
</script>

<button
	class="langpick"
	bind:this={trigger}
	onpointerdown={(event) => event.stopPropagation()}
	onclick={toggle}
>
	<Icon name="globe" size="0.75rem" style="solid" />
	{LANGUAGES.find((lang) => lang.code === currentLanguage())?.label}
	<Icon name="caretDown" size="0.625rem" style="solid" />
</button>
<ContextMenu bind:this={menu} {items} minWidth="9rem" />

<style lang="scss">
	.langpick {
		@include bare-button;

		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--text);
		font-size: 0.6875rem;
		cursor: pointer;

		&:hover {
			color: var(--link);
		}

		&:focus-visible {
			@include focus-ring;
		}
	}
</style>
