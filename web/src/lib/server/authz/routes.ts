// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The API route catalog: for every route id and method, the action an account
 * needs and the resource the call is about.
 *
 * The gate in `hooks.server.ts` reads this before any handler runs, so a
 * handler never has to remember to check; and a route that is **not** here is
 * refused, because an authorization table that forgets a route must fail
 * closed. Adding an endpoint means adding its rule.
 *
 * A resource is read off the params when the URL names it, and off a clone of
 * the body for the few creates that name it there (`/api/env`, `/api/instances`).
 * `session` marks the handful of routes that need nothing beyond being signed in
 * (an avatar, the host vitals in the chrome).
 */

import { getAccount } from '$core/accounts';
import { loadCluster, loadLock } from '$core/config';
import { effectiveTargets, entriesOf } from '$core/families';
import { loadPacksLock } from '$core/packslock';
import { listResourcePacks } from '$core/respacks';
import { resourceId } from '$shared/iam/resources';
import type { IamResourceType } from '$shared/iam/actions';
import { hiddenInstances, keepHiddenRefs } from '$lib/server/fleetscope';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface RuleContext {
	params: Record<string, string>;
	url: URL;
	request: Request;
	/** The signed-in account the request is decided for */
	account?: string;
}

export interface RouteRule {
	action: string;
	/**
	 * When `resource` names several (a plugin identity spans one record per
	 * platform), the request is allowed if the account may act on any of them.
	 * Only ever used for reads: a screen about a thing the account can see part of.
	 */
	anyOf?: (ctx: RuleContext) => Promise<string[]>;
	/**
	 * Further checks the request must also pass, each its own action and
	 * resource: how reading a server's logs also asks for its chat, since the
	 * same lines are in both.
	 */
	and?: (ctx: RuleContext) => Promise<Array<{ action: string; resource: string | null }>>;
	/** When the verb depends on the body, this resolves it; `action` is the fallback */
	actionOf?: (ctx: RuleContext) => Promise<string>;
	resource?: (ctx: RuleContext) => string | null | Promise<string | null>;
}

/** `session`: signed in is enough. */
export type MethodRules = Partial<Record<Method, RouteRule | 'session'>>;

const of = (type: IamResourceType, param: string) => (ctx: RuleContext): string | null => {
	const value = ctx.params[param];

	return value ? resourceId(type, value) : null;
};

const instance = of('instance', 'name');

/** The chat of the instance a URL names. */
const chatOf = (ctx: RuleContext): Array<{ action: string; resource: string | null }> => {
	const name = ctx.params.name;

	return name ? [{ action: 'chat:Read', resource: resourceId('chat', name) }] : [];
};

/** Logs and consoles carry every chat line the server printed. */
const alsoChat = async (ctx: RuleContext): Promise<Array<{ action: string; resource: string | null }>> => chatOf(ctx);

/** Whether a path names log content: anything under a `logs/` folder, a log file or a crash report. */
export function pathIsLog(path: string | null | undefined): boolean {
	const clean = normalizePath(path);

	return /(^|\/)logs(\/|$)/i.test(clean) || /\.log(\.gz)?$/i.test(clean) || /(^|\/)crash-reports(\/|$)/i.test(clean);
}

/** Whether an archive of a path would carry log content: the instance root does, as does any log path. */
export function archiveHoldsChat(path: string | null | undefined): boolean {
	const clean = normalizePath(path);

	return clean === '' || clean === '.' || pathIsLog(clean);
}

function normalizePath(path: string | null | undefined): string {
	return (path ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
}

/** The paths a file route names, from the query or the JSON body. */
async function pathsOf(ctx: RuleContext): Promise<string[]> {
	const fromQuery = ctx.url.searchParams.get('path');

	if (fromQuery !== null) {
		return [fromQuery];
	}

	if (ctx.request.method === 'GET') {
		return [];
	}

	try {
		const body = await ctx.request.clone().json();
		const candidates = [body?.path, body?.from, ...(Array.isArray(body?.paths) ? body.paths : [])];

		return candidates.filter((value): value is string => typeof value === 'string');
	} catch {
		return [];
	}
}

/**
 * Reading a log file's text, or copying or moving one somewhere readable, asks
 * for the server's chat too. Listing a folder does not: names hold no chat.
 */
const chatIfLogFile = async (ctx: RuleContext): Promise<Array<{ action: string; resource: string | null }>> => {
	if (ctx.request.method === 'GET' && ctx.url.pathname.endsWith('/files') && !ctx.url.searchParams.has('read')) {
		return [];
	}

	return (await pathsOf(ctx)).some(pathIsLog) ? chatOf(ctx) : [];
};

/** Downloading a file or an archive that carries logs asks for the server's chat too. */
const chatIfArchive = async (ctx: RuleContext): Promise<Array<{ action: string; resource: string | null }>> => {
	if (ctx.url.searchParams.has('stage')) {
		// a staged archive was checked when it was staged
		return [];
	}

	return (await pathsOf(ctx)).some(archiveHoldsChat) ? chatOf(ctx) : [];
};

/** One more action a request must pass, on its own resource. */
export interface RuleCheck {
	action: string;
	resource: string | null;
}

type AndRule = (ctx: RuleContext) => Promise<RuleCheck[]>;

/** Several `and` rules on one route; every check of every rule must pass. */
const both = (...rules: AndRule[]): AndRule => async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const out: RuleCheck[] = [];

	for (const rule of rules) {
		out.push(...await rule(ctx));
	}

	return out;
};

/** The request's JSON body, read off a clone so the handler still gets it; empty when there is none. */
async function jsonOf(ctx: RuleContext): Promise<Record<string, unknown>> {
	if (ctx.request.method === 'GET' || ctx.request.method === 'HEAD') {
		return {};
	}

	try {
		const parsed: unknown = await ctx.request.clone().json();

		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch {
		return {};
	}
}

/** The non-empty strings of a list field; a lone string counts as a list of one. */
function stringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.map((entry) => String(entry).trim())
			.filter((entry) => entry !== '');
	}

	if (typeof value === 'string' && value.trim() !== '') {
		return [value.trim()];
	}

	return [];
}

/** File extensions a server, a loader or a shell will execute. */
const CODE_EXTENSIONS = new Set([
	'jar', 'class', 'war', 'so', 'dll', 'dylib', 'exe', 'bin',
	'sh', 'bash', 'zsh', 'fish', 'py', 'pyc',
	'js', 'mjs', 'cjs', 'ts', 'groovy', 'gvy', 'kts', 'kt', 'lua', 'rb', 'pl', 'php',
	'bat', 'cmd', 'ps1',
	// Skript scripts and JShell snippets run inside the server
	'sk', 'jsh'
]);

