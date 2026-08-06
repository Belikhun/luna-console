<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Icon from './Icon.svelte';
	import Dropdown from './Dropdown.svelte';
	import ShellGlyph from './ShellGlyph.svelte';
	import Terminal from './Terminal.svelte';

	/**
	 * Terminal drawer: a grip row that resizes the panel and closes it, a header
	 * carrying the mark, title, Actions menu and window tools, then the session
	 * tab strip (underline indicator, per-tab close, "+" to add). Every session
	 * stays mounted so switching tabs never loses terminal state.
	 */
	let {
		height = $bindable(320),
		user = 'root',
		onclose
	}: {
		height?: number;
		/** whose prompt this is; the signed-in console account, or `root` in a shell */
		user?: string;
		onclose: () => void;
	} = $props();

	interface ShellTab {
		id: number;
		name: string;
	}

	/** status bar height, in px; the drawer's bottom edge sits on top of it */
	const STATUSBAR_H = 28;
	const MIN_HEIGHT = 160;

	let nextId = 2;
	let tabs: ShellTab[] = $state([{ id: 1, name: 'shell-1' }]);
	let active = $state(1);
	let dragging = $state(false);
	/** distance from the pointer to the drawer's top edge when the drag started */
	let grabOffset = 0;

	function addTab(): void {
		const id = nextId++;

		tabs = [...tabs, { id, name: `shell-${id}` }];
		active = id;
	}

	/** Closing the last tab closes the drawer with it. */
	function closeTab(id: number, event?: Event): void {
		event?.stopPropagation();

		tabs = tabs.filter((tab) => tab.id !== id);

		if (tabs.length === 0) {
			onclose();

			return;
		}

		if (active === id) {
			active = tabs[tabs.length - 1]!.id;
		}
	}

	function startDrag(event: PointerEvent): void {
		event.preventDefault();

		const drawer = (event.currentTarget as HTMLElement).closest('.shell')!;

		grabOffset = event.clientY - drawer.getBoundingClientRect().top;
		dragging = true;
	}

	/**
	 * The grip sits inside the drawer rather than on its edge, so resizing has to
	 * preserve the pointer's offset from the top edge; otherwise the drawer jumps
	 * up by the grip row's height on the first move.
	 */
	function onPointerMove(event: PointerEvent): void {
		if (!dragging) {
			return;
		}

		const bottom = window.innerHeight - STATUSBAR_H;
		const top = event.clientY - grabOffset;
		const maxHeight = window.innerHeight - MIN_HEIGHT;

		height = Math.min(Math.max(bottom - top, MIN_HEIGHT), maxHeight);
	}
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={() => (dragging = false)} />

