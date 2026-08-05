// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * `sudo luna setup` is the machine installer.
 *
 * Everything a host needs to run a daemon 24/7, in one root-owned pass: a
 * service account, the cluster root, the single binary inside it, PATH wiring
 * so that binary is reachable, the daemon config, the systemd unit, shell
 * completion, then enable + start + verify. It is the only command that writes
 * outside the cluster root, and the only one that requires root.
 *
 * Deliberately not a wrapper around `daemon service install`: that command
 * writes a unit for an already-configured host, this one *configures* the host.
 * They share `unitFile()` and nothing else.
 */

import { existsSync } from "node:fs";
import {
	chmod,
	chown,
	copyFile,
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { command, Bail } from "../framework";
import { pc, info, ok, warn, fail, Spinner } from "../ui";
import { BASH_HOOK } from "../complete";
import { unitFile, UNIT_NAME, UNIT_PATH } from "./daemon";
import { DEFAULT_CLUSTER_PORT } from "../../daemon/config";
import { starterCluster } from "../../shared/bootstrap";
import { isCompiledBinary } from "../../version";
import { t } from "../../shared/i18n";

/**
 * The one binary, under the service account's home, which `createUser` sets to
 * the cluster root.
 *
 * A self-upgrade stages `<path>.new` beside the binary and renames it into
 * place, so it needs write permission on the **containing directory**, not just
 * the file. A binary in `/usr/local/bin` can therefore never replace itself,
 * however it is owned, and that directory must stay root's. Keeping the single
 * copy in a directory the service account already owns is what makes an
 * unattended upgrade possible at all; humans reach it through PATH instead.
 */
const BIN_DIR = ".bin";

/** Pre-1.0 installs put a second, root-owned copy here. It is removed on sight. */
const LEGACY_BIN = "/usr/local/bin/luna";

/** System-wide PATH entry, for login shells of every account. */
const PROFILE_PATH = "/etc/profile.d/luna.sh";

/** Marker around the block setup owns in a shell rc file, so a re-run replaces it. */
const RC_OPEN = "# >>> luna >>>";
const RC_CLOSE = "# <<< luna <<<";

/** Interactive non-login shells never read /etc/profile.d, so rc files matter too. */
const RC_FILES = [".bashrc", ".zshrc"];

/** The daemon config the unit points at; first candidate in the probe order. */
const CONFIG_PATH = "/etc/luna/daemon.json";

/** Default service account, when the invoking user is root itself. */
const DEFAULT_USER = "luna";

/** Default cluster root on a machine that has none yet. */
const DEFAULT_ROOT = "/srv/luna";

/** How long `--start` waits for the daemon to answer on its socket. */
const VERIFY_TIMEOUT_MS = 20_000;

interface Plan {
	mode: "primary" | "follower";
	name: string;
	root: string;
	user: string;
	group: string;
	token: string | undefined;
	listen: string | undefined;
	primary: string | undefined;
	host: string | undefined;
	bin: string;
	dryRun: boolean;
	start: boolean;
}

/** Run a command, returning its exit code and captured output. */
async function run(argv: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();

	return { code: await proc.exited, out: (out + err).trim() };
}

/** Whether this machine is running systemd, rather than only having it installed. */
function hasSystemd(): boolean {
	return existsSync("/run/systemd/system");
}

/** Whether a user account exists, without shelling out to id(1) for the answer. */
async function userExists(name: string): Promise<boolean> {
	const passwd = await readFile("/etc/passwd", "utf8").catch(() => "");

	return passwd.split("\n").some((line) => line.startsWith(`${name}:`));
}

/**
 * Create the service account: a system user with no login shell, homed at the
 * cluster root. Servers run as this user, so it owns everything under the root.
 */
async function createUser(name: string, home: string): Promise<void> {
	const result = await run([
		"useradd",
		"--system",
		"--home-dir",
		home,
		"--shell",
		"/usr/sbin/nologin",
		"--comment",
		"luna cluster daemon",
		name,
	]);

	if (result.code !== 0) {
		throw new Bail(t("cli.setup.userCreateFailed", { name, error: result.out }));
	}
}

/** Numeric uid/gid of an account, for the chowns the installer does itself. */
async function uidGid(name: string): Promise<{ uid: number; gid: number }> {
	const uid = await run(["id", "-u", name]);
	const gid = await run(["id", "-g", name]);

	if (uid.code !== 0 || gid.code !== 0) {
		throw new Bail(t("cli.setup.uidGidFailed", { name }));
	}

	return { uid: Number(uid.out), gid: Number(gid.out) };
}

/** Recursive chown, which node's own chown is not. */
async function chownTree(path: string, uid: number, gid: number): Promise<void> {
	const result = await run(["chown", "-R", `${uid}:${gid}`, path]);

	if (result.code !== 0) {
		throw new Bail(t("cli.setup.chownFailed", { path, error: result.out }));
	}
}

/** Write a file the plan describes, or say what would be written. */
async function place(
	plan: Plan,
	path: string,
	content: string,
	mode: number,
	owner?: { uid: number; gid: number },
): Promise<void> {
	if (plan.dryRun) {
		info(
			`${t("cli.setup.wouldWrite", { path: pc.cyan(path) })} ${pc.dim(`(${content.length} bytes, mode ${mode.toString(8)})`)}`,
		);

		return;
	}

	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
	await chmod(path, mode);

	if (owner) {
		await chown(path, owner.uid, owner.gid);
	}

	ok(t("cli.setup.wrote", { path }));
}

/**
 * Install the running binary at one path, unless it is already there.
 *
 * Copied to a staging file and renamed into place rather than written over:
 * on a re-run the destination is a *running* daemon's executable, and writing
 * into that is ETXTBSY. The rename is atomic and the running process keeps the
 * inode it started from, the same swap a self-upgrade does.
 */
async function installBinary(
	plan: Plan,
	target: string,
	owner?: { uid: number; gid: number },
): Promise<void> {
	const source = process.execPath;

	if (resolve(source) === resolve(target)) {
		info(t("cli.setup.binaryInPlace", { path: target }));

		return;
	}

	if (plan.dryRun) {
		info(
			`${t("cli.setup.wouldInstall", { source: pc.cyan(source), target: pc.cyan(target) })}${owner ? pc.dim(` (${t("cli.setup.ownedBy", { user: plan.user })})`) : ""}`,
		);

		return;
	}

	const staging = `${target}.new`;

	await mkdir(dirname(target), { recursive: true });

	try {
		await copyFile(source, staging);
		await chmod(staging, 0o755);

		if (owner) {
			await chown(staging, owner.uid, owner.gid);
		}

		await rename(staging, target);
	} catch (err) {
		await unlink(staging).catch(() => {});

		throw err;
	}

	const size = ((await stat(target)).size / 1024 / 1024).toFixed(1);

	ok(
		`${t("cli.setup.installed", { path: target })} ${pc.dim(`(${size} MB${owner ? `, ${t("cli.setup.ownedBy", { user: plan.user })}` : ""})`)}`,
	);
}

/**
 * Install the binary into a directory the service account owns.
 *
 * The directory has to belong to it, not just the file: an upgrade writes
 * `luna.new` next to the target before renaming it over, which is a write
 * against the *directory*. Owning it is the whole point.
 */
async function installDaemonBinary(plan: Plan, owner: { uid: number; gid: number }): Promise<void> {
	if (!plan.dryRun) {
		const dir = dirname(plan.bin);

		await mkdir(dir, { recursive: true });
		await chown(dir, owner.uid, owner.gid);
		await chmod(dir, 0o755);
	}

	await installBinary(plan, plan.bin, plan.dryRun ? undefined : owner);

	if (plan.dryRun) {
		return;
	}

	// A cluster root on a `noexec` mount would take the unit down with a bare
	// systemd 203/EXEC, which says nothing about why. Ask now, while there is
	// still somewhere useful to point the user.
	const probe = await run([plan.bin, "version"]).catch(() => ({ code: -1, out: "" }));

	if (probe.code !== 0) {
		throw new Bail(
			t("cli.setup.noexec", {
				bin: plan.bin,
				error: probe.out || t("cli.setup.spawnFailed"),
				root: plan.root,
			}),
		);
	}
}

/** Drop the root-owned copy an older install left on PATH. */
async function removeLegacyBinary(plan: Plan): Promise<void> {
	if (resolve(plan.bin) === resolve(LEGACY_BIN) || !existsSync(LEGACY_BIN)) {
		return;
	}

	if (plan.dryRun) {
		info(
			`${t("cli.setup.wouldRemove", { path: pc.cyan(LEGACY_BIN) })} ${pc.dim(t("cli.setup.superseded"))}`,
		);

		return;
	}

	await unlink(LEGACY_BIN);

	ok(`${t("cli.setup.removed", { path: LEGACY_BIN })} ${pc.dim(t("cli.setup.supersededShort"))}`);
}

/**
 * Replace the block this installer owns in a shell rc file, leaving everything
 * else byte-for-byte. Returns whether the file changed.
 */
async function rewriteBlock(path: string, block: string): Promise<boolean> {
	const before = existsSync(path) ? await readFile(path, "utf8") : "";
	const open = before.indexOf(RC_OPEN);
	const close = before.indexOf(RC_CLOSE);

	let after: string;

	if (open !== -1 && close > open) {
		after = before.slice(0, open) + block + before.slice(close + RC_CLOSE.length);
	} else {
		after = before.endsWith("\n") || before === "" ? `${before}${block}\n` : `${before}\n${block}\n`;
	}

	if (after === before) {
		return false;
	}

	await writeFile(path, after);

	return true;
}

/**
 * Put the binary's directory on PATH, since there is no longer a copy in a
 * directory that is already there.
 *
 * Two places, because they cover different shells: `/etc/profile.d` is read by
 * *login* shells of every account, and the rc files by *interactive non-login*
 * ones, which is what a terminal emulator or a tmux pane usually starts, and
 * which would otherwise never see the change. Only the human who invoked sudo
 * gets rc edits; the service account has no login shell to read them.
 */
async function wirePath(plan: Plan): Promise<void> {
	const dir = dirname(plan.bin);
	const block = `${RC_OPEN}\nexport PATH="${dir}:$PATH"\n${RC_CLOSE}`;

	await place(plan, PROFILE_PATH, `${block}\n`, 0o644);

	const human = process.env.SUDO_USER;

	if (!human || human === "root") {
		return;
	}

	const home = await run(["getent", "passwd", human]);
	const fields = home.out.split(":");
	const homeDir = fields[5];

	if (!homeDir || !existsSync(homeDir)) {
		return;
	}

	for (const name of RC_FILES) {
		const path = join(homeDir, name);

		// only files the user already keeps: creating a .zshrc for someone who
		// does not run zsh is litter, and /etc/profile.d already covers login
		if (!existsSync(path)) {
			continue;
		}

		if (plan.dryRun) {
			info(t("cli.setup.wouldWirePath", { dir: pc.cyan(dir), path: pc.cyan(path) }));

			continue;
		}

		if (await rewriteBlock(path, block)) {
			ok(t("cli.setup.pathSet", { path }));
		}
	}
}

/**
 * Make sure the cluster root exists and belongs to the service account. A
 * primary also needs a registry to start at all, so an empty one is seeded when
 * the directory has none; a follower's arrives over the cluster link.
 */
async function prepareRoot(plan: Plan, owner: { uid: number; gid: number }): Promise<void> {
	const registry = join(plan.root, "cluster.json");

	if (plan.dryRun) {
		info(t("cli.setup.wouldCreateRoot", { root: pc.cyan(plan.root), user: plan.user }));

		if (plan.mode === "primary" && !existsSync(registry)) {
			info(t("cli.setup.wouldSeed", { path: pc.cyan(registry) }));
		}

		return;
	}

	await mkdir(plan.root, { recursive: true });

	if (plan.mode === "primary" && !existsSync(registry)) {
		await writeFile(registry, JSON.stringify(starterCluster(), null, "\t") + "\n");

		ok(`${t("cli.setup.seeded", { path: registry })} ${pc.dim(t("cli.setup.noInstancesYet"))}`);
	}

	await chownTree(plan.root, owner.uid, owner.gid);

	ok(t("cli.setup.rootOwned", { root: plan.root, user: plan.user }));
}

/** The daemon config the unit points at, with only the keys this mode uses. */
function configFile(plan: Plan): string {
	const config: Record<string, unknown> = {
		mode: plan.mode,
		name: plan.name,
		root: plan.root,
	};

	if (plan.mode === "primary") {
		config.listen = {
			host: plan.listen?.split(":")[0] || "0.0.0.0",
			port: Number(plan.listen?.split(":")[1] ?? DEFAULT_CLUSTER_PORT),
		};
	} else {
		config.primary = { address: plan.primary };

		if (plan.host) {
			config.host = plan.host;
		}
	}

	if (plan.token) {
		config.token = plan.token;
	}

	return JSON.stringify(config, null, "\t") + "\n";
}

/** Whether the service is running right now. */
async function serviceActive(): Promise<boolean> {
	return (await run(["systemctl", "is-active", "--quiet", UNIT_NAME])).code === 0;
}

/**
 * Make systemd re-read the unit. Always run once the unit is written, even with
 * `--no-start`: leaving it stale makes every later systemctl call warn that the
 * unit changed on disk.
 */
async function reloadUnits(plan: Plan): Promise<void> {
	if (plan.dryRun) {
		info(t("cli.setup.wouldRun", { command: pc.cyan("systemctl daemon-reload") }));

		return;
	}

	const reload = await run(["systemctl", "daemon-reload"]);

	if (reload.code !== 0) {
		throw new Bail(t("cli.setup.reloadFailed", { error: reload.out }));
	}
}

/**
 * Ask systemd to pick up the unit and bring it online.
 *
 * A service that was already running is *restarted*, not left alone: the whole
 * point of a re-run is that the binary or the config changed, and
 * `enable --now` is a no-op on something already active. It would leave the
 * old build serving.
 */
async function enableService(plan: Plan, wasActive: boolean): Promise<void> {
	const verb = wasActive ? "restart" : "enable --now";

	if (plan.dryRun) {
		info(t("cli.setup.wouldRun", { command: pc.cyan(`systemctl ${verb} ${UNIT_NAME}`) }));

		return;
	}

	// enabling is separate from starting so a re-run also repairs a unit that
	// was disabled by hand
	const enable = await run(["systemctl", "enable", UNIT_NAME]);

	if (enable.code !== 0) {
		throw new Bail(
			t("cli.setup.systemctlFailed", { command: `systemctl enable ${UNIT_NAME}`, error: enable.out }),
		);
	}

	const start = await run(["systemctl", wasActive ? "restart" : "start", UNIT_NAME]);

	if (start.code !== 0) {
		throw new Bail(
			t("cli.setup.systemctlFailed", {
				command: `systemctl ${wasActive ? "restart" : "start"} ${UNIT_NAME}`,
				error: start.out,
			}),
		);
	}

	ok(
		wasActive
			? t("cli.setup.restarted", { unit: UNIT_NAME })
			: t("cli.setup.enabledStarted", { unit: UNIT_NAME }),
	);
}

/**
 * Wait for the daemon to answer. A unit that starts and immediately dies is the
 * failure this catches; systemd reports the start as successful either way.
 */
async function verify(plan: Plan): Promise<void> {
	const spinner = new Spinner().start(t("cli.setup.waiting"));
	const deadline = Date.now() + VERIFY_TIMEOUT_MS;

	while (Date.now() < deadline) {
		const result = await run([plan.bin, "daemon", "status"]);

		if (result.code === 0 && result.out.includes(plan.name)) {
			spinner.stop();

			for (const line of result.out.split("\n")) {
				console.log(`  ${line}`);
			}

			return;
		}

		await Bun.sleep(1000);
	}

	spinner.stop();

	warn(t("cli.setup.noAnswer"));
	info(
		t("cli.setup.checkHint", {
			status: pc.cyan(`systemctl status ${UNIT_NAME}`),
			journal: pc.cyan(`journalctl -u ${UNIT_NAME} -n 50`),
		}),
	);
}

/** Prompt for a value, falling back to the default when not on a terminal. */
async function ask(
	message: string,
	initial: string,
	interactive: boolean,
): Promise<string> {
	if (!interactive) {
		return initial;
	}

	const { text, isCancel } = await import("@clack/prompts");
	const answer = await text({ message, initialValue: initial, defaultValue: initial });

	if (isCancel(answer)) {
		throw new Bail(t("cli.common.aborted"));
	}

	return String(answer || initial);
}

/**
 * What this machine was configured with last time, if anything.
 *
 * Re-running the installer is a *reconfigure*, not a reset: the existing values
 * become the defaults, so `luna setup --root /new/place` moves the root without
 * silently rotating the cluster token and orphaning every follower.
 */
async function existingSetup(): Promise<{
	config: Partial<Plan> & { listen?: string };
	user?: string;
}> {
	const config: Partial<Plan> & { listen?: string } = {};

	if (existsSync(CONFIG_PATH)) {
		try {
			const saved = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as {
				mode?: "primary" | "follower";
				name?: string;
				root?: string;
				token?: string;
				host?: string;
				listen?: { host?: string; port?: number };
				primary?: { address?: string };
			};

			config.mode = saved.mode;
			config.name = saved.name;
			config.root = saved.root;
			config.token = saved.token;
			config.host = saved.host;
			config.primary = saved.primary?.address;

			if (saved.listen) {
				config.listen = `${saved.listen.host ?? "0.0.0.0"}:${saved.listen.port ?? DEFAULT_CLUSTER_PORT}`;
			}
		} catch {
			warn(t("cli.setup.badConfig", { path: CONFIG_PATH }));
		}
	}

	// the service account is in the unit, not the config
	const unit = existsSync(UNIT_PATH) ? await readFile(UNIT_PATH, "utf8").catch(() => "") : "";
	const user = /^User=(.+)$/m.exec(unit)?.[1];

	return { config, user };
}

/** Resolve the plan from flags, prompting for whatever a terminal can supply. */
async function buildPlan(opts: Record<string, string | boolean>): Promise<Plan> {
	const interactive = process.stdin.isTTY === true && !opts.yes;
	const previous = await existingSetup();

	if (previous.config.name) {
		info(
			`${t("cli.setup.reconfiguring", { name: pc.bold(previous.config.name) })} ${pc.dim(`(${t("cli.setup.fromFile", { path: CONFIG_PATH })})`)}`,
		);
	}

	let mode = (opts.mode as string) ?? previous.config.mode ?? "";

	if (!mode && interactive) {
		const { select, isCancel } = await import("@clack/prompts");
		const picked = await select({
			message: t("cli.setup.askMode"),
			options: [
				{
					value: "primary",
					label: "primary",
					hint: t("cli.setup.primaryHint"),
				},
				{
					value: "follower",
					label: "follower",
					hint: t("cli.setup.followerHint"),
				},
			],
		});

		if (isCancel(picked)) {
			throw new Bail(t("cli.common.aborted"));
		}

		mode = String(picked);
	}

	mode ||= "primary";

	if (mode !== "primary" && mode !== "follower") {
		throw new Bail(t("cli.setup.invalidMode", { mode }));
	}

	const shortHost = hostname().split(".")[0]?.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "luna";

	const name =
		(opts.name as string) ??
		(await ask(t("cli.setup.askName"), previous.config.name ?? shortHost, interactive));

	const root =
		(opts.root as string) ??
		(await ask(t("cli.setup.askRoot"), previous.config.root ?? DEFAULT_ROOT, interactive));

	// SUDO_USER is who invoked sudo, which is almost always the right owner on a
	// personal machine; a bare root shell gets the system account instead
	const suggestedUser = previous.user || process.env.SUDO_USER || DEFAULT_USER;
	const user = (opts.user as string) ?? (await ask(t("cli.setup.askUser"), suggestedUser, interactive));

	let token = (opts.token as string) ?? previous.config.token;
	let primary: string | undefined;
	let host: string | undefined;
	let listen: string | undefined;

	if (mode === "follower") {
		primary =
			(opts.primary as string) ??
			(await ask(
				t("cli.setup.askPrimary"),
				previous.config.primary ?? `10.0.0.10:${DEFAULT_CLUSTER_PORT}`,
				interactive,
			));

		if (!primary) {
			throw new Bail(t("cli.setup.needsPrimary"));
		}

		host =
			(opts.host as string) ??
			(interactive
				? await ask(t("cli.setup.askHost"), previous.config.host ?? "", true)
				: previous.config.host);

		token = token ?? (await ask(t("cli.setup.askToken"), "", interactive));

		if (!token) {
			throw new Bail(t("cli.setup.needsToken"));
		}
	} else {
		listen = (opts.listen as string) ?? previous.config.listen ?? `0.0.0.0:${DEFAULT_CLUSTER_PORT}`;

		if (!token) {
			// a primary without a token cannot accept followers, and generating one
			// costs nothing; an operator who wants none can clear it in the config
			const bytes = new Uint8Array(32);

			crypto.getRandomValues(bytes);
			token = Buffer.from(bytes).toString("base64url");
		}
	}

	return {
		mode,
		name,
		root: resolve(root),
		user,
		group: user,
		token,
		listen,
		primary,
		host: host || undefined,
		bin: (opts.bin as string) ?? join(resolve(root), BIN_DIR, "luna"),
		dryRun: !!opts["dry-run"],
		start: !opts["no-start"],
	};
}

command({
	path: ["setup"],
	desc: t("cli.setup.desc"),
	opts: [
		{ flag: "--mode", desc: t("cli.setup.optMode"), value: true },
		{ flag: "--name", desc: t("cli.setup.optName"), value: true },
		{ flag: "--root", desc: t("cli.setup.optRoot", { root: DEFAULT_ROOT }), value: true },
		{ flag: "--user", desc: t("cli.setup.optUser"), value: true },
		{ flag: "--token", desc: t("cli.setup.optToken"), value: true },
		{ flag: "--listen", desc: t("cli.setup.optListen", { listen: `0.0.0.0:${DEFAULT_CLUSTER_PORT}` }), value: true },
		{ flag: "--primary", desc: t("cli.setup.optPrimary"), value: true },
		{ flag: "--host", desc: t("cli.setup.optHost"), value: true },
		{ flag: "--bin", desc: t("cli.setup.optBin", { path: `<root>/${BIN_DIR}/luna` }), value: true },
		{ flag: "--no-start", desc: t("cli.setup.optNoStart") },
		{ flag: "--dry-run", desc: t("cli.setup.optDryRun") },
		{ flag: "--yes", desc: t("cli.setup.optYes") },
	],

	handler: async (_args, opts) => {
		// a from-source run would point ExecStart at the bun interpreter, and the
		// service would start "luna" by starting bun with no script
		if (!isCompiledBinary()) {
			throw new Bail(t("cli.setup.notCompiled"));
		}

		const root = process.getuid?.() === 0;

		if (!root && !opts["dry-run"]) {
			fail(t("cli.setup.needsRoot"));
			info(t("cli.setup.rerunSudo", { command: pc.cyan(`sudo ${process.execPath} setup`) }));
			info(t("cli.setup.previewHint", { command: pc.cyan("luna setup --dry-run") }));

			process.exitCode = 1;

			return;
		}

		const plan = await buildPlan(opts);

		// noted before anything is written: whether this is a fresh install or a
		// reconfigure of a live one decides between starting and restarting
		const wasActive = hasSystemd() && (await serviceActive());

		console.log("");
		info(`${pc.bold(plan.mode)} daemon ${pc.bold(plan.name)}`);
		info(`root      ${plan.root}`);
		info(`user      ${plan.user}`);
		info(`binary    ${plan.bin} ${pc.dim(`(${t("cli.setup.binNote", { user: plan.user })})`)}`);
		info(`config    ${CONFIG_PATH}`);
		info(`unit      ${UNIT_PATH}`);

		if (plan.mode === "follower") {
			info(
				`primary   ${plan.primary}${plan.host ? ` (${t("cli.setup.advertising", { host: plan.host })})` : ""}`,
			);
		} else {
			info(`listener  ${plan.listen}`);
		}

		console.log("");

		if (plan.dryRun) {
			warn(t("cli.setup.dryRunNote"));
		}

		// -- account ------------------------------------------------------------
		let owner = { uid: 0, gid: 0 };

		if (await userExists(plan.user)) {
			info(t("cli.setup.userExists", { name: plan.user }));
		} else if (plan.dryRun) {
			info(t("cli.setup.wouldCreateUser", { name: pc.cyan(plan.user), root: plan.root }));
		} else {
			await createUser(plan.user, plan.root);
			ok(t("cli.setup.createdUser", { name: plan.user }));
		}

		if (!plan.dryRun) {
			owner = await uidGid(plan.user);
		}

		// -- binary, root, config, unit, completion --------------------------------
		await prepareRoot(plan, owner);
		await installDaemonBinary(plan, owner);
		await removeLegacyBinary(plan);
		await wirePath(plan);

		// the token is in here, so nobody but the service account may read it
		await place(plan, CONFIG_PATH, configFile(plan), 0o640, plan.dryRun ? undefined : owner);
		await place(plan, UNIT_PATH, unitFile(plan.bin, plan.user, CONFIG_PATH), 0o644);
		await place(plan, "/etc/bash_completion.d/luna", BASH_HOOK, 0o644);

		// -- service ----------------------------------------------------------------
		if (!hasSystemd()) {
			warn(t("cli.setup.noSystemd"));
			info(t("cli.setup.startYourself", { command: pc.cyan(`${plan.bin} daemon run`) }));

			return;
		}

		await reloadUnits(plan);

		if (!plan.start) {
			ok(t("cli.setup.inPlace"));
			info(
				t("cli.setup.startHint", { command: pc.cyan(`systemctl enable --now ${UNIT_NAME}`) }),
			);

			return;
		}

		await enableService(plan, wasActive);

		if (plan.dryRun) {
			return;
		}

		await verify(plan);

		console.log("");

		if (plan.mode === "primary") {
			ok(t("cli.setup.primaryReady"));
			info(t("cli.setup.tokenLine", { token: pc.cyan(plan.token ?? `(${t("cli.common.none")})`) }));
			info(t("cli.setup.tokenNote"));
			info(t("cli.setup.consoleHint", { command: pc.cyan("luna web --host 0.0.0.0") }));
		} else {
			ok(t("cli.setup.followerReady"));
			info(t("cli.setup.followerListed", { command: pc.cyan("luna daemon list") }));
		}

		console.log("");
		info(
			t("cli.setup.pathNote", {
				name: pc.cyan("luna"),
				command: pc.cyan(`source ${PROFILE_PATH}`),
			}),
		);

		// sudo resets PATH to its own secure_path, which will not contain the
		// cluster root, so the next privileged run needs the absolute path
		warn(t("cli.setup.sudoNote", { command: pc.cyan(`sudo ${plan.bin} setup`) }));
	},
});
