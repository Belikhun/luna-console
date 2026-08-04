/**
 * The server-selector model: what the LunaCore proxy plugin renders as the
 * `/servers` chest GUI, expressed as luna data rather than as YAML.
 *
 * This lives in shared because all three sides need it — the daemon generates
 * `servers.yml` from it, the CLI validates it, and the console's editor
 * validates the draft in the browser while the admin types. The shapes mirror
 * `VelocityServerSelectorConfig` field for field; where they differ, the comment
 * says why.
 */

export type SelectorStatus = "ONLINE" | "OFFLINE" | "MAINT" | "NOP";

export const SELECTOR_STATUSES: readonly SelectorStatus[] = ["ONLINE", "OFFLINE", "MAINT", "NOP"];

/** Slots the plugin lets a server occupy — row 6 is its own hardcoded footer. */
export const SELECTOR_PAGE_SIZE = 45;

/**
 * The placeholders the plugin resolves. Anything else is reported as a warning,
 * or as an error when `diagnostics.unknownPlaceholderAsError` is set — which is
 * why the editor checks them rather than letting a typo reach a reload.
 */
export const KNOWN_PLACEHOLDERS: readonly string[] = [
	"server_name",
	"luna_host_name",
	"luna_server_name",
	"server_display",
	"server_accent_color",
	"server_status",
	"server_status_color",
	"server_status_icon",
	"online",
	"max",
	"uptime",
	"uptime_long",
	"tps",
	"cpu_usage",
	"ram_used_mb",
	"ram_max_mb",
	"ram_percent",
	"latency_ms",
	"version",
	"software",
	"server_software",
	"server_version",
	"server_version_full",
	"motd",
	"player_name",
	"line",
];

/** Material the plugin falls back to per status when nothing is configured. */
export const DEFAULT_STATUS_MATERIALS: Record<SelectorStatus, string> = {
	ONLINE: "LIME_CONCRETE",
	OFFLINE: "RED_CONCRETE",
	MAINT: "YELLOW_CONCRETE",
	NOP: "GRAY_CONCRETE",
};

/** A conditional override, applied on top of the resolved item when `when` holds. */
export interface SelectorConditionalRule {
	when: string;
	material?: string;
	glint?: boolean;
	description?: string[];
	/**
	 * Raw per-rule template override. The editor never writes this — it is carried
	 * through untouched so importing a hand-written file loses nothing.
	 */
	template?: Record<string, unknown>;
}

/** Where a server sits in the GUI, and how clicking it behaves. */
export interface InstanceSelectorEntry {
	/** 1-based page, as the plugin's config counts them */
	page: number;
	/** 0–44 inside the 5-row server grid */
	slot: number;
	/** Tri-state: absent leaves the item's vanilla glint alone */
	glint?: boolean;
	glintByStatus?: Partial<Record<SelectorStatus, boolean>>;
	permission?: string;
	connectMessage?: string;
	conditional?: SelectorConditionalRule[];
	descriptionByStatus?: Partial<Record<SelectorStatus, string[]>>;
	/**
	 * Raw per-server template block, round-tripped only. The plugin treats one of
	 * these as a *replacement* for the global template rather than a merge, so a
	 * partial block silently wipes the global header and footer — the editor
	 * refuses to author them for that reason.
	 */
	template?: Record<string, unknown>;
}

/** The four text fields a by-status block may override. */
export interface SelectorTemplateOverride {
	name?: string;
	header?: string[];
	bodyLine?: string;
	footer?: string[];
}

export interface SelectorTemplate extends SelectorTemplateOverride {
	/** Fallback material for servers that set none of their own */
	material?: string;
	byStatus?: Partial<Record<SelectorStatus, SelectorTemplateOverride>>;
}

export interface SelectorMessages {
	opening?: string;
	playerOnly?: string;
	notFound?: string;
	offline?: string;
	maint?: string;
	noPermission?: string;
	connecting?: string;
}

