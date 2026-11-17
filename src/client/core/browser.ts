// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/browser: Mèo Béo's open-web browser sessions, held by
 * the primary daemon. The caller names the owner (the console account, or
 * `token:<id>` for a program) and the holder (the conversation).
 */

import type * as core from "../../core/browser";

import { call } from "../rpc";

export type {
	BrowserAction,
	BrowserDevice,
	BrowserLogEntry,
	BrowserNetworkEntry,
	BrowserResult,
	BrowserSessionInfo,
	BrowserState,
	BrowserViewport,
	ElementSpec,
} from "../../core/browser";

export const openBrowser = call("browser.open") as typeof core.openBrowser;
export const browserAct = call("browser.act") as typeof core.browserAct;
export const closeBrowser = call("browser.close") as typeof core.closeBrowser;
export const listBrowsers = call("browser.list") as (...args: Parameters<typeof core.listBrowsers>) => Promise<ReturnType<typeof core.listBrowsers>>;
