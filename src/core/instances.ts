// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";

import type { ClusterConfig, InstanceConfig, PluginsLock } from "./types";
import { addonDirForFamily, instanceDir, loadLock, managedInstances } from "./config";
import { renderManagedFiles } from "./configfiles";
import { ENV_SCRIPT, loadEnv, renderEnvFile, resolveVars } from "./environment";
import { ensureInstanceRuntime, isRuntimeInstalled, javaSelection } from "./runtimes";
import { isJavaAgentJar } from "./archive";
import { agentAddonKey, agentJarOf, agentOptionsOf } from "./settings";
import { traitsOf } from "./software";
import * as screen from "./screen";
import { ping } from "./ping";
import { t } from "../shared/i18n";

export const NORESTART = ".luna-norestart";

/**
 * Dropped by the wrapper loop while it waits out `restartDelay` after a crash.
 * The screen session is alive across that gap but no JVM is, which would
 * otherwise read as "stopped".
 */
export const RESTARTING = ".luna-restarting";

/** Seconds the wrapper waits before relaunching, when nothing says otherwise. */
export const DEFAULT_RESTART_DELAY = 3;

/** Longest wait an instance may ask for: an hour is already absurd. */
export const MAX_RESTART_DELAY = 3600;

const RUN_SCRIPT = "run.sh";

/**
 * How a managed runtime reaches the run script: the builtin the environment
 * file exports, quoted so the whole path stays one shell word.
 */
const JAVA_VAR = '"$LUNA_JAVA"';

/** Screen session name for an instance, e.g. `luna.lobby`. */
export function sessionName(cfg: ClusterConfig, name: string): string {
	return cfg.screenPrefix + name;
}

/**
 * The process name to look this instance's server up by.
 *
 * Everything on a JVM is `java` whatever jar it was handed; a native server is
 * its own executable, and that is the name `/proc` carries for it.
 */
export function serverProcessName(inst: InstanceConfig): string {
	const traits = traitsOf(inst.software, inst.mcVersion);

	// only a native software runs under its own name, and one always names its
	// binary; the software id is what that binary is called anyway
	if (traits.usesJava) {
		return "java";
	}

	return traits.binaryName || inst.software;
}

/**
 * File name of the server binary inside the instance directory. Software that
 * launches from an argument file has no single runnable file, so asking for one
 * is a mistake worth naming rather than an empty string to concatenate.
 */
export function jarName(inst: InstanceConfig): string {
	const name = traitsOf(inst.software, inst.mcVersion).binaryName;

	if (!name) {
		throw new Error(t("core.instances.noBinary", { software: inst.software }));
	}

	return name;
}

/**
 * Whether an instance relaunches itself after an unexpected exit. Absent means
 * on, because that is what every instance did before the field existed.
 */
export function autoRestartOf(inst: InstanceConfig): boolean {
	return inst.autoRestart !== false;
}

/** How long the wrapper waits before relaunching, clamped to something sane. */
export function restartDelayOf(inst: InstanceConfig): number {
	const wanted = inst.restartDelay ?? DEFAULT_RESTART_DELAY;

	if (!Number.isFinite(wanted)) {
		return DEFAULT_RESTART_DELAY;
	}

	return Math.min(MAX_RESTART_DELAY, Math.max(0, Math.round(wanted)));
}

/** Reject a restart delay that is not a whole number of seconds in range. */
export function validateRestartDelay(seconds: number): string | undefined {
	if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
		return t("core.instances.restartDelayNotInteger");
	}

	if (seconds < 0 || seconds > MAX_RESTART_DELAY) {
		return t("core.instances.restartDelayRange", { max: MAX_RESTART_DELAY });
	}

	return undefined;
}

/** Console command that shuts this software down gracefully. */
export function stopCommand(inst: InstanceConfig): string {
	return traitsOf(inst.software, inst.mcVersion).stopCommand;
}

