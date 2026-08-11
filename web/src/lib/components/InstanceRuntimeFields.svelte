<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Select from './Select.svelte';
	import Toggle from './Toggle.svelte';
	import JavaAgentsField from './JavaAgentsField.svelte';
	import type { AgentAddon } from './javaagents';

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
		memory?: string;
		profile?: string;
		runtime?: string;
		javaArgs?: string;
		javaAgents?: string[];
		autoRestart?: boolean;
		restartDelay?: number;
	} = $props();
</script>

<div class="fields">
	<label class="field">
		<span class="lbl">{t('web.instanceFields.memory')}</span>
		<span class="hint">{t('web.instanceFields.memoryHint')}</span>
		<input class="input" bind:value={memory} {disabled} placeholder="2G" />
	</label>

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
