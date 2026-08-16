// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/settings: the schema, and the validation over it.
 *
 * Everything here is pure, and nothing here may reach the RPC client - the same
 * rule `client/core/software.ts` states, and for the same reason. That path
 * pulls in the unix-socket plumbing and `node:fs`/`node:path` with it, and a
 * browser bundle cannot have those. The console's own components import this
 * module (`JavaAgentsField`, `SettingsForm`), so a single `call()` here breaks
 * every page that renders one.
 *
 * The two operations that genuinely need a daemon - reading and writing an
 * instance's `server.properties` - live in `client/core/services/settings.ts`.
 */

export {
	SETTING_GROUPS,
	SERVER_SETTINGS,
	settingSpec,
	editableSettingKeys,
	validateSetting,
	validateSettings,
	parseJavaArgs,
	validateJavaArgs,
	parseJavaAgents,
	validateJavaAgents,
	agentJarOf,
	agentAddonKey,
	agentOptionsOf,
	ADDON_AGENT_PREFIX,
} from "../../core/settings";
export type { SettingSpec, SettingGroup } from "../../core/settings";
export type { ApplySettingsResult, SettingChange } from "../../core/settingsapply";