/**
 * The loader's generated argument file, relative to the instance directory.
 * The installer writes the whole classpath and launch target in there, so it
 * is the only supported way to boot such a server; there is no runnable `-jar`.
 */
export function argsFileOf(inst: InstanceConfig): string {
	const resolve = traitsOf(inst.software, inst.mcVersion).argsFile;

	if (!resolve) {
		throw new Error(t("core.instances.noArgsFile", { software: inst.software }));
	}

	return resolve(inst);
}

/**
 * What the daemon measured about one instance, for a server that cannot
 * measure itself.
 *
 * The names are the heartbeat's, not luna's, because that is what this is: the
 * missing half of a backend's own heartbeat, handed to it from outside.
 */
export interface HostMetrics {
	/** Whole machine, 0-100 */
	systemCpuUsagePercent: number;
	/** This instance's share of the whole machine, 0-100 */
	processCpuUsagePercent: number;
	/** Resident set size, which is a native server's answer to heap used */
	ramUsedBytes: number;
	/** The instance's configured size: a native server has no other ceiling */
	ramMaxBytes: number;
}

/** `4G`, `512M`, `2048` (megabytes) as the registry writes it, in bytes. */
function memoryBytes(memory: string): number {
	const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)b?\s*$/i.exec(memory);

	if (!match) {
		return 0;
	}

	const scale: Record<string, number> = {
		"": 1024 * 1024,
		k: 1024,
		m: 1024 * 1024,
		g: 1024 * 1024 * 1024,
		t: 1024 * 1024 * 1024 * 1024,
	};

	return Math.round(Number(match[1]) * (scale[match[2]!.toLowerCase()] ?? 0));
}

/**
 * Leave this instance's metrics where its own server can read them.
 *
 * Only for software that cannot measure itself (`hostMetricsFile`); everything
 * else reports from inside and would only be told what it already knows.
 *
 * The body is form-encoded with the heartbeat's field names, because a
 * heartbeat is exactly what it becomes: the backend splices these into the one
 * it sends. It also means the reader on the other side is the decoder that
 * already parses heartbeat replies, rather than a second format to keep in step.
 * `sampledAtEpochMillis` is the one field the heartbeat has no use for; it is
 * how a backend tells a fresh sample from one left behind by a dead daemon.
 *
 * Best-effort by design: this runs every sample cycle, and an instance whose
 * directory is being deleted underneath it must not take the sampler down.
 */
export async function writeHostMetrics(
	cfg: ClusterConfig,
	name: string,
	usage: { systemCpuPercent?: number; cpuPercentOfOneCore?: number; rssMb?: number },
): Promise<void> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		return;
	}

	const relative = traitsOf(inst.software, inst.mcVersion).hostMetricsFile;

	if (!relative) {
		return;
	}

	// the sampler counts an instance's CPU against a single core, because that
	// is what the console's column means; the heartbeat field means share of
	// the machine, which is what a JVM reports for the same thing
	const cores = Math.max(1, cpus().length);
	const metrics: HostMetrics = {
		systemCpuUsagePercent: round(usage.systemCpuPercent ?? 0),
		processCpuUsagePercent: round((usage.cpuPercentOfOneCore ?? 0) / cores),
		ramUsedBytes: Math.round((usage.rssMb ?? 0) * 1024 * 1024),
		ramMaxBytes: memoryBytes(inst.memory),
	};

	const body = new URLSearchParams({
		sampledAtEpochMillis: String(Date.now()),
		...Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, String(value)])),
	}).toString();

	const target = join(instanceDir(inst), relative);

	try {
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, `${body}\n`, "utf8");
	} catch {
		// the backend keeps its last sample and drops it once it goes stale;
		// there is nothing here worth failing a sample cycle over
	}
}

/** One decimal, clamped to a percentage. */
function round(percent: number): number {
	return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
}

