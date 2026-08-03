/**
 * Plugin identity, families and addon groups (DESIGN.md §3.1–3.2).
 *
 * A lockfile entry is one *build* of a plugin: the pair (plugin name, family).
 * Entry keys already encode that pair ("spark-bukkit" / "spark-velocity"), so
 * identity is two derived fields on the entry rather than a new data model —
 * `migrateLock` fills them once and the helpers here fall back to the old
 * meaning (key = name, loader = family) so unmigrated data still resolves.
 *
 * An **addon group** is a named set of addons — plugin names, resource pack
 * keys and data pack names — applied to instances as a unit. An instance's
 * effective plugin set is the union of its groups (always including
 * "default"); an entry deploys to an instance when its plugin is in that set
 * and its family matches the instance's software. The pack kinds resolve the
 * same way, in respacks.ts and datapacks.ts, from `memberInstances` here.
 */

import type {
	AddonGroup,
	ClusterConfig,
	InstanceConfig,
	PluginEntry,
	PluginFamily,
	PluginsLock,
	Software,
} from "./types";
import { expandTargets, managedInstances, managesPlugins } from "./config";

export const DEFAULT_GROUP = "default";

/** Baseline plugins every instance gets; locked into the default group. */
export const DEFAULT_GROUP_PLUGINS = [
	"luna-core",
	"luna-auth",
	"luna-messenger",
	"vault",
	"tab",
	"tab-bridge",
	"spark",
	"protocollib",
	"skinsrestorer",
	"placeholderapi",
	"luckperms",
];

/** Current lockfile schema revision written by `migrateLock`. */
export const LOCK_VERSION = 2;

/** The plugin name an entry belongs to. */
export function pluginNameOf(key: string, entry: PluginEntry): string {
	return entry.plugin ?? key;
}

/** The platform family an entry runs on. */
export function familyOf(entry: PluginEntry): PluginFamily {
	return entry.family ?? entry.loader;
}

/**
 * Whether a build of this family loads on the given server software. Software
 * outside the plugin system (neoforge) matches nothing, so a group can never
 * pull a pool jar into a modpack's `mods/`.
 */
export function familyMatches(family: PluginFamily, software: Software): boolean {
	if (!managesPlugins(software)) {
		return false;
	}

	if (family === "universal") {
		return true;
	}

	return family === software;
}

/** Group names applied to an instance — "default" always, then its own list. */
export function instanceGroupNames(inst: InstanceConfig): string[] {
	// `pluginGroups` is the pre-addon-group spelling; cluster.json is migrated on
	// load, but an in-flight config passed over RPC may still carry it
	const own = inst.addonGroups ?? inst.pluginGroups ?? [];

	return [DEFAULT_GROUP, ...own.filter((name) => name !== DEFAULT_GROUP)];
}

/** The kinds of addon a group can carry. */
export type AddonKind = "plugins" | "respacks" | "datapacks";

/** One kind's members of a group, always a list. */
export function groupMembers(group: AddonGroup, kind: AddonKind): string[] {
	if (kind === "respacks") {
		return group.respacks ?? [];
	}

	if (kind === "datapacks") {
		return group.datapacks ?? [];
	}

	return group.plugins;
}

/**
 * Group names carrying one addon, sorted — "used by" for a pack or plugin.
 * Takes the group map rather than the lockfile, because the pack modules
 * resolve membership against `plugins.lock.json`'s groups while their own
 * source of truth is `packs.lock.json`.
 */
export function groupsWith(
	groups: Record<string, AddonGroup> | undefined,
	kind: AddonKind,
	member: string,
): string[] {
	return Object.entries(groups ?? {})
		.filter(([, group]) => groupMembers(group, kind).includes(member))
		.map(([name]) => name)
		.sort();
}

/**
 * Instances that get one addon through group membership: every managed
 * instance whose groups carry it. The pack modules narrow this further (a
 * resource pack rule never names the proxy; a data pack needs a world).
 */
export function memberInstances(
	cfg: ClusterConfig,
	groups: Record<string, AddonGroup> | undefined,
	kind: AddonKind,
	member: string,
): string[] {
	const carriers = new Set(groupsWith(groups, kind, member));

	if (!carriers.size) {
		return [];
	}

	return Object.entries(managedInstances(cfg))
		.filter(([, inst]) => instanceGroupNames(inst).some((group) => carriers.has(group)))
		.map(([name]) => name)
		.sort();
}

/** Every distinct plugin name in the lockfile, sorted. */
export function allPluginNames(lock: PluginsLock): string[] {
	const names = new Set<string>();

	for (const [key, entry] of Object.entries(lock.plugins)) {
		names.add(pluginNameOf(key, entry));
	}

	return [...names].sort();
}

