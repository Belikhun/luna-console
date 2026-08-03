/**
 * Bridge mirror of core/addons: applying a group's pack membership writes pack
 * definitions, talks to the proxy console and copies into instance worlds, so
 * it runs as a daemon job — with the data pack deploy routed to each owner.
 *
 * Adoption splits in two for the same reason the daemon does: reading and
 * renaming an instance's own files happens on the machine that holds them,
 * while recording the outcome in the lockfiles is pure and runs here.
 */

import type * as core from "../../core/addons";

import { call, jobCall } from "../rpc";

export { applyAddonAdoption } from "../../core/addons";
export type {
	AddonGroupApply,
	AddonAdoption,
	AdoptedAddon,
	UnmanagedAddon,
	SeenAddonKind,
} from "../../core/addons";

export const adoptInstanceAddons = call("addons.adoptInstanceAddons", {
	cfg: 0,
}) as typeof core.adoptInstanceAddons;

export const applyAddonGroups = jobCall("addons.applyGroups", {
	cfg: 0,
	lock: 1,
	reporter: { arg: 3, prop: "reporter" },
	kind: "addon-groups",
}) as typeof core.applyAddonGroups;