/**
 * Assemble the full launch command for an instance.
 *
 * Three shapes, by the software's launch kind. A `jar` server runs `-jar`; an
 * `argsfile` server (the forge loaders) launches from the installer's argument
 * file, which already carries the classpath and the launch target, so luna
 * contributes only the heap, the profile's flags and `nogui`; a `native` server
 * is an executable with no JVM anywhere, so the profile, the heap and the
 * managed runtime are all skipped. The loader pack's own `user_jvm_args.txt` is
 * deliberately not referenced, because memory and flags come from the registry.
 *
 * `--nogui` versus a bare `nogui` is not cosmetic: paper parses it as an option,
 * modlauncher and the vanilla-derived servers as a program argument.
 *
 * A managed runtime is emitted as `$LUNA_JAVA` rather than as its path: this
 * function is pure config and runs on clients too, where the cluster root is
 * the primary's and a follower's runtime path would be wrong. The variable is a
 * builtin the environment file carries, resolved by the daemon that owns the
 * instance, and `.luna-env` is sourced above the loop that runs this line.
 */
/**
 * Where an agent entry's jar sits, relative to the instance directory, or
 * undefined when it names an addon the lockfile does not have.
 *
 * A path entry already is that answer. An `addon:` entry names a pooled addon
 * instead, and the jar is wherever deploy puts it: the directory that addon's
 * family uses, under the lockfile's own file name. That indirection is the whole
 * point of the form - the operator picks the plugin, and luna keeps the path
 * right as the plugin is updated, re-familied or moved between addon directories.
 */
export function resolveAgentJar(entry: string, lock?: PluginsLock): string | undefined {
	const addon = agentAddonKey(entry);

	if (addon === undefined) {
		return agentJarOf(entry);
	}

	const pooled = lock?.plugins[addon];

	if (!pooled) {
		return undefined;
	}

	return `${addonDirForFamily(pooled.family)}/${pooled.file}`;
}

/**
 * The `-javaagent:` flag an entry becomes, carrying its options through.
 *
 * An addon reference the lockfile cannot answer is rendered verbatim rather than
 * dropped: this string is also what the instance detail view shows, and an agent
 * silently missing from it would read as a working command. Refusing to start on
 * one is `writeRunScript`'s job, where the reason can actually be reported.
 */
function agentFlag(entry: string, lock?: PluginsLock): string {
	const jar = resolveAgentJar(entry, lock) ?? agentJarOf(entry);

	return `-javaagent:${jar}${agentOptionsOf(entry)}`;
}

export function buildJavaCommand(
	cfg: ClusterConfig,
	inst: InstanceConfig,
	lock?: PluginsLock,
): string {
	const traits = traitsOf(inst.software, inst.mcVersion);

	if (!traits.usesJava) {
		return `./${jarName(inst)}`;
	}

	const profile = cfg.javaProfiles[inst.profile];

	if (!profile) {
		throw new Error(t("core.instances.unknownProfile", { name: inst.profile }));
	}

	const selection = javaSelection(cfg, inst);

	const java = selection.kind === "path"
		? selection.path
		: selection.kind === "runtime"
			? JAVA_VAR
			: "java";

	const parts = [
		java,
		`-Xms${inst.memory}`,
		`-Xmx${inst.memory}`,
		...profile.flags,
		// per-instance flags last, so they win over the profile's defaults for any
		// option the JVM resolves by last-one-wins
		...(inst.javaArgs ?? []),
		// agents after the flags they may want to read, and immediately before the
		// jar, which is where an operator reading the resolved command looks for them
		...(inst.javaAgents ?? []).map((entry) => agentFlag(entry, lock)),
	];

	if (traits.kind === "argsfile") {
		parts.push(`@${argsFileOf(inst)}`);
	} else {
		parts.push("-jar", jarName(inst));
	}

	if (traits.noGui === "flag") {
		parts.push("--nogui");
	} else if (traits.noGui === "bare") {
		parts.push("nogui");
	}

	if (profile.jarArgs) {
		parts.push(...profile.jarArgs);
	}

	return parts.join(" ");
}

