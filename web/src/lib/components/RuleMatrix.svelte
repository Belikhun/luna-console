<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import {
		hasWildcard,
		respackMatchesServer,
		toggleServerRule,
		toggleWildcard
	} from '$shared/packrules';
	import Checkbox from './Checkbox.svelte';
	import Icon from './Icon.svelte';

	/**
	 * Checkbox editor for a resource pack's server rules.
	 *
	 * The rules are a small language (`*`, `name`, `!name`, exclusions win) and
	 * writing them by hand is where the mistakes are: `*` plus `survival` reads
	 * like "only survival" and means "everywhere". So the matrix shows the answer
	 *; served or not, per backend; and edits the rule list underneath through
	 * the same functions the daemon uses to write it (`$shared/packrules`), which
	 * is why a tick here predicts the proxy exactly.
	 *
	 * The list stays visible and stays editable elsewhere: this is a view onto
	 * `servers`, not a replacement for it.
	 */
	let {
		instances,
		servers = $bindable(),
		granted = [],
		running = []
	}: {
		/** Backend names to offer, in display order */
		instances: string[];
		/** The rule list being edited */
		servers: string[];
		/** Backends an addon group contributes; cannot be removed here */
		granted?: string[];
		/** Backends currently up, for the dim "stopped" note */
		running?: string[];
	} = $props();

	const wildcard = $derived(hasWildcard(servers));
	const served = $derived(instances.filter((name) => respackMatchesServer(servers, name)));

	/** The rule that decides one backend, for the per-row explanation. */
	function ruleFor(name: string): string {
		const exclusion = servers.find((rule) => rule.trim().toLowerCase() === `!${name}`);

		if (exclusion) {
			return exclusion.trim();
		}

		const direct = servers.find((rule) => rule.trim().toLowerCase() === name);

		if (direct) {
			return direct.trim();
		}

		return wildcard ? '*' : '—';
	}

	function setOne(name: string, on: boolean): void {
		servers = toggleServerRule(servers, name, on);
	}

	function setAll(on: boolean): void {
		servers = toggleWildcard(servers, on, served);
	}
</script>

<div class="matrix">
	<div class="head">
		<label class="all">
			<Checkbox
				checked={wildcard}
				indeterminate={!wildcard && served.length > 0}
				label={t('web.ruleMatrix.everyBackend')}
				onchange={setAll}
			/>
			<span class="alltext">
				Every backend <code>*</code>
				<span class="dim">{t('web.ruleMatrix.newInstancesAuto')}</span>
			</span>
		</label>
		<span class="tally dim">{served.length} of {instances.length} served</span>
	</div>

	<div class="rows">
		{#each instances as name (name)}
			{@const on = served.includes(name)}
			{@const locked = granted.includes(name)}
			<label class="row" class:on class:locked>
				<Checkbox
					checked={on}
					disabled={locked}
					label={name}
					onchange={(next) => setOne(name, next)}
				/>
				<span class="name">{name}</span>
				{#if !running.includes(name)}
					<span class="off dim">{t('web.ruleMatrix.stopped')}</span>
				{/if}
				<span class="rule mono" class:excluded={ruleFor(name).startsWith('!')}>{ruleFor(name)}</span>
				{#if locked}
					<span class="lock dim" title={t('web.ruleMatrix.grantedByGroup')}>
						<Icon name="layerGroup" size="0.75rem" />
					</span>
				{/if}
			</label>
		{/each}
	</div>

	<div class="result">
		<span class="dim">{t('web.ruleMatrix.rules')}</span>
		<code class="mono">{servers.join(', ') || '—'}</code>
	</div>
</div>

<style lang="scss">
	.matrix {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding-bottom: 0.75rem;
		border-bottom: 0.1rem solid var(--border-divider);
	}

	.all {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}

	.alltext code {
		font-size: 0.8125rem;
	}

	.tally {
		font-size: 0.8125rem;
		white-space: nowrap;
	}

	// two columns where there is room; the cluster has enough backends that one
	// column would push the rule list below the fold
	.rows {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0.25rem 1rem;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.5rem;
		border-radius: var(--radius-input);
		cursor: pointer;

		&:hover {
			background: var(--bg-hover);
		}

		&.locked {
			cursor: default;
		}
	}

	.name {
		flex: 1;
		min-width: 0;
		@include ellipsis;
	}

	// a row that is not served reads as inactive, but its name stays legible
	.row:not(.on) .name {
		color: var(--text-secondary);
	}

	.off {
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.0625rem;
	}

	.rule {
		font-size: 0.75rem;
		color: var(--text-secondary);

		&.excluded {
			color: var(--warning);
		}
	}

	.lock {
		display: inline-flex;
	}

	.result {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding-top: 0.75rem;
		border-top: 0.1rem solid var(--border-divider);
		font-size: 0.8125rem;

		code {
			min-width: 0;
			word-break: break-all;
		}
	}
</style>
