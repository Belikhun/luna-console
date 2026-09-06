<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import MinecraftItem from './MinecraftItem.svelte';
	import ItemTooltip from './ItemTooltip.svelte';
	import { EQUIPMENT_SLOTS, ENDER_CHEST_SLOTS, INVENTORY_SLOTS, idLabel } from '$core/playerdata';
	import type { EquipmentSlot, PlayerItem } from '$core/playerdata';

	/**
	 * A player's inventory as the inventory screen lays it out: the four armour
	 * slots and the offhand down the left, the 3×9 main grid, the hotbar under it
	 * with the selected slot marked; and the ender chest as its own 3×9 below.
	 *
	 * Slots are drawn in CSS rather than on the container texture, because the
	 * asset extractor keeps only the double-chest sheet and the inventory screen
	 * has no fixed frame worth reproducing: what matters is the grid the player
	 * knows, and the items in it, which `MinecraftItem` draws from the real models.
	 * `--gui-px` is published so the tooltip's own game-pixel metrics follow the
	 * slot size, exactly as the selector's chest does.
	 */
	let {
		inventory,
		equipment,
		enderChest,
		selectedSlot = 0,
		slot = '2.75rem'
	}: {
		inventory: PlayerItem[];
		equipment: Partial<Record<EquipmentSlot, PlayerItem>>;
		enderChest: PlayerItem[];
		/** Hotbar slot the player is holding, 0-8 */
		selectedSlot?: number;
		/** Side of one slot, as a CSS length */
		slot?: string;
	} = $props();

	const COLS = 9;
	const HOTBAR = 9;

	const bySlot = $derived(new Map(inventory.map((item) => [item.slot, item])));
	const enderBySlot = $derived(new Map(enderChest.map((item) => [item.slot, item])));

	/** Main grid rows top to bottom are slots 9-35; the hotbar is 0-8 under them. */
	const mainSlots = $derived(
		Array.from({ length: INVENTORY_SLOTS - HOTBAR }, (_, index) => index + HOTBAR)
	);
	const hotbarSlots = Array.from({ length: HOTBAR }, (_, index) => index);
	const enderSlots = Array.from({ length: ENDER_CHEST_SLOTS }, (_, index) => index);

	let hovered: PlayerItem | null = $state(null);
	let tipLeft = $state(0);
	let tipTop = $state(0);

	function enter(item: PlayerItem | undefined, event: MouseEvent): void {
		hovered = item ?? null;
		move(event);
	}

	function move(event: MouseEvent): void {
		// px, not rem: this is the pointer's own position, converted on the way in
		tipLeft = event.clientX + 12;
		tipTop = event.clientY - 8;
	}

	function leave(): void {
		hovered = null;
	}

	/** `minecraft:diamond_helmet` → `DIAMOND_HELMET`, which is how the registry keys items. */
	function material(item: PlayerItem): string {
		return item.id.replace(/^minecraft:/, '').toUpperCase();
	}

	function enchanted(item: PlayerItem): boolean {
		return Object.keys(item.enchantments).length > 0;
	}

	const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

	function roman(level: number): string {
		return ROMAN[level] ?? String(level);
	}

	/** Text the tooltip parser must not read as tags. */
	function safe(text: string): string {
		return text.replace(/[<>]/g, '');
	}

	/** The game's own tooltip: name, enchantments, lore, durability, id. */
	function tooltipName(item: PlayerItem): string {
		const name = safe(item.customName ?? idLabel(item.id));
		const color = item.customName ? '<italic>' : enchanted(item) ? '<aqua>' : '<white>';

		return `${color}${name}`;
	}

	function tooltipLore(item: PlayerItem): string[] {
		const lines: string[] = [];

		for (const [id, level] of Object.entries(item.enchantments)) {
			lines.push(`<gray>${safe(idLabel(id))} ${roman(level)}`);
		}

		for (const line of item.lore) {
			lines.push(`<dark_purple><italic>${safe(line)}`);
		}

		if (item.contents && item.contents.length > 0) {
			for (const inner of item.contents.slice(0, 6)) {
				lines.push(`<white>${safe(inner.customName ?? idLabel(inner.id))} <gray>x${inner.count}`);
			}

			if (item.contents.length > 6) {
				lines.push(`<italic><gray>${t('web.inventory.andMore', { count: item.contents.length - 6 })}`);
			}
		}

		if (item.damage !== undefined && item.maxDamage !== undefined) {
			lines.push(`<white>${t('web.inventory.durability', { left: item.maxDamage - item.damage, max: item.maxDamage })}`);
		} else if (item.damage !== undefined && item.damage > 0) {
			lines.push(`<white>${t('web.inventory.damageTaken', { damage: item.damage })}`);
		}

		// a plugin's own item rides on a vanilla one through custom data; the id it
		// keeps there (`nova.id`, and the same shape for anything else) is the name
		// the operator knows the item by
		for (const [owner, value] of Object.entries(item.customData ?? {})) {
			const id = (value as { id?: unknown } | null)?.id;

			if (typeof id === 'string') {
				lines.push(`<gray>${safe(owner)}: <white>${safe(id)}`);
			}
		}

		lines.push(`<dark_gray>${safe(item.id)}`);

		return lines;
	}
