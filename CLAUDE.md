# mrds — Project Instructions

This directory (`control/`) is the source tree of the centralized control center for the
**Luna Minecraft cluster**, which lives one level up at `/mnt/shulker/mrds`: one Velocity
proxy + seven Paper backends (`lobby`, `survival`, `event`, `event2`, `infdun`, `iceboat`,
`manhunt`) running in GNU screen sessions `luna.<name>`, plus external servers (`create`,
`sandbox`) routed through the proxy. Everything is driven by the `mrds` CLI and its
web console.

Authoritative docs — read before making architectural decisions:
- `docs/DESIGN.md` — infra assessment + full design (plugin model with per-instance version
  resolution, server-version requirements, port-managed plugins, CLI UX, migration plan)
- `docs/PROGRESS.md` — what is built so far, decisions made along the way, what's left

Stack (locked): Bun + TypeScript · single compiled binary (`bun build --compile` →
`dist/mrds`, symlinked as `/mnt/shulker/mrds/mrds`) · picocolors + @clack/prompts
for the terminal · SvelteKit (Svelte 5 runes) + adapter-node running **under Bun** for the
web console (no Elysia, no separate backend) · **SCSS** (`sass-embedded` through
`vitePreprocess`) for every stylesheet · xterm.js for the terminal drawer · SSE for all
streaming (never WebSockets) · Modrinth + PaperMC Fill v3 as the only external APIs.

## Layout

```
control/                # this repo — the only source tree
  src/core/             # domain logic — no console I/O
  src/cli/              # terminal presentation
  web/                  # SvelteKit console (routes/api/** imports core via $core)
    src/app.scss        #   design tokens + element/utility base
    src/lib/styles/     #   _shared.scss — mixins/variables, auto-injected everywhere
    src/lib/server/     #   server-only helpers (mrds.ts bridge, http.ts)
  docs/                 # progress notes and working documents

/mnt/shulker/mrds/      # cluster root (parent dir) — managed data, not source
  cluster.json          # instance registry — source of truth
  plugins.lock.json     # plugin metadata/versions — source of truth
  plugins/              # jar pool (+ versions/ for per-instance variants)
  logs/<instance>/      # archived, compacted logs (YYYY-MM.log.gz)
  <instance>/           # live server directories (managed, not source)
```

## Coding guidelines (MANDATORY)

### Formatting
- **Indentation: tabs, never spaces.** Exception: YAML files (spec forbids tabs) use 2 spaces.
- **Line endings: CRLF, never LF.** Enforced by `.editorconfig` and `.gitattributes` in this
  directory; configure any formatter (Prettier, Biome, `svelte-check` fixers, editors) to
  `lineEnding: crlf` + `indentStyle: tab` — never let a tool "fix" these to LF/spaces.
- **CSS lengths: rem/em only, never px, and stay on the scale.** Quarter-rem steps for 1rem
  and up (1, 1.25, 1.5, 1.75, 2, 2.25, …); below 1rem, eighth-steps are also allowed (0.125,
  0.25, 0.375, 0.5, 0.625, 0.75, 0.875), plus 0.1rem for hairline borders. Never invent
  off-scale values like 0.9rem, 0.6rem, 1.6rem, 2.2rem. The one exception is a value the
  browser hands us in device pixels (`getBoundingClientRect`, `offsetWidth`, xterm metrics):
  keep those in px in TypeScript and convert on the way into a style.

### Styles are SCSS
- **Every stylesheet and every `<style>` block is SCSS** — `web/src/app.scss` plus
  `<style lang="scss">` in every component. There is no plain `.css` in `web/src/`
  (`web/static/**` keeps the vendored FontAwesome/Albula CSS as shipped).
- **One rule per line, nested, breathing.** Declarations are never packed onto the
  selector's line; states and children nest with `&` (`&:hover`, `&.active`, `&::after`)
  instead of repeating the parent selector; a blank line separates rules.
  **Preserve the cascade when nesting** — two rules of equal specificity still resolve by
  source order, so don't reorder `:disabled` past a variant class while "tidying".
- **Comments are `//`**, so they never reach the output. Keep the ones that explain a
  metric, a hack or a deliberate design decision; drop the ones that restate the property.
- **Design tokens stay CSS custom properties** in `app.scss` — they are read at runtime
  (theming, `--split-*` chrome offsets, per-instance colours) and must not be flattened
  into build-time Sass variables.
- **Shared partial**: `web/src/lib/styles/_shared.scss` holds the breakpoint variables
  (`$bp-narrow/$bp-medium/$bp-wide`) and the `below`, `ellipsis`, `focus-ring`, `fill` and
  `bare-button` mixins. `css.preprocessorOptions.scss.additionalData` in `vite.config.ts`
  injects it into every SCSS block, so **never add an `@use` line in a component**. The
  partial must stay output-free (variables/mixins/functions only), or every component
  would ship a copy of its CSS.
