<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { post } from '$lib/api';
	import type { Snippet } from 'svelte';
	import CodeEditor from './CodeEditor.svelte';
	import Btn from './Btn.svelte';
	import ButtonGroup from './ButtonGroup.svelte';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';
	import PolicyVisualEditor from './PolicyVisualEditor.svelte';
	import { policyToYaml } from '$shared/iam/yaml';
	import type { PolicyDocument } from '$shared/iam/grammar';
	import { POLICY_VALIDATE_DEBOUNCE_MS, type PolicyEditorMode, type PolicyValidation } from './policyeditor';

	/**
	 * The editor for one IAM policy document: Monaco in YAML, with the daemon's
	 * verdict on the text underneath. The daemon is the only place YAML is parsed,
	 * so every pause in typing asks `/api/iam/policies/validate` and the result is
	 * shown as it comes back; a parent that saves the document reads the same
	 * verdict through `onvalidate` to keep its Save button honest.
	 *
	 * With `showToggle` it also offers the visual editor (`mode="visual"`). The
	 * YAML stays the value either way: the form's document is written out as
	 * YAML on every change, and going back to the form asks the daemon for the
	 * parsed document, so YAML is still only ever read in one place.
	 */
	let {
		value = $bindable(''),
		readonly = false,
		path = 'iam/policy.yaml',
		height = '24rem',
		onvalidate,
		onsave,
		mode = $bindable<PolicyEditorMode>('yaml'),
		showToggle = false,
		tools
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
		/** which face is showing; switching goes through the toggle so YAML is checked first */
		mode?: PolicyEditorMode;
		/** offer the Visual | YAML toggle above the editor */
		showToggle?: boolean;
		/** extra controls at the right of the toggle row, e.g. an Actions dropdown */
		tools?: Snippet;
	} = $props();

	/** the document the visual editor starts from; replaced on every switch into it */
	let visualDocument = $state<PolicyDocument | null>(null);
	let visualKey = $state(0);
	let switching = $state(false);
	let switchError = $state('');

	/** the text the last good verdict was about, so a switch can reuse its document */
	let validatedText = '';
	let validatedDocument: PolicyDocument | undefined;

	/** Show the form or the text; into the form only from YAML that parses. */
	export async function setMode(next: PolicyEditorMode): Promise<void> {
		switchError = '';

		if (next === mode) {
			return;
		}

		if (next === 'yaml') {
			mode = 'yaml';
			visualDocument = null;

			return;
		}

		if (!value.trim()) {
			visualDocument = { Version: 1, Statement: [] };
			visualKey += 1;
			mode = 'visual';

			return;
		}

		let document = validatedText === value ? validatedDocument : undefined;

		if (!document) {
			switching = true;

			try {
				const result = await post<PolicyValidation>('/iam/policies/validate', { yaml: value });

				document = result.ok ? result.document : undefined;
			} catch {
				document = undefined;
			} finally {
				switching = false;
			}
		}

		if (!document) {
			switchError = t('web.policyEditor.fixBeforeVisual');

			return;
		}

		visualDocument = document;
		visualKey += 1;
		mode = 'visual';
	}

	function visualChanged(document: PolicyDocument): void {
		const text = policyToYaml(document);

		if (text !== value) {
			value = text;
		}
	}

	// a parent that sets `mode` to visual before anything was loaded still gets a form
	$effect(() => {
		if (mode === 'visual' && !visualDocument && !switching) {
			mode = 'yaml';
			void setMode('visual');
		}
	});

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
				if (result.ok) {
					validatedText = text;
					validatedDocument = result.document;
				}

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
	{#if showToggle && !readonly}
		<div class="toggle">
			<ButtonGroup>
				<Btn
					icon="listCheck"
					variant={mode === 'visual' ? 'primary' : 'normal'}
					loading={switching}
					onclick={() => void setMode('visual')}
				>
					{t('web.policyEditor.visual')}
				</Btn>
				<Btn icon="code" variant={mode === 'yaml' ? 'primary' : 'normal'} onclick={() => void setMode('yaml')}>
					{t('web.policyEditor.yaml')}
				</Btn>
			</ButtonGroup>
			{#if switchError}
				<span class="switch-error">{switchError}</span>
			{/if}
			<span class="spacer"></span>
			{#if tools}{@render tools()}{/if}
		</div>
	{/if}

	{#if mode === 'visual' && visualDocument && !readonly}
		{#key visualKey}
			<PolicyVisualEditor document={visualDocument} onchange={visualChanged} />
		{/key}
	{:else}
		<CodeEditor bind:value {path} readOnly={readonly} {height} {onsave} />
	{/if}

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

	.toggle {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}

	.spacer {
		flex: 1;
	}

	.switch-error {
		color: var(--error);
		font-size: 0.8125rem;
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
