// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Tracked instance lifecycle: start, stop and restart with live progress
 * derived from the server's own log. The untracked primitives in
 * `instances.ts` stay the source of truth for *how* an instance starts and
 * stops; this module wraps them with a log follower that classifies what the
 * server prints into ProgressReporter phases (JVM bootstrap, server boot,
 * plugin loading, world preparation on the way up; plugin disable and world
 * saving on the way down), so a console or CLI can show *where* a
 * minute-long operation actually is.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { instanceDir, loadLock, managedInstances } from "./config";
import * as instances from "./instances";
import { ping } from "./ping";
import { instancePluginReport } from "./pluginstate";
import { ProgressReporter } from "./progress";
import { ensureInstanceRuntime, isRuntimeInstalled, javaSelection } from "./runtimes";
import * as screen from "./screen";
import { traitsOf } from "./software";
import type { ClusterConfig } from "./types";
import { readJournal } from "./worldops";
import { t } from "../shared/i18n";

/** How often the log is polled while a transition is in flight. */
const POLL_MS = 400;

/** Session-existence checks shell out, so they run on a coarser cadence. */
const SESSION_CHECK_EVERY = 5;

/** A modded world on spinning rust can take minutes; beyond this it is stuck. */
const START_TIMEOUT_MS = 10 * 60_000;

/** How long after "Done" the server gets to answer its first ping. */
const PING_CONFIRM_MS = 15_000;

/** Outcome of a tracked start. */
export interface TrackedStartResult {
	outcome: "started" | "already-running";
	tookMs: number;
}

/**
 * Incremental reader of one log file. Each poll returns only the complete
 * lines appended since the last one; a file that shrank was rotated by the
 * server (Paper archives latest.log on boot), so reading restarts at the top
 * of the new file.
 */
class LogFollower {
	private readonly path: string;
	private offset = 0;
	private remainder = "";

	constructor(path: string) {
		this.path = path;
	}

	/** Skip everything already in the file, so only new output is seen. */
	async seekToEnd(): Promise<void> {
		try {
			this.offset = (await stat(this.path)).size;
		} catch {
			this.offset = 0;
		}
	}

	/** Complete lines appended since the last poll. */
	async poll(): Promise<string[]> {
		let size: number;

		try {
			size = (await stat(this.path)).size;
		} catch {
			return [];
		}

		if (size < this.offset) {
			this.offset = 0;
			this.remainder = "";
		}

		if (size === this.offset) {
			return [];
		}

		const slice = await Bun.file(this.path).slice(this.offset, size).text();

		this.offset = size;

		const lines = (this.remainder + slice).split("\n");

		this.remainder = lines.pop() ?? "";

		return lines.map((line) => line.replace(/\r$/, ""));
	}
}

/**
 * Seconds, from what a ready line happens to report.
 *
 * The vanilla family captures a bare figure already in seconds; pumpkin, being
 * fast enough for it to matter, reports "6ms". The reporter prints the number
 * followed by "s", so a millisecond figure passed through verbatim would read
 * as six seconds.
 */
function elapsedSeconds(elapsed: string): string {
	const match = /^([\d.]+)\s*(ms)?$/i.exec(elapsed.trim());

	if (!match || !Number.isFinite(Number(match[1]))) {
		return elapsed;
	}

	if (!match[2]) {
		return match[1]!;
	}

	return (Number(match[1]) / 1000).toFixed(3);
}

/** Progress ceiling for open-ended counters (plugins), so they never read done. */
const COUNTER_CAP = 0.9;

/** Creep an open-ended counter towards its cap: fast at first, then slower. */
function creep(count: number): number {
	return Math.min(COUNTER_CAP, 0.1 + count * 0.05);
}

/**
 * Start an instance and follow its log until the server reports itself up,
 * mirroring the boot into the reporter: JVM bootstrap, server boot, plugin
 * loading and world preparation (with the real spawn-area percentage). The
 * start itself is `instances.startInstance`'s; this only adds the tracking.
 */