/** Entry keys that are builds of the given plugin name. */
export function entriesOf(lock: PluginsLock, plugin: string): string[] {
	return Object.entries(lock.plugins)
		.filter(([key, entry]) => pluginNameOf(key, entry) === plugin)
		.map(([key]) => key);
}

/**
 * Whether an instance wants a plugin by name: its per-instance override wins
 * (true force-adds, false disables), otherwise any of its groups naming the
 * plugin does.
 */
export function instanceWants(inst: InstanceConfig, lock: PluginsLock, plugin: string): boolean {
	const override = inst.pluginOverrides?.[plugin];

	if (override !== undefined) {
		return override;
	}

	return instanceGroupNames(inst).some((group) => lock.groups?.[group]?.plugins.includes(plugin));
}

/**
 * Instances an entry reaches through group membership or a force-add override:
 * the instance wants the entry's plugin and the entry's family matches its
 * software.
 */
export function groupCoverage(cfg: ClusterConfig, lock: PluginsLock, key: string): string[] {
	const entry = lock.plugins[key];

	if (!entry) {
		return [];
	}

	const plugin = pluginNameOf(key, entry);
	const family = familyOf(entry);
	const covered: string[] = [];

	for (const [name, inst] of Object.entries(managedInstances(cfg))) {
		if (!familyMatches(family, inst.software)) {
			continue;
		}

		if (instanceWants(inst, lock, plugin)) {
			covered.push(name);
		}
	}

	return covered;
}

/**
 * Every instance an entry deploys to: explicit targets (instance-specific
 * extras, wildcards included) united with group/override coverage, minus the
 * instances that disabled the plugin — a `false` override beats an explicit
 * lockfile target too. This is the single resolution deploy, drift detection
 * and compat checks all share, so it is also where instances outside the plugin
 * system drop out: naming one explicitly must not deploy into its `mods/`.
 */
export function effectiveTargets(cfg: ClusterConfig, lock: PluginsLock, key: string): string[] {
	const entry = lock.plugins[key];

	if (!entry) {
		return [];
	}

	const insts = managedInstances(cfg);
	const plugin = pluginNameOf(key, entry);
	const out = new Set<string>(expandTargets(cfg, entry.targets));

	for (const name of groupCoverage(cfg, lock, key)) {
		out.add(name);
	}

	for (const name of [...out]) {
		const inst = insts[name];

		if (!inst || !managesPlugins(inst.software)) {
			out.delete(name);

			continue;
		}

		if (inst.pluginOverrides?.[plugin] === false) {
			out.delete(name);
		}
	}

	return [...out].sort();
}

/**
 * Set (or clear, with `null`) an instance's per-instance override for a plugin
 * name. Mutates the cluster config — the caller persists it. Force-adding a
 * plugin the pool does not know is refused; disabling anything is allowed.
 */
export function setPluginOverride(
	cfg: ClusterConfig,
	lock: PluginsLock,
	instance: string,
	plugin: string,
	state: boolean | null,
): void {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(`unknown instance: ${instance}`);
	}

	if (state === true && entriesOf(lock, plugin).length === 0) {
		throw new Error(`unknown plugin: ${plugin} — nothing pooled under that name`);
	}

	if (state === null) {
		delete inst.pluginOverrides?.[plugin];

		if (inst.pluginOverrides && Object.keys(inst.pluginOverrides).length === 0) {
			delete inst.pluginOverrides;
		}

		return;
	}

	inst.pluginOverrides ??= {};
	inst.pluginOverrides[plugin] = state;
}

/**
 * Create or update an addon group. Each member list is replaced when the patch
 * carries it and left alone when it does not, so a caller editing only the
 * resource packs cannot drop the plugins. The default group keeps its
 * hardcoded plugins.
 */
export function setGroup(
	lock: PluginsLock,
	name: string,
	patch: {
		plugins?: string[];
		respacks?: string[];
		datapacks?: string[];
		description?: string;
	},
): AddonGroup {
	if (!/^[a-z0-9_-]+$/.test(name)) {
		throw new Error("group name must be lowercase alphanumeric/-/_");
	}

	lock.groups ??= {};

	const existing = lock.groups[name];
	const group: AddonGroup = existing ?? { plugins: [] };

	if (patch.plugins) {
		group.plugins = [...new Set(patch.plugins)].sort();
	}

	// an empty list is a real value here (the group carries no packs), so the
	// key is dropped rather than kept as []
	for (const kind of ["respacks", "datapacks"] as const) {
		const members = patch[kind];

		if (!members) {
			continue;
		}

		const unique = [...new Set(members)].sort();

		if (unique.length) {
			group[kind] = unique;
		} else {
			delete group[kind];
		}
	}

	if (patch.description !== undefined) {
		if (patch.description) {
			group.description = patch.description;
		} else {
			delete group.description;
		}
	}

	if (name === DEFAULT_GROUP) {
		group.builtin = true;

		// hardcoded members can be joined by extras but never removed
		group.plugins = [...new Set([...DEFAULT_GROUP_PLUGINS, ...group.plugins])].sort();
	}

	lock.groups[name] = group;

	return group;
}