/** Folders a loader reads jars or zips from; a zip there is loaded as a mod (old Forge does). */
const CODE_FOLDERS = new Set(['plugins', 'mods', 'coremods', 'libraries', 'jars', 'versions']);

/** Files that decide what the JVM runs, whatever their extension says. */
const CODE_NAMES = new Set([
	'server.jar',
	'run.sh',
	'start.sh',
	'start.bat',
	'.luna-env',
	'user_jvm_args.txt',
	'unix_args.txt',
	'win_args.txt',
	'jvm.args'
]);

/**
 * Extensions of plain data, which may be moved into a code folder freely.
 * Anything else landing there may be a directory (a mod folder, Forge's
 * `mods/1.12.2/`) carrying jars in with it.
 */
const DATA_EXTENSIONS = new Set([
	'yml', 'yaml', 'json', 'json5', 'toml', 'properties', 'txt', 'conf', 'cfg', 'ini', 'md', 'csv', 'xml',
	'log', 'gz', 'bak', 'old', 'disabled', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ogg', 'ttf', 'otf',
	'dat', 'nbt', 'snbt', 'mca', 'mcmeta', 'lang', 'schem', 'schematic', 'litematic', 'db', 'sqlite'
]);

/**
 * A path's segments, lowercased, with `.` and `..` resolved the way the
 * instance resolver will resolve them, so `plugins/../run.sh` is `run.sh`.
 */
function pathSegments(path: string | null | undefined): string[] {
	const out: string[] = [];

	for (const raw of (path ?? '').replace(/\\/g, '/').split('/')) {
		const segment = raw.trim().toLowerCase();

		if (segment === '' || segment === '.') {
			continue;
		}

		if (segment === '..') {
			out.pop();
			continue;
		}

		out.push(segment);
	}

	return out;
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf('.');

	return dot >= 0
		? name.slice(dot + 1)
		: '';
}

/**
 * Whether writing this path puts executable code on the server: a jar, a
 * native library, a script, a zip in a folder a loader reads, or one of the
 * files that decide the JVM's command line. What `code:Deploy` guards.
 */
export function pathIsCode(path: string | null | undefined): boolean {
	const segments = pathSegments(path);
	const name = segments[segments.length - 1];

	if (name === undefined) {
		return false;
	}

	if (CODE_NAMES.has(name)) {
		return true;
	}

	const extension = extensionOf(name);

	if (CODE_EXTENSIONS.has(extension)) {
		return true;
	}

	const inCodeFolder = segments.slice(0, -1).some((segment) => CODE_FOLDERS.has(segment));

	return extension === 'zip' && inCodeFolder;
}

/**
 * Whether moving, copying or renaming something to this path can put code on
 * the server. Beyond `pathIsCode`, the source may be a whole directory, so
 * anything that is or lands inside a code folder counts unless its name says
 * it is plain data: otherwise a folder of jars uploaded as harmless names could
 * be renamed into `mods/`.
 */
export function moveTargetIsCode(path: string | null | undefined): boolean {
	if (pathIsCode(path)) {
		return true;
	}

	const segments = pathSegments(path);
	const name = segments[segments.length - 1];

	if (name === undefined || !segments.some((segment) => CODE_FOLDERS.has(segment))) {
		return false;
	}

	return !DATA_EXTENSIONS.has(extensionOf(name));
}

/**
 * Environment variables the JVM, the dynamic linker or bash read on their own:
 * a value in one of them runs code at start (`-javaagent`, `-XX:OnError`,
 * `LD_PRELOAD`), so setting one is `code:Deploy` too.
 */
export function envIsCode(name: string | null | undefined): boolean {
	const upper = (name ?? '').trim().toUpperCase();

	return /^(JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JAVA_OPTS|JAVA_HOME|CLASSPATH|PATH|IFS|ENV|BASH_ENV|BASH_FUNC_.*|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|GLIBC_TUNABLES|LD_.*|DYLD_.*)$/.test(upper);
}

/** Where the path of a file route's write lands: the instance the URL names. */
const codeDeploy = (ctx: RuleContext): RuleCheck[] => [{ action: 'code:Deploy', resource: instance(ctx) }];

/** Writing a file (`PUT /files`, an upload's begin and finish, a managed template) whose path is code. */
const codeIfBodyPath = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const parsed = await jsonOf(ctx);

	return typeof parsed.path === 'string' && pathIsCode(parsed.path)
		? codeDeploy(ctx)
		: [];
};

function baseName(path: string): string {
	return path.replace(/\/+$/, '').split('/').pop() ?? path;
}

/**
 * The paths a file-manager verb creates, as `files/ops` computes them: a
 * directory or empty file at `path`, a rename's `to`, and for move and copy
 * each source's own name inside the folder `to`.
 */
function opTargets(parsed: Record<string, unknown>): { created: string[]; moved: string[] } {
	const action = String(parsed.action ?? '');

	if (action === 'mkdir' || action === 'newfile') {
		return { created: stringList(parsed.path), moved: [] };
	}

	if (action === 'rename') {
		return { created: [], moved: stringList(parsed.to) };
	}

	if (action === 'move' || action === 'copy') {
		const dir = String(parsed.to ?? '').replace(/\/+$/, '');
		const moved = stringList(parsed.paths).map((path) => dir
			? `${dir}/${baseName(path)}`
			: baseName(path));

		return { created: [], moved };
	}

	return { created: [], moved: [] };
}

/** A file-manager verb that would create code, or carry a folder into a code folder. */
const codeIfOps = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const targets = opTargets(await jsonOf(ctx));
	const isCode = targets.created.some(pathIsCode) || targets.moved.some(moveTargetIsCode);

	return isCode
		? codeDeploy(ctx)
		: [];
};

/** Whether a JVM flag field (a list or the raw text the forms send) carries any flag. */
function hasFlags(value: unknown): boolean {
	return stringList(value).length > 0;
}

/**
 * Custom JVM flags, java agents or a java executable of the caller's choosing
 * run code of the caller's choosing, so they are `code:Deploy` on the instance.
 * Picking an existing profile or runtime is not: those are an administrator's.
 */
const codeIfJvm = (resource: (ctx: RuleContext) => string | null | Promise<string | null>) =>
	async (ctx: RuleContext): Promise<RuleCheck[]> => {
		const parsed = await jsonOf(ctx);
		const java = typeof parsed.java === 'string' && parsed.java.trim() !== '';

		if (!hasFlags(parsed.javaArgs) && !hasFlags(parsed.javaAgents) && !java) {
			return [];
		}

		return [{ action: 'code:Deploy', resource: await resource(ctx) }];
	};

/** A jar, or a pack file, from bytes or a URL rather than the catalog. */
const alwaysCode = async (): Promise<RuleCheck[]> => [{ action: 'code:Deploy', resource: null }];

