<script lang="ts">
	import type { SettingGroup, SettingSpec } from '$core/settings';
	import FormGrid from './FormGrid.svelte';
	import Select from './Select.svelte';
	import Slider from './Slider.svelte';
	import Toggle from './Toggle.svelte';

	/**
	 * Editor for an instance's server settings, rendered from the core schema so
	 * the launch wizard and the configuration tab offer exactly the same fields
	 * with the same ranges and choices.
	 *
	 * Values are strings throughout — that is what a properties file holds, and
	 * keeping them strings means nothing has to be coerced on the way back.
	 */
	let {
		schema,
		groups,
		values = $bindable({}),
		/** the keys luna owns are shown read-only unless a caller hides them */
		showManaged = true
	}: {
		schema: SettingSpec[];
		groups: Array<{ id: SettingGroup; label: string; hint: string }>;
		values?: Record<string, string>;
		showManaged?: boolean;
	} = $props();

	const shown = $derived(schema.filter((spec) => showManaged || !spec.managed));

	function set(key: string, value: string): void {
		values[key] = value;
	}

	/**
	 * Whether a spec's slider can honestly represent the current value. A value from
	 * outside the schema's range — an older config with a view distance of 48 — would
	 * be clamped by the slider's own thumb and read as something it is not, so those
	 * fall back to the number box.
	 */
	function sliderFits(spec: SettingSpec): boolean {
		if (spec.control !== 'slider' || spec.managed) {
			return false;
		}

		const numeric = Number(values[spec.key] ?? spec.fallback);

		return (
			Number.isFinite(numeric) &&
			numeric >= (spec.min ?? 0) &&
			numeric <= (spec.max ?? Number.MAX_SAFE_INTEGER)
		);
	}
</script>

{#each groups as group}
	{@const specs = shown.filter((spec) => spec.group === group.id)}
	{#if specs.length}
		<div class="group">
			<div class="ghead">
				<h3>{group.label}</h3>
				<span class="dim">{group.hint}</span>
			</div>
			<FormGrid>
				{#each specs as spec (spec.key)}
					{#if spec.type === 'boolean'}
						<div class="field switch" class:locked={!!spec.managed}>
							<Toggle
								checked={values[spec.key] === 'true'}
								disabled={!!spec.managed}
								label={spec.label}
								onchange={(on) => set(spec.key, on ? 'true' : 'false')}
							/>
							<div class="text">
								<span class="lbl">{spec.label}</span>
								<span class="hint">{spec.managed ?? spec.hint ?? spec.key}</span>
							</div>
						</div>
					{:else if sliderFits(spec)}
						<div class="field">
							<span class="lbl">{spec.label}</span>
							<span class="hint">{spec.hint ?? spec.key}</span>
							<Slider
								value={Number(values[spec.key] ?? spec.fallback)}
								min={spec.min ?? 0}
								max={spec.max ?? 100}
								step={spec.step ?? 1}
								unit={spec.unit ?? ''}
								label={spec.label}
								onchange={(next) => set(spec.key, String(next))}
							/>
						</div>
					{:else if spec.type === 'choice'}
						<div class="field">
							<span class="lbl">{spec.label}</span>
							<span class="hint">{spec.managed ?? spec.hint ?? spec.key}</span>
							<Select
								value={values[spec.key] ?? spec.fallback}
								width="100%"
								options={(spec.choices ?? []).map((choice) => ({
									value: choice.value,
									label: choice.label
								}))}
								onchange={(value) => set(spec.key, value)}
							/>
						</div>
					{:else}
						<label class="field">
							<span class="lbl">{spec.label}</span>
							<span class="hint">{spec.managed ?? spec.hint ?? spec.key}</span>
							<input
								class="input"
								type={spec.type === 'number' ? 'number' : 'text'}
								min={spec.min}
								max={spec.max}
								disabled={!!spec.managed}
								value={values[spec.key] ?? spec.fallback}
								oninput={(event) => set(spec.key, event.currentTarget.value)}
							/>
						</label>
					{/if}
				{/each}
			</FormGrid>
		</div>
	{/if}
{/each}

<style lang="scss">
	.group {
		& + .group {
			margin-top: 1.5rem;
			padding-top: 1.25rem;
			border-top: 0.1rem solid var(--border-divider);
		}
	}

	.ghead {
		display: flex;
		align-items: baseline;
		gap: 0.625rem;
		margin-bottom: 0.875rem;

		h3 {
			margin: 0;
			font-size: 0.875rem;
			color: var(--text-heading);
		}

		span {
			font-size: 0.75rem;
		}
	}

	// a switch reads left to right, so its label sits beside it rather than above
	.switch {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;

		.text {
			display: flex;
			flex-direction: column;
		}

		&.locked .text {
			color: var(--text-disabled);
		}
	}
</style>
