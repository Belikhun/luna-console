// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/firewall: LunaCore's firewall on the proxy, and the
 * GeoIP prefixes luna sends it. Everything runs in the daemon, which is where
 * the proxy's API and the GeoIP download are reachable.
 */

import { call } from "../rpc";
import type * as core from "../../core/firewall";

export type { CountrySync } from "../../core/firewall";
export * from "../../shared/firewall";

export const firewallOverview = call("firewall.firewallOverview") as typeof core.firewallOverview;
export const updateFirewallSettings = call("firewall.updateFirewallSettings") as typeof core.updateFirewallSettings;
export const saveFirewallRule = call("firewall.saveFirewallRule") as typeof core.saveFirewallRule;
export const setFirewallRuleEnabled = call("firewall.setFirewallRuleEnabled") as typeof core.setFirewallRuleEnabled;
export const removeFirewallRule = call("firewall.removeFirewallRule") as typeof core.removeFirewallRule;
export const firewallActivity = call("firewall.firewallActivity") as typeof core.firewallActivity;
export const checkFirewallAddress = call("firewall.checkFirewallAddress") as typeof core.checkFirewallAddress;
export const ipBanHistory = call("firewall.ipBanHistory") as typeof core.ipBanHistory;
export const addressCountries = call("firewall.addressCountries") as typeof core.addressCountries;
export const syncCountries = call("firewall.syncCountries") as typeof core.syncCountries;