export interface SelectorDiagnostics {
	enabled?: boolean;
	failOnValidationError?: boolean;
	unknownPlaceholderAsError?: boolean;
}

/** The cluster-wide half of the selector, stored as `serverSelector` in cluster.json. */
export interface ServerSelectorConfig {
	enabled: boolean;
	title?: string;
	failOnServerCommandOverrideFailure?: boolean;
	diagnostics?: SelectorDiagnostics;
	template?: SelectorTemplate;
	messages?: SelectorMessages;
	statusColors?: Partial<Record<SelectorStatus, string>>;
	statusIcons?: Partial<Record<SelectorStatus, string>>;
}

/**
 * One server as the editor sees it: the per-instance metadata plus the facts it
 * needs to render but does not own (which daemon hosts it, what software it
 * runs). The browser never sees a ClusterConfig, so this is the wire shape.
 */
export interface SelectorServerDraft {
	serverDisplay?: string;
	accentColor?: string;
	serverIcon?: string;
	serverStatusIcons?: Partial<Record<SelectorStatus, string>>;
	description?: string[];
	selector?: InstanceSelectorEntry;
	/** Derived from the owning daemon — `server-info.host-name` on disk */
	hostName: string;
	software: string;
	mcVersion?: string;
	/** True when luna only proxies this server and does not manage its files */
	external?: boolean;
}

export interface SelectorDraft {
	global: ServerSelectorConfig;
	servers: Record<string, SelectorServerDraft>;
}

export interface SelectorIssue {
	level: "error" | "warning";
	/** Dotted path into the draft, e.g. `servers.survival.slot` — the editor
	 *  turns this into a link to the offending field */
	path: string;
	message: string;
}

/** Every field the plugin scans for `%placeholder%` tokens. */
function placeholderFields(draft: SelectorDraft): Array<{ path: string; text: string }> {
	const out: Array<{ path: string; text: string }> = [];
	const push = (path: string, text: string | undefined): void => {
		if (text) {
			out.push({ path, text });
		}
	};

	const pushLines = (path: string, lines: string[] | undefined): void => {
		if (!lines) {
			return;
		}

		lines.forEach((line, index) => push(`${path}.${index}`, line));
	};

	const pushOverride = (path: string, override: SelectorTemplateOverride | undefined): void => {
		if (!override) {
			return;
		}

		push(`${path}.name`, override.name);
		push(`${path}.bodyLine`, override.bodyLine);
		pushLines(`${path}.header`, override.header);
		pushLines(`${path}.footer`, override.footer);
	};

	push("title", draft.global.title);
	pushOverride("template", draft.global.template);

	for (const status of SELECTOR_STATUSES) {
		pushOverride(`template.byStatus.${status}`, draft.global.template?.byStatus?.[status]);
	}

	const messages = draft.global.messages ?? {};

	for (const [key, value] of Object.entries(messages)) {
		push(`messages.${key}`, value);
	}

	for (const [name, server] of Object.entries(draft.servers)) {
		push(`servers.${name}.connectMessage`, server.selector?.connectMessage);
		pushLines(`servers.${name}.description`, server.description);

		for (const status of SELECTOR_STATUSES) {
			pushLines(`servers.${name}.descriptionByStatus.${status}`, server.selector?.descriptionByStatus?.[status]);
		}

		(server.selector?.conditional ?? []).forEach((rule, index) => {
			pushLines(`servers.${name}.conditional.${index}.description`, rule.description);
		});
	}

	return out;
}

const PLACEHOLDER_PATTERN = /%([a-zA-Z0-9_]+)%/g;
const MATERIAL_PATTERN = /^[A-Za-z0-9_]+$/;

/** Whether a server is drawn in the GUI at all. */
export function isPlaced(server: SelectorServerDraft): boolean {
	return !!server.selector && Number.isFinite(server.selector.slot) && Number.isFinite(server.selector.page);
}