export async function startInstanceTracked(
	cfg: ClusterConfig,
	name: string,
	reporter?: ProgressReporter,
): Promise<TrackedStartResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	// The same refusal `startInstance` makes, but before any of the work above
	// it: this path installs a runtime and renders config files on the way, and
	// a locked instance should cost nothing rather than a few hundred megabytes
	// of download followed by a refusal.
	const lock = await readJournal(instanceDir(inst));

	if (lock) {
		throw new Error(t("core.instances.worldLocked", { name, kind: lock.kind, phase: lock.phase }));
	}

	const progress = reporter ?? new ProgressReporter(`start ${name}`);
	const session = instances.sessionName(cfg, name);
	const startedAt = Date.now();

	if (await screen.sessionExists(session)) {
		progress.complete(t("core.lifecycle.alreadyRunning"));

		return { outcome: "already-running", tookMs: 0 };
	}

	// the phases below are the whole story; the root adds nothing of its own
	progress.weighOwn(0);

	const traits = traitsOf(inst.software, inst.mcVersion);
	const isProxy = traits.isProxy;
	const selection = javaSelection(cfg, inst);

	// a first start on a machine that has never held this runtime downloads a few
	// hundred megabytes; it only becomes a phase when there is really something to
	// install, so an ordinary start's tree keeps the shape operators know
	const runtime =
		selection.kind === "runtime" && !isRuntimeInstalled(selection.id)
			? progress.child(t("core.lifecycle.phaseRuntimeInstall"), 4)
			: undefined;

	// pumpkin is a native binary: there is no JVM to wait for, and saying so
	// on every start of one is the kind of wrong that makes an operator doubt
	// the rest of the tree
	const boot = progress.child(
		traits.usesJava ? t("core.lifecycle.phaseJava") : t("core.lifecycle.phaseProcess"),
		1,
	);
	const server = progress.child(
		isProxy ? t("core.lifecycle.phaseProxyBoot") : t("core.lifecycle.phaseServerBoot"),
		2,
	);
	// a server that never mentions its pack registry cannot be reported on; the
	// phase is left out rather than completed on evidence that was never there
	const datapacks = traits.announcesDataPacks
		? progress.child(t("core.lifecycle.phaseDatapacks"), 1)
		: undefined;
	const plugins = isProxy ? undefined : progress.child(t("core.lifecycle.phasePlugins"), 2);
	const world = isProxy ? undefined : progress.child(t("core.lifecycle.phaseWorld"), 3);

	// Reading every unmanaged jar's descriptor spawns an unzip per member per jar,
	// which on a modpack is hundreds of processes. Doing it here, once, is what
	// keeps it out of the console's addon tab: that tab redraws every few seconds
	// off the same cache, and paying the cost on a start nobody is waiting on
	// beats paying it on every poll. Weighted 1 against the world's 3, because it
	// is bounded by a directory listing rather than by chunk generation.
	const scan = progress.child(t("core.lifecycle.phaseAddonScan"), 1);

	const follower = new LogFollower(join(instanceDir(inst), "logs", "latest.log"));

	await follower.seekToEnd();

	if (runtime) {
		await ensureInstanceRuntime(cfg, name, runtime);
	}

	await boot.task(
		{ start: t("core.lifecycle.spawningSession"), progress: 0.6 },
		() => instances.startInstance(cfg, name),
	);

	boot.info(
		0.6,
		traits.usesJava ? t("core.lifecycle.waitingJvm") : t("core.lifecycle.waitingProcess"),
	);

	let done = false;
	let doneIn = "";
	let sawOutput = false;
	let pluginCount = 0;
	let ticks = 0;
	const deadline = Date.now() + START_TIMEOUT_MS;

	while (!done) {
		if (Date.now() > deadline) {
			throw new Error(
				t("core.lifecycle.startTimeout", { name, minutes: START_TIMEOUT_MS / 60_000 }),
			);
		}

		await Bun.sleep(POLL_MS);

		const lines = await follower.poll();

		if (lines.length > 0 && !sawOutput) {
			sawOutput = true;
			boot.complete(traits.usesJava ? t("core.lifecycle.jvmUp") : t("core.lifecycle.processUp"));
		}

		for (const line of lines) {
			// the wrapper loop restarting (or giving up) mid-start is a crash, and
			// the reporter's failing node is what tells the user where to look
			const exited = /\[luna\] server exited \(code (\d+)\)/.exec(line);

			if (exited) {
				server.error(
					server.progress,
					t("core.lifecycle.exitedDuringStartup", { code: exited[1] ?? "?" }),
				);

				throw new Error(t("core.lifecycle.exitedCheckLogs", { name, code: exited[1] ?? "?" }));
			}

			if (line.includes("[luna] crash loop detected")) {
				throw new Error(t("core.lifecycle.crashLoop", { name }));
			}

			const doneLine = traits.readyMarker.exec(line);

			if (doneLine) {
				done = true;
				doneIn = elapsedSeconds(doneLine[1] ?? "");

				continue;
			}

			// the quietest stretch of a first boot; nothing else prints for a while
			if (line.includes("Loading libraries")) {
				server.info(0.3, t("core.lifecycle.loadingLibraries"));

				continue;
			}

			// the data pack registry loads during bootstrap: new world packs are
			// announced first, then recipes, then advancements; the trio covers
			// vanilla data and world datapacks alike
			const newPack = /Found new data pack ([^,]+), loading it automatically/.exec(line);

			if (newPack && datapacks) {
				datapacks.info(0.3, t("core.lifecycle.loadingPack", { name: newPack[1] ?? "" }));

				continue;
			}

			const recipes = /Loaded (\d+) recipes/.exec(line);

			if (recipes && datapacks) {
				datapacks.info(0.6, t("core.lifecycle.recipesLoaded", { count: recipes[1] ?? "" }));

				continue;
			}

			const advancements = /Loaded (\d+) advancements/.exec(line);

			if (advancements && datapacks) {
				datapacks.complete(
					t("core.lifecycle.advancementsLoaded", { count: advancements[1] ?? "" }),
				);

				continue;
			}

			const version = /Starting minecraft server version (.+)/.exec(line);

			if (version) {
				server.info(0.5, `minecraft ${version[1]}`);

				continue;
			}

			if (line.includes("Loading properties")) {
				server.info(0.7, t("core.lifecycle.loadingProperties"));

				continue;
			}

			if (isProxy && line.includes("Booting up")) {
				server.info(0.5, t("core.lifecycle.velocityBooting"));

				continue;
			}

			// how an addon announces itself is the software's own wording, so the
			// line comes from the traits table; hardcoding bukkit's leaves every
			// mod loader and pumpkin reporting "no plugins logged" on every start
			const addon = traits.addonLoadMarker?.exec(line);

			if (addon && plugins) {
				pluginCount += 1;
				plugins.info(
					creep(pluginCount),
					t("core.lifecycle.loadingPlugin", { name: addon[1] ?? addon[2] ?? "" }),
				);

				continue;
			}

			const level = /Preparing level "([^"]+)"/.exec(line);

			if (level && world) {
				server.complete(t("core.lifecycle.serverCoreUp"));
				world.info(0.05, t("core.lifecycle.preparingLevel", { name: level[1] ?? "" }));

				continue;
			}

			const spawn = /Preparing spawn area: (\d+)%/.exec(line);

			if (spawn && world) {
				world.info(
					0.05 + (Number(spawn[1]) / 100) * 0.9,
					t("core.lifecycle.preparingSpawn", { percent: spawn[1] ?? "0" }),
				);

				continue;
			}

			if (line.includes("Time elapsed:") && world) {
				world.complete(t("core.lifecycle.worldReady"));
			}
		}

		ticks += 1;

		// a boot that dies before its first log line never prints an exit marker
		// into a log that was rotated away; the vanished session is the only sign
		if (!done && ticks % SESSION_CHECK_EVERY === 0 && !(await screen.sessionExists(session))) {
			throw new Error(t("core.lifecycle.sessionVanished", { name }));
		}
	}

	server.complete(
		isProxy
			? t("core.lifecycle.proxyUpIn", { seconds: doneIn })
			: t("core.lifecycle.serverCoreUp"),
	);

	// report() overwrites the message even with undefined, so a node that
	// already told its story must not be completed a second time
	if (datapacks && datapacks.calculated < 1) {
		datapacks.complete(t("core.lifecycle.datapacksLoaded"));
	}

	plugins?.complete(
		pluginCount
			? t("core.lifecycle.pluginStepsDone", { count: pluginCount })
			: t("core.lifecycle.noPluginsLogged"),
	);
	world?.complete(t("core.lifecycle.worldReady"));

	// after the roster has been logged, so the state each row gets is the one this
	// boot actually produced rather than the previous run's
	await scan.task(
		{
			start: t("core.lifecycle.scanningAddons"),
			failed: t("core.lifecycle.addonScanFailed"),
		},
		async () => {
			const report = await instancePluginReport(cfg, await loadLock(), name);

			scan.report(
				1,
				report.unmanaged.length ? "info" : "okay",
				t("core.lifecycle.addonsScanned", {
					managed: report.rows.length,
					unmanaged: report.unmanaged.length,
				}),
			);
		},
	);

	// "Done" means the server believes it is up; the ping is the outside view
	const until = Date.now() + PING_CONFIRM_MS;
	let answered = false;

	while (Date.now() < until) {
		const pong = await ping("127.0.0.1", inst.port);

		if (pong) {
			answered = true;

			break;
		}

		await Bun.sleep(500);
	}

	const tookMs = Date.now() - startedAt;

	if (answered) {
		progress.complete(t("core.lifecycle.startedAnswering", { seconds: doneIn }));
	} else {
		progress.warn(1, t("core.lifecycle.startedNotAnswering", { seconds: doneIn }));
	}

	return { outcome: "started", tookMs };
}

