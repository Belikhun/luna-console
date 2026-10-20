<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { post } from '$lib/api';
	import CodeEditor from './CodeEditor.svelte';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';
	import { POLICY_VALIDATE_DEBOUNCE_MS, type PolicyValidation } from './policyeditor';

	/**
	 * The editor for one IAM policy document: Monaco in YAML, with the daemon's
	 * verdict on the text underneath. The daemon is the only place YAML is parsed,
	 * so every pause in typing asks `/api/iam/policies/validate` and the result is
	 * shown as it comes back; a parent that saves the document reads the same
	 * verdict through `onvalidate` to keep its Save button honest.
	 */
	let {
		value = $bindable(''),
		readonly = false,
		path = 'iam/policy.yaml',
		height = '24rem',
		onvalidate,
		onsave
	}: {
		value: string;
		/** a built-in document: shown, never validated or edited */
		readonly?: boolean;
		/** keys Monaco's language; keep the `.yaml` suffix */
		path?: string;
		height?: string;
		/** the latest verdict, or null while the document is empty or still being checked */
		onvalidate?: (result: PolicyValidation | null) => void;
		/** Ctrl/Cmd+S inside the editor */
		onsave?: () => void;
	} = $props();

	let validation = $state<PolicyValidation | null>(null);
	let checking = $state(false);

	let timer: ReturnType<typeof setTimeout> | undefined;

	/** Answers arrive out of order on a fast typist; only the newest request counts. */
	let sequence = 0;

	function publish(result: PolicyValidation | null): void {
		validation = result;
		onvalidate?.(result);
	}

	async function validate(text: string): Promise<void> {
		const mine = ++sequence;

		checking = true;

		try {
			const result = await post<PolicyValidation>('/iam/policies/validate', { yaml: text });

			if (mine === sequence) {
				publish(result);
			}
		} catch (err) {
			if (mine === sequence) {
				publish({ ok: false, issues: [{ path: '', message: (err as Error).message }], statements: 0 });
			}
		} finally {
			if (mine === sequence) {
				checking = false;
			}
		}
	}

	$effect(() => {
		const text = value;

		clearTimeout(timer);

		if (readonly) {
			return;
		}

		if (!text.trim()) {
			sequence++;
			checking = false;
			publish(null);

			return;
		}

		timer = setTimeout(() => {
			void validate(text);
		}, POLICY_VALIDATE_DEBOUNCE_MS);
	});

	onDestroy(() => {
		clearTimeout(timer);
	});
</script>

<div class="policy-editor">
	<CodeEditor bind:value {path} readOnly={readonly} {height} {onsave} />

	{#if !readonly}
		<div class="verdict" class:ok={validation?.ok} class:bad={validation && !validation.ok}>
			{#if checking}
				<Spinner />
				<span class="dim">{t('web.policyEditor.checking')}</span>
			{:else if !validation}
				<Icon name="circleInfo" size="0.875rem" />
				<span class="dim">{t('web.policyEditor.empty')}</span>
			{:else if validation.ok}
				<Icon name="circleCheck" size="0.875rem" />
				<span>{t('web.policyEditor.valid', { count: validation.statements })}</span>
			{:else}
				<div class="issues">
					<div class="head">
						<Icon name="circleXMark" size="0.875rem" />
						<span>{t('web.policyEditor.invalid', { count: validation.issues.length })}</span>
					</div>
					<ul>
						{#each validation.issues as issue, index (index)}
							<li>
								{#if issue.path}
									<span class="mono path">{issue.path}</span>
								{/if}
								<span>{issue.message}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style lang="scss">
	// a plain block, not a flex column: the editor's wrapper carries `flex: 1`
	// so it can take the remaining space of a filling panel, and inside a
	// content-sized flex column that shrank it to nothing
	.policy-editor {
		display: block;
	}

	.verdict {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 1.5rem;
		margin-top: 0.5rem;
		font-size: 0.8125rem;

		&.ok {
			color: var(--success);
		}

		&.bad {
			color: var(--error);
			align-items: flex-start;
		}
	}

	.issues {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;

		.head {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		ul {
			margin: 0;
			padding-left: 1.5rem;
			color: var(--text);
		}

		li {
			display: flex;
			gap: 0.5rem;
			line-height: 1.25rem;
		}

		.path {
			color: var(--text-secondary);
			font-size: 0.75rem;
		}
	}
</style>
