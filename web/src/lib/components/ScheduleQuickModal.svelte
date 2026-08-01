<script lang="ts">
	import { post } from '$lib/api';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';
	import Select from './Select.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Quick one-shot scheduling from instance management: pick start/stop/restart
	 * and a time, and a one-time schedule is created for the given instances —
	 * the full schedule form stays one click away for anything recurring.
	 */
	let {
		open = $bindable(false),
		instances,
		action = $bindable('restart')
	}: {
		open?: boolean;
		/** the instances the schedule targets */
		instances: string[];
		action?: string;
	} = $props();

	let at = $state('');
	let creating = $state(false);

	/** Prefill the time field with the next round half-hour when the modal opens. */
	$effect(() => {
		if (!open || at) {
			return;
		}

		const next = new Date(Date.now() + 30 * 60_000);

		next.setMinutes(next.getMinutes() < 30 ? 30 : 60, 0, 0);

		// datetime-local wants local time without a zone suffix
		const pad = (value: number): string => String(value).padStart(2, '0');

		at = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;
	});

	async function create(): Promise<void> {
		creating = true;

		const label = `${action} ${instances.join(', ')}`;

		try {
			await post('/schedules', {
				name: label,
				action,
				instances,
				trigger: { kind: 'at', at: new Date(at).toISOString() }
			});

			Notify.success(`Scheduled: ${label}`, {
				detail: `Runs once at ${new Date(at).toLocaleString('sv')} — manage it on the Schedules page.`
			});

			open = false;
			at = '';
		} catch (err) {
			Notify.error('Could not create the schedule', { detail: (err as Error).message });
		}

		creating = false;
	}
</script>

<Modal title="Schedule an action" bind:open>
	<p class="dim intro">
		One-time run against <b>{instances.join(', ')}</b> — recurring schedules live on the
		<a href="/schedules">Schedules page</a>.
	</p>
	<div class="two">
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
		<label class="field">
			<span class="lbl">Run at</span>
			<input class="input" type="datetime-local" bind:value={at} />
		</label>
	</div>
	{#snippet footer()}
		<Btn onclick={() => (open = false)}>Cancel</Btn>
		<Btn
			variant="primary"
			loading={creating}
			disabled={!at || !instances.length}
			onclick={create}
		>
			Schedule
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.intro {
		margin: 0 0 0.75rem;
		font-size: 0.8125rem;
	}

	.two {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0 1rem;
	}
</style>