/**
 * Stop an instance gracefully, mirroring the shutdown the server logs
 * (plugins disabling, worlds saving, the process exiting) into the reporter.
 * The stop itself (sentinel, console command, escalation) is
 * `instances.stopInstance`'s; this only adds the tracking.
 */
export async function stopInstanceTracked(
	cfg: ClusterConfig,
	name: string,
	reporter?: ProgressReporter,
): Promise<instances.StopResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const progress = reporter ?? new ProgressReporter(`stop ${name}`);
	const session = instances.sessionName(cfg, name);

	if (!(await screen.sessionExists(session))) {
		progress.complete(t("core.lifecycle.notRunning"));

		return { outcome: "not-running", tookMs: 0 };
	}

	progress.weighOwn(0);

	const isProxy = traitsOf(inst.software, inst.mcVersion).isProxy;
	const plugins = isProxy ? undefined : progress.child(t("core.lifecycle.phasePlugins"), 2);
	const worlds = isProxy ? undefined : progress.child(t("core.lifecycle.phaseWorlds"), 2);
	const exit = progress.child(t("core.lifecycle.phaseExit"), 1);

	const follower = new LogFollower(join(instanceDir(inst), "logs", "latest.log"));

	await follower.seekToEnd();

	exit.info(0.1, isProxy ? t("core.lifecycle.askingVelocity") : t("core.lifecycle.askingServer"));

	const stopping = instances.stopInstance(cfg, name);
	let disabled = 0;

	const classify = (lines: string[]): void => {
		for (const line of lines) {
			if (/Stopping (the )?server/.test(line)) {
				plugins?.info(0.15, t("core.lifecycle.shuttingDown"));

				continue;
			}

			const disabling = /\[(\S+?)\] Disabling (\S+)/.exec(line);

			if (disabling && plugins) {
				disabled += 1;
				plugins.info(creep(disabled), t("core.lifecycle.disablingPlugin", { name: disabling[2] ?? "" }));

				continue;
			}

			if (line.includes("Saving players") && worlds) {
				plugins?.complete(
					disabled
						? t("core.lifecycle.pluginsDisabledCount", { count: disabled })
						: t("core.lifecycle.pluginsDisabled"),
				);
				worlds.info(0.3, t("core.lifecycle.savingPlayers"));

				continue;
			}

			if (line.includes("Saving worlds") && worlds) {
				worlds.info(0.5, t("core.lifecycle.savingWorlds"));

				continue;
			}

			const chunks = /Saving chunks for level '([^']+)'/.exec(line);

			if (chunks && worlds) {
				worlds.info(
					Math.min(0.9, worlds.progress + 0.15),
					t("core.lifecycle.savingChunks", { name: chunks[1] ?? "" }),
				);

				continue;
			}

			if (line.includes("All dimensions are saved") && worlds) {
				worlds.complete(t("core.lifecycle.worldsSaved"));
			}
		}
	};

	// follow the log while the real stop runs; the race wakes on whichever
	// happens first, and the same settled promise racing again costs nothing
	let result: instances.StopResult | undefined;

	while (!result) {
		classify(await follower.poll());

		result = await Promise.race([
			stopping,
			Bun.sleep(POLL_MS).then(() => undefined),
		]);
	}

	classify(await follower.poll());

	if (plugins && plugins.calculated < 1) {
		plugins.complete(
			disabled ? t("core.lifecycle.pluginsDisabledCount", { count: disabled }) : undefined,
		);
	}

	if (worlds && worlds.calculated < 1) {
		worlds.complete();
	}

	if (result.outcome === "forced") {
		exit.warn(1, t("core.lifecycle.stopTimedOut"));
		progress.warn(1, t("core.lifecycle.forcedDown", { name }));
	} else {
		exit.complete(
			t("core.lifecycle.processGone", { seconds: (result.tookMs / 1000).toFixed(1) }),
		);
		progress.complete(
			t("core.lifecycle.stoppedIn", { seconds: (result.tookMs / 1000).toFixed(1) }),
		);
	}

	return result;
}

/**
 * Stop, then start, under one reporter: the console's restart is exactly the
 * two tracked halves in sequence, weighted by how long each really takes.
 */
export async function restartInstanceTracked(
	cfg: ClusterConfig,
	name: string,
	reporter?: ProgressReporter,
): Promise<TrackedStartResult> {
	const progress = reporter ?? new ProgressReporter(`restart ${name}`);

	progress.weighOwn(0);

	const stopNode = progress.child(t("core.lifecycle.phaseStop"), 2);
	const startNode = progress.child(t("core.lifecycle.phaseStart"), 3);

	await stopInstanceTracked(cfg, name, stopNode);

	const result = await startInstanceTracked(cfg, name, startNode);

	progress.complete(t("core.lifecycle.restarted", { name }));

	return result;
}
