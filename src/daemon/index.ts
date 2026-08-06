// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Daemon runtime entry. `luna daemon run` lands here: resolve the daemon
 * config, bind the local API socket (plus the cluster TCP listener on a
 * primary), and start the long-lived loops; sampler, scheduler, and the
 * follower link when this daemon is not the primary.
 */

import { existsSync } from "node:fs";
import { t } from "../shared/i18n";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { appendJournal, setJournalMachine, type JournalLevel } from "../core/journal";
import { configureProviders } from "../core/services/providers";
import { resolveDaemonConfig, type DaemonConfig } from "./config";
import { setDaemonIdentity } from "./identity";
import { buildHandler, type WsData } from "./server";

/**
 * Timestamped daemon log line (the daemon is not core; it may print).
 *
 * Every line also lands in the console journal, which is what the console's Logs
 * screen reads: the daemon's own stdout is inside a screen session or a systemd
 * unit, and "read the journal" must not mean "ssh in and find the right pane".
 * The append is fire-and-forget on purpose; `log` is called from synchronous
 * paths, and journalling can never be the reason one of them fails.
 */
export function log(message: string, level: JournalLevel = "info"): void {
	const now = new Date();
	const stamp = now.toTimeString().slice(0, 8);

	console.log(`[${stamp}] ${message}`);

	void appendJournal({ source: "daemon", level, message });
}

/** Whether a daemon is already answering on this socket. */
async function socketAlive(socket: string): Promise<boolean> {
	try {
		const response = await fetch("http://luna/info", {
			unix: socket,
			signal: AbortSignal.timeout(800),
		});

		return response.ok;
	} catch {
		return false;
	}
}

/** Run the daemon until SIGINT/SIGTERM. */
export async function runDaemon(): Promise<void> {
	const dcfg = await resolveDaemonConfig();

	// core resolves the cluster root through this; set before any core call
	process.env.LUNA_ROOT = dcfg.root;

	setDaemonIdentity(dcfg);

	// every journal entry is stamped with the machine that wrote it; core cannot
	// read the daemon's identity itself, so the runtime hands it over
	setJournalMachine(dcfg.name);

	// provider credentials come from the daemon config; core never reads env
	configureProviders({ curseforgeApiKey: dcfg.curseforgeApiKey });

	if (!existsSync(dcfg.root)) {
		if (dcfg.mode !== "follower") {
			throw new Error(t("daemon.rootMissing", { root: dcfg.root }));
		}

		// a fresh follower starts empty and fills up from the primary's state sync
		await mkdir(dcfg.root, { recursive: true });
	}

	if (existsSync(dcfg.socket)) {
		if (await socketAlive(dcfg.socket)) {
			throw new Error(t("daemon.alreadyRunning", { socket: dcfg.socket }));
		}

		await unlink(dcfg.socket);
	}

	await mkdir(dirname(dcfg.socket), { recursive: true });

	const startedAt = Date.now();

	// the unix listener never upgrades, but Bun's serve options require a
	// websocket handler once the fetch callback calls server.upgrade anywhere
	const noWebsocket: Bun.WebSocketHandler<WsData> = {
		message(ws) {
			ws.close(1008, "no websocket on the local socket");
		},
	};

	const local = Bun.serve({
		unix: dcfg.socket,
		fetch: buildHandler(dcfg, true, startedAt),
		websocket: noWebsocket,
		// SSE consumers (job streams, console tails) legitimately go quiet for
		// long stretches; a first server boot spends a minute in "Loading
		// libraries" with nothing to report; and Bun's default 10s idle timeout
		// would cut them off mid-job. 0 disables it. Bun's types claim unix
		// listeners take no idleTimeout, but the runtime both applies the 10s
		// default and honours the override (its own timeout error says to pass it).
		idleTimeout: 0 as never,
	});

	log(t("daemon.log.starting", { name: dcfg.name, mode: dcfg.mode, root: dcfg.root }));
	log(`local API on ${dcfg.socket}`);

	let cluster: Bun.Server<WsData> | undefined;

	const { ensureHealthSampler } = await import("./health");
	const { ensureUpgradeWatcher } = await import("./upgrade");

	// both roles report their own machine's health; a follower's rides the
	// heartbeat up to the primary, which is where the console reads the fleet
	ensureHealthSampler();

	// keeps "what could this daemon upgrade to" answered from memory; the
	// check itself never applies anything
	ensureUpgradeWatcher();

	if (dcfg.mode === "primary") {
		if (dcfg.listen) {
			const { hubWebSocket, installHub } = await import("./hub");

			cluster = Bun.serve({
				hostname: dcfg.listen.host,
				port: dcfg.listen.port,
				fetch: buildHandler(dcfg, false, startedAt),
				websocket: hubWebSocket,
				// same SSE-idle reasoning as the local listener; a forwarded job's
				// stream crosses this one
				idleTimeout: 0,
			});

			installHub(dcfg, startedAt);

			if (!dcfg.token) {
				log(t("daemon.log.noToken"));
			}

			log(`cluster listener on ${dcfg.listen.host}:${dcfg.listen.port}`);
		}

		const { ensureSampler } = await import("./sampler");
		const { ensureScheduler } = await import("./scheduler");

		ensureSampler();
		ensureScheduler();
		log("sampler + scheduler armed");
	} else {
		const { startFollower } = await import("./follower");
		const { ensureSampler } = await import("./sampler");

		startFollower(dcfg, startedAt);

		// the follower samples its own instances; the scheduler stays primary-only
		ensureSampler();
	}

	const shutdown = async (signal: string): Promise<void> => {
		log(t("daemon.log.shuttingDown", { signal }));

		local.stop(true);
		cluster?.stop(true);

		try {
			await unlink(dcfg.socket);
		} catch {
			// already gone
		}

		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	// the servers keep the event loop alive from here
}

export type { DaemonConfig };