/**
 * Write the instance's environment file from the store, resolved for this
 * instance (builtin < global < machine < instance). Regenerated on every start
 * so a variable change needs nothing but a restart, and 0600 because the
 * resolved set includes whatever the operator marked secret.
 */
export async function writeEnvFile(cfg: ClusterConfig, name: string): Promise<string> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const vars = await resolveVars(cfg, await loadEnv(), name);
	const path = join(instanceDir(inst), ENV_SCRIPT);

	await Bun.write(path, renderEnvFile(vars));
	await chmod(path, 0o600);

	return path;
}

/** Generate the instance run script (auto-restart loop with stop sentinel + crash-loop guard). */
export async function writeRunScript(cfg: ClusterConfig, name: string): Promise<string> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const selection = javaSelection(cfg, inst);

	// starting installs the runtime first, so this only trips when the script is
	// written on its own, or when the runtime was removed from under the instance
	if (selection.kind === "runtime" && !isRuntimeInstalled(selection.id)) {
		throw new Error(t("core.runtimes.notInstalled", { id: selection.id, name }));
	}

	// a -javaagent: pointing at nothing aborts the JVM before a single line of
	// server log, so the instance would look like it crashed for no reason; say
	// what is wrong while there is still something readable to say it in. The
	// three ways it can be wrong get three answers, because "deploy it" and
	// "fix the name" are different jobs.
	const agents = inst.javaAgents ?? [];
	const lock = agents.some((entry) => agentAddonKey(entry) !== undefined)
		? await loadLock()
		: undefined;

	for (const entry of agents) {
		const addon = agentAddonKey(entry);
		const jar = resolveAgentJar(entry, lock);

		if (!jar) {
			throw new Error(t("core.instances.agentAddonUnknown", { addon: addon ?? entry, name }));
		}

		const path = join(instanceDir(inst), jar);

		if (!existsSync(path)) {
			throw new Error(
				addon === undefined
					? t("core.instances.agentJarMissing", { jar, name })
					: t("core.instances.agentAddonNotDeployed", { addon, jar, name }),
			);
		}

		// the picker offers every addon this instance has, and most addons are not
		// agents; without this the mistake surfaces as a server that died with no
		// log at all, because the JVM refuses before it runs anything
		if (!(await isJavaAgentJar(path))) {
			throw new Error(t("core.instances.agentNotAnAgent", { jar: addon ?? jar, name }));
		}
	}

	const header = `#!/bin/bash
# Generated by luna. Do not edit; it is regenerated on every start.
cd "$(dirname "$0")" || exit 1
rm -f ${NORESTART} ${RESTARTING}

# Environment manager (luna env): every variable the instance resolves, exported
# into the JVM's environment. Written beside this script on every start.
if [ -f ${ENV_SCRIPT} ]; then
    . ./${ENV_SCRIPT}
fi
`;

	// A requested stop is answered the same way whether or not the instance
	// relaunches itself, so both shapes below check the sentinel first: it is what
	// makes "luna stop" mean stopped rather than "restart in three seconds".
	const stopCheck = (indent: string): string =>
		[
			`${indent}if [ -f ${NORESTART} ]; then`,
			`${indent}    rm -f ${NORESTART}`,
			`${indent}    echo "[luna] stop requested, not restarting."`,
			`${indent}    exit 0`,
			`${indent}fi`,
		].join("\n");

	// Auto-restart off: run once and report the exit. No loop is emitted at all,
	// rather than a loop with an unreachable tail, because an operator reads this.
	const script = autoRestartOf(inst)
		? `${header}
CRASH_WINDOW=300
CRASH_MAX=3
RESTART_DELAY=${restartDelayOf(inst)}
crashes=()

while true; do
    ${buildJavaCommand(cfg, inst, lock)}
    code=$?

${stopCheck("    ")}

    now=$(date +%s)
    recent=()
    for t in "\${crashes[@]}"; do
        [ $(( now - t )) -lt $CRASH_WINDOW ] && recent+=("$t")
    done
    crashes=("\${recent[@]}" "$now")
    if [ "\${#crashes[@]}" -ge "$CRASH_MAX" ]; then
        echo "[luna] crash loop detected (\${#crashes[@]} exits in \${CRASH_WINDOW}s), staying down."
        exit 1
    fi

    echo "[luna] server exited (code $code), restarting in \${RESTART_DELAY}s. Ctrl+C to abort."

    # the sentinel is what lets luna tell "waiting to relaunch" apart from
    # "stopped": the session is alive through the wait, but no JVM is
    date +%s > ${RESTARTING}
    sleep $RESTART_DELAY
    rm -f ${RESTARTING}
done
`
		: `${header}
${buildJavaCommand(cfg, inst, lock)}
code=$?

${stopCheck("")}

echo "[luna] server exited (code $code), auto-restart is off."
exit $code
`;

	const path = join(instanceDir(inst), RUN_SCRIPT);

	await Bun.write(path, script);
	await chmod(path, 0o755);

	return path;
}