/** A modpack installed from an uploaded `.mrpack` rather than a Modrinth slug. */
const codeIfMrpackStage = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const parsed = await jsonOf(ctx);
	const stage = typeof parsed.mrpackStage === 'string' && parsed.mrpackStage.trim() !== '';
	const name = typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : null;

	return stage
		? [{ action: 'code:Deploy', resource: name ? resourceId('instance', name) : null }]
		: [];
};

/**
 * The resource an addon target names. A wildcard (`*`, `*paper`) reaches every
 * instance there is or will be, so it is checked against `luna:instance/*`
 * itself, which only a wildcard grant matches.
 */
export function instanceTarget(target: string): string {
	return target.startsWith('*')
		? resourceId('instance', '*')
		: resourceId('instance', target);
}

/** One action on every instance a target list names, each resource once. */
export function onInstances(action: string, targets: string[]): RuleCheck[] {
	const resources = [...new Set(targets.map(instanceTarget))];

	return resources.map((resource) => ({ action, resource }));
}

/** A resource pack's server rules as the instances they name: `!x` names x, `all` is `*`. */
export function packRuleTargets(rules: string[]): string[] {
	return rules
		.map((rule) => rule.trim().toLowerCase().replace(/^!/, '').trim())
		.filter((rule) => rule !== '')
		.map((rule) => rule === 'all'
			? '*'
			: rule);
}

/** What changed between two target lists, either way: a target dropped is as much a change as one added. */
function changedTargets(before: string[], after: string[]): string[] {
	const old = new Set(before);
	const next = new Set(after);

	return [
		...after.filter((target) => !old.has(target)),
		...before.filter((target) => !next.has(target))
	];
}

/** The pool records a plugin name means: the key itself, else every family of the identity. */
async function pluginEntries(name: string): Promise<Array<{ key: string; targets: string[]; pins: string[] }>> {
	const lock = await loadLock();
	const keys = lock.plugins[name]
		? [name]
		: entriesOf(lock, name);

	return keys.map((key) => ({
		key,
		targets: lock.plugins[key]?.targets ?? [],
		pins: Object.keys(lock.plugins[key]?.pins ?? {})
	}));
}

/**
 * `instance:ManageAddons` on every instance a change of a plugin's targets
 * adds or drops; a list the plugin does not have yet is all additions. The
 * instances in `hidden` were never shown to the account, so a list sent back
 * without them keeps them (`keepHiddenRefs`) rather than dropping them.
 */
export async function pluginTargetChecks(name: string, next: string[], hidden: Set<string> | null = null): Promise<RuleCheck[]> {
	const entries = await pluginEntries(name);
	const changed = entries.length === 0
		? next
		: entries.flatMap((entry) => changedTargets(entry.targets, keepHiddenRefs(next, entry.targets, hidden)));

	return onInstances('instance:ManageAddons', changed);
}

/**
 * Removing a plugin: from the instances named, or, with none, from everywhere
 * it is deployed (its group-given instances too) and from the pool.
 */
export async function pluginRemovalChecks(name: string, from: string[]): Promise<RuleCheck[]> {
	if (from.length > 0) {
		return onInstances('instance:ManageAddons', from);
	}

	const lock = await loadLock();
	const cfg = await loadCluster();
	const keys = lock.plugins[name]
		? [name]
		: entriesOf(lock, name);
	const targets = keys.flatMap((key) => [
		...effectiveTargets(cfg, lock, key),
		...(lock.plugins[key]?.targets ?? []).filter((target) => target.startsWith('*'))
	]);

	return onInstances('instance:ManageAddons', targets);
}

/** Unpinning on the instances named, or, with none, on every instance holding a pin. */
export async function pluginUnpinChecks(name: string, targets: string[]): Promise<RuleCheck[]> {
	if (targets.length > 0) {
		return onInstances('instance:ManageAddons', targets);
	}

	const entries = await pluginEntries(name);

	return onInstances('instance:ManageAddons', entries.flatMap((entry) => entry.pins));
}

/** A data pack's current targets, or null when the pool has no such pack. */
async function datapackTargets(name: string): Promise<string[] | null> {
	const lock = await loadPacksLock();

	return lock.datapacks[name]?.targets ?? null;
}

/** `instance:ManageAddons` on every instance a change of a data pack's targets adds or drops; `hidden` as for plugins. */
export async function datapackTargetChecks(name: string, next: string[], hidden: Set<string> | null = null): Promise<RuleCheck[]> {
	const current = await datapackTargets(name);

	return onInstances('instance:ManageAddons', current === null
		? next
		: changedTargets(current, keepHiddenRefs(next, current, hidden)));
}

/** Removing a data pack from the instances named, or from all it targets and the pool. */
export async function datapackRemovalChecks(name: string, from: string[]): Promise<RuleCheck[]> {
	if (from.length > 0) {
		return onInstances('instance:ManageAddons', from);
	}

	return onInstances('instance:ManageAddons', await datapackTargets(name) ?? []);
}

/** `instance:ManageAddons` on every server a change of a resource pack's rules adds or drops; `hidden` as for plugins. */
export async function respackServerChecks(key: string, next: string[], hidden: Set<string> | null = null): Promise<RuleCheck[]> {
	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const rows = await listResourcePacks(cfg, lock);
	const row = rows.find((candidate) => candidate.key === key);
	const after = packRuleTargets(keepHiddenRefs(next, row?.servers, hidden));
	const changed = row
		? changedTargets(packRuleTargets(row.servers), after)
		: after;

	return onInstances('instance:ManageAddons', changed);
}

/**
 * Switching a resource pack on or off reaches every server its rules name, and
 * a pack nobody has given rules yet is sent everywhere (`*`): so a change of
 * `enabled` asks `instance:ManageAddons` on all of them. `hidden` as for plugins.
 */
export async function respackEnableChecks(
	key: string,
	enabled: unknown,
	servers: string[] | undefined,
	hidden: Set<string> | null = null
): Promise<RuleCheck[]> {
	if (typeof enabled !== 'boolean') {
		return [];
	}

	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const row = (await listResourcePacks(cfg, lock)).find((candidate) => candidate.key === key);

	if (row && row.enabled === enabled) {
		return [];
	}

	const current = row?.servers.length
		? row.servers
		: ['*'];
	const rules = servers
		? keepHiddenRefs(servers, row?.servers, hidden)
		: current;

	return onInstances('instance:ManageAddons', packRuleTargets(rules));
}

/**
 * A hostname normally points at the network's own address; naming another
 * address, or adopting a record the zone already holds, is editing DNS records,
 * which can aim a name under the operators' domain anywhere.
 */
const recordsIfAddressed = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const parsed = await jsonOf(ctx);

	return parsed.address || parsed.adopt === true
		? [{ action: 'domain:ManageRecords', resource: null }]
		: [];
};