/**
 * Drop one addon from every group carrying it — what a pack's removal owes the
 * groups, so a deleted pack does not linger as a phantom member. Returns
 * whether anything changed, so the caller knows to persist.
 */
export function pruneAddon(lock: PluginsLock, kind: AddonKind, member: string): boolean {
	let changed = false;

	for (const group of Object.values(lock.groups ?? {})) {
		const members = groupMembers(group, kind);

		if (!members.includes(member)) {
			continue;
		}

		const kept = members.filter((name) => name !== member);

		if (kind === "plugins") {
			group.plugins = kept;
		} else if (kept.length) {
			group[kind] = kept;
		} else {
			delete group[kind];
		}

		changed = true;
	}

	return changed;
}

/** Delete a group. The default group cannot be deleted. */
export function deleteGroup(lock: PluginsLock, name: string): void {
	if (name === DEFAULT_GROUP) {
		throw new Error("the default group cannot be deleted");
	}

	if (!lock.groups?.[name]) {
		throw new Error(`unknown group: ${name}`);
	}

	delete lock.groups[name];
}

/** Instances using a group ("default" → every managed instance). */
export function groupInstances(cfg: ClusterConfig, name: string): string[] {
	return Object.entries(managedInstances(cfg))
		.filter(([, inst]) => instanceGroupNames(inst).includes(name))
		.map(([instName]) => instName)
		.sort();
}

/** How one plugin of a group resolves against a (prospective) instance. */
export interface GroupCheckRow {
	plugin: string;
	/** Selected groups that want this plugin */
	groups: string[];
	/** Force-added by a per-instance override rather than a group */
	manual?: boolean;
	/** Disabled by a per-instance override — will not deploy regardless of status */
	disabled?: boolean;
	/** Lockfile key of the matched build, when one exists */
	entry?: string;
	family?: PluginFamily;
	/**
	 * ok         — matching family with a compatible (or version-independent) build
	 * unverified — matching family, but the build carries no MC metadata (luna/manual jars)
	 * no-version — matching family, no pooled build supports the MC version
	 * skipped    — no build for this platform
	 * missing    — named in a group but nothing is pooled at all
	 */
	status: "ok" | "unverified" | "no-version" | "skipped" | "missing";
	/** Version that would deploy (ok/unverified) */
	version?: string;
	gameVersions?: string[];
	/** A compatible build could be downloaded from Modrinth */
	downloadable: boolean;
}

const CHECK_ORDER: Record<GroupCheckRow["status"], number> = {
	missing: 0,
	"no-version": 1,
	skipped: 2,
	unverified: 3,
	ok: 4,
};

/** MC versions a pooled build supports, mirroring compatReport's source of truth. */
function pooledGameVersions(entry: PluginEntry, version: string | undefined): string[] | undefined {
	if (!version) {
		return undefined;
	}

	if (entry.variants?.[version]?.gameVersions?.length) {
		return entry.variants[version]!.gameVersions;
	}

	if (version === entry.installed?.versionNumber) {
		return entry.installed?.gameVersions;
	}

	return undefined;
}

/**
 * Validation table for a group selection: how each wanted plugin lands on an
 * instance of the given software + MC version. `instance` sharpens version
 * resolution with its pins/assignments when the instance already exists.
 * `overrides` are the per-instance force-adds/disables to evaluate — they
 * default to the instance's stored ones, so a prospective (launch-form)
 * selection can pass its own.
 */
