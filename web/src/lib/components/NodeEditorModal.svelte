<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';
	import Select from './Select.svelte';
	import Toggle from './Toggle.svelte';
	import type { NodeSpec, EditableNode } from './nodes';

	/**
	 * Create or edit one LuckPerms node: key, grant/negate, context pairs and
	 * expiry. The modal only collects the node; the caller applies it (and,
	 * when editing, removes the original first), because group and user nodes
	 * go to different endpoints.
	 */

	let {
		open = $bindable(false),
		node = null,
		servers = [],
		onsubmit
	}: {
		open?: boolean;
		/** the node being edited, or null to create one */
		node?: EditableNode | null;
		/** backend names offered by the server-context shortcut */
		servers?: string[];
		onsubmit: (spec: NodeSpec) => void;
	} = $props();

	const EXPIRY_UNITS = [
		{ value: '0', label: t('web.nodeEditor.permanent') },
		{ value: '60', label: t('web.nodeEditor.minutes') },
		{ value: '3600', label: t('web.nodeEditor.hours') },
		{ value: '86400', label: t('web.nodeEditor.days') }
	];

	let key = $state('');
	let grant = $state(true);
	let expiryAmount = $state(1);
	let expiryUnit = $state('0');
	let contexts: Array<{ key: string; value: string }> = $state([]);

	/** Re-seed the form whenever the dialog opens for a (different) node. */
	$effect(() => {
		if (!open) {
			return;
		}

		key = node?.key ?? '';
		grant = node?.value ?? true;
		contexts = (node?.contexts ?? []).map((pair) => ({ ...pair }));

		const remainingSeconds = node?.expiryEpochMillis
			? Math.max(0, Math.floor((node.expiryEpochMillis - Date.now()) / 1000))
			: 0;

		if (remainingSeconds >= 86400) {
			expiryUnit = '86400';
			expiryAmount = Math.round(remainingSeconds / 86400);
		} else if (remainingSeconds >= 3600) {
			expiryUnit = '3600';
			expiryAmount = Math.round(remainingSeconds / 3600);
		} else if (remainingSeconds > 0) {
			expiryUnit = '60';
			expiryAmount = Math.max(1, Math.round(remainingSeconds / 60));
		} else {
			expiryUnit = '0';
			expiryAmount = 1;
		}
	});

	function addContext(contextKey = '', contextValue = ''): void {
		contexts = [...contexts, { key: contextKey, value: contextValue }];
	}

	function removeContext(index: number): void {
		contexts = contexts.filter((_, position) => position !== index);
	}

	const valid = $derived(
		key.trim().length > 0 &&
			contexts.every((pair) => pair.key.trim() && pair.value.trim()) &&
			(expiryUnit === '0' || expiryAmount > 0)
	);

	function submit(): void {
		const spec: NodeSpec = {
			key: key.trim(),
			value: grant,
			expirySeconds: expiryUnit === '0' ? 0 : Math.round(expiryAmount * Number(expiryUnit)),
			contexts: Object.fromEntries(
				contexts.map((pair) => [pair.key.trim(), pair.value.trim()])
			)
		};

		open = false;
		onsubmit(spec);
	}
</script>

<Modal title={node ? t('web.nodeEditor.editNode') : t('web.nodeEditor.addNode')} bind:open>
	<label class="field">
		<span class="lbl">{t('web.nodeEditor.nodeKey')}</span>
		<span class="hint">e.g. <code>{t('web.nodeEditor.minecraftCommandGamemode')}</code>{t('web.nodeEditor.or')} <code>group.&lt;name&gt;</code> {t('web.nodeEditor.forInheritance')}</span>
		<input class="input mono" bind:value={key} placeholder={t('web.nodeEditor.permissionNodeKey')} />
	</label>

	<div class="field">
		<span class="lbl">{t('web.nodeEditor.value')}</span>
		<label class="grant">
			<Toggle checked={grant} onchange={(checked) => (grant = checked)} />
			<span>{grant ? 'Granted; the permission is given' : 'Negated; the permission is explicitly denied'}</span>
		</label>
	</div>

	<div class="field">
		<span class="lbl">{t('web.nodeEditor.contexts')}</span>
		<span class="hint">{t('web.nodeEditor.theNodeOnlyApplies')}</span>
		{#each contexts as pair, index}
			<div class="ctxrow">
				<input class="input mono ctxkey" bind:value={pair.key} placeholder={t('web.nodeEditor.key')} />
				<span class="dim">=</span>
				<input class="input mono ctxval" bind:value={pair.value} placeholder={t('web.nodeEditor.value')} />
				<Btn variant="icon" icon="close" title={t('web.nodeEditor.removeContext')} onclick={() => removeContext(index)} />
			</div>
		{/each}
		<div class="ctxadd">
			<Btn icon="plus" onclick={() => addContext()}>{t('web.nodeEditor.addContext')}</Btn>
			{#if servers.length > 0 && !contexts.some((pair) => pair.key === 'server')}
				<Select
					value=""
					width="13rem"
					options={[
						{ value: '', label: t('web.nodeEditor.limitToServer') },
						...servers.map((server) => ({ value: server, label: `server=${server}` }))
					]}
					onchange={(value) => {
						if (value) {
							addContext('server', value);
						}
					}}
				/>
			{/if}
		</div>
	</div>

	<div class="field">
		<span class="lbl">{t('web.nodeEditor.expiry')}</span>
		<div class="expiry">
			<Select bind:value={expiryUnit} width="9rem" options={EXPIRY_UNITS} />
			{#if expiryUnit !== '0'}
				<input class="input num" type="number" min="1" bind:value={expiryAmount} />
			{/if}
		</div>
	</div>

	{#snippet footer()}
		<Btn onclick={() => (open = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" disabled={!valid} onclick={submit}>
			{node ? t('web.nodeEditor.saveNode') : t('web.nodeEditor.addNode')}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-bottom: 1rem;

		&:last-child {
			margin-bottom: 0;
		}
	}

	.lbl {
		font-weight: 700;
		color: var(--text-heading);
	}

	.hint {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.grant {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
	}

	.ctxrow {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;

		.ctxkey {
			width: 9rem;
		}

		.ctxval {
			flex: 1;
		}
	}

	.ctxadd {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.expiry {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.num {
		width: 7rem;
	}
</style>