</script>

<div class="inventory" style:--slot={slot} style:--gui-px="calc({slot} / 18)">
	<div class="screen">
		<div class="column equipment">
			{#each EQUIPMENT_SLOTS as key}
				{@const item = equipment[key]}
				<div class="cell {key}" title={t(`web.inventory.slot.${key}`)}>
					{#if item}
						<button
							type="button"
							class="item"
							onmouseenter={(event) => enter(item, event)}
							onmousemove={move}
							onmouseleave={leave}
						>
							<MinecraftItem item={material(item)} glint={enchanted(item)} size="calc(var(--slot) * 0.8)" />
							{#if item.count > 1}
								<span class="count">{item.count}</span>
							{/if}
						</button>
					{:else}
						<span class="empty-mark">{t(`web.inventory.slotShort.${key}`)}</span>
					{/if}
				</div>
			{/each}
		</div>

		<div class="column main">
			<div class="grid" style:grid-template-columns="repeat({COLS}, var(--slot))">
				{#each mainSlots as index}
					{@render cell(bySlot.get(index), false)}
				{/each}
			</div>
			<div class="grid hotbar" style:grid-template-columns="repeat({COLS}, var(--slot))">
				{#each hotbarSlots as index}
					{@render cell(bySlot.get(index), index === selectedSlot)}
				{/each}
			</div>
		</div>
	</div>

	<div class="ender">
		<div class="ender-title">{t('web.inventory.enderChest')}</div>
		<div class="grid" style:grid-template-columns="repeat({COLS}, var(--slot))">
			{#each enderSlots as index}
				{@render cell(enderBySlot.get(index), false)}
			{/each}
		</div>
	</div>

	{#if hovered}
		<div class="tip" style:left="{tipLeft}px" style:top="{tipTop}px">
			<ItemTooltip name={tooltipName(hovered)} lore={tooltipLore(hovered)} />
		</div>
	{/if}
</div>

{#snippet cell(item: PlayerItem | undefined, selected: boolean)}
	<div class="cell" class:selected>
		{#if item}
			<button
				type="button"
				class="item"
				onmouseenter={(event) => enter(item, event)}
				onmousemove={move}
				onmouseleave={leave}
			>
				<MinecraftItem item={material(item)} glint={enchanted(item)} size="calc(var(--slot) * 0.8)" />
				{#if item.count > 1}
					<span class="count">{item.count}</span>
				{/if}
				{#if item.damage !== undefined && item.maxDamage !== undefined && item.damage > 0}
					<span
						class="durability"
						class:low={item.damage / item.maxDamage > 0.75}
						style:--left="{Math.max(0, 1 - item.damage / item.maxDamage) * 100}%"
					></span>
				{/if}
			</button>
		{/if}
	</div>
{/snippet}

<style lang="scss">
	.inventory {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		position: relative;
	}

	.screen {
		display: flex;
		gap: 1rem;
		align-items: flex-start;
		flex-wrap: wrap;
	}

	.column {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.equipment {
		gap: 0.125rem;

		// the offhand sits apart from the armour, as it does on the screen
		.cell.offhand {
			margin-top: 0.5rem;
		}
	}

	.grid {
		display: grid;
		gap: 0.125rem;
	}

	// the slot bevel: dark inset over the panel grey, the way the GUI draws it
	.cell {
		width: var(--slot);
		height: var(--slot);
		box-sizing: border-box;
		background: var(--bg-terminal);
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.125rem;
		display: flex;
		align-items: center;
		justify-content: center;
		position: relative;

		&.selected {
			outline: 0.125rem solid var(--text-heading);
			outline-offset: 0.0625rem;
		}
	}

	.item {
		@include bare-button;
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		position: relative;
		cursor: default;
	}

	.count {
		position: absolute;
		right: 0.125rem;
		bottom: 0;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		font-weight: 700;
		color: #fff;
		text-shadow: 0.0625rem 0.0625rem 0 #3f3f3f;
		line-height: 1;
	}

	// the durability bar, drawn under the item as the game does
	.durability {
		position: absolute;
		left: 12%;
		right: 12%;
		bottom: 12%;
		height: 0.125rem;
		background: #2b2b2b;

		&::after {
			content: '';
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: var(--left);
			background: var(--success);
		}

		&.low::after {
			background: var(--error);
		}
	}

	.empty-mark {
		font-size: 0.625rem;
		color: var(--text-secondary);
		opacity: 0.5;
		text-transform: uppercase;
		letter-spacing: 0.0625rem;
	}

	.ender-title {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		margin-bottom: 0.375rem;
	}

	.tip {
		position: fixed;
		z-index: 40;
		pointer-events: none;
	}
</style>