- Media queries go through `@include below($bp-medium) { … }` rather than hand-written
  `@media (max-width: …)`.

### Code shape
- **Never a one-line `if`.** Every `if`/`else`/`for`/`while` body gets braces and its own
  lines — no `if (x) return;`, no brace-less single statement, no `else if (…) doThing();`.
  Guard clauses are welcome, but they are still three lines.
- **Let the code breathe.** Separate logical blocks with a blank line: after a guard-clause
  group, between "gather inputs" / "compute" / "return", around loops and `try` blocks,
  and between the members of a class or object literal that are more than one line each.
  A function whose body is a solid wall of statements is wrong even when it is short.
- **Never crowd code.** One statement per line, no comma-chained declarations, no packing
  several concerns into a single expression just to save a line. Prefer a named intermediate
  over a nested call soup; vertical space is free, re-reading is not.
- **Multi-line ternaries.** Any ternary that does not comfortably fit one short line is
  written with `?` and `:` each starting their own indented line. Nested ternaries follow the
  same shape, one level of indent per branch — never fold them back onto one line.

```ts
// Wrong — one-line if, crowded, folded ternary
if (!inst) return null;
const a = inst.paused ? "paused" : inst.running ? "running" : "stopped";

// Right
if (!inst) {
	return null;
}

const state = inst.paused
	? "paused"
	: inst.running
		? "running"
		: "stopped";

return state;
```

### Naming
- **Local variables** (function-scoped, parameters, private/module-internal): `camelCase`.
- **Public constants** (exported primitive/frozen values): `ALL_UPPERCASE_WITH_UNDERSCORE`.
- **Public/exported variables, objects, classes**: `PascalCase`.

```ts
// Local → camelCase
function applyUpdate(instanceName: string) {
	const jarCount = 0;
	let currentState = "stopped";
}

// Public constants → ALL_UPPERCASE_WITH_UNDERSCORE
export const PORT_PRESETS = { "simple-voice-chat:paper": [/* … */] };
export const STOP_TIMEOUT_MS = 60_000;

// Public / exported objects, classes, interfaces → PascalCase
export const Sym = { ok: "●", bad: "●" };
export class Spinner {}
export interface InstanceConfig {}
```

- Functions: `camelCase` (default convention; not covered by the rule above).
- These rules apply to all TypeScript/JavaScript/Svelte code in this repo. When generating or
  editing code, match them exactly — do not fall back to ecosystem defaults (camelCase
  exports, LF, spaces).

### Output & logging
- **`core/` never prints.** No `console.*` anywhere under `src/core/` — domain
  functions return result objects and let the caller render them. The single existing
  exception is the fatal "cluster.json not found" bail in `config.ts`.
- **All terminal output goes through `cli/ui.ts`**: `info/ok/warn/fail`, `table/printTable`,
  `Spinner`, `Sym`, and `pc` (picocolors) — never hand-rolled `console.log` with raw ANSI in
  command files.
- Web server code (`web/src/routes/api/**`, `web/src/lib/server/`) returns JSON/SSE; use
  `console.error` only for genuinely unexpected server-side failures.
- The browser client uses plain `console` for debugging only — no logging framework.

### Comments
- **Never comment obvious logic** — if reading the code already says what it does, a comment
  is noise. No "increment the counter", no restating the line below.
- **Do comment**: ambiguity, hacks/workarounds, hidden behavior (screen quirks, Modrinth API
  edge cases, surgical config rewriting), non-obvious constraints, and cross-references to
  the design doc (e.g. "downgrade guard per DESIGN.md — plugin versioning").

### Types & documentation
- **Full type hints everywhere** — explicit parameter and return types on all functions; no
  implicit `any`, no relying on inference for public surfaces. `strict` +
  `noUncheckedIndexedAccess` are on; keep them satisfied rather than casting them away.
- **Every public (exported) function has a JSDoc block** explaining what it does, its
  parameters when non-obvious, and its return value.
- Shared shapes live in `core/types.ts`; Svelte components export their types from sibling
  `.ts` modules (`table.ts`, `menu.ts`, `grid.ts`) — type exports from a component's
  `<script>` block do not resolve.

## Non-negotiable design invariants

### Layering
- `core/` is pure domain logic: it never imports from `cli/` or `web/`, and never prints.
- **A new feature is a core function first**, then a thin CLI command in `cli/commands/` and
  a thin API route in `web/src/routes/api/`. Logic is never duplicated between the CLI and
  the console — the web routes import the same functions via the `$core` alias.
