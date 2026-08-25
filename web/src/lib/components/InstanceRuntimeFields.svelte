<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Select from './Select.svelte';
	import Slider from './Slider.svelte';
	import Toggle from './Toggle.svelte';
	import JavaAgentsField from './JavaAgentsField.svelte';
	import type { AgentAddon } from './javaagents';
	import { formatMemoryMb, MEMORY_MIN_MB, MEMORY_STEP_MB, parseMemoryMb } from '$core/memory';

	/**
	 * How an instance runs: heap, java profile, runtime, JVM flags, java agents
	 * and the crash-relaunch policy.
	 *
	 * One component because there is one answer. The launch wizard and an
	 * instance's Configuration tab were separately-written forms over the same
	 * registry fields, which is why the wizard could not set a restart policy and
	 * the configuration tab could not be reached from creation: a field added to
	 * one simply did not exist in the other. Everything here is bindable and
	 * nothing here saves - each screen owns its own submit, because creating and
	 * reconfiguring are different requests.
	 *
	 * Non-JVM software (pumpkin is a native binary) gets the memory field and the
	 * restart policy and nothing else, since the rest describe a JVM it does not
	 * have.
	 */
	let {
		usesJava = true,
		profiles = [],
		runtimeOptions = [],
		runtimeHint,
		instance,
		binaryName,
		addons = [],
		disabled = false,
		memoryCapMb,
		memoryCapNote,
		memory = $bindable('2G'),
		profile = $bindable('aikar'),
		runtime = $bindable(''),
		javaArgs = $bindable(''),
		javaAgents = $bindable([]),
		autoRestart = $bindable(true),
		restartDelay = $bindable(3)
	}: {
		usesJava?: boolean;
		profiles?: string[];
		/** ready-made options, since the two screens source runtimes differently:
		 *  the wizard from the whole fleet, an instance from its own machine */
		runtimeOptions?: Array<{ value: string; label: string; disabled?: boolean }>;
		runtimeHint?: string;
		/** existing instance, for the agent picker's loose-jar listing */
		instance?: string;
		binaryName?: string | null;
		/** pooled addons attachable as agents on this (prospective) instance */
		addons?: AgentAddon[];
		disabled?: boolean;
		/**
		 * Most heap this instance may be given, MB: the host machine's physical
		 * memory plus its swap. Absent means the ceiling is unknown (no health
		 * sample yet, or an external server), and the field stays a text box
		 * rather than inventing a range.
		 */
		memoryCapMb?: number;
		/** Where the ceiling comes from, named so the number is not a bare assertion */
		memoryCapNote?: string;
		memory?: string;
		profile?: string;
		runtime?: string;
		javaArgs?: string;
		javaAgents?: string[];
		autoRestart?: boolean;
		restartDelay?: number;
	} = $props();

	const memoryMb = $derived(parseMemoryMb(memory));

	/**
	 * Whether the slider can honestly represent what this instance asks for.
	 *
	 * A value above the ceiling would be clamped by the thumb and read as a
	 * smaller heap than is configured, so those fall back to the text box with
	 * the reason spelled out; the same guard `SettingsForm` applies to a setting
	 * whose stored value predates the schema's range.
	 */
	const sliderFits = $derived(
		memoryCapMb !== undefined &&
			memoryCapMb >= MEMORY_MIN_MB + MEMORY_STEP_MB &&
			memoryMb !== undefined &&
			memoryMb >= MEMORY_MIN_MB &&
			memoryMb <= memoryCapMb
	);

	/** Configured above what the machine has: worth saying, not worth hiding. */
	const overCap = $derived(
		memoryCapMb !== undefined && memoryMb !== undefined && memoryMb > memoryCapMb
	);
</script>

<div class="fields">
	{#if sliderFits}
		<div class="field">
			<span class="lbl">{t('web.instanceFields.memory')}</span>
			<span class="hint">
				{memoryCapNote ?? t('web.instanceFields.memorySliderHint')}
			</span>
			<Slider
				value={memoryMb}
				min={MEMORY_MIN_MB}
				max={memoryCapMb}
				step={MEMORY_STEP_MB}
				{disabled}
				label={t('web.instanceFields.memory')}
				format={formatMemoryMb}
				onchange={(value) => (memory = formatMemoryMb(value))}
			/>
		</div>
	{:else}
		<label class="field">
			<span class="lbl">{t('web.instanceFields.memory')}</span>
			<span class="hint">{t('web.instanceFields.memoryHint')}</span>
			<input class="input" bind:value={memory} {disabled} placeholder="2G" />
			{#if overCap}
				<span class="err">
					{t('web.instanceFields.memoryOverCap', {
						cap: formatMemoryMb(memoryCapMb ?? 0),
						where: memoryCapNote ?? t('web.instanceFields.thisMachine')
					})}
				</span>
			{/if}
		</label>
	{/if}

	{#if usesJava}
		<div class="field">
			<span class="lbl">{t('web.instanceFields.javaProfile')}</span>
			<span class="hint">{t('web.instanceFields.javaProfileHint')}</span>
			<Select
				bind:value={profile}
				width="100%"
				{disabled}
				options={profiles.map((entry) => ({ value: entry, label: entry }))}
			/>
		</div>

		<div class="field">
			<span class="lbl">{t('web.instanceFields.javaRuntime')}</span>
			<span class="hint">{runtimeHint ?? t('web.instanceFields.javaRuntimeHint')}</span>
			<Select bind:value={runtime} width="100%" searchable {disabled} options={runtimeOptions} />
		</div>
	{/if}

	<div class="field">
		<span class="lbl">{t('web.instanceFields.autoRestart')}</span>
		<span class="hint">{t('web.instanceFields.autoRestartHint')}</span>
		<span class="toggleRow">
			<Toggle
				checked={autoRestart}
				{disabled}
				label={t('web.instanceFields.autoRestart')}
				onchange={(on) => (autoRestart = on)}
			/>
			<span class="dim">
				{autoRestart ? t('web.instanceFields.autoRestartOn') : t('web.instanceFields.autoRestartOff')}
			</span>
		</span>
	</div>

	<label class="field">
		<span class="lbl">{t('web.instanceFields.restartDelay')}</span>
		<span class="hint">{t('web.instanceFields.restartDelayHint')}</span>
		<input
			class="input"
			type="number"
			min="0"
			max="3600"
			step="1"
			bind:value={restartDelay}
			disabled={disabled || !autoRestart}
		/>
	</label>

	{#if usesJava}
		<label class="field">
			<span class="lbl">{t('web.instanceFields.javaArgs')}</span>
			<span class="hint">{t('web.instanceFields.javaArgsHint')}</span>
			<input
				class="input mono"
				bind:value={javaArgs}
				{disabled}
				placeholder="-XX:+UseStringDeduplication -Dfile.encoding=UTF-8"
			/>
		</label>

		<div class="field">
			<span class="lbl">{t('web.instanceFields.javaAgents')}</span>
			<span class="hint">{t('web.instanceFields.javaAgentsHint')}</span>
			<JavaAgentsField {instance} {binaryName} {addons} {disabled} bind:agents={javaAgents} />
		</div>
	{:else}
		<p class="hint">{t('web.launch.noJavaNote')}</p>
	{/if}
</div>

<style lang="scss">
	.fields {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.toggleRow {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
</style>
