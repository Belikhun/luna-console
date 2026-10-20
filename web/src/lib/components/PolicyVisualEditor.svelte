<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { api } from '$lib/api';
	import Btn from './Btn.svelte';
	import Checkbox from './Checkbox.svelte';
	import Icon from './Icon.svelte';
	import Select from './Select.svelte';
	import SearchInput from './SearchInput.svelte';
	import { IAM_SERVICES, actionLabelKey, actionsOf, type IamActionSpec } from '$shared/iam/actions';
	import { CONDITION_KEYS, CONDITION_OPERATORS, type ConditionOperator, type PolicyDocument } from '$shared/iam/grammar';
	import { SUMMARY_ACCESS_LEVELS, accessLevelOf, type SummaryAccessLevel } from '$shared/iam/summary';
	import { policyToYaml } from '$shared/iam/yaml';
	import {
		blocksFromDocument,
		documentFromBlocks,
		duplicateBlock,
		emptyBlock,
		filterActions,
		serviceLabel,
		serviceResourceType,
		visualId,
		type VisualBlock
	} from './policyvisual';

	/**
	 * The visual policy editor, AWS's: one collapsible block per statement,
	 * titled by its service, holding the service, the actions grouped by access
	 * level, the resources and the optional request conditions.
	 *
	 * It edits a document, not text: `document` is read once when the editor
	 * mounts and every change is handed back through `onchange`, which the
	 * owning `PolicyEditor` writes out as YAML. A statement the form cannot show
	 * stays exactly as it came, behind a card saying so.
	 */
	let {
		document,
		onchange
	}: {
		/** the starting document; read once, so remount the editor to load another */
		document: PolicyDocument;
		onchange: (document: PolicyDocument) => void;
	} = $props();

	let blocks: VisualBlock[] = $state(untrack(() => blocksFromDocument(document)));

	/** access levels folded shut, keyed `<block id>:<level>` */
	let folded: Record<string, boolean> = $state({});

	/** existing resources per type, for the "pick an existing one" list */
	let known: Record<string, Array<{ id: string; name: string }>> = $state({});
	let loadingTypes: Record<string, boolean> = $state({});

	$effect(() => {
		onchange(documentFromBlocks(blocks));
	});

	const serviceOptions = $derived(
		IAM_SERVICES.map((service) => ({ value: service, label: `${serviceLabel(service)} (${service})` }))
	);

	const operatorOptions = $derived(CONDITION_OPERATORS.map((operator) => ({ value: operator, label: operator })));

	const keyOptions = $derived(
		CONDITION_KEYS.map((key) => ({ value: key, label: key.replace('<k>', t('web.policyVisual.tagKeyToken')) }))
	);

	const levelLabels: Record<SummaryAccessLevel, string> = $derived({
		List: t('web.policySummary.levelList'),
		Read: t('web.policySummary.levelRead'),
		Write: t('web.policySummary.levelWrite'),
		Delete: t('web.policySummary.levelDelete')
	});

	function actionText(spec: IamActionSpec): string {
		const key = actionLabelKey(spec);
		const label = t(key);

		return label === key
			? spec.verb
			: label;
	}

	function levelsOf(service: string): Array<{ level: SummaryAccessLevel; specs: IamActionSpec[] }> {
		const specs = actionsOf(service);

		return SUMMARY_ACCESS_LEVELS
			.map((level) => ({ level, specs: specs.filter((spec) => accessLevelOf(spec) === level) }))
			.filter((group) => group.specs.length > 0);
	}

	function setService(block: VisualBlock, service: string): void {
		if (block.service === service) {
			return;
		}

		block.service = service;
		block.all = false;
		block.actions = [];
		block.resourceMode = 'all';
		block.resources = [];
	}

	function toggleAction(block: VisualBlock, name: string, checked: boolean): void {
		if (checked) {
			if (!block.actions.includes(name)) {
				block.actions = [...block.actions, name];
			}

			return;
		}

		block.actions = block.actions.filter((entry) => entry !== name);
	}

	function toggleLevel(block: VisualBlock, specs: IamActionSpec[], checked: boolean): void {
		const names = specs.map((spec) => spec.name);

		block.actions = checked
			? [...new Set([...block.actions, ...names])]
			: block.actions.filter((entry) => !names.includes(entry));
	}

	function toggleAll(block: VisualBlock, checked: boolean): void {
		block.all = checked;

		if (checked) {
			block.actions = [];
		}
	}

	function addResource(block: VisualBlock): void {
		const type = serviceResourceType(block.service);

		block.resources = [...block.resources, type ? `luna:${type}/` : ''];
	}

	function removeResource(block: VisualBlock, index: number): void {
		block.resources = block.resources.filter((_, position) => position !== index);
	}

	function pickResource(block: VisualBlock, id: string): void {
		if (id && !block.resources.includes(id)) {
			block.resources = [...block.resources.filter((entry) => entry.trim() !== '' && !entry.endsWith('/')), id];
		}
	}

	async function loadKnown(type: string): Promise<void> {
		if (known[type] || loadingTypes[type]) {
			return;
		}

		loadingTypes[type] = true;

		try {
			const data = await api<{ resources: Array<{ id: string; name: string }> }>(
				`/resources?type=${encodeURIComponent(type)}`
			);

			known[type] = data.resources;
		} catch {
			// the list is a convenience; typing an id still works without it
			known[type] = [];
		} finally {
			loadingTypes[type] = false;
		}
	}

	function setResourceMode(block: VisualBlock, mode: 'all' | 'specific'): void {
		block.resourceMode = mode;

		const type = serviceResourceType(block.service);

		if (mode === 'specific' && type) {
			void loadKnown(type);

			if (block.resources.length === 0) {
				addResource(block);
			}
		}
	}

	function addCondition(block: VisualBlock): void {
		block.conditions = [
			...block.conditions,
			{
				id: visualId(),
				template: 'luna:ResourceTag/<k>',
				tagKey: '',
				operator: 'StringEquals',
				ifExists: false,
				values: ''
			}
		];

		block.conditionsOpen = true;
	}

	function removeCondition(block: VisualBlock, id: number): void {
		block.conditions = block.conditions.filter((row) => row.id !== id);
	}

	function duplicate(index: number): void {
		const source = blocks[index];

		if (!source) {
			return;
		}

		blocks = [...blocks.slice(0, index + 1), duplicateBlock(source), ...blocks.slice(index + 1)];
	}

	function remove(index: number): void {
		blocks = blocks.filter((_, position) => position !== index);
	}

	function addStatement(): void {
		blocks = [...blocks, emptyBlock()];
	}

	function blockTitle(block: VisualBlock): string {
		if (block.raw) {
			return block.raw.Sid ?? t('web.policyVisual.statementNumbered', { number: blocks.indexOf(block) + 1 });
		}

		return block.service
			? serviceLabel(block.service)
			: t('web.policyVisual.selectService');
	}

	function pickOptions(block: VisualBlock): Array<{ value: string; label: string }> {
		const type = serviceResourceType(block.service);

		if (!type) {
			return [];
		}

		return (known[type] ?? [])
			.filter((entry) => !block.resources.includes(entry.id))
			.map((entry) => ({ value: entry.id, label: entry.name }));
	}
