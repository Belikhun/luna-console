// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { agentStatus } from '$core/agent';
import { checkClaudeCode, upgradeClaudeCode } from '$core/claudecode';
import { findClaudeExecutable } from '$lib/server/agent/executable';
import { startJob } from '$lib/server/jobs';
import { errorMessage, jsonBody } from '$lib/server/http';

/**
 * The Claude Code build Mèo Béo runs and the SDK the console drives it with.
 *
 * GET → { sdk: { version, claude }, check, executable }: the SDK baked into this
 * console and the Claude Code build its manifest pairs with, what the daemon
 * found installed and on offer, and which executable a run would actually use
 * (the settings or `LUNA_CLAUDE_BIN` can point somewhere luna does not manage).
 *
 * POST { version? } → { job }: install a build into `<root>/.bin/claude`, as a
 * job, since the binary is a few hundred megabytes. `version` is a channel
 * (`stable`, `latest`) or an exact one; it defaults to the build the SDK pairs
 * with, because the two speak a protocol that moves between releases.
 */
export async function GET() {
	try {
		const [check, status] = await Promise.all([checkClaudeCode(), agentStatus()]);

		return json({
			sdk: { version: __AGENT_SDK_VERSION__, claude: __AGENT_SDK_CLAUDE__ },
			check,
			executable: findClaudeExecutable(status.settings.executable)
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

export async function POST({ request, locals }) {
	const body = await jsonBody(request);
	const version = String(body.version ?? '').trim() || __AGENT_SDK_CLAUDE__ || 'latest';

	if (!/^(\d+\.\d+\.\d+|stable|latest)$/.test(version)) {
		throw error(400, `not a Claude Code version: ${version}`);
	}

	const actor = locals.account?.username ?? 'root';
	const job = startJob('claude-code-upgrade', 'claude', `Install Claude Code ${version}`, async (reporter) => {
		return await upgradeClaudeCode({ version, actor, reporter });
	});

	return json({ ok: true, job });
}
