<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import Btn from './Btn.svelte';

	/** A single flashbar message. */
	let {
		kind = 'info',
		dismiss,
		children
	}: {
		kind?: 'info' | 'success' | 'warning' | 'error';
		dismiss?: () => void;
		children: Snippet;
	} = $props();

	const icons = {
		info: 'circleInfo',
		success: 'circleCheck',
		warning: 'triangleExclamation',
		error: 'circleXMark'
	};
</script>

<div class="flash {kind}">
	<span class="fi"><Icon name={icons[kind]} size="1rem" /></span>
	<div class="msg">{@render children()}</div>
	{#if dismiss}
		<Btn variant="icon" icon="close" title="Dismiss" onclick={dismiss} />
	{/if}
</div>

<style lang="scss">
	.flash {
		border-radius: 0.75rem;
		padding: 0.375rem 0.5rem 0.375rem 1rem;
		display: flex;
		gap: 0.75rem;
		align-items: center;
		font-size: 0.875rem;
		border: 0.125rem solid;
		margin-bottom: 0.75rem;
		animation: fadein 0.12s ease-out;
	}
	.fi {
		display: inline-flex;
		margin-top: 0.1rem;
	}

	.msg {
		flex: 1;
		padding: 0.25rem 0;
	}

	// per-level tint: token border, hand-mixed dark ground, lightened text
	.flash.error {
		border-color: var(--error);
		background: #1f1113;
		color: #ffc2c2;

		.fi {
			color: var(--error);
		}
	}

	.flash.success {
		border-color: var(--success);
		background: #101f12;
		color: #b5e8ba;

		.fi {
			color: var(--success);
		}
	}

	.flash.info {
		border-color: var(--info);
		background: #0d1c2e;
		color: #bcd9f5;

		.fi {
			color: var(--info);
		}
	}

	.flash.warning {
		border-color: var(--warning);
		background: #201c0d;
		color: #f0e3a8;

		.fi {
			color: var(--warning);
		}
	}
</style>
