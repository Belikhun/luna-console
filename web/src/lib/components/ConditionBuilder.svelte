<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * The `when:` expression of a conditional rule, as rows instead of syntax.
	 *
	 * The structure is deliberately flat; groups of ANDed terms, ORed together -
	 * because that is the only shape the plugin evaluates correctly: its splitter
	 * is not paren-aware, so `(a || b) && c` does not mean what it looks like.
	 *
	 * An expression this cannot represent is never rewritten; the field falls back
	 * to raw text and says why.
	 */

	import { t } from '$lib/i18n.svelte';
	import Btn from './Btn.svelte';
	import Icon from './Icon.svelte';
	import Select from './Select.svelte';
	import { SELECTOR_STATUSES } from '$shared/selector';
	import { formatWhen, parseWhen, WHEN_OPERATORS, WHEN_VARIABLES, type WhenExpression } from '$shared/selectorwhen';

	interface Props {
		value: string;
		onchange: (value: string) => void;
	}

	const { value, onchange }: Props = $props();

	const parsed = $derived(parseWhen(value ?? ''));
	const structured = $derived(!!parsed);

	const variableOptions = WHEN_VARIABLES.map((name) => ({ value: name, label: name }));
	const operatorOptions = WHEN_OPERATORS.map((op) => ({ value: op, label: op }));
	const statusOptions = SELECTOR_STATUSES.map((status) => ({ value: status, label: status }));

	/** Statuses are the one variable with a closed set of values worth offering. */
	function isStatusVariable(name: string): boolean {
		return name === 'status' || name === 'server_status';
	}

	function edit(mutate: (expression: WhenExpression) => void): void {
		if (!parsed) {
			return;
		}

		const next: WhenExpression = { clauses: parsed.clauses.map((clause) => ({ terms: [...clause.terms] })) };
		mutate(next);
		onchange(formatWhen(next));
	}
</script>

{#if structured && parsed}
	<div class="builder">
		{#each parsed.clauses as clause, clauseIndex (clauseIndex)}
			{#if clauseIndex > 0}
				<p class="joiner">{t('web.conditions.or')}</p>
			{/if}

			<div class="clause">
				{#each clause.terms as term, termIndex (termIndex)}
					<div class="term">
						{#if termIndex > 0}
							<span class="and">{t('web.conditions.and')}</span>
						{/if}

						<Select
							value={term.variable}
							options={variableOptions}
							width="11rem"
							onchange={(next) =>
								edit((expression) => {
									const target = expression.clauses[clauseIndex]?.terms[termIndex];

									if (target) {
										target.variable = next;
									}
								})}
						/>

						<Select
							value={term.op ?? '=='}
							options={operatorOptions}
							width="5rem"
							onchange={(next) =>
								edit((expression) => {
									const target = expression.clauses[clauseIndex]?.terms[termIndex];

									if (target) {
										target.op = next as (typeof WHEN_OPERATORS)[number];
										target.value = target.value ?? '';
									}
								})}
						/>

						{#if isStatusVariable(term.variable)}
							<Select
								value={(term.value ?? 'ONLINE').toUpperCase()}
								options={statusOptions}
								width="8rem"
								onchange={(next) =>
									edit((expression) => {
										const target = expression.clauses[clauseIndex]?.terms[termIndex];

										if (target) {
											target.value = next;
										}
									})}
							/>
						{:else}
							<input
								class="input"
								value={term.value ?? ''}
								oninput={(event) => {
									const next = (event.currentTarget as HTMLInputElement).value;

									edit((expression) => {
										const target = expression.clauses[clauseIndex]?.terms[termIndex];

										if (target) {
											target.value = next;
										}
									});
								}}
							/>
						{/if}

						<Btn
							variant="icon"
							title={t('web.conditions.removeCondition')}
							onclick={() =>
								edit((expression) => {
									expression.clauses[clauseIndex]?.terms.splice(termIndex, 1);
									expression.clauses = expression.clauses.filter((entry) => entry.terms.length > 0);
								})}
						>
							<Icon name="close" style="solid" />
						</Btn>
					</div>
				{/each}

				<Btn
					variant="link"
					onclick={() =>
						edit((expression) => {
							expression.clauses[clauseIndex]?.terms.push({ variable: 'status', op: '==', value: 'OFFLINE' });
						})}
				>
					+ and
				</Btn>
			</div>
		{/each}

		<Btn
			variant="link"
			onclick={() =>
				edit((expression) => {
					expression.clauses.push({ terms: [{ variable: 'status', op: '==', value: 'OFFLINE' }] });
				})}
		>
			+ or
		</Btn>
	</div>
{:else}
	<div class="raw">
		<input class="input mono" value={value} oninput={(event) => onchange((event.currentTarget as HTMLInputElement).value)} />
		<p class="hint">
			{t('web.conditions.thisConditionUsesParentheses')}
		</p>
	</div>
{/if}

<style lang="scss">
	.builder {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.clause {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.5rem;
		border: var(--hairline) solid var(--border-divider);
		border-radius: var(--radius-input);
		background: var(--bg-panel-raised);
	}

	.term {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-wrap: wrap;
	}

	.and,
	.joiner {
		color: var(--text-secondary);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.joiner {
		margin: 0;
	}

	.raw .input {
		margin-bottom: 0.25rem;
	}
</style>