export interface InstanceStatus {
	name: string;
	inst: InstanceConfig;
	/** stopped = no session; starting = session+process but no ping; running =
	 *  answers pings; auto-restarting = the wrapper is waiting out its delay after
	 *  a crash; unknown = owned by an unreachable follower daemon */
	state: "stopped" | "starting" | "running" | "auto-restarting" | "unknown";
	javaPid?: number;
	uptimeMs?: number;
	players?: { online: number; max: number };
	pingVersion?: string;
	/** When auto-restarting, the moment the wrapper began waiting */
	restartingSince?: number;
}

/**
 * The epoch millisecond the wrapper started waiting to relaunch, or undefined
 * when it is not waiting. The file holds unix seconds, written by `date +%s`.
 */
async function readRestartingSince(dir: string): Promise<number | undefined> {
	const path = join(dir, RESTARTING);

	if (!existsSync(path)) {
		return undefined;
	}

	const seconds = Number.parseInt((await Bun.file(path).text().catch(() => "")).trim(), 10);

	return Number.isFinite(seconds) ? seconds * 1000 : Date.now();
}

/**
 * Live state of one instance: whether its session and java process exist, and
 * whether the server answers a status ping (the difference between "starting"
 * and "running").
 */
export async function getStatus(cfg: ClusterConfig, name: string): Promise<InstanceStatus> {
	const inst = managedInstances(cfg)[name]!;
	const dir = instanceDir(inst);
	const session = sessionName(cfg, name);

	const [hasSession, pid] = await Promise.all([
		screen.sessionExists(session),
		screen.serverPidFor(dir, serverProcessName(inst)),
	]);

	const up = hasSession && pid !== undefined;

	const status: InstanceStatus = {
		name,
		inst,
		state: up ? "starting" : "stopped",
		javaPid: pid,
	};

	// a live session with no JVM is either mid-relaunch or genuinely down; the
	// sentinel the wrapper writes is what tells them apart. It is only trusted
	// while the session lives, so one left behind by a killed session is inert.
	if (hasSession && pid === undefined) {
		const since = await readRestartingSince(dir);

		if (since !== undefined) {
			status.state = "auto-restarting";
			status.restartingSince = since;
		}
	}

	if (pid) {
		const started = await screen.processStartTime(pid);

		if (started) {
			status.uptimeMs = Date.now() - started.getTime();
		}
	}

	if (up) {
		const pong = await ping("127.0.0.1", inst.port);

		if (pong) {
			status.state = "running";
			status.players = { online: pong.online, max: pong.max };
			status.pingVersion = pong.version;
		}
	}

	return status;
}

/** Live state of every managed instance, probed in parallel. */
export async function getAllStatuses(cfg: ClusterConfig): Promise<InstanceStatus[]> {
	const names = Object.keys(managedInstances(cfg));

	return await Promise.all(names.map((name) => getStatus(cfg, name)));
}

