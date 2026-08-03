/**
 * Tracked instance lifecycle: start, stop and restart with live progress
 * derived from the server's own log. The untracked primitives in
 * `instances.ts` stay the source of truth for *how* an instance starts and
 * stops; this module wraps them with a log follower that classifies what the
 * server prints into ProgressReporter phases — JVM bootstrap, server boot,
 * plugin loading, world preparation on the way up; plugin disable and world
 * saving on the way down — so a console or CLI can show *where* a
 * minute-long operation actually is.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { instanceDir, managedInstances } from "./config";
import * as instances from "./instances";
import { ping } from "./ping";
import { ProgressReporter } from "./progress";
import * as screen from "./screen";
import type { ClusterConfig } from "./types";

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
 * start itself is `instances.startInstance`'s — this only adds the tracking.
 */
export async function startInstanceTracked(
	cfg: ClusterConfig,
	name: string,
	reporter?: ProgressReporter,
): Promise<TrackedStartResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(`unknown instance: ${name}`);
	}

	const progress = reporter ?? new ProgressReporter(`start ${name}`);
	const session = instances.sessionName(cfg, name);
	const startedAt = Date.now();

	if (await screen.sessionExists(session)) {
		progress.complete("already running");

		return { outcome: "already-running", tookMs: 0 };
	}

	// the phases below are the whole story; the root adds nothing of its own
	progress.weighOwn(0);

	const isProxy = inst.software === "velocity";
	const boot = progress.child("Java runtime", 1);
	const server = progress.child(isProxy ? "Proxy boot" : "Server boot", 2);
	const datapacks = isProxy ? undefined : progress.child("Data packs", 1);
	const plugins = isProxy ? undefined : progress.child("Plugins", 2);
	const world = isProxy ? undefined : progress.child("World", 3);

	const follower = new LogFollower(join(instanceDir(inst), "logs", "latest.log"));

	await follower.seekToEnd();

	await boot.task(
		{ start: "regenerating the run script and spawning the session", progress: 0.6 },
		() => instances.startInstance(cfg, name),
	);

	boot.info(0.6, "screen session up — waiting for the JVM");

	let done = false;
	let doneIn = "";
	let sawOutput = false;
	let pluginCount = 0;
	let ticks = 0;
	const deadline = Date.now() + START_TIMEOUT_MS;

	while (!done) {
		if (Date.now() > deadline) {
			throw new Error(`${name} did not finish starting within ${START_TIMEOUT_MS / 60_000} minutes`);
		}

		await Bun.sleep(POLL_MS);

		const lines = await follower.poll();

		if (lines.length > 0 && !sawOutput) {
			sawOutput = true;
			boot.complete("JVM up — server log is flowing");
		}

		for (const line of lines) {
			// the wrapper loop restarting (or giving up) mid-start is a crash, and
			// the reporter's failing node is what tells the user where to look
			const exited = /\[luna\] server exited \(code (\d+)\)/.exec(line);

			if (exited) {
				server.error(server.progress, `server exited during startup (code ${exited[1]})`);

				throw new Error(`${name} exited during startup (code ${exited[1]}) — check its logs`);
			}

			if (line.includes("[luna] crash loop detected")) {
				throw new Error(`${name} is crash-looping and was shut down — check its logs`);
			}

			const doneLine = /Done \(([\d.]+)s\)!/.exec(line);

			if (doneLine) {
				done = true;
				doneIn = doneLine[1]!;

				continue;
			}

			// the quietest stretch of a first boot — nothing else prints for a while
			if (line.includes("Loading libraries")) {
				server.info(0.3, "loading libraries — a first boot takes a while");

				continue;
			}

			// the data pack registry loads during bootstrap: new world packs are
			// announced first, then recipes, then advancements — the trio covers
			// vanilla data and world datapacks alike
			const newPack = /Found new data pack ([^,]+), loading it automatically/.exec(line);

			if (newPack && datapacks) {
				datapacks.info(0.3, `loading ${newPack[1]}`);

				continue;
			}

			const recipes = /Loaded (\d+) recipes/.exec(line);

			if (recipes && datapacks) {
				datapacks.info(0.6, `${recipes[1]} recipes loaded`);

				continue;
			}

			const advancements = /Loaded (\d+) advancements/.exec(line);

			if (advancements && datapacks) {
				datapacks.complete(`${advancements[1]} advancements loaded`);

				continue;
			}

			const version = /Starting minecraft server version (.+)/.exec(line);

			if (version) {
				server.info(0.5, `minecraft ${version[1]}`);

				continue;
			}

			if (line.includes("Loading properties")) {
				server.info(0.7, "loading server properties");

				continue;
			}

			if (isProxy && line.includes("Booting up")) {
				server.info(0.5, "velocity booting");

				continue;
			}

			const loading = /Loading server plugin (\S+)/.exec(line);

			if (loading && plugins) {
				pluginCount += 1;
				plugins.info(creep(pluginCount), `loading ${loading[1]}`);

				continue;
			}

			const enabling = /\[(\S+?)\] Enabling (\S+)/.exec(line);

			if (enabling && plugins) {
				pluginCount += 1;
				plugins.info(creep(pluginCount), `enabling ${enabling[2]}`);

				continue;
			}

			const level = /Preparing level "([^"]+)"/.exec(line);

			if (level && world) {
				server.complete("server core up");
				world.info(0.05, `preparing level "${level[1]}"`);

				continue;
			}

			const spawn = /Preparing spawn area: (\d+)%/.exec(line);

			if (spawn && world) {
				world.info(0.05 + (Number(spawn[1]) / 100) * 0.9, `preparing spawn area — ${spawn[1]}%`);

				continue;
			}

			if (line.includes("Time elapsed:") && world) {
				world.complete("world ready");
			}
		}

		ticks += 1;

		// a boot that dies before its first log line never prints an exit marker
		// into a log that was rotated away — the vanished session is the only sign
		if (!done && ticks % SESSION_CHECK_EVERY === 0 && !(await screen.sessionExists(session))) {
			throw new Error(`${name}'s screen session vanished during startup — check its logs`);
		}
	}

	server.complete(isProxy ? `proxy up in ${doneIn}s` : "server core up");

	// report() overwrites the message even with undefined, so a node that
	// already told its story must not be completed a second time
	if (datapacks && datapacks.calculated < 1) {
		datapacks.complete("data packs loaded");
	}

	plugins?.complete(pluginCount ? `${pluginCount} plugin step(s) done` : "no plugins logged");
	world?.complete("world ready");

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
		progress.complete(`started in ${doneIn}s — answering pings`);
	} else {
		progress.warn(1, `boot finished in ${doneIn}s but the server is not answering pings yet`);
	}

	return { outcome: "started", tookMs };
}

