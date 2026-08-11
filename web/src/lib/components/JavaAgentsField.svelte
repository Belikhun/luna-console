<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { api } from '$lib/api';
	import Btn from './Btn.svelte';
	import Icon from './Icon.svelte';
	import Select from './Select.svelte';
	import { ADDON_AGENT_PREFIX, agentAddonKey, validateJavaAgents } from '$core/settings';
	import type { AgentAddon } from './javaagents';

	/**
	 * The java agents attached to an instance: one row per agent, each either a
	 * pooled addon or a loose jar in the instance directory, plus that agent's own
	 * options.
	 *
	 * Agents get a field of their own rather than a `-javaagent:` typed into the
	 * JVM arguments beside them, because there are things only a field can do: it
	 * can list what is attached, remove one without retyping the rest, and say
	 * whether the jar will actually be there. That last one is the whole point - a
	 * `-javaagent:` pointing at nothing aborts the JVM before the server writes a
	 * single log line, so a misconfigured agent looks like a crash for no reason.
	 *
	 * **Prefer the addon form.** Some plugins only work loaded as an agent (Nova is
	 * the usual example) and those are ordinary lockfile entries, so naming the
	 * addon keeps one fact in one place: its presence is decided by the instance's
	 * groups, and the agent flag follows whatever that produces. A path is for a
	 * jar luna does not pool, like the velocity forwarding agent.
	 *
	 * Nothing here saves; the configuration tab batches its fields into one PATCH.
	 */
	let {
		instance,
		binaryName,
		addons = [],
		agents = $bindable([]),
		disabled = false
	}: {
		/** the instance whose directory is searched for loose jars; without one the
		 *  field still edits, it just cannot say whether a jar is there */
		instance?: string;
		/** the instance's own server jar, kept out of the picker: it lives in the
		 *  same directory and is the one jar there that can never be an agent */
		binaryName?: string | null;
		/** pooled addons this instance is actually given, from the config route */
		addons?: AgentAddon[];
		/** agent entries, each `<jar>` or `addon:<key>`, optionally `=<options>` */
		agents?: string[];
		disabled?: boolean;
	} = $props();

	interface AgentRow {
		/** the jar half: a path, or `addon:<key>` */
		jar: string;
		options: string;
		/** the lockfile key when this row names an addon */
		addon?: string;
	}

	/** Loose jars in the instance's root, or null while the listing has not answered. */
	let loose: string[] | null = $state(null);

	let picked = $state('');

	const rows = $derived(
		agents.map((entry): AgentRow => {
			const split = entry.indexOf('=');

			return {
				jar: split < 0 ? entry : entry.slice(0, split),
				options: split < 0 ? '' : entry.slice(split + 1),
				addon: agentAddonKey(entry)
			};
		})
	);

	const problem = $derived(validateJavaAgents(agents));

	const attached = $derived(new Set(rows.map((row) => row.jar)));

	// addons first: it is the form that keeps working as a plugin is updated, so
	// it is the one an operator should fall into without having to know why
	const choices = $derived([
		...addons
			.map((addon) => ({
				value: `${ADDON_AGENT_PREFIX}${addon.key}`,
				label: addon.version ? `${addon.key} · ${addon.version}` : addon.key
			}))
			.filter((choice) => !attached.has(choice.value)),
		...(loose ?? [])
			.filter((jar) => jar !== binaryName && !attached.has(jar))
			.map((jar) => ({ value: jar, label: jar }))
	]);

	$effect(() => {
		void loadLoose(instance);
	});

	async function loadLoose(name: string | undefined) {
		loose = null;

		if (!name) {
			return;
		}

		try {
			const listing = await api<{ entries: Array<{ name: string; kind: string }> }>(
				`/instances/${encodeURIComponent(name)}/files?path=`
			);

			loose = listing.entries
				.filter((entry) => entry.kind === 'file' && entry.name.toLowerCase().endsWith('.jar'))
				.map((entry) => entry.name);
		} catch {
			// the instance directory may not exist yet, or its daemon may be down.
			// Either way the field still works - it only loses the "is the jar there?"
			// answer, so it must not claim a jar is missing.
			loose = null;
		}
	}

	function write(next: AgentRow[]) {
		agents = next.map((row) => (row.options ? `${row.jar}=${row.options}` : row.jar));
	}

	function update(index: number, patch: Partial<AgentRow>) {
		write(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
	}

	function remove(index: number) {
		write(rows.filter((_, at) => at !== index));
	}

	function add() {
		const jar = picked.trim();

		if (!jar || attached.has(jar)) {
			return;
		}

		write([...rows, { jar, options: '' }]);
		picked = '';
	}

	/** What this row resolves to, or why it does not. */
	function note(row: AgentRow): { level: 'info' | 'warn'; text: string } | undefined {
		if (row.addon !== undefined) {
			const pooled = addons.find((addon) => addon.key === row.addon);

			if (!pooled) {
				return { level: 'warn', text: t('web.javaAgents.addonNotHere', { addon: row.addon }) };
			}

			return { level: 'info', text: pooled.path };
		}

		// only a root-level jar can be judged by a one-level listing; a nested path
		// is unlisted rather than absent, and start-time is where it is decided
		if (loose === null || !row.jar || row.jar.includes('/') || loose.includes(row.jar)) {
			return undefined;
		}

		return { level: 'warn', text: t('web.javaAgents.jarMissing', { jar: row.jar }) };
	}
</script>

<div class="agents">
	{#if rows.length === 0}
		<p class="empty">{t('web.javaAgents.none')}</p>
	{/if}

	{#each rows as row, index (index)}
		{@const hint = note(row)}
		<div class="row">
			<span class="flag">-javaagent:</span>
			<input
				class="input mono jar"
				class:bad={hint?.level === 'warn'}
				value={row.jar}
				{disabled}
				placeholder={t('web.javaAgents.jarPlaceholder')}
				oninput={(event) => update(index, { jar: event.currentTarget.value })}
			/>
			<input
				class="input mono options"
				value={row.options}
				{disabled}
				placeholder={t('web.javaAgents.optionsPlaceholder')}
				oninput={(event) => update(index, { options: event.currentTarget.value })}
			/>
			<Btn
				variant="icon"
				icon="trash"
				{disabled}
				title={t('web.javaAgents.remove')}
				onclick={() => remove(index)}
			/>
		</div>

		{#if hint}
			<p class="note" class:warn={hint.level === 'warn'}>
				{#if hint.level === 'warn'}
					<Icon name="triangleExclamation" style="solid" />
				{:else}
					<Icon name="right" style="light" />
				{/if}
				<span class="mono">{hint.text}</span>
			</p>
		{/if}
	{/each}

	<div class="add">
		{#if choices.length}
			<Select
				value={picked}
				width="100%"
				{disabled}
				options={[{ value: '', label: t('web.javaAgents.pick') }, ...choices]}
				onchange={(value) => (picked = value)}
			/>
		{:else}
			<input
				class="input mono"
				bind:value={picked}
				{disabled}
				placeholder={t('web.javaAgents.jarPlaceholder')}
			/>
		{/if}
		<Btn icon="plus" disabled={disabled || !picked.trim()} onclick={add}>
			{t('web.javaAgents.add')}
		</Btn>
	</div>

	{#if problem}
		<p class="note warn">
			<Icon name="triangleExclamation" style="solid" />
			<span>{problem}</span>
		</p>
	{/if}
</div>

<style lang="scss">
	.agents {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.empty {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.flag {
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 0.875rem;
		white-space: nowrap;
	}

	.jar {
		flex: 2;
		min-width: 0;

		&.bad {
			border-color: var(--warning);
		}
	}

	.options {
		flex: 1;
		min-width: 0;
	}

	.note {
		// indented past the flag label, so it reads as a remark about the jar field
		// above it rather than as a second row
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0 6.5rem;
		color: var(--text-secondary);
		font-size: 0.875rem;

		&.warn {
			color: var(--warning);
		}
	}

	.add {
		display: flex;
		align-items: center;
		gap: 0.5rem;

		.input {
			flex: 1;
			min-width: 0;
		}
	}
</style>
