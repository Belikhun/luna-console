import type { PlayerObject } from 'skinview3d';

/**
 * Static poses for the skin preview.
 *
 * The preview does not animate: an admin looking at a skin wants to *read* it,
 * and a model that keeps moving makes comparing two players harder than it
 * needs to be. Each pose is a fixed set of joint rotations applied every frame
 * (through a zero-speed FunctionAnimation), so switching poses is instant and
 * nothing drifts.
 *
 * The numbers follow skinview3d's own animations — the walking pose is one
 * frame of its WalkingAnimation at mid-stride, which is also the stance
 * NameMC renders players in.
 */

export interface SkinPose {
	id: string;
	label: string;
	apply: (player: PlayerObject) => void;
}

/** Arms rest a couple of degrees away from the body, as vanilla renders them. */
const ARM_REST_Z = Math.PI * 0.02;

/** Mid-stride swing amplitude, matching WalkingAnimation's 0.5 radians. */
const WALK_SWING = 0.5;

export const SKIN_POSES: SkinPose[] = [
	{
		id: 'walking',
		label: 'Walking',
		apply: (player) => {
			const skin = player.skin;

			skin.leftLeg.rotation.x = WALK_SWING;
			skin.rightLeg.rotation.x = -WALK_SWING;
			skin.leftArm.rotation.x = -WALK_SWING;
			skin.rightArm.rotation.x = WALK_SWING;
			skin.leftArm.rotation.z = ARM_REST_Z;
			skin.rightArm.rotation.z = -ARM_REST_Z;
		}
	},
	{
		id: 'standing',
		label: 'Standing',
		apply: (player) => {
			const skin = player.skin;

			skin.leftArm.rotation.z = ARM_REST_Z;
			skin.rightArm.rotation.z = -ARM_REST_Z;
		}
	},
	{
		id: 'running',
		label: 'Running',
		apply: (player) => {
			const skin = player.skin;

			// leaning into the stride, with the head held level against the lean
			skin.body.rotation.x = 0.25;
			skin.head.rotation.x = -0.25;
			skin.leftLeg.rotation.x = 1;
			skin.rightLeg.rotation.x = -0.8;
			skin.leftArm.rotation.x = -1.1;
			skin.rightArm.rotation.x = 1.1;
			skin.leftArm.rotation.z = ARM_REST_Z;
			skin.rightArm.rotation.z = -ARM_REST_Z;
		}
	},
	{
		id: 'waving',
		label: 'Waving',
		apply: (player) => {
			const skin = player.skin;

			// right arm up beside the head, the other resting
			skin.rightArm.rotation.z = -2.5;
			skin.rightArm.rotation.x = 0.1;
			skin.leftArm.rotation.z = ARM_REST_Z;
			skin.head.rotation.y = -0.15;
		}
	},
	{
		id: 'crouching',
		label: 'Crouching',
		apply: (player) => {
			const skin = player.skin;

			// vanilla's sneak offsets, from skinview3d's CrouchAnimation at full crouch
			skin.body.rotation.x = 0.4537860552;
			skin.body.position.y = -8.103677462;
			skin.body.position.z = -2.1244129377;
			skin.head.position.y = -3.618325234674;
			skin.leftArm.rotation.x = 0.410367746202;
			skin.rightArm.rotation.x = 0.410367746202;
			skin.leftArm.rotation.z = 0.1;
			skin.rightArm.rotation.z = -0.1;
			skin.leftArm.position.y = -4.53943318;
			skin.rightArm.position.y = -4.53943318;
			skin.leftArm.position.z = 0.168294197;
			skin.rightArm.position.z = 0.168294197;
			skin.leftLeg.position.z = -3.4500310377;
			skin.rightLeg.position.z = -3.4500310377;
		}
	},
	{
		id: 'flying',
		label: 'Flying',
		apply: (player) => {
			const skin = player.skin;

			// the whole body tips forward; arms sweep back along it
			player.rotation.x = -Math.PI / 3;
			skin.head.rotation.x = 0.6;
			skin.leftArm.rotation.x = -2.6;
			skin.rightArm.rotation.x = -2.6;
			skin.leftArm.rotation.z = 0.2;
			skin.rightArm.rotation.z = -0.2;
			skin.leftLeg.rotation.x = 0.15;
			skin.rightLeg.rotation.x = -0.15;
		}
	}
];

/** The pose used when nothing is stored — the stance NameMC renders. */
export const DEFAULT_POSE = 'walking';

/** Look up a pose by id, falling back to the default. */
export function poseById(id: string): SkinPose {
	return SKIN_POSES.find((pose) => pose.id === id) ?? SKIN_POSES[0]!;
}