/**
 * The verb a shared addon change asks for: naming the servers it acts on makes
 * it a change to those servers (`instance:ManageAddons` on each, from the
 * rule's `and`) plus seeing the addon; naming none acts everywhere.
 */
const perServerBody = (wide: string, narrow: string, key: string) => async (ctx: RuleContext): Promise<string> =>
	stringList((await jsonOf(ctx))[key]).length > 0
		? narrow
		: wide;

const perServerQuery = (wide: string, narrow: string, key: string) => async (ctx: RuleContext): Promise<string> =>
	stringList(ctx.url.searchParams.get(key)?.split(',')).length > 0
		? narrow
		: wide;

/** `instance:ManageAddons` on each instance a body list names; nothing when it names none. */
const addonsOnBody = (key: string): AndRule => async (ctx: RuleContext): Promise<RuleCheck[]> =>
	onInstances('instance:ManageAddons', stringList((await jsonOf(ctx))[key]));

/** A change of the plugin's targets, when the body carries one. */
const pluginTargetsChange = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const parsed = await jsonOf(ctx);
	const name = ctx.params.name;

	if (!name || !Array.isArray(parsed.targets)) {
		return [];
	}

	return await pluginTargetChecks(name, stringList(parsed.targets), await hiddenInstances(ctx.account));
};

const pluginRemoval = async (ctx: RuleContext): Promise<RuleCheck[]> =>
	await pluginRemovalChecks(ctx.params.name ?? '', stringList(ctx.url.searchParams.get('from')?.split(',')));

const pluginPin = async (ctx: RuleContext): Promise<RuleCheck[]> =>
	onInstances('instance:ManageAddons', stringList((await jsonOf(ctx)).targets));

const pluginUnpin = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const parsed = await jsonOf(ctx);

	return await pluginUnpinChecks(String(parsed.name ?? ''), stringList(parsed.targets));
};

/** An upload replacing a pooled data pack's zip reaches every instance the pack is on. */
const datapackUpload = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const parsed = await jsonOf(ctx);
	const name = String(parsed.name ?? '');
	const current = name
		? await datapackTargets(name) ?? []
		: [];

	return onInstances('instance:ManageAddons', [...stringList(parsed.targets), ...current]);
};

const datapackTargetsChange = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const parsed = await jsonOf(ctx);
	const name = ctx.params.name;

	if (!name || !Array.isArray(parsed.targets)) {
		return [];
	}

	return await datapackTargetChecks(name, stringList(parsed.targets), await hiddenInstances(ctx.account));
};

const datapackRemoval = async (ctx: RuleContext): Promise<RuleCheck[]> =>
	await datapackRemovalChecks(ctx.params.name ?? '', stringList(ctx.url.searchParams.get('from')?.split(',')));

const respackServersChange = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const parsed = await jsonOf(ctx);
	const key = ctx.params.key;

	if (!key || !Array.isArray(parsed.servers)) {
		return [];
	}

	return await respackServerChecks(key, stringList(parsed.servers), await hiddenInstances(ctx.account));
};

const respackEnable = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const parsed = await jsonOf(ctx);
	const servers = Array.isArray(parsed.servers)
		? stringList(parsed.servers)
		: undefined;

	return await respackEnableChecks(ctx.params.key ?? '', parsed.enabled, servers, await hiddenInstances(ctx.account));
};

/** The instance verb each schedule action performs when it fires. */
const SCHEDULE_VERBS: Record<string, string> = {
	start: 'instance:Start',
	stop: 'instance:Stop',
	restart: 'instance:Restart',
	// a scheduled backup is the world screen's backup
	backup: 'instance:ManageWorld'
};

/** A schedule may only aim at instances its creator could act on by hand. */
const scheduleTargets = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const parsed = await jsonOf(ctx);
	const verb = SCHEDULE_VERBS[String(parsed.action ?? '')] ?? 'instance:Configure';

	return onInstances(verb, stringList(parsed.instances));
};

/** An environment variable scoped to an instance changes that instance; one the JVM reads is code. */
const envScope = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const parsed = await jsonOf(ctx);
	const target = ctx.request.method === 'DELETE'
		? ctx.url.searchParams.get('instance')
		: typeof parsed.instance === 'string'
			? parsed.instance
			: null;
	const name = ctx.request.method === 'DELETE'
		? ctx.url.searchParams.get('name')
		: typeof parsed.name === 'string'
			? parsed.name
			: null;
	const resource = target
		? resourceId('instance', target)
		: null;
	const checks: RuleCheck[] = [];

	if (target) {
		checks.push({ action: 'instance:ManageEnvironment', resource });
	}

	if (ctx.request.method !== 'DELETE' && envIsCode(name)) {
		checks.push({ action: 'code:Deploy', resource });
	}

	return checks;
};

/** A hostname routed to an instance changes how players reach it. */
const networkOnBodyInstance = async (ctx: RuleContext): Promise<RuleCheck[]> => {
	const target = (await jsonOf(ctx)).instance;

	return typeof target === 'string' && target !== ''
		? [{ action: 'instance:ManageNetwork', resource: resourceId('instance', target) }]
		: [];
};

/**
 * Moderation is network-wide unless it names instances: then it edits those
 * servers' own ban, whitelist and operator lists, which is each instance's
 * `instance:ManagePlayers` and not `player:Moderate`. A kick always goes
 * through the proxy, so it stays network moderation whatever it names.
 */
function moderationInstances(parsed: Record<string, unknown>): string[] {
	if (String(parsed.action ?? '') === 'kick') {
		return [];
	}

	return stringList(parsed.instances);
}

const moderation: RouteRule = {
	action: 'player:Moderate',
	actionOf: async (ctx: RuleContext): Promise<string> =>
		moderationInstances(await jsonOf(ctx)).length > 0
			? 'instance:ManagePlayers'
			: 'player:Moderate',
	resource: async (ctx: RuleContext): Promise<string | null> => {
		const first = moderationInstances(await jsonOf(ctx))[0];

		return first !== undefined
			? instanceTarget(first)
			: null;
	},
	and: async (ctx: RuleContext): Promise<RuleCheck[]> =>
		onInstances('instance:ManagePlayers', moderationInstances(await jsonOf(ctx)).slice(1))
};

const plugin = of('plugin', 'name');
const pack = of('pack', 'key');
const datapack = of('datapack', 'name');
const addonGroup = of('addon-group', 'name');
const profile = of('profile', 'name');
const domain = of('domain', 'name');
const schedule = of('schedule', 'id');
const env = of('env', 'name');
const player = of('player', 'player');
const permissionGroup = of('permission-group', 'name');
const knowledge = of('knowledge', 'id');

const publishKnowledge = async (ctx: RuleContext): Promise<RuleCheck[]> => [
	{ action: 'knowledge:Publish', resource: knowledge(ctx) }
];

const machine = of('machine', 'name');

