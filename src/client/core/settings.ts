// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/settings: the schema and its validation are pure; the
 * server.properties reads/writes happen on the instance's own daemon.
 */

import type * as core from "../../core/settings";

import { call } from "../rpc";

export {
	SETTING_GROUPS,
	SERVER_SETTINGS,
	settingSpec,
	editableSettingKeys,
	validateSetting,
	validateSettings,
	parseJavaArgs,
	validateJavaArgs,
} from "../../core/settings";
export type { SettingSpec, SettingGroup, ApplySettingsResult } from "../../core/settings";

export const readServerProperties = call("settings.readServerProperties", {
	cfg: 0,
}) as typeof core.readServerProperties;
export const applySettings = call("settings.applySettings", { cfg: 0 }) as typeof core.applySettings;