/** Start an instance in its screen session, regenerating its run script first. */
export async function startInstance(
	cfg: ClusterConfig,
	name: string,
): Promise<"started" | "already-running"> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const session = sessionName(cfg, name);

	if (await screen.sessionExists(session)) {
		return "already-running";
	}

	// everything derived from the registry and the env store is rebuilt here, so a
	// start is what converges the instance onto the current state: the runtime it
	// launches on, the env file the JVM inherits, the managed config files rendered
	// from their templates, then the run script that ties them together
	await ensureInstanceRuntime(cfg, name);
	await writeEnvFile(cfg, name);
	await renderManagedFiles(cfg, name);

	const script = await writeRunScript(cfg, name);

	await screen.startDetached(session, script, instanceDir(inst));

	return "started";
}

export interface StopResult {
	outcome: "stopped" | "not-running" | "forced";
	tookMs: number;
}

/**
 * Stop an instance gracefully: drop the no-restart sentinel so the wrapper loop
 * exits, ask the server to shut itself down, then escalate to SIGTERM and to
 * killing the session if it overruns `timeoutMs`. Idempotent: stopping an
 * already-stopped instance reports "not-running" and touches nothing.
 */
export async function stopInstance(
	cfg: ClusterConfig,
	name: string,
	timeoutMs = 120_000,
): Promise<StopResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const dir = instanceDir(inst);
	const session = sessionName(cfg, name);
	const started = Date.now();

	if (!(await screen.sessionExists(session))) {
		return { outcome: "not-running", tookMs: 0 };
	}

	// Sentinel first so the wrapper loop exits instead of restarting. A stop
	// landing mid-wait also clears the restart marker, so nothing is left behind
	// claiming a relaunch that is no longer coming.
	await Bun.write(join(dir, NORESTART), "");
	await rm(join(dir, RESTARTING), { force: true });

	const processName = serverProcessName(inst);
	const pid = await screen.serverPidFor(dir, processName);
	let forced = false;

	if (pid !== undefined) {
		await screen.stuff(session, stopCommand(inst));

		while (Date.now() - started < timeoutMs) {
			const alive = await screen.serverPidFor(dir, processName);

			if (alive === undefined || alive !== pid) {
				break;
			}

			await Bun.sleep(500);
		}

		if ((await screen.serverPidFor(dir, processName)) === pid) {
			process.kill(pid, "SIGTERM");
			await Bun.sleep(3000);
			forced = true;
		}
	}

	// Wait for the wrapper to exit on its own, then make sure the session is gone.
	for (let i = 0; i < 20 && (await screen.sessionExists(session)); i++) {
		await Bun.sleep(250);
	}

	if (await screen.sessionExists(session)) {
		await screen.quit(session);
	}

	// Kill a respawned server (legacy start loop won the race): <1s old, pre-world-load.
	const respawned = await screen.serverPidFor(dir, processName);

	if (respawned !== undefined && respawned !== pid) {
		try {
			process.kill(respawned, "SIGTERM");
		} catch {
			// it exited on its own between the lookup and the signal
		}
	}

	const sentinel = join(dir, NORESTART);

	if (existsSync(sentinel)) {
		await rm(sentinel, { force: true });
	}

	return {
		outcome: forced ? "forced" : "stopped",
		tookMs: Date.now() - started,
	};
}

/** Order for --all operations: proxy first on start, proxy last on stop. */
export function orderedNames(cfg: ClusterConfig, mode: "start" | "stop"): string[] {
	const names = Object.keys(managedInstances(cfg));
	const backends = names.filter((name) => name !== "proxy").sort();

	return mode === "start" ? ["proxy", ...backends] : [...backends, "proxy"];
}

/** Send an arbitrary console command to a running instance. */
export async function sendCommand(
	cfg: ClusterConfig,
	name: string,
	cmd: string,
): Promise<boolean> {
	const session = sessionName(cfg, name);

	if (!(await screen.sessionExists(session))) {
		return false;
	}

	await screen.stuff(session, cmd);

	return true;
}
