/**
 * Bridge mirror of core/addons: applying a group's pack membership writes pack
 * definitions, talks to the proxy console and copies into instance worlds, so
 * it runs as a daemon job — with the data pack deploy routed to each owner.
 */

import type * as core from "../../core/addons";

import { jobCall } from "../rpc";

export type { AddonGroupApply } from "../../core/addons";

export const applyAddonGroups = jobCall("addons.applyGroups", {
	cfg: 0,
	lock: 1,
	reporter: { arg: 3, prop: "reporter" },
	kind: "addon-groups",
}) as typeof core.applyAddonGroups;