/**
 * Check a draft the way `VelocityServerSelectorValidator` checks the file it
 * generates.
 *
 * This exists so the editor can refuse to apply what the proxy would reject: a
 * validation error there aborts `lunacoreproxy reload` outright, which would
 * leave the cluster running the previous config with no obvious sign why.
 *
 * @returns every issue found, errors and warnings together, in draft order
 */
export function validateSelectorDraft(draft: SelectorDraft): SelectorIssue[] {
	const issues: SelectorIssue[] = [];
	const placed = Object.entries(draft.servers).filter(([, server]) => isPlaced(server));

	if (draft.global.enabled && placed.length === 0) {
		issues.push({
			level: "error",
			path: "servers",
			message: "the selector is enabled but no server is placed in the grid",
		});
	}

	const takenSlots = new Map<string, string>();

	for (const [name, server] of placed) {
		const entry = server.selector!;
		const base = `servers.${name}`;

		if (!server.serverDisplay || !server.serverDisplay.trim()) {
			issues.push({ level: "error", path: `${base}.serverDisplay`, message: "a placed server needs a display name" });
		}

		if (!server.description || server.description.length === 0) {
			issues.push({ level: "error", path: `${base}.description`, message: "a placed server needs at least one description line" });
		}

		if (entry.slot < 0 || entry.slot >= SELECTOR_PAGE_SIZE) {
			issues.push({ level: "error", path: `${base}.slot`, message: `slot must be between 0 and ${SELECTOR_PAGE_SIZE - 1}` });
		}

		if (entry.page < 1) {
			issues.push({ level: "error", path: `${base}.page`, message: "page starts at 1" });
		}

		const key = `${entry.page}:${entry.slot}`;
		const rival = takenSlots.get(key);

		if (rival) {
			issues.push({
				level: "error",
				path: `${base}.slot`,
				message: `page ${entry.page} slot ${entry.slot} is already taken by ${rival}`,
			});
		} else {
			takenSlots.set(key, name);
		}

		if (!server.accentColor || !server.accentColor.trim()) {
			issues.push({ level: "warning", path: `${base}.accentColor`, message: "no accent colour set" });
		}

		const materials: Array<[string, string | undefined]> = [
			[`${base}.serverIcon`, server.serverIcon],
			...SELECTOR_STATUSES.map((status): [string, string | undefined] => [
				`${base}.serverStatusIcons.${status}`,
				server.serverStatusIcons?.[status],
			]),
		];

		for (const [path, material] of materials) {
			if (material && !MATERIAL_PATTERN.test(material.trim())) {
				issues.push({ level: "warning", path, message: `"${material}" does not look like a material name` });
			}
		}

		(entry.conditional ?? []).forEach((rule, index) => {
			if (!rule.when || !rule.when.trim()) {
				issues.push({
					level: "warning",
					path: `${base}.conditional.${index}.when`,
					message: "a rule with no condition is dropped by the plugin",
				});
			}

			if (rule.material && !MATERIAL_PATTERN.test(rule.material.trim())) {
				issues.push({
					level: "warning",
					path: `${base}.conditional.${index}.material`,
					message: `"${rule.material}" does not look like a material name`,
				});
			}
		});
	}

	const unknownIsError = draft.global.diagnostics?.unknownPlaceholderAsError === true;

	for (const field of placeholderFields(draft)) {
		for (const match of field.text.matchAll(PLACEHOLDER_PATTERN)) {
			const name = match[1] ?? "";

			if (KNOWN_PLACEHOLDERS.includes(name)) {
				continue;
			}

			issues.push({
				level: unknownIsError ? "error" : "warning",
				path: field.path,
				message: `%${name}% is not a placeholder the plugin resolves`,
			});
		}
	}

	return issues;
}

/** The subset of issues that would abort the proxy's reload. */
export function selectorErrors(issues: SelectorIssue[]): SelectorIssue[] {
	return issues.filter((issue) => issue.level === "error");
}