/** A resource named by a query parameter. */
const query = (type: IamResourceType, key: string) => (ctx: RuleContext): string | null => {
	const value = ctx.url.searchParams.get(key);

	return value ? resourceId(type, value) : null;
};

/** A resource named by a field of the JSON body; the body is cloned, so the handler still reads it. */
const body = (type: IamResourceType, key: string) => async (ctx: RuleContext): Promise<string | null> => {
	try {
		const parsed = await ctx.request.clone().json();
		const value = parsed?.[key];

		return typeof value === 'string' && value !== '' ? resourceId(type, value) : null;
	} catch {
		return null;
	}
};

/**
 * The records a plugin URL names. The pool is keyed `<name>@<family>`, one
 * record per platform, and the plugin screen is addressed by the identity
 * (`luckperms`) or by one key (`luckperms@forge`); an identity resolves to every
 * family it spans, so a policy naming any one of them reaches the screen.
 */
const pluginRecords = async (ctx: RuleContext): Promise<string[]> => {
	const name = ctx.params.name;

	if (!name) {
		return [];
	}

	const lock = await loadLock();

	if (lock.plugins[name]) {
		return [resourceId('plugin', name)];
	}

	const keys = entriesOf(lock, name);

	return keys.length > 0
		? keys.map((key) => resourceId('plugin', key))
		: [resourceId('plugin', name)];
};

/** Accounts are addressed by id in the URL; the resource id carries the username. */
const account = async (ctx: RuleContext): Promise<string | null> => {
	const id = ctx.params.id;

	if (!id) {
		return null;
	}

	const found = await getAccount(id);

	return resourceId('account', found?.username ?? id);
};

/** The resource id itself, sent in the body (the tag routes take any resource). */
const bodyId = (key: string) => async (ctx: RuleContext): Promise<string | null> => {
	try {
		const parsed = await ctx.request.clone().json();
		const value = parsed?.[key];

		return typeof value === 'string' && value !== '' ? value : null;
	} catch {
		return null;
	}
};

/** A verb that depends on the body's `action` field. */
function byAction(
	map: Record<string, string>,
	fallback: string,
	resource?: RouteRule['resource']
): RouteRule {
	return {
		action: fallback,
		resource,
		actionOf: async (ctx: RuleContext) => {
			try {
				const parsed = await ctx.request.clone().json();
				const verb = typeof parsed?.action === 'string' ? parsed.action : '';

				return map[verb] ?? fallback;
			} catch {
				return fallback;
			}
		}
	};
}