/**
 * Stop an instance gracefully, mirroring the shutdown the server logs —
 * plugins disabling, worlds saving, the process exiting — into the reporter.
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
		throw new Error(`unknown instance: ${name}`);
	}

	const progress = reporter ?? new ProgressReporter(`stop ${name}`);
	const session = instances.sessionName(cfg, name);

	if (!(await screen.sessionExists(session))) {
		progress.complete("not running");

		return { outcome: "not-running", tookMs: 0 };
	}

	progress.weighOwn(0);

	const isProxy = inst.software === "velocity";
	const plugins = isProxy ? undefined : progress.child("Plugins", 2);
	const worlds = isProxy ? undefined : progress.child("Worlds", 2);
	const exit = progress.child("Process exit", 1);

	const follower = new LogFollower(join(instanceDir(inst), "logs", "latest.log"));

	await follower.seekToEnd();

	exit.info(0.1, isProxy ? "asking velocity to end" : "asking the server to stop");

	const stopping = instances.stopInstance(cfg, name);
	let disabled = 0;

	const classify = (lines: string[]): void => {
		for (const line of lines) {
			if (/Stopping (the )?server/.test(line)) {
				plugins?.info(0.15, "server shutting down");

				continue;
			}

			const disabling = /\[(\S+?)\] Disabling (\S+)/.exec(line);

			if (disabling && plugins) {
				disabled += 1;
				plugins.info(creep(disabled), `disabling ${disabling[2]}`);

				continue;
			}

			if (line.includes("Saving players") && worlds) {
				plugins?.complete(disabled ? `${disabled} plugin(s) disabled` : "plugins disabled");
				worlds.info(0.3, "saving players");

				continue;
			}

			if (line.includes("Saving worlds") && worlds) {
				worlds.info(0.5, "saving worlds");

				continue;
			}

			const chunks = /Saving chunks for level '([^']+)'/.exec(line);

			if (chunks && worlds) {
				worlds.info(Math.min(0.9, worlds.progress + 0.15), `saving chunks — ${chunks[1]}`);

				continue;
			}

			if (line.includes("All dimensions are saved") && worlds) {
				worlds.complete("worlds saved");
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
		plugins.complete(disabled ? `${disabled} plugin(s) disabled` : undefined);
	}

	if (worlds && worlds.calculated < 1) {
		worlds.complete();
	}

	if (result.outcome === "forced") {
		exit.warn(1, "graceful stop timed out — SIGTERM sent");
		progress.warn(1, `${name} was forced down`);
	} else {
		exit.complete(`process gone in ${(result.tookMs / 1000).toFixed(1)}s`);
		progress.complete(`stopped in ${(result.tookMs / 1000).toFixed(1)}s`);
	}

	return result;
}

/**
 * Stop, then start, under one reporter — the console's restart is exactly the
 * two tracked halves in sequence, weighted by how long each really takes.
 */
export async function restartInstanceTracked(
	cfg: ClusterConfig,
	name: string,
	reporter?: ProgressReporter,
): Promise<TrackedStartResult> {
	const progress = reporter ?? new ProgressReporter(`restart ${name}`);

	progress.weighOwn(0);

	const stopNode = progress.child("Stop", 2);
	const startNode = progress.child("Start", 3);

	await stopInstanceTracked(cfg, name, stopNode);

	const result = await startInstanceTracked(cfg, name, startNode);

	progress.complete(`${name} restarted`);

	return result;
}
