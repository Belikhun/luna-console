<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/** Create a schedule — same form shape as the instance launch wizard. */

	let name = $state('');
	let action = $state('restart');
	let kind = $state('cron');
	let at = $state('');
	let cron = $state('0 4 * * *');
	let rate = $state('60');
	let maxRuns = $state('');
	let enabled = $state(true);
	let instances: Set<string> = $state(new Set());
	let instanceNames: string[] = $state([]);
	let creating = $state(false);

	onMount(async () => {
		const data = await api('/instances');

		instanceNames = data.instances.map((inst: any) => inst.name);
	});

	function toggleInstance(instance: string, on: boolean): void {
		const next = new Set(instances);

		if (on) {
			next.add(instance);
		} else {
			next.delete(instance);
		}

		instances = next;
	}

	const triggerText = $derived.by(() => {
		if (kind === 'at') {
			return at ? `once at ${at.replace('T', ' ')}` : 'once at …';
		}

		if (kind === 'cron') {
			return `cron(${cron})`;
		}

		return `every ${rate} min`;
	});

	async function create(): Promise<void> {
		creating = true;

		const trigger =
			kind === 'at'
				? { kind: 'at', at: new Date(at).toISOString() }
				: kind === 'cron'
					? { kind: 'cron', expr: cron }
					: { kind: 'rate', minutes: Number(rate) };

		const note = Notify.loading(`Creating schedule ${name}…`);

		try {
			await post('/schedules', {
				name,
				action,
				instances: [...instances],
				trigger,
				maxRuns: maxRuns ? Number(maxRuns) : undefined,
				enabled
			});

			note.set({
				level: 'success',
				message: `Schedule ${name} created`,
				detail: enabled ? '' : 'Created paused — enable it from the Schedules page.',
				closeable: true
			});

			await goto('/schedules');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not create ${name}`,
				detail: (err as Error).message,
				closeable: true
			});

			creating = false;
		}
	}
</script>

<svelte:head><title>Create schedule | Luna Console</title></svelte:head>

<PageHeader
	title="Create a schedule"
	description="Start, stop or restart instances on a fixed time, a cron expression or a rate — runs fire from the luna daemon, 24/7"
/>

<div class="wizard">
	<Panel title="Name & action">
		<label class="field">
			<span class="lbl">Schedule name</span>
			<input
				class="input"
				bind:value={name}
				placeholder="e.g. nightly survival restart"
				disabled={creating}
			/>
		</label>
		<div class="field">
			<span class="lbl">Action</span>
			<Select
				bind:value={action}
				width="100%"
				options={[
					{ value: 'start', label: 'Start' },
					{ value: 'stop', label: 'Stop' },
					{ value: 'restart', label: 'Restart' }
				]}
			/>
		</div>
	</Panel>

	<Panel
		title="Trigger"
		description="One-time schedules disable themselves after firing; recurring ones keep going until paused or their run cap is reached"
	>
		<div class="field">
			<span class="lbl">Schedule type</span>
			<Select
				bind:value={kind}
				width="100%"
				options={[
					{ value: 'at', label: 'One-time — fixed date and time' },
					{ value: 'cron', label: 'Recurring — cron expression' },
					{ value: 'rate', label: 'Recurring — fixed rate' }
				]}
			/>
		</div>
		{#if kind === 'at'}
			<label class="field">
				<span class="lbl">Run at</span>
				<input class="input" type="datetime-local" bind:value={at} disabled={creating} />
			</label>
		{:else if kind === 'cron'}
			<label class="field">
				<span class="lbl">Cron expression</span>
				<span class="hint">
					minute hour day-of-month month day-of-week — e.g. "30 4 * * *" is daily 04:30
				</span>
				<input class="input mono" bind:value={cron} disabled={creating} />
			</label>
		{:else}
			<label class="field">
				<span class="lbl">Every N minutes</span>
				<input class="input" type="number" min="1" bind:value={rate} disabled={creating} />
			</label>
		{/if}
		{#if kind !== 'at'}
			<FormGrid cols={2}>
				<label class="field">
					<span class="lbl">Stop after N runs</span>
					<span class="hint">Blank repeats forever; the schedule pauses itself when done</span>
					<input
						class="input"
						type="number"
						min="1"
						bind:value={maxRuns}
						placeholder="∞"
						disabled={creating}
					/>
				</label>
			</FormGrid>
		{/if}
		<label class="reg">
			<Checkbox
				checked={enabled}
				label="Enabled immediately"
				onchange={(value) => (enabled = value)}
			/>
			Enabled immediately — untick to create it paused
		</label>
	</Panel>

	<Panel
		title="Instances"
		count={instances.size}
		description="The action runs against every selected instance, in one pass"
	>
		<div class="inst-grid">
			{#each instanceNames as instance (instance)}
				<label class="pick">
					<Checkbox
						checked={instances.has(instance)}
						disabled={creating}
						label={instance}
						onchange={(on) => toggleInstance(instance, on)}
					/>
					<span>{instance}</span>
				</label>
			{/each}
		</div>
	</Panel>

	<div class="summary">
		<span class="dim">
			{name || '(name)'} · {action} · {triggerText} · {instances.size} instance(s)
			{#if maxRuns}· stops after {maxRuns} run(s){/if}
		</span>
		<Btn
			variant="primary"
			disabled={!name || !instances.size || (kind === 'at' && !at)}
			loading={creating}
			onclick={create}
		>
			Create schedule
		</Btn>
	</div>
</div>

<style lang="scss">
	.wizard {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 47.5rem;
	}

	.reg {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-top: 0.25rem;
	}

	.inst-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
		gap: 0.375rem 1rem;
		padding: 0.5rem 0.25rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
	}

	.pick {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		cursor: pointer;
	}

	// the summary bar stays reachable while the form scrolls
	.summary {
		position: sticky;
		bottom: 0;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		background: var(--bg-panel);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
		padding: 0.75rem 1.25rem;
	}
</style>
