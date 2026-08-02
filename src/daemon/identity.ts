import type { InstanceConfig } from "../core/types";

import type { DaemonConfig } from "./config";

/**
 * Which daemon this process is — set once at startup, consulted wherever an
 * operation must decide between running locally and forwarding to the
 * instance's owner.
 */

let identity: { name: string; mode: "primary" | "follower" } = {
	name: "",
	mode: "primary",
};

/** Record this process's daemon identity (called once from runDaemon). */
export function setDaemonIdentity(dcfg: DaemonConfig): void {
	identity = { name: dcfg.name, mode: dcfg.mode };
}

/** This daemon's name. */
export function daemonName(): string {
	return identity.name;
}

/** Whether this daemon is the primary. */
export function isPrimary(): boolean {
	return identity.mode === "primary";
}

/**
 * Whether this daemon owns an instance: an instance with no `daemon` field
 * belongs to the primary; one with the field belongs to the named follower.
 */
export function ownsInstance(inst: InstanceConfig): boolean {
	if (!inst.daemon) {
		return identity.mode === "primary";
	}

	return inst.daemon === identity.name;
}

/** The owner daemon's name, or undefined when the instance is ours. */
export function ownerOf(inst: InstanceConfig): string | undefined {
	if (ownsInstance(inst)) {
		return undefined;
	}

	return inst.daemon;
}
