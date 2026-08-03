<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import PlayerSkin from './PlayerSkin.svelte';
	import Select from './Select.svelte';
	import { SKIN_POSES, DEFAULT_POSE, poseById } from './skinposes';

	/**
	 * Skin preview: the player model held in a **static** pose, NameMC-style —
	 * walking by default, with the other stances selectable. Nothing animates
	 * on its own; the model only moves when the viewer drags it, because a
	 * preview that keeps turning is harder to read than one that stays put.
	 *
	 * The texture comes from the console's own skin proxy, so rendering works
	 * offline once a skin has been cached. When WebGL is unavailable or the
	 * player has no recorded skin, the flat 2D body composite takes over —
	 * the panel never comes up empty-handed.
	 */

	let {
		player,
		width = 220,
		height = 320,
		bust = 0,
		poses = true
	}: {
		/** UUID or username — whatever the caller has */
		player: string;
		/** Canvas size in device pixels */
		width?: number;
		height?: number;
		/** Bump to bypass the browser's cached copy after a skin change */
		bust?: number;
		/** Show the pose picker under the model */
		poses?: boolean;
	} = $props();

	/** Where the chosen pose is remembered, so it survives navigation. */
	const POSE_KEY = 'luna.skin.pose';

	/** Yaw of the model's resting three-quarter view, in radians. */
	const RESTING_YAW = 0.45;

	let canvas: HTMLCanvasElement | undefined = $state();
	let fallback = $state(false);
	let pose = $state(DEFAULT_POSE);
	let viewer: any;

	async function build(target: string, poseId: string, cacheBust: number): Promise<void> {
		if (!canvas) {
			return;
		}

		try {
			const skinview3d = await import('skinview3d');

			viewer?.dispose();
			viewer = new skinview3d.SkinViewer({
				canvas,
				width,
				height,
				skin: `/api/players/${encodeURIComponent(target)}/skin${cacheBust ? `?v=${cacheBust}` : ''}`,
				enableControls: true,
				zoom: 0.85
			});

			viewer.autoRotate = false;
			viewer.controls.enablePan = false;
			viewer.playerObject.rotation.y = RESTING_YAW;

			applyPose(skinview3d, poseId);

			fallback = false;
		} catch {
			// no WebGL, no recorded skin, or the module failed to load
			viewer?.dispose();
			viewer = undefined;
			fallback = true;
		}
	}

	/**
	 * Hold the model in one pose. A zero-speed FunctionAnimation is how a
	 * static stance is expressed here: the pose is re-applied every frame (so
	 * it survives the viewer's own resets) while the animation clock never
	 * advances. resetJoints() first, because poses differ in which joints they
	 * touch and a stale offset would otherwise linger.
	 */
	function applyPose(skinview3d: any, poseId: string): void {
		if (!viewer) {
			return;
		}

		const chosen = poseById(poseId);

		viewer.animation = new skinview3d.FunctionAnimation((model: any) => {
			model.resetJoints();
			model.rotation.x = 0;
			model.rotation.y = RESTING_YAW;
			chosen.apply(model);
		});
		viewer.animation.speed = 0;
	}

	async function changePose(next: string): Promise<void> {
		pose = next;

		try {
			localStorage.setItem(POSE_KEY, next);
		} catch {
			// a browser with storage disabled just forgets the choice
		}

		if (!viewer) {
			return;
		}

		applyPose(await import('skinview3d'), next);
	}

	onMount(() => {
		try {
			const stored = localStorage.getItem(POSE_KEY);

			if (stored) {
				pose = stored;
			}
		} catch {
			// no storage, default pose
		}

		return () => viewer?.dispose();
	});

	$effect(() => {
		// the viewer is rebuilt for a new player or a changed texture; the pose
		// is read untracked because changePose applies it without a rebuild
		const target = player;
		const cacheBust = bust;

		void build(target, untrack(() => pose), cacheBust);
	});
</script>

<div class="wrap">
	{#if fallback}
		<PlayerSkin {player} view="body" px={7} {bust} />
	{/if}

	<canvas bind:this={canvas} class:hidden={fallback} title="Drag to turn the model"></canvas>

	{#if poses && !fallback}
		<Select
			value={pose}
			width="100%"
			options={SKIN_POSES.map((entry) => ({ value: entry.id, label: entry.label }))}
			onchange={(value) => void changePose(value)}
		/>
	{/if}
</div>

<style lang="scss">
	.wrap {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
	}

	canvas {
		display: block;
		border-radius: 0.5rem;
		cursor: grab;

		&:active {
			cursor: grabbing;
		}

		&.hidden {
			display: none;
		}
	}
</style>