export const API_RULES: Record<string, MethodRules> = {
	'/api/auth/session': { GET: 'session', POST: 'session', DELETE: 'session' },
	'/api/auth/bootstrap': { POST: 'session' },
	'/api/host': { GET: 'session' },
	'/api/avatar/[...path]': { GET: 'session' },
	'/api/accounts/[id]/avatar': { GET: 'session', PUT: { action: 'account:Update', resource: account } },

	'/api/accounts': { GET: { action: 'account:List' }, POST: { action: 'account:Create' } },
	'/api/accounts/[id]': {
		GET: { action: 'account:Describe', resource: account },
		PATCH: { action: 'account:Update', resource: account },
		DELETE: { action: 'account:Delete', resource: account }
	},
	'/api/accounts/[id]/password': { POST: { action: 'account:SetPassword', resource: account } },
	'/api/accounts/[id]/identities': {
		POST: { action: 'account:ManageIdentities', resource: account },
		PATCH: { action: 'account:ManageIdentities', resource: account },
		DELETE: { action: 'account:ManageIdentities', resource: account }
	},
	'/api/accounts/[id]/sessions': {
		GET: { action: 'account:Describe', resource: account },
		DELETE: { action: 'account:ManageSessions', resource: account }
	},
	'/api/accounts/[id]/permissions': { GET: { action: 'account:Describe', resource: account } },

	'/api/iam/policies': { GET: { action: 'iam:ListPolicies' }, POST: { action: 'iam:CreatePolicy' } },
	'/api/iam/policies/validate': { POST: { action: 'iam:ListPolicies' } },
	'/api/iam/policies/[name]': {
		GET: { action: 'iam:DescribePolicy' },
		PATCH: { action: 'iam:UpdatePolicy' },
		DELETE: { action: 'iam:DeletePolicy' }
	},
	'/api/iam/groups': { GET: { action: 'iam:ListGroups' }, POST: { action: 'iam:CreateGroup' } },
	'/api/iam/groups/[name]': {
		GET: { action: 'iam:DescribeGroup' },
		PATCH: { action: 'iam:UpdateGroup' },
		DELETE: { action: 'iam:DeleteGroup' }
	},
	'/api/iam/groups/[name]/members': {
		POST: { action: 'iam:UpdateGroup' },
		DELETE: { action: 'iam:UpdateGroup' }
	},
	'/api/iam/attachments': { POST: { action: 'iam:Attach' }, DELETE: { action: 'iam:Detach' } },
	'/api/iam/inline': { PUT: { action: 'iam:Attach' }, DELETE: { action: 'iam:Detach' } },
	'/api/iam/simulate': { POST: { action: 'iam:Simulate' } },
	'/api/iam/overview': { GET: { action: 'iam:ListPolicies' } },
	'/api/iam/audit': { GET: { action: 'iam:ReadAudit' } },
	'/api/iam/can': { POST: 'session' },
	'/api/resources': { GET: { action: 'tag:List' } },
	'/api/resources/describe': { POST: { action: 'tag:Describe' } },
	'/api/resources/tags': {
		PUT: { action: 'tag:Tag', resource: bodyId('id') },
		DELETE: { action: 'tag:Untag', resource: bodyId('id') }
	},

	'/api/instances': {
		GET: { action: 'instance:List' },
		POST: { action: 'instance:Create', resource: body('instance', 'name'), and: codeIfJvm(body('instance', 'name')) }
	},
	'/api/instances/defaults': { GET: { action: 'instance:Create' } },
	'/api/instances/[name]': {
		GET: { action: 'instance:Describe', resource: instance },
		DELETE: { action: 'instance:Delete', resource: instance }
	},
	'/api/instances/[name]/state': {
		POST: byAction(
			{ start: 'instance:Start', stop: 'instance:Stop', restart: 'instance:Restart' },
			'instance:Start',
			instance
		)
	},
	'/api/instances/[name]/access': {
		GET: { action: 'instance:Describe', resource: instance },
		POST: { action: 'instance:ManagePlayers', resource: instance }
	},
	'/api/instances/[name]/addons': { POST: { action: 'instance:ManageAddons', resource: instance } },
	'/api/instances/[name]/addons/collisions': { GET: { action: 'instance:Describe', resource: instance } },
	'/api/instances/[name]/addons/stream': { GET: { action: 'instance:Describe', resource: instance } },
	'/api/instances/[name]/build': {
		GET: { action: 'instance:Describe', resource: instance },
		POST: { action: 'instance:Configure', resource: instance }
	},
	'/api/instances/[name]/chat': { GET: { action: 'chat:Read', resource: of('chat', 'name') } },
	'/api/instances/[name]/config': {
		GET: { action: 'instance:Describe', resource: instance },
		PATCH: { action: 'instance:Configure', resource: instance, and: codeIfJvm(instance) }
	},
	'/api/instances/[name]/console': {
		GET: { action: 'instance:ReadConsole', resource: instance, and: alsoChat },
		POST: { action: 'instance:SendCommand', resource: instance }
	},
	'/api/instances/[name]/datapacks': {
		GET: { action: 'instance:Describe', resource: instance },
		POST: { action: 'instance:ManageAddons', resource: instance }
	},
	'/api/instances/[name]/env': {
		GET: { action: 'instance:Describe', resource: instance },
		POST: { action: 'instance:ManageEnvironment', resource: instance }
	},
	'/api/instances/[name]/files': {
		GET: { action: 'instance:ReadFiles', resource: instance, and: chatIfLogFile },
		PUT: { action: 'instance:WriteFiles', resource: instance, and: codeIfBodyPath }
	},
	'/api/instances/[name]/files/download': {
		GET: { action: 'instance:ReadFiles', resource: instance, and: chatIfArchive },
		POST: { action: 'instance:ReadFiles', resource: instance, and: chatIfArchive }
	},
	'/api/instances/[name]/files/manage': {
		GET: { action: 'instance:ReadFiles', resource: instance, and: chatIfLogFile },
		POST: { action: 'instance:WriteFiles', resource: instance, and: codeIfBodyPath }
	},
	'/api/instances/[name]/files/ops': {
		POST: { action: 'instance:WriteFiles', resource: instance, and: both(chatIfLogFile, codeIfOps) }
	},
	'/api/instances/[name]/files/upload': {
		GET: { action: 'instance:WriteFiles', resource: instance },
		POST: { action: 'instance:WriteFiles', resource: instance, and: codeIfBodyPath }
	},
	'/api/instances/[name]/files/upload/[token]': { PUT: { action: 'instance:WriteFiles', resource: instance } },
	'/api/instances/[name]/logs': { GET: { action: 'instance:ReadLogs', resource: instance, and: alsoChat } },
	'/api/instances/[name]/metrics': { GET: { action: 'instance:ReadMetrics', resource: instance } },
	'/api/instances/[name]/threads': { GET: { action: 'instance:ReadMetrics', resource: instance } },
	'/api/instances/[name]/modpack': {
		GET: { action: 'instance:Describe', resource: instance },
		POST: { action: 'instance:Configure', resource: instance }
	},
	'/api/instances/[name]/players': { GET: { action: 'instance:Describe', resource: instance } },
	'/api/instances/[name]/players/[player]': { GET: { action: 'instance:Describe', resource: instance } },
	'/api/instances/[name]/plugins': {
		GET: { action: 'instance:Describe', resource: instance },
		POST: { action: 'instance:ManageAddons', resource: instance }
	},
	'/api/instances/[name]/plugins/[plugin]': { GET: { action: 'instance:Describe', resource: instance } },
	'/api/instances/[name]/properties': {
		GET: { action: 'instance:Describe', resource: instance },
		PUT: { action: 'instance:Configure', resource: instance },
		DELETE: { action: 'instance:Configure', resource: instance }
	},
	'/api/instances/[name]/proxy': {
		GET: { action: 'instance:Describe', resource: instance },
		PUT: { action: 'instance:ManageNetwork', resource: instance }
	},
	'/api/instances/[name]/unmanaged/[file]': { GET: { action: 'instance:ReadLogs', resource: instance, and: alsoChat } },
	'/api/instances/[name]/world': { GET: { action: 'instance:Describe', resource: instance } },
	'/api/instances/[name]/world/actions': { POST: { action: 'instance:ManageWorld', resource: instance } },
	'/api/instances/[name]/world/backups/[id]': {
		PATCH: { action: 'instance:ManageWorld', resource: instance },
		POST: { action: 'instance:ManageWorld', resource: instance },
		DELETE: { action: 'instance:ManageWorld', resource: instance }
	},
	'/api/instances/[name]/world/backups/[id]/download': { GET: { action: 'instance:ReadFiles', resource: instance } },
	'/api/worlds/stage': { POST: { action: 'instance:ManageWorld' } },
	'/api/worlds/stage/[token]': {
		GET: { action: 'instance:ManageWorld' },
		PUT: { action: 'instance:ManageWorld' },
		DELETE: { action: 'instance:ManageWorld' }
	},
	'/api/modpacks/search': { GET: { action: 'catalog:Read' } },
	'/api/modpacks/versions': { GET: { action: 'catalog:Read' } },
	'/api/modpacks/install': {
		POST: {
			action: 'instance:Create',
			resource: body('instance', 'name'),
			and: both(codeIfMrpackStage, codeIfJvm(body('instance', 'name')))
		}
	},
	'/api/modpacks/stage': { POST: { action: 'instance:Create', and: alwaysCode } },
	'/api/modpacks/stage/[token]': { GET: { action: 'instance:Create' } },

	'/api/daemons': { GET: { action: 'machine:List' } },
	'/api/daemons/stream': { GET: { action: 'machine:List' } },
	'/api/daemons/[name]': {
		GET: { action: 'machine:Describe', resource: machine },
		POST: { action: 'machine:Upgrade', resource: machine },
		DELETE: { action: 'machine:Remove', resource: machine }
	},

	'/api/plugins': { GET: { action: 'plugin:List' } },
	'/api/plugins/search': { GET: { action: 'catalog:Read' } },
	'/api/plugins/versions': { GET: { action: 'catalog:Read' } },
	'/api/plugins/validate': { GET: { action: 'catalog:Read' } },
	'/api/plugins/check': { POST: { action: 'plugin:List' } },
	'/api/plugins/add': { POST: { action: 'plugin:Install', and: addonsOnBody('targets') } },
	'/api/plugins/fetch': { POST: { action: 'plugin:Install' } },
	'/api/plugins/upload': { POST: { action: 'plugin:Install', and: both(alwaysCode, addonsOnBody('targets')) } },
	'/api/plugins/update': { POST: { action: 'plugin:Update' } },
	'/api/plugins/deploy': {
		POST: { action: 'plugin:Configure', actionOf: perServerBody('plugin:Configure', 'plugin:List', 'instances'), and: addonsOnBody('instances') }
	},
	'/api/plugins/scan': { POST: { action: 'plugin:Configure' } },
	'/api/plugins/pin': {
		GET: { action: 'plugin:Describe', resource: query('plugin', 'name') },
		POST: {
			action: 'plugin:Configure',
			actionOf: perServerBody('plugin:Configure', 'plugin:Describe', 'targets'),
			resource: body('plugin', 'name'),
			and: pluginPin
		}
	},
	'/api/plugins/unpin': {
		POST: {
			action: 'plugin:Configure',
			actionOf: perServerBody('plugin:Configure', 'plugin:Describe', 'targets'),
			resource: body('plugin', 'name'),
			and: pluginUnpin
		}
	},
	'/api/plugins/[name]': {
		GET: { action: 'plugin:Describe', anyOf: pluginRecords },
		PATCH: { action: 'plugin:Configure', resource: plugin, and: pluginTargetsChange },
		DELETE: { action: 'plugin:Remove', actionOf: perServerQuery('plugin:Remove', 'plugin:Describe', 'from'), resource: plugin, and: pluginRemoval }
	},
	'/api/plugins/[name]/identify': {
		GET: { action: 'plugin:Describe', resource: plugin },
		POST: { action: 'plugin:Configure', resource: plugin },
		DELETE: { action: 'plugin:Configure', resource: plugin }
	},
	'/api/providers': { GET: { action: 'catalog:Read' } },
	'/api/software': { GET: { action: 'catalog:Read' } },
	'/api/software/[id]/versions': { GET: { action: 'catalog:Read' } },

	'/api/respacks': { GET: { action: 'pack:List' }, POST: { action: 'pack:Install' } },
	'/api/respacks/add': { POST: { action: 'pack:Install' } },
	'/api/respacks/search': { GET: { action: 'catalog:Read' } },
	'/api/respacks/update': { POST: { action: 'pack:Update' } },
	'/api/respacks/reload': { POST: { action: 'pack:Configure' } },
	'/api/respacks/resend': { POST: { action: 'pack:Configure' } },
	'/api/respacks/dynamic': { GET: { action: 'pack:List' }, POST: { action: 'pack:Configure' } },
	'/api/respacks/[key]': {
		PATCH: { action: 'pack:Configure', resource: pack, and: both(respackServersChange, respackEnable) },
		DELETE: { action: 'pack:Remove', resource: pack }
	},
	'/api/respacks/[key]/detail': { GET: { action: 'pack:Describe', resource: pack } },
	'/api/respacks/[key]/file': { POST: { action: 'pack:Update', resource: pack } },
	'/api/respacks/[key]/identify': {
		GET: { action: 'pack:Describe', resource: pack },
		POST: { action: 'pack:Configure', resource: pack },
		DELETE: { action: 'pack:Configure', resource: pack }
	},
	'/api/respacks/[key]/instances': { POST: { action: 'pack:Configure', resource: pack, and: addonsOnBody('instance') } },
	'/api/respacks/[key]/resend': { POST: { action: 'pack:Configure', resource: pack } },
	'/api/respacks/[key]/versions': {
		GET: { action: 'pack:Describe', resource: pack },
		POST: { action: 'pack:Update', resource: pack }
	},

	'/api/datapacks': { GET: { action: 'datapack:List' }, POST: { action: 'datapack:Install', and: datapackUpload } },
	'/api/datapacks/add': { POST: { action: 'datapack:Install', and: addonsOnBody('targets') } },
	'/api/datapacks/search': { GET: { action: 'catalog:Read' } },
	'/api/datapacks/update': { POST: { action: 'datapack:Update' } },
	'/api/datapacks/deploy': {
		POST: { action: 'datapack:Configure', actionOf: perServerBody('datapack:Configure', 'datapack:List', 'instances'), and: addonsOnBody('instances') }
	},
	'/api/datapacks/[name]': {
		PATCH: { action: 'datapack:Configure', resource: datapack, and: datapackTargetsChange },
		DELETE: { action: 'datapack:Remove', actionOf: perServerQuery('datapack:Remove', 'datapack:Describe', 'from'), resource: datapack, and: datapackRemoval }
	},
	'/api/datapacks/[name]/identify': {
		GET: { action: 'datapack:Describe', resource: datapack },
		POST: { action: 'datapack:Configure', resource: datapack },
		DELETE: { action: 'datapack:Configure', resource: datapack }
	},

	'/api/addons/groups': {
		GET: { action: 'addon-group:List' },
		POST: { action: 'addon-group:Create', resource: body('addon-group', 'name') },
		DELETE: { action: 'addon-group:Delete', resource: query('addon-group', 'name') }
	},
	'/api/addons/groups/[name]': {
		GET: { action: 'addon-group:Describe', resource: addonGroup },
		PATCH: { action: 'addon-group:Update', resource: addonGroup },
		POST: { action: 'addon-group:Update', resource: addonGroup },
		DELETE: { action: 'addon-group:Delete', resource: addonGroup }
	},

	'/api/runtimes': {
		GET: { action: 'runtime:List' },
		POST: byAction({ install: 'runtime:Install', remove: 'runtime:Remove' }, 'runtime:Install')
	},
	'/api/runtimes/available': { GET: { action: 'catalog:Read' } },
	'/api/profiles': { GET: { action: 'profile:List' }, POST: { action: 'profile:Create' } },
	'/api/profiles/[name]': {
		GET: { action: 'profile:Describe', resource: profile },
		PATCH: { action: 'profile:Update', resource: profile },
		DELETE: { action: 'profile:Delete', resource: profile }
	},

	'/api/ports': {
		GET: { action: 'network:Describe' },
		POST: { action: 'network:ManageProxy' },
		PUT: { action: 'port-pool:Update' }
	},
	'/api/proxy': { GET: { action: 'network:Describe' }, POST: { action: 'network:ManageProxy' } },
	'/api/selector': { GET: { action: 'network:Describe' }, PATCH: { action: 'network:ManageProxy' } },
	'/api/selector/preview': { GET: { action: 'network:Describe' } },
	'/api/selector/apply': { POST: { action: 'network:ManageProxy' } },
	'/api/selector/import': { POST: { action: 'network:ManageProxy' } },
	'/api/domains': {
		GET: { action: 'domain:List' },
		POST: { action: 'domain:Create', and: both(networkOnBodyInstance, recordsIfAddressed) }
	},
	'/api/domains/check': { POST: { action: 'domain:List' } },
	'/api/domains/records': { GET: { action: 'domain:Describe', resource: query('domain', 'name') } },
	'/api/domains/settings': { PATCH: { action: 'domain:ConfigureProvider' } },
	'/api/domains/[name]': {
		PATCH: { action: 'domain:ManageRecords', resource: domain },
		DELETE: { action: 'domain:Delete', resource: domain }
	},
	'/api/domains/[name]/link': { POST: { action: 'domain:Link', resource: domain, and: networkOnBodyInstance } },
	'/api/domains/[name]/unlink': { POST: { action: 'domain:Link', resource: domain } },

	'/api/schedules': { GET: { action: 'schedule:List' }, POST: { action: 'schedule:Create', and: scheduleTargets } },
	'/api/schedules/[id]': {
		PATCH: { action: 'schedule:Update', resource: schedule },
		POST: { action: 'schedule:Update', resource: schedule },
		DELETE: { action: 'schedule:Delete', resource: schedule }
	},
	'/api/env': {
		GET: { action: 'env:List' },
		POST: { action: 'env:Set', resource: body('env', 'name'), and: envScope },
		DELETE: { action: 'env:Unset', resource: query('env', 'name'), and: envScope }
	},
	'/api/env/[name]': { GET: { action: 'env:Describe', resource: env } },
	'/api/env/[name]/reveal': { POST: { action: 'env:Reveal', resource: env } },

	'/api/players': { GET: { action: 'player:List' } },
	'/api/players/moderate': { POST: moderation },
	'/api/players/[player]': { GET: { action: 'player:Describe', resource: player } },
	'/api/players/[player]/chat': { GET: { action: 'chat:ReadPlayer', resource: player } },
	'/api/players/[player]/sessions': { GET: { action: 'player:Describe', resource: player } },
	'/api/players/[player]/vault': { GET: { action: 'player:Describe', resource: player } },
	'/api/players/[player]/vault/transactions': { GET: { action: 'player:Describe', resource: player } },
	'/api/players/[player]/auth': {
		GET: { action: 'player:Describe', resource: player },
		POST: { action: 'player:Act', resource: player }
	},
	'/api/players/[player]/skin': {
		GET: { action: 'player:Describe', resource: player },
		POST: { action: 'player:Act', resource: player }
	},
	'/api/players/[player]/moderation': {
		GET: { action: 'player:Describe', resource: player },
		POST: { action: 'player:Moderate', resource: player }
	},
	'/api/players/[player]/permissions': {
		GET: { action: 'player:Describe', resource: player },
		POST: { action: 'player:ManagePermissions', resource: player }
	},
	'/api/moderation': { GET: { action: 'player:List' } },
	'/api/moderation/log': { GET: { action: 'player:List' } },
	'/api/moderation/network-ip-bans': { GET: { action: 'player:List' }, POST: { action: 'player:Moderate' } },
	'/api/luna/players': { GET: { action: 'player:List' } },
	'/api/luna/admin': { POST: { action: 'player:Act' } },
	'/api/luna/stream': { GET: { action: 'event:Read' } },
	'/api/luna/telemetry': { GET: { action: 'event:Read' } },
	'/api/permissions/groups': { GET: { action: 'permission-group:List' }, POST: { action: 'permission-group:Create' } },
	'/api/permissions/groups/[name]': {
		GET: { action: 'permission-group:Describe', resource: permissionGroup },
		POST: { action: 'permission-group:Update', resource: permissionGroup },
		DELETE: { action: 'permission-group:Delete', resource: permissionGroup }
	},

	'/api/cleanup': { GET: { action: 'cleanup:Describe' }, POST: { action: 'cleanup:Run' } },
	'/api/console/logs': { GET: { action: 'journal:Read' } },
	'/api/events': { GET: { action: 'event:Read' } },
	'/api/jobs': { GET: { action: 'job:Describe' } },
	'/api/jobs/[id]': { GET: { action: 'job:Describe' } },
	'/api/shell/exec': { GET: { action: 'shell:Execute' } },
	'/api/shell/complete': { POST: { action: 'shell:Execute' } },
	'/api/mc/assets': { GET: { action: 'catalog:Read' }, POST: { action: 'catalog:Read' } },
	'/api/mc/assets/gui': { GET: { action: 'catalog:Read' } },
	'/api/mc/assets/registry': { GET: { action: 'catalog:Read' } },
	'/api/mc/assets/font/[file]': { GET: { action: 'catalog:Read' } },
	'/api/mc/assets/texture/[...path]': { GET: { action: 'catalog:Read' } },

	'/api/mcp-tokens': { GET: { action: 'mcp:ListTokens' }, POST: { action: 'mcp:CreateToken' } },
	'/api/mcp-tokens/[id]': {
		GET: { action: 'mcp:DescribeToken' },
		PATCH: { action: 'mcp:UpdateToken' },
		DELETE: { action: 'mcp:DeleteToken' }
	},
	'/api/mcp-tokens/[id]/rotate': { POST: { action: 'mcp:RotateToken' } },
	'/api/mcp-calls': { GET: { action: 'mcp:ReadCalls' } },
	// the screen writes any scope and pins into every token's instructions, which
	// is publishing; Mèo Béo's memory tools only write the account's own notes
	'/api/knowledge': { GET: { action: 'knowledge:List' }, POST: { action: 'knowledge:Create', and: publishKnowledge } },
	'/api/knowledge/[id]': {
		GET: { action: 'knowledge:Describe', resource: knowledge },
		PATCH: { action: 'knowledge:Update', resource: knowledge, and: publishKnowledge },
		DELETE: { action: 'knowledge:Delete', resource: knowledge }
	},

	'/api/agent': { GET: { action: 'agent:Describe' }, PATCH: { action: 'agent:Configure' } },
	'/api/agent/credential': { PUT: { action: 'agent:Configure' }, DELETE: { action: 'agent:Configure' } },
	'/api/agent/test': { POST: { action: 'agent:Configure' } },
	'/api/agent/uploads': { POST: { action: 'agent:Chat' } },
	'/api/agent/uploads/[id]': { DELETE: { action: 'agent:Chat' } },
	'/api/agent/conversations': { GET: { action: 'agent:Chat' }, POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]': {
		GET: { action: 'agent:Chat' },
		PATCH: { action: 'agent:Chat' },
		DELETE: { action: 'agent:Chat' }
	},
	'/api/agent/conversations/[id]/approve': { POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/compact': { POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/messages': { POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/navigated': { POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/run': { PATCH: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/screenshot': { POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/stop': { POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/stream': { GET: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/watch': { GET: { action: 'agent:Chat' } }
};

/**
 * Page routes whose resource has to be resolved asynchronously (an account is
 * addressed by id, and its resource id carries the username). Everything else
 * is in `$lib/authz/pages`, shared with the nav.
 */
export const PAGE_ASYNC_RULES: Record<string, RouteRule> = {
	'/plugins/[name]': { action: 'plugin:Describe', anyOf: pluginRecords },
	'/console/accounts/[id]': { action: 'account:Describe', resource: account },
	'/console/accounts/[id]/edit': { action: 'account:Update', resource: account }
};

/** The action a rule resolves to, reading the body when the rule depends on it. */
export async function ruleAction(rule: RouteRule, ctx: RuleContext): Promise<string> {
	if (rule.actionOf) {
		return await rule.actionOf(ctx);
	}

	return rule.action;
}