- `cli/framework.ts` is the single source of truth for command parsing: the typed registry
  drives argument parsing, help text, `__complete` shell completion, and the REPL. Adding a
  command means adding a registry entry, never a bespoke `process.argv` branch.

### State
- `cluster.json` and `plugins.lock.json` are the **source of truth**; the live instance
  directories are derived. Never edit an instance's files by hand in code paths that should
  update the registry — change state, then re-deploy/sync from it.
- Config files owned by other software (`velocity.toml`, `server.properties`, plugin YAML)
  are edited **surgically and line-preservingly** (`core/confedit.ts`, `proxy.ts` section
  replacement) — never regenerated wholesale, never reformatted.
- Plugin versions resolve **per instance**: newest compatible jar is the pool primary, older
  compatible builds are variants in `plugins/versions/<name>@<ver>.jar`, and explicit pins
  win. Updates are channel-gated (release/beta/alpha) with a date-based downgrade guard —
  never let an "update" move an instance backwards or onto a snapshot.
- `luna-*` jars are in-house plugins (`source: "luna"` in the lockfile): excluded from
  Modrinth checks; their deployment mechanism is still to be provided.

### Operations
- Destructive or cluster-wide actions (stop, delete, set-version, cleanup) must be
  idempotent, report exactly what they touched, and confirm before acting unless the user
  passed an explicit `--yes`-style flag. `set-version` gates on plugin MC-version
  compatibility and rolls back on failure.
- Stopping is graceful: `.mrds-norestart` sentinel → console `stop`/`end` → escalation. The
  generated per-instance `run.sh` has a crash-loop guard; keep it that way.

### Web console
- **The existing console is the design reference**: match the dark token set and the metrics
  already in `web/src/app.scss` and the component library rather than introducing a new visual
  language. Where a value looks off-scale it is usually deliberate — check the comment before
  "fixing" it. Implementation patterns come from the user's vloom dashboard (cloned at
  `~/dashboard`).
- **Everything goes through the component library** in `web/src/lib/components/` — no
  hand-rolled buttons, tables, grids or panels inside pages. Extend the component when a page
  needs something new.
- Font is **Albula Pro**; icons are **Font Awesome v7** through the `<icon data-icon="name">`
  integration (both in `web/static/`, loaded from `app.html`). Never use unicode-glyph icons
  or an external icon package.
- **Icon styles**: the integration ships four weights of the same glyph — `thin` (100),
  `light` (300), `regular` (400, the default) and `solid` (900) — selected with the `style`
  prop on `Icon.svelte`, which maps to `icon.style-*` classes, i.e. plain `font-weight`.
  Use them to encode state rather than swapping icons: outline (`light`/`regular`) for the
  idle state, `solid` for the active one (e.g. the table's sort caret). Navigation and
  toolbar affordances use `solid`. Check a name exists before using it — the integration's
  own naming applies (`arrowUp/arrowDown/arrowLeft/arrowRight` are the *chevrons*;
  `up/down/left/right` are long arrows; `caretDown` is the filled dropdown caret).
- **Underlines carry meaning**: anything that navigates (links, breadcrumbs, resource names
  in tables) gets a solid underline; text that merely *reveals* more about itself — a status
  value, a timestamp with a popover — gets the `.info-trigger` dashed underline in body
  colour, never link blue. Chrome links (brand, side nav, tabs, buttons rendered as `<a>`)
  opt out of the underline in their own component.
- Streaming (instance console, terminal drawer, events) is **SSE only**. The terminal drawer
  runs the real compiled CLI and gets its Tab-completion and ghost text from the CLI's own
  `__complete` engine — completion logic is never reimplemented in the browser.
- Vite must run under Bun (`bunx --bun vite …`): API routes use `Bun.spawn`/`Bun.file`.
  Use `--strictPort` so a stale server on 8330 can't silently shadow a new one.

## Commands

```
bun run src/cli/index.ts <cmd…>   # run the CLI from source (this dir)
bun run build                     # compile the single binary → dist/mrds
bun run typecheck                 # tsc --noEmit (web/ is excluded)
cd web && bun run build           # production console bundle
cd web && bun run check           # svelte-check
mrds web [--dev] [--host 0.0.0.0] # serve the console (default 127.0.0.1:8330)
cd web && bun run dev             # same thing directly: Vite + HMR on 8330
```

Iterate on the console with `--dev`: Vite hot-reloads Svelte and CSS edits and restarts
API routes in place, so there is no rebuild/restart cycle. `--strictPort` is always passed
so a stale server on 8330 can never silently shadow the new one. Only run
`cd web && bun run build` when producing the deployable bundle.

Server LAN address is `10.0.0.10`; the console is reachable at
`http://10.0.0.10:8330` when bound to `0.0.0.0`.