export function validateGroups(
	cfg: ClusterConfig,
	lock: PluginsLock,
	opts: {
		software: Software;
		mcVersion?: string;
		groups: string[];
		instance?: string;
		overrides?: Record<string, boolean>;
	},
): GroupCheckRow[] {
	const selection = [
		DEFAULT_GROUP,
		...opts.groups.filter((name) => name !== DEFAULT_GROUP),
	].filter((name) => lock.groups?.[name]);

	const overrides =
		opts.overrides ??
		(opts.instance ? (managedInstances(cfg)[opts.instance]?.pluginOverrides ?? {}) : {});

	const wanted = new Map<string, string[]>();

	for (const groupName of selection) {
		for (const plugin of lock.groups![groupName]!.plugins) {
			if (!wanted.has(plugin)) {
				wanted.set(plugin, []);
			}

			wanted.get(plugin)!.push(groupName);
		}
	}

	// force-adds appear as rows of their own; disables keep their row but are flagged
	for (const [plugin, state] of Object.entries(overrides)) {
		if (state && !wanted.has(plugin)) {
			wanted.set(plugin, []);
		}
	}

	const rows: GroupCheckRow[] = [];

	for (const [plugin, groups] of wanted) {
		const keys = entriesOf(lock, plugin);

		if (!keys.length) {
			rows.push({ plugin, groups, status: "missing", downloadable: false });

			continue;
		}

		// prefer the exact family over a universal build
		const matching = keys
			.filter((key) => familyMatches(familyOf(lock.plugins[key]!), opts.software))
			.sort((a, b) => {
				const exactA = familyOf(lock.plugins[a]!) === opts.software ? 0 : 1;
				const exactB = familyOf(lock.plugins[b]!) === opts.software ? 0 : 1;

				return exactA - exactB;
			});

		const key = matching[0];

		if (!key) {
			rows.push({ plugin, groups, status: "skipped", downloadable: false });

			continue;
		}

		const entry = lock.plugins[key]!;
		const family = familyOf(entry);

		const version = opts.instance
			? (entry.pins?.[opts.instance] ?? entry.assign?.[opts.instance] ?? entry.installed?.versionNumber)
			: entry.installed?.versionNumber;

		// velocity builds are MC-version independent (same rule resolveEntry applies)
		if (opts.software !== "paper" || !opts.mcVersion) {
			rows.push({ plugin, groups, entry: key, family, status: "ok", version, downloadable: false });

			continue;
		}

		const gameVersions = pooledGameVersions(entry, version);

		if (!gameVersions?.length) {
			rows.push({
				plugin,
				groups,
				entry: key,
				family,
				status: "unverified",
				version,
				downloadable: false,
			});

			continue;
		}

		if (gameVersions.includes(opts.mcVersion)) {
			rows.push({
				plugin,
				groups,
				entry: key,
				family,
				status: "ok",
				version,
				gameVersions,
				downloadable: false,
			});

			continue;
		}

		// the assigned build does not fit — maybe another pooled variant does
		const fallback = Object.values(entry.variants ?? {}).find((variant) =>
			variant.gameVersions?.includes(opts.mcVersion!),
		);

		if (fallback) {
			rows.push({
				plugin,
				groups,
				entry: key,
				family,
				status: "ok",
				version: fallback.versionNumber,
				gameVersions: fallback.gameVersions,
				downloadable: false,
			});

			continue;
		}

		rows.push({
			plugin,
			groups,
			entry: key,
			family,
			status: "no-version",
			version,
			gameVersions,
			downloadable: !!entry.modrinth,
		});
	}

	for (const row of rows) {
		if (overrides[row.plugin] === true && row.groups.length === 0) {
			row.manual = true;
		}

		if (overrides[row.plugin] === false) {
			row.disabled = true;
		}
	}

	return rows.sort((a, b) => {
		const order = CHECK_ORDER[a.status] - CHECK_ORDER[b.status];

		return order !== 0 ? order : a.plugin.localeCompare(b.plugin);
	});
}

/**
 * Derive (plugin, family) for a v1 entry from its naming conventions, falling
 * back to where the jar is actually deployed for suffix-less names — that is
 * what tells a universal jar (proxy + backends) from a mislabeled one.
 */
function deriveIdentity(key: string, entry: PluginEntry): { plugin: string; family: PluginFamily } {
	// the standardized scheme is unambiguous: <plugin>@<family>
	const standardized = key.match(/^(.+)@(paper|velocity|universal|neoforge)$/);

	if (standardized) {
		return { plugin: standardized[1]!, family: standardized[2] as PluginFamily };
	}

	let base = key.endsWith("-all") ? key.slice(0, -4) : key;
	let family: PluginFamily | undefined;

	const velocity = base.match(/^(.*)-velocity$/);
	const paper = base.match(/^(.*)-(bukkit|paper|spigot)$/);

	if (velocity) {
		base = velocity[1]!;
		family = "velocity";
	} else if (paper) {
		base = paper[1]!;
		family = "paper";
	}

	// "-backend" marks the paper-side module of a velocity plugin (luna-auth-backend)
	if (base.endsWith("-backend")) {
		base = base.slice(0, -8);
		family ??= entry.loader;
	}

	if (!family) {
		const targets = entry.targets;
		const proxyOnly = targets.length > 0 && targets.every((target) => target === "proxy");
		const both = targets.includes("proxy") && targets.some((target) => target !== "proxy");

		if (entry.loader === "paper" && proxyOnly) {
			family = "velocity";
		} else if (entry.loader === "paper" && both) {
			family = "universal";
		} else {
			family = entry.loader;
		}
	}

	return { plugin: base, family };
}