</script>

<div class="visual">
	{#each blocks as block, index (block.id)}
		<section class="block" class:deny={block.effect === 'Deny'}>
			<header>
				<button class="fold" aria-expanded={block.open} onclick={() => (block.open = !block.open)}>
					<span class="caret" class:open={block.open}><Icon name="arrowRight" size="0.75rem" style="solid" /></span>
					<span class="title">{blockTitle(block)}</span>
					{#if block.service && !block.raw}
						<span class="mono dim svc">{block.service}</span>
					{/if}
					<span class="effect" class:deny={block.effect === 'Deny'}>
						{block.effect === 'Deny' ? t('web.policyVisual.deny') : t('web.policyVisual.allow')}
					</span>
				</button>
				<span class="tools">
					<Btn variant="icon" icon="copy" title={t('web.policyVisual.duplicate')} onclick={() => duplicate(index)} />
					<Btn variant="icon" icon="trash" title={t('web.policyVisual.remove')} onclick={() => remove(index)} />
				</span>
			</header>

			{#if block.open}
				<div class="body">
					{#if block.raw}
						<div class="unsupported">
							<Icon name="triangleExclamation" size="0.875rem" style="solid" />
							<span>{t(block.unsupported)} {t('web.policyVisual.unsupportedKeep')}</span>
						</div>
						<pre class="mono raw">{policyToYaml({ Version: 1, Statement: [block.raw] })}</pre>
					{:else}
						<div class="row">
							<Select
								label={t('web.policyVisual.service')}
								value={block.service}
								options={serviceOptions}
								width="22rem"
								searchable
								onchange={(value) => setService(block, value)}
							/>
						</div>

						{#if block.service}
							{@const resourceType = serviceResourceType(block.service)}
							<div class="group">
								<div class="ghead">
									<h4>{t('web.policyVisual.actionsAllowed')}</h4>
									<span class="dim">{t('web.policyVisual.actionsHint')}</span>
								</div>

								<div class="radios">
									<span class="lbl">{t('web.policyVisual.effect')}</span>
									<label class="choice">
										<Checkbox
											shape="radio"
											checked={block.effect === 'Allow'}
											label={t('web.policyVisual.allow')}
											onchange={() => (block.effect = 'Allow')}
										/>
										<span>{t('web.policyVisual.allow')}</span>
									</label>
									<label class="choice">
										<Checkbox
											shape="radio"
											checked={block.effect === 'Deny'}
											label={t('web.policyVisual.deny')}
											onchange={() => (block.effect = 'Deny')}
										/>
										<span>{t('web.policyVisual.deny')}</span>
									</label>
								</div>

								<SearchInput
									bind:value={block.filter}
									placeholder={t('web.policyVisual.filterActions')}
									width="22rem"
								/>

								<label class="choice allrow">
									<Checkbox
										checked={block.all}
										label={t('web.policyVisual.allActions', { service: serviceLabel(block.service) })}
										onchange={(checked) => toggleAll(block, checked)}
									/>
									<span>
										{t('web.policyVisual.allActions', { service: serviceLabel(block.service) })}
										<span class="mono dim">({block.service}:*)</span>
									</span>
								</label>

								{#each levelsOf(block.service) as group (group.level)}
									{@const shown = filterActions(group.specs, block.filter, actionText)}
									{@const picked = block.all
										? group.specs.length
										: group.specs.filter((spec) => block.actions.includes(spec.name)).length}
									{@const foldKey = `${block.id}:${group.level}`}
									{#if shown.length > 0}
										<div class="level">
											<div class="lhead">
												<button class="fold small" onclick={() => (folded[foldKey] = !folded[foldKey])}>
													<span class="caret" class:open={!folded[foldKey]}>
														<Icon name="arrowRight" size="0.625rem" style="solid" />
													</span>
												</button>
												<Checkbox
													checked={picked === group.specs.length}
													indeterminate={picked > 0 && picked < group.specs.length}
													disabled={block.all}
													label={levelLabels[group.level]}
													onchange={(checked) => toggleLevel(block, group.specs, checked)}
												/>
												<b>{levelLabels[group.level]}</b>
												<span class="dim">{t('web.policyVisual.levelCount', { picked, total: group.specs.length })}</span>
											</div>
											{#if !folded[foldKey]}
												<div class="actions">
													{#each shown as spec (spec.name)}
														<label class="choice action">
															<Checkbox
																checked={block.all || block.actions.includes(spec.name)}
																disabled={block.all}
																label={spec.name}
																onchange={(checked) => toggleAction(block, spec.name, checked)}
															/>
															<span class="atext">
																<span class="mono">{spec.verb}</span>
																<span class="dim">{actionText(spec)}</span>
															</span>
														</label>
													{/each}
												</div>
											{/if}
										</div>
									{/if}
								{/each}
							</div>

							<div class="group">
								<div class="ghead">
									<h4>{t('web.policyVisual.resources')}</h4>
								</div>

								{#if !resourceType}
									<p class="dim note">{t('web.policyVisual.noResourceType')}</p>
								{:else}
									<div class="radios">
										<label class="choice">
											<Checkbox
												shape="radio"
												checked={block.resourceMode === 'all'}
												label={t('web.policyVisual.allResources')}
												onchange={() => setResourceMode(block, 'all')}
											/>
											<span>{t('web.policyVisual.allResources')}</span>
										</label>
										<label class="choice">
											<Checkbox
												shape="radio"
												checked={block.resourceMode === 'specific'}
												label={t('web.policyVisual.specificResources')}
												onchange={() => setResourceMode(block, 'specific')}
											/>
											<span>{t('web.policyVisual.specificResources')}</span>
										</label>
									</div>

									{#if block.resourceMode === 'specific'}
										<p class="dim note">
											{t('web.policyVisual.resourceHint', { type: resourceType })}
										</p>
										{#each block.resources as _, position (position)}
											<div class="resource">
												<input
													class="input mono"
													type="text"
													spellcheck="false"
													autocapitalize="none"
													placeholder="luna:{resourceType}/*"
													bind:value={block.resources[position]}
												/>
												<Btn
													variant="icon"
													icon="close"
													title={t('web.policyVisual.removeResource')}
													onclick={() => removeResource(block, position)}
												/>
											</div>
										{/each}
										<div class="row">
											<Btn icon="plus" onclick={() => addResource(block)}>{t('web.policyVisual.addResource')}</Btn>
											<Select
												label={t('web.policyVisual.pickExisting', { type: resourceType })}
												value=""
												options={pickOptions(block)}
												width="18rem"
												searchable
												disabled={pickOptions(block).length === 0}
												onchange={(value) => pickResource(block, value)}
											/>
										</div>
									{/if}
								{/if}
							</div>

							<div class="group">
								<button class="fold ghead" onclick={() => (block.conditionsOpen = !block.conditionsOpen)}>
									<span class="caret" class:open={block.conditionsOpen}>
										<Icon name="arrowRight" size="0.75rem" style="solid" />
									</span>
									<h4>{t('web.policyVisual.conditions')}</h4>
									<span class="dim">{t('web.policyVisual.optional')}</span>
								</button>

								{#if block.conditionsOpen}
									{#each block.conditions as row (row.id)}
										<div class="condition">
											<Select
												label={t('web.policyVisual.conditionKey')}
												bind:value={row.template}
												options={keyOptions}
												width="15rem"
											/>
											{#if row.template.includes('<k>')}
												<input
													class="input mono tagkey"
													type="text"
													spellcheck="false"
													placeholder={t('web.policyVisual.tagKeyPlaceholder')}
													bind:value={row.tagKey}
												/>
											{/if}
											<Select
												label={t('web.policyVisual.operator')}
												value={row.operator}
												options={operatorOptions}
												width="15rem"
												onchange={(value) => (row.operator = value as ConditionOperator)}
											/>
											<label class="choice">
												<Checkbox
													checked={row.ifExists}
													disabled={row.operator === 'Null'}
													label={t('web.policyVisual.ifExists')}
													onchange={(checked) => (row.ifExists = checked)}
												/>
												<span>{t('web.policyVisual.ifExists')}</span>
											</label>
											<input
												class="input mono values"
												type="text"
												spellcheck="false"
												placeholder={t('web.policyVisual.valuesPlaceholder')}
												bind:value={row.values}
											/>
											<Btn
												variant="icon"
												icon="close"
												title={t('web.policyVisual.removeCondition')}
												onclick={() => removeCondition(block, row.id)}
											/>
										</div>
									{/each}
									<div class="row">
										<Btn icon="plus" onclick={() => addCondition(block)}>{t('web.policyVisual.addCondition')}</Btn>
									</div>
								{/if}
							</div>

							<label class="field sid">
								<span class="lbl">{t('web.policyVisual.sid')}</span>
								<span class="hint">{t('web.policyVisual.sidHint')}</span>
								<input class="input mono" type="text" spellcheck="false" bind:value={block.sid} />
							</label>
						{/if}
					{/if}
				</div>
			{/if}
		</section>
	{/each}

	<div class="more">
		<Btn icon="plus" onclick={addStatement}>{t('web.policyVisual.addStatement')}</Btn>
	</div>
</div>

<style lang="scss">
	.visual {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.block {
		border: 0.1rem solid var(--border-divider);
		border-left: 0.25rem solid var(--success);
		border-radius: var(--radius-container);
		background: var(--bg-panel);

		&.deny {
			border-left-color: var(--error);
		}

		header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.5rem;
			padding: 0.5rem 0.75rem;
		}
	}

	.fold {
		@include bare-button;

		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		color: var(--text);
		cursor: pointer;
		text-align: left;

		&.small {
			gap: 0;
		}

		h4 {
			margin: 0;
		}
	}

	.caret {
		display: inline-flex;
		color: var(--text-secondary);
		transition: transform 0.15s ease;

		&.open {
			transform: rotate(90deg);
		}
	}

	.title {
		@include ellipsis;

		font-weight: 700;
	}

	.svc {
		font-size: 0.75rem;
	}

	.effect {
		font-size: 0.75rem;
		padding: 0.125rem 0.5rem;
		border-radius: 0.75rem;
		border: 0.1rem solid var(--success);
		color: var(--success);

		&.deny {
			border-color: var(--error);
			color: var(--error);
		}
	}

	.tools {
		display: inline-flex;
		gap: 0.25rem;
		flex: none;
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 0.25rem 1rem 1rem 2rem;
	}

	.row {
		display: flex;
		align-items: flex-end;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding-top: 0.75rem;
		border-top: 0.1rem solid var(--border-divider);
	}

	.ghead {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;

		h4 {
			margin: 0;
			font-size: 0.875rem;
		}

		span {
			font-size: 0.8125rem;
		}
	}

	.radios {
		display: flex;
		align-items: center;
		gap: 1.25rem;
		flex-wrap: wrap;

		.lbl {
			font-size: 0.8125rem;
			color: var(--text-secondary);
		}
	}

	.choice {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		cursor: pointer;
	}

	.allrow {
		padding: 0.25rem 0;
	}

	.level {
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-input);
	}

	.lhead {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.625rem;
		background: var(--bg-input);
		font-size: 0.875rem;
	}

	.actions {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0.375rem 1rem;
		padding: 0.625rem 0.75rem;
	}

	.action {
		align-items: flex-start;
	}

	.atext {
		display: flex;
		flex-direction: column;
		min-width: 0;

		.dim {
			font-size: 0.75rem;
		}
	}

	.note {
		margin: 0;
		font-size: 0.8125rem;
	}

	.resource {
		display: flex;
		align-items: center;
		gap: 0.5rem;

		.input {
			flex: 1;
			max-width: 32rem;
		}
	}

	.condition {
		display: flex;
		align-items: flex-end;
		gap: 0.75rem;
		flex-wrap: wrap;

		.tagkey {
			width: 10rem;
		}

		.values {
			flex: 1 1 12rem;
			min-width: 10rem;
		}
	}

	.sid {
		max-width: 22rem;
	}

	.unsupported {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--warning);
		font-size: 0.8125rem;
	}

	.raw {
		margin: 0;
		padding: 0.75rem 1rem;
		background: var(--bg-input);
		border-radius: var(--radius-input);
		font-size: 0.8125rem;
		overflow-x: auto;
	}

	.more {
		display: flex;
	}
</style>