<div class="shell" class:dragging style="height: {height}px">
	<div class="grip-row" role="presentation" onpointerdown={startDrag}>
		<span class="grip">
			<svg viewBox="0 0 16 16" aria-hidden="true">
				<path d="M3 6.5H13" />
				<path d="M3 9.5H13" />
			</svg>
		</span>
		<button class="tool close" title={t('web.terminal.closeTerminal')} onclick={onclose}>
			<Icon name="close" size="0.875rem" />
		</button>
	</div>

	<div class="hd">
		<span class="title"><ShellGlyph size="1.125rem" /> {t('web.layout.terminal')}</span>
		<span class="spacer"></span>
		<Dropdown
			label={t('web.common.actions')}
			items={[
				{ label: t('web.terminal.newTab'), icon: 'plus', action: addTab },
				{ label: t('web.terminal.closeTab'), icon: 'close', action: () => closeTab(active) },
				{ divider: true, label: '' },
				{ label: t('web.terminal.closeAllTabs'), icon: 'trash', danger: true, action: onclose }
			]}
		/>
		<button
			class="tool"
			title={t('web.terminal.openNewWindow')}
			onclick={() => window.open('/instances', '_blank')}
		>
			<Icon name="expand" size="1rem" />
		</button>
		<button class="tool" title={t('web.table.preferences')}>
			<Icon name="gear" size="1rem" style="solid" />
		</button>
	</div>

	<div class="tabs" role="tablist">
		{#each tabs as tab (tab.id)}
			<div class="tab" class:active={active === tab.id}>
				<button
					class="tlink"
					role="tab"
					aria-selected={active === tab.id}
					onclick={() => (active = tab.id)}
				>
					{tab.name}
				</button>
				<button class="x" title={t('web.terminal.closeTab')} onclick={(event) => closeTab(tab.id, event)}>
					<Icon name="close" size="0.75rem" />
				</button>
			</div>
		{/each}
		<button class="add" title="New shell tab" onclick={addTab}>
			<Icon name="plus" size="1rem" />
		</button>
	</div>

	<div class="body">
		{#each tabs as tab (tab.id)}
			<div class="session" class:hidden={active !== tab.id}>
				<Terminal {user} />
			</div>
		{/each}
	</div>
</div>

<style lang="scss">
	.shell {
		flex: none;
		display: flex;
		flex-direction: column;
		border-top: 0.1rem solid var(--border-drawer);
		background: var(--bg-panel);
		min-height: 10rem;
		position: relative;
	}
	.shell.dragging {
		user-select: none;

		.grip {
			color: var(--link);
		}
	}

	// grip row: its own darker band so the drag target reads as a bar rather than
	// dead space above the header
	.grip-row {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		height: 2rem;
		flex: none;
		background: var(--bg-table-header);
		border-bottom: 0.1rem solid var(--border-divider);
		cursor: row-resize;

		&:hover .grip {
			color: var(--link);
		}

		.close {
			position: absolute;
			top: 50%;
			right: 0.75rem;
			transform: translateY(-50%);
			padding: 0.125rem;
		}
	}

	.grip {
		display: inline-flex;
		color: var(--text-heading);

		svg {
			width: 1.25rem;
			height: 1.25rem;
			fill: none;
			stroke: currentColor;
			stroke-width: 2;
			stroke-linecap: round;
		}
	}

	.hd {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1.25rem 0.625rem;
		flex: none;
	}
	.title {
		display: inline-flex;
		align-items: center;
		gap: 0.625rem;
		color: var(--text-heading);
		font-size: 1rem;
		font-weight: 700;
	}
	.spacer {
		flex: 1;
	}

	.tool {
		@include bare-button;

		color: var(--text);
		padding: 0.25rem;
		border-radius: 0.25rem;
		display: inline-flex;

		&:hover {
			color: var(--link);
		}
	}

	// session tabs: underline indicator riding a full-width rule
	.tabs {
		display: flex;
		align-items: stretch;
		gap: 0.25rem;
		padding: 0 1.25rem;
		border-bottom: 0.1rem solid var(--border-divider);
		overflow-x: auto;
		overflow-y: hidden;
		flex: none;
	}
	.tab {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.75rem;
		padding: 0 0.75rem;
		user-select: none;

		// the active indicator overlaps the strip's bottom rule
		&::after {
			content: '';
			position: absolute;
			left: 0;
			right: 0;
			bottom: 0;
			height: 0.25rem;
			background: transparent;
		}

		.x {
			opacity: 0;
		}

		&:hover,
		&.active {
			.tlink {
				color: var(--link);
			}

			.x {
				opacity: 1;
			}
		}

		&.active::after {
			background: var(--link);
		}
	}

	.tlink {
		background: none;
		border: none;
		font-family: var(--font);
		font-size: 0.875rem;
		font-weight: 700;
		color: var(--text-heading);
		padding: 0.75rem 0;
		cursor: pointer;
		white-space: nowrap;
	}

	.add {
		@include bare-button;

		align-self: center;
		color: var(--link);
		padding: 0.25rem;
		display: inline-flex;
		border-radius: 0.25rem;

		&:hover {
			background: color-mix(in srgb, var(--link) 12%, transparent);
		}
	}

	.x {
		@include bare-button;

		align-self: center;
		color: var(--text-secondary);
		padding: 0.125rem;
		display: inline-flex;
		border-radius: 0.25rem;

		&:hover {
			color: var(--link);
		}
	}

	.body {
		flex: 1;
		min-height: 0;
		position: relative;
		background: var(--bg-terminal);
	}

	// every session stays mounted, so switching tabs never loses terminal state
	.session {
		@include fill;

		&.hidden {
			visibility: hidden;
			pointer-events: none;
		}
	}
</style>