/** Explicit target lists made fully redundant by default-group coverage. */
function coveredByDefault(entry: PluginEntry, family: PluginFamily): boolean {
	if (family === "paper") {
		return entry.targets.length === 1 && entry.targets[0] === "*paper";
	}

	if (family === "velocity") {
		return entry.targets.length === 1 && entry.targets[0] === "proxy";
	}

	return false;
}

/** Config templates seeded on migration, keyed by entry name (DESIGN.md §3.3).
 *  Both the legacy and the standardized (`<plugin>@<family>`) keys are listed,
 *  so seeding works on either side of the naming migration. */
const LUNA_CORE_TEMPLATE: PluginEntry["config"] = [
	{
		file: "plugins/LunaCore/config.yml",
		// the bootstrap makes the very first boot heartbeat correctly: without
		// it the file only exists after that boot, so `set` stays pending-file
		// and the plugin reports to its bundled default endpoint (or nowhere)
		write:
			"# Written by luna before first boot — LunaCore merges its remaining defaults.\n" +
			"heartbeat:\n" +
			"  enabled: true\n" +
			'  endpoint: "http://${LUNA_PROXY_HOST}:${LUNA_HTTP_PORT}/api/heartbeat"\n' +
			'  serverName: "${LUNA_INSTANCE}"\n',
		set: {
			endpoint: "http://${LUNA_PROXY_HOST}:${LUNA_HTTP_PORT}/api/heartbeat",
			serverName: "${LUNA_INSTANCE}",
		},
	},
];

const LUCKPERMS_TEMPLATE: PluginEntry["config"] = [
	{
		file: "plugins/LuckPerms/config.yml",
		set: {
			server: "${LUNA_INSTANCE}",
		},
	},
];

const SEED_TEMPLATES: Record<string, PluginEntry["config"]> = {
	"luna-core-paper-all": LUNA_CORE_TEMPLATE,
	"luna-core@paper": LUNA_CORE_TEMPLATE,
	"luckperms-bukkit": LUCKPERMS_TEMPLATE,
	"luckperms@paper": LUCKPERMS_TEMPLATE,
};

/**
 * Bring a lockfile up to the current schema, in place. Idempotent; returns
 * whether anything changed so the caller knows to persist. Never touches a
 * field the operator may have edited (existing plugin/family/config survive).
 */
export function migrateLock(lock: PluginsLock): boolean {
	let changed = false;

	for (const [key, entry] of Object.entries(lock.plugins)) {
		if (entry.plugin !== undefined && entry.family !== undefined) {
			continue;
		}

		const identity = deriveIdentity(key, entry);

		entry.plugin ??= identity.plugin;
		entry.family ??= identity.family;
		changed = true;
	}

	if (!lock.groups?.[DEFAULT_GROUP]) {
		setGroup(lock, DEFAULT_GROUP, { plugins: DEFAULT_GROUP_PLUGINS });
		changed = true;
	} else {
		// re-assert the hardcoded members — a hand-edited lockfile must not be able
		// to drop a baseline plugin from every instance at once
		const group = lock.groups[DEFAULT_GROUP]!;
		const missing = DEFAULT_GROUP_PLUGINS.filter((name) => !group.plugins.includes(name));

		if (missing.length || !group.builtin) {
			setGroup(lock, DEFAULT_GROUP, {});
			changed = true;
		}
	}

	// explicit targets that say exactly what the default group now says are
	// dropped, so editing the group actually changes what deploys
	const defaults = new Set(lock.groups![DEFAULT_GROUP]!.plugins);

	for (const [key, entry] of Object.entries(lock.plugins)) {
		if (!defaults.has(pluginNameOf(key, entry))) {
			continue;
		}

		if (entry.targets.length && coveredByDefault(entry, familyOf(entry))) {
			entry.targets = [];
			changed = true;
		}
	}

	for (const [key, ops] of Object.entries(SEED_TEMPLATES)) {
		const entry = lock.plugins[key];

		if (entry && entry.config === undefined) {
			entry.config = ops;
			changed = true;
		}
	}

	if ((lock.version ?? 1) < LOCK_VERSION) {
		lock.version = LOCK_VERSION;
		changed = true;
	}

	return changed;
}
