# luna-console: Project Instructions

`control/` is the source tree of the control centre for the **Luna Minecraft cluster**, which
lives one level up at `/mnt/shulker/mrds`: one Velocity proxy plus seven Paper backends (`lobby`,
`survival`, `event`, `event2`, `infdun`, `iceboat`, `manhunt`) running in GNU screen sessions
`luna.<name>`, plus external servers (`create`, `sandbox`) routed through the proxy. The **luna
daemon** is the long-lived process that owns the cluster; the `luna` CLI and the web console are
its clients. This machine runs the primary; follower daemons elsewhere manage the instances
assigned to them and mirror state plus plugins from the primary.

**`luna` is the one name** the project, the binary, the daemon, the system user, the config
directory and every release asset share. The historical `mrds`/`MRDS_` prefix survives only in the
cluster root path `/mnt/shulker/mrds`, which is a location, not an identity.

Stack (locked): Bun + TypeScript · single compiled binary (`bun build --compile` → `dist/luna`,
symlinked as `/mnt/shulker/mrds/luna`) · picocolors + @clack/prompts for the terminal · SvelteKit
(Svelte 5 runes) + adapter-node running **under Bun** for the web console (no Elysia, no separate
backend) · **SCSS** (`sass-embedded` through `vitePreprocess`) for every stylesheet · xterm.js for
the terminal drawer · **Monaco** for config editing, reached only through the dynamic import in
`CodeEditor.svelte` and carrying just the languages a server config uses (`$lib/monaco.ts` touches
`self` at module load, so a static import breaks SSR for the whole page) · SSE for all client
streaming (never WebSockets to a browser; daemons talk to each other over WebSocket + HTTP file
streaming) · HTTP over a unix socket between clients and the local daemon · the addon providers
(Modrinth, CurseForge, Hangar, Smithed, behind `core/services/providers.ts`) + PaperMC Fill v3 as
the only external APIs.

## Layout

```
control/                # this repo — the only source tree
  src/core/             # domain logic — no console I/O; executes inside the daemon
  src/daemon/           # daemon runtime: config, RPC ops, jobs, sampler, scheduler,
                        #   hub (primary) + follower link, unix-socket/TCP server
  src/client/           # daemon client: socket discovery, RPC/jobs, and core/ —
                        #   bridge modules mirroring src/core name-for-name
  src/shared/           # bits both sides need (socket paths, progress mirroring)
  src/cli/              # terminal presentation (a daemon client)
  src/lang/<code>/      # language files: cli, core, daemon, web
  web/                  # SvelteKit console ($core alias → src/client/core)
    src/app.scss        #   design tokens + element/utility base
    src/lib/styles/     #   _shared.scss — mixins/variables, auto-injected everywhere
    src/lib/server/     #   server-only helpers (luna.ts bridge, http.ts)
  deploy/               # container topologies: compose files for primary + follower
  .github/workflows/    # ci (typecheck · svelte-check · build) and release (tags)
  Dockerfile            # binary + console + JRE + screen — the published image

/mnt/shulker/mrds/      # cluster root (parent dir) — managed data, not source
  .data/                # every state file; `STATE_FILES` in core/config.ts
    cluster.json        # instance registry — source of truth
    plugins.lock.json   # plugin metadata/versions — source of truth
    packs.lock.json     # resource/data pack state
    environment.json    # env variables: global + per-machine + per-instance
    configfiles.json    # managed config-file templates (instance → path → body)
    schedules.json      # start/stop/restart schedules
    accounts.json       # console accounts + identities + the audit trail
    sessions.json       # open console sessions — primary-local, never mirrored
  plugins/              # jar pool (+ versions/ for per-instance variants)
  logs/<instance>/      # archived, compacted logs (YYYY-MM.log.gz)
  logs/console/         # the console journal (YYYY-MM.ndjson), per machine
  <instance>/           # live server directories (managed, not source)
```

## Coding guidelines (MANDATORY)

### Formatting
- **Indentation: tabs, never spaces.** Exception: YAML files (spec forbids tabs) use 2 spaces.
- **Line endings: CRLF, never LF.** Enforced by `.editorconfig` and `.gitattributes` in this
  directory; configure any formatter (Prettier, Biome, `svelte-check` fixers, editors) to
  `lineEnding: crlf` + `indentStyle: tab` — never let a tool "fix" these to LF/spaces.
  The one exception, pinned in `.gitattributes`: `.github/workflows/*.yml`, the `Dockerfile`
  and `deploy/**` stay **LF**, because a GitHub Actions `run:` block becomes a shell script
  and CRLF there fails as `command not found: bun\r`.
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

### Every front-facing string is a language key
- **The text a human reads lives in `src/lang/<code>/{cli,core,daemon,web}.json`**, never inline.
  `src/shared/i18n.ts` resolves it: `t("cli.ports.check.noIssues")`, `{name}` placeholders filled
  from the params object, English as the fallback, and the key itself returned when it is unknown
  (so a gap shows on screen instead of throwing). `en` and `vi` both ship, and a new string means
  a new entry in **both** — key sets are kept identical, placeholders included.
- **The CLI and the daemon read `LUNA_LANG`** once, at import. The console has no env: components
  import `t` from `$lib/i18n.svelte` (never `$shared/i18n` — the wrapper carries the rune that
  repaints on a switch), the locale is persisted in `localStorage` under `luna:lang`, and the
  picker sits in the status bar. A Svelte `columns`/`filters`/menu array that holds `t()` calls
  must be `$derived([…])`, or its labels keep the locale they were first built with.
- **Schema-like data stores keys, not text.** `SERVER_SETTINGS`/`SETTING_GROUPS` labels and hints,
  `CATALOG_KINDS`, `REFRESH_INTERVALS`, the search providers' `group` — all hold i18n keys, and the
  renderer calls `t(spec.label)`. That is what keeps one schema entry serving the CLI table, the
  launch wizard and the configuration tab in every locale.
- **Not everything is a message.** Protocol text stays literal: the `[luna]` markers `run.sh`
  echoes (`lifecycle.ts` matches them with regexes), config keys, file names, screen session names,
  provider ids. Placeholder glyphs (`pc.dim("—")`, `<span class="dim">–</span>`) are typography, not
  prose.

### Language of the words themselves
- **One standard for every string and every comment** — a button label, a flash message and an
  inline `//` note are all held to it.
- **No em or en dashes in prose.** Use a semicolon, a colon, a comma, parentheses, or two
  sentences. In terminal output the separator convention is ` · `; the `—`/`–` glyph is reserved
  for "no value" cells.
- Say what a thing is, plainly: no "seamlessly", no "powerful", no three-item lists padded to
  sound complete, no sentence that only restates the heading above it.

### Comments
- **Never comment obvious logic** — if reading the code already says what it does, a comment
  is noise. No "increment the counter", no restating the line below.
- **Do comment**: ambiguity, hacks/workarounds, hidden behavior (screen quirks, Modrinth API
  edge cases, surgical config rewriting), and non-obvious constraints (e.g. "downgrade guard —
  plugin versioning").

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
- `core/` is pure domain logic: it never imports from `cli/`, `web/`, `daemon/` or `client/`, never
  prints, and executes **only inside the daemon process**.
- **Clients never touch the cluster directly.** The CLI and the web routes import the bridge
  (`src/client/core/*`, the web's `$core` alias), which runs pure helpers locally and RPCs anything
  touching disk, processes or network to the daemon over the unix socket. Never import `src/core`
  from `cli/` or `web/`: that bypasses the daemon and, on a follower topology, the owner routing.
- **A new feature is a core function first**, then an op entry in `daemon/rpc.ts` (with cfg/lock
  echo + instance-routing metadata), a mirrored export in `src/client/core/<module>.ts`, and only
  then a thin CLI command in `cli/commands/` and a thin API route in `web/src/routes/api/`. Logic is
  never duplicated between the CLI and the console. Reporter-taking core functions run as daemon
  jobs: use `jobCall`, and the caller's ProgressReporter keeps working through the snapshot mirror.
- Ops acting on one instance declare their `instance` argument index in the registry, which is what
  routes them to a follower daemon when the instance lives elsewhere.
- `cli/framework.ts` is the single source of truth for command parsing: the typed registry drives
  argument parsing, help text, `__complete` shell completion and the REPL. A new command is a
  registry entry, never a bespoke `process.argv` branch.

### State
- `cluster.json` and `plugins.lock.json` are the **source of truth**; live instance directories are
  derived. Never hand-edit an instance's files in a code path that should update the registry;
  change state, then re-deploy or sync from it.
- Config files owned by other software (`velocity.toml`, `server.properties`, plugin YAML) are
  edited **surgically and line-preservingly** (`core/confedit.ts`, `proxy.ts` section replacement):
  never regenerated wholesale, never reformatted. Properties values are Java-escaped on disk
  (`level-type=minecraft\:flat`); `confedit` unescapes on read and escapes on write, so nothing
  above that layer sees a backslash.
- The **editable server settings are a schema**, `SERVER_SETTINGS` in `core/settings.ts`: key, type,
  range, choices and default in one place, rendered by the CLI table, the launch wizard and the
  configuration tab alike. A new setting is a schema entry, never a new form field. Values are
  validated against the schema before anything is written, and the keys wiring velocity forwarding
  (`online-mode`, `server-ip`, `enforce-secure-profile`, `prevent-proxy-connections`) are marked
  `managed`: shown, never writable, because editing one silently breaks logins for that backend.
- Custom JVM flags (`javaArgs`) are appended after the profile's flags and land **unquoted** in the
  generated `run.sh`, so they are validated as flags: no shell metacharacters, no restating
  `-Xmx`/`-Xms`, which come from the instance's memory field.
- **A port pool is named, cluster-wide, and its id is the mapping.** `cfg.portPools` is a catalog
  (`PortPool[]`); a machine needing different numbers carries a `PortPoolOverride` inside the pool,
  never a definition of its own, because a pool must exist on every machine or a provision could not
  land there. Consumers ask by id: provisioning takes `game`, a plugin's `PortBindingSpec.pool`
  names its own. `poolConsumers()` derives that list, and it is what forbids renaming a built-in id
  or narrowing a pool past a consumer's protocol. Nothing is "assigned" to an instance or a plugin;
  a pool nobody asks for is inert, and the UI says so.
- **Ports are per machine, and the registry is the ledger.** A port is only taken on the host that
  binds it, so allocation, duplicate detection and usage are machine-scoped: the proxy's 25565 here
  says nothing about a follower's own 25565. Provisioning goes through `acquirePort` (pool + machine
  + a reservation held until the registry catches up, because the jar download outlasts the pick)
  and an explicit port through `checkPort`; deleting an instance *is* the release, because an
  allocation exists only because an instance records it. Never add a second list of who holds what,
  and never compute an instance's address by hand: everything routable comes from
  `instanceAddress()`, which is also what writes `velocity.toml`.
- Plugin versions resolve **per instance**: newest compatible jar is the pool primary, older
  compatible builds are variants in `plugins/versions/<name>@<ver>.jar`, explicit pins win. Updates
  are channel-gated (release/beta/alpha) with a date-based downgrade guard; never let an update move
  an instance backwards or onto a snapshot.
- **A web map is a provider entry, and the rendered files are the map.** `core/maps.ts` is the
  registry (BlueMap, Dynmap): which addon slug ships it, where its config lives per platform, which
  key names its webroot, and which request paths only the running server can answer. Everything above
  it - the proxy route, the card art, the console's HUD - is provider-agnostic, so a third map is a
  registry entry plus a `PORT_PRESETS` entry and nothing else. Two questions are kept apart on
  purpose: `mapAccessFor` says an instance *has* a map (pure, lockfile only, so the public snapshot
  carries it), `mapEndpointFor` says where it answers *live*, and a null origin is a supported setup
  rather than a fault - Dynmap's own arrangement for an external webserver is to write its files down
  and bind nothing. Reading a file tries live first and the rendered webroot second, because the
  plugin's webserver dies with the server and the tiles do not; a `preferFile` path inverts that for
  the one file whose generated version names endpoints that stop existing (Dynmap's
  `standalone/config.js`). A stored player list is emptied on the way out, since a stopped server
  drawing the last people it saw is a lie a visitor cannot see through.
- `luna-*` jars are in-house plugins (`source: "luna"` in the lockfile): excluded from Modrinth
  checks, and their deployment mechanism is still to be provided.
- **Environment values layer one-directionally**: builtin < global < machine < instance
  (`core/environment.ts`). A machine's key is read off the *instance's* `daemon` field
  (`machineKeyOf`, primary = `""`), never off the daemon running the call, so the primary resolves a
  follower's values correctly; `resolveDetailed` reports which scope won and what it shadowed.
  Machine keys are presented as **names** wherever a human sees them (`shared/machines.ts`
  converts), since nobody can type `""`. Every instance's resolved set is written to `.luna-env`
  (mode 0600, regenerated per start) and sourced by `run.sh`, so a variable reaches the JVM with no
  templating and **a restart is the whole apply step**. The layering is pure math over a store
  identical on every machine, so `layerScopes` is separate and the **client bridge composes**
  `resolveDetailed` from the routed `builtinVars` op plus local layering. Do not collapse that back
  into one op; it is what keeps the resolution view working against a follower on an older build.
- **A secret's value never leaves the daemon on a read; revealing it is an action.** Listings mask
  it, `revealAndRecord` returns it and appends to the store's capped `history` trail, which records
  the scope and the time but **never a value**. New env mutations go through
  `setVariable`/`unsetVariable` so they land in that trail automatically. The CLI's `--reveal` reads
  the store directly and is not recorded: a shell that can reach the daemon socket already has it,
  and that is the trust boundary.
- **Environment is shown at three levels, and every table carries a `Source` column.**
  `/environment` is one row per *value* (not per name), so a name with overrides is several rows; a
  machine's Environment tab and an instance's Environment tab each show the **effective set at that
  level**, the wider values inherited plus that level's own departures, with `Source` naming which
  layer won. A table of overrides alone cannot answer "what does this machine or instance actually
  see", which is the question those screens exist for. An inherited row is still actionable
  (override it), but its remove verb is disabled, because the value lives at a wider scope and
  deleting it from a narrower screen would surprise everything else reading it. Only the instance
  level can show builtins, since they are computed per instance. The variable's own screen
  (`/environment/<name>`) is where the layering, `variableUsage` (which files and plugin templates
  reference it, what each instance resolves) and the change trail live.
- **A managed config file is derived from its template, never the reverse.** `configfiles.json`
  holds the template; `startInstance` renders it into the instance before spawning. Creating a
  placeholder must leave the file on disk byte-identical: `createPlaceholder` refuses a name already
  holding a different value at that scope, and refuses when a narrower scope would make the render
  rewrite the file unless the caller forces it, and nothing is written until every check passes. A
  file the server rewrote itself is **drift**: the template still wins, but the drifted text is kept
  as `<file>.luna-drift` and reported, so a regenerated config is never lost, and `readoptFile`
  pulls it back in keeping the placeholders whose values still match. Client paths always go through
  `resolveInstancePath` (no escaping the instance dir), browsing never recurses, and editing is
  capped at 512 KB and refuses binaries.
- **State files are primary-owned.** A follower writing `cluster.json`, `plugins.lock.json`,
  `environment.json` or `configfiles.json` forwards the save up the cluster link (`notifySave` → the
  follower's hook → the hub persists → the root watcher syncs it back). A new cluster-root state file
  means adding it to `SaveFile`, calling `notifySave` from its saver, and listing it in
  `SYNC_FILES`; otherwise a follower's write is silently clobbered by the next sync frame.
- **State lives in `<root>/.data/`, and only `core/config.ts` knows that.** Every state file resolves
  through `statePath()`, so a new one is a `STATE_FILES` entry and nothing else; never `join(root(),
  "x.json")`. A cluster root *is* a directory holding `.data/cluster.json`, which is what root
  discovery looks for; `ensureDataDir()` runs at daemon boot because the hub's sync watcher opens that
  directory and `watch` throws on a missing one. **The cluster link carries logical names, not
  paths**: `syncFilePath()` resolves each name on the machine that has it, so where a file lives is
  never on the wire.

### Console accounts
- **The console is gated; the CLI is not.** Every web route goes through
  `web/src/hooks.server.ts`, which resolves the session cookie once and hangs the account on
  `event.locals`: a page without one redirects to `/login`, an API route answers 401 JSON. The CLI
  never signs in, because a shell that can open the daemon socket can already do everything the
  daemon can, so the socket's file permissions *are* the check. It acts as the reserved identity
  `root` (`ROOT_ACTOR`), which is why no account may be created under that name; `LUNA_ACTOR`
  overrides it, and the console's terminal drawer sets it so commands typed there are attributed to
  the operator rather than to `root`. The prompt is `<actor>@luna` in both the REPL and the drawer.
- **An account is an identity; its credentials are separate objects.** `ConsoleIdentity` covers a
  console password, an access key for scripts and a linked Minecraft profile, each retired on its
  own: a leaked access key must be killable without locking its owner out. A password is
  argon2id-hashed; an access key's secret and a session's token are 256-bit random, so SHA-256 is
  all their lookups need, compared with a constant-time digest match. Nothing in `src/client/core/
  accounts.ts` can return a hash — there is deliberately **no bridge for the raw store**, so a route
  cannot leak one by forgetting to mask it, and the whole verify → open-session → record cycle runs
  inside the daemon.
- **Two stores, and only one of them is cluster state.** `accounts.json` is primary-owned and
  mirrored like every other state file (`SaveFile` + `notifySave` + `SYNC_FILES`). `sessions.json` is
  the primary's own runtime state and is **not** mirrored: the console only runs beside the primary,
  so a follower could not validate a token it was given, and copying live credentials to machines
  that cannot use them buys nothing. A session's `lastSeenAt` is only persisted once it is
  `SESSION_TOUCH_MS` stale, or every page load would rewrite the file and wake the sync watcher.
- **Every refusal reads the same and every refusal is recorded.** A disabled account, a wrong
  password and a username that does not exist all answer with one message, because telling them
  apart is how an account list gets enumerated; a miss also burns an argon2 verification, since
  returning in microseconds is the same leak by another route. Failures count toward a lockout
  (`MAX_SIGNIN_FAILURES` → `LOCKOUT_MS`). The audit trail records the scope and the actor and
  **never a value**, exactly as the environment trail does.
- **Authorization is not in this phase.** Every console account can reach everything, and the
  screens say so rather than implying a permission model that does not exist. Do not add per-account
  checks piecemeal; RBAC/ABAC is its own phase.
- **A new kind of console log goes in the journal, not a second log.** `core/journal.ts` is the
  append-only NDJSON record of what luna itself did (daemon lines, console routes, CLI, sign-ins),
  monthly files under `logs/console/`, **per machine** — a follower's journal stays on the follower.
  It is a third thing on purpose: `core/logs.ts` reads an *instance's* log, and `daemon/events.ts` is
  the in-memory cluster event feed that dies with the daemon.

### Daemon health
- **Every daemon samples its own machine** (`daemon/health.ts`, 5 s, one hour kept): CPU, memory,
  cluster-root disk, load, host uptime, IP addresses and each owned instance's resident memory. A
  follower's samples reach the primary on the heartbeat **pong**, never by a separate poll: the
  primary's `ping` carries a sequence number and its clock, so the same round trip measures link
  latency, and three unanswered pings close the link. New health facts belong in `HealthSample`, so
  the CLI, the fleet stream and the detail view all get them at once.
- **Reachability is judged from the primary**, by TCP-probing a follower's advertised host on each
  running instance's port; a healthy WebSocket link says nothing about whether velocity can reach
  the backends. Follower-owned instances are therefore created with `server-ip=0.0.0.0`, and only
  the primary's own backends bind loopback.
- Daemon events go into the shared cluster log under the pseudo-instance `daemon:<name>`
  (`daemonEventKey`), never a second log.
- **Build version ≠ protocol version.** The build version (generated `src/version.ts`: package
  version + git SHA + build time) is what an upgrade changes; the protocol version is what refuses a
  mismatched link. Report both wherever a daemon is described. The primary serves the binary it is
  itself running (`process.execPath`) at `/files/binary`, and a follower self-upgrades by verified
  download → atomic rename over its own path → exit, so systemd restarts it; never mid-job, never
  for the primary. `/info` and `/files/binary*` are gated on the token only, never on the protocol
  check, because a follower rejected for protocol skew is exactly the one needing a new binary.
  Self-upgrade refuses outright from a source run: `process.execPath` is the bun interpreter there,
  and overwriting it would take the toolchain with it (`isCompiledBinary()`).
- **A protocol mismatch quarantines a link; it never closes one.** The hub keeps the socket, marks
  the follower (`FollowerLink.quarantine`), and still pings and reach-probes it, so the fleet view
  reports a live machine that has been refused rather than an absent one; the row carries `state`
  (`online`/`quarantined`/`offline`) and `online` means *usable*, which is why provisioning and
  removal ask `state`, not `online`. Only `QUARANTINE_OPS` are still forwarded — `daemon.selfUpgrade`
  and `daemon.checkUpgrade`, the two frames both builds still agree on and the two that end the
  quarantine — and state sync is withheld, because the build that would receive it reads those files
  differently. Closing the socket instead is the trap: it strands the follower from the one machine
  able to fix it, and leaves "offline" as the only thing anybody can be told.
- **Nothing automatic is ever forced.** `selfUpgrade(force)` takes the preferred channel's build even
  when that is the build already running, which is a reinstall; as an unattended action that is a
  loop (install, exit, restart, find it again — the 8 Aug incident, once every eleven seconds for a
  week). The `autoUpgrade` policy, the follower's mismatch recovery and the hub's rescue push are all
  unforced, so a machine with nothing newer to install stays put and stays visibly quarantined, which
  is a state an operator can act on. Forcing stays reserved for somebody typing the command. Both
  ends also rate-limit (a cooldown on the follower, one push per follower per cooldown on the hub),
  and `selfUpgrade` joins an in-flight upgrade rather than starting a second swap of the same file.
- **One binary, and it lives in the cluster root.** `luna setup` installs exactly
  `<root>/.bin/luna`, owned by the service account, and puts that directory on PATH
  (`/etc/profile.d/luna.sh` for login shells, a marked block in the invoking user's
  `.bashrc`/`.zshrc` for interactive ones). Nothing is installed under `/usr`, and a copy left there
  by an older install is removed. The reason is upgrades: a swap stages `luna.new` beside the target
  and renames it, so it needs the **directory** writable, which `/usr/local/bin` is not. Never point
  `ExecStart` anywhere else, and never reintroduce a second copy: two drift the moment one
  self-upgrades. Consequence: `sudo` uses its own `secure_path`, so privileged runs need the
  absolute path (`sudo <root>/.bin/luna setup`). The container image is the exception, keeping the
  binary at `/usr/local/bin/luna` and running as root, because images are replaced, not upgraded.

### Operations
- Destructive or cluster-wide actions (stop, delete, set-version, cleanup) must be idempotent,
  report exactly what they touched, and confirm before acting unless the user passed an explicit
  `--yes`-style flag. `set-version` gates on plugin MC-version compatibility and rolls back on
  failure.
- Stopping is graceful: `.luna-norestart` sentinel → console `stop`/`end` → escalation. The
  generated per-instance `run.sh` has a crash-loop guard; keep it that way.

### Long-running tasks report live progress
Anything that can outlast a keypress or an HTTP request (downloading a server jar, deploying
plugins, building luna modules, a cluster-wide sweep) **reports its progress as it goes**, to both
the CLI and the console. A spinner that says nothing for forty seconds is not acceptable.

The mechanism is `core/progress.ts`'s **`ProgressReporter` tree**, ported from the vloom framework's
`Vloom\ProgressReporter` and keeping its semantics:
- The root node is the whole operation; `child(name, weight)` creates a node per step. Weight each
  child by how long it really takes (the jar download is worth ~6× writing the config files), or
  call `expect(n)` when the children appear as the work runs.
- A node reports its own `[0, 1]` progress with `report/info/okay/warn/error/complete`, or wraps a
  step in `task({ start, done, failed }, fn)`. A parent's roll-up is its own progress worth
  `progressWeight` (default 0.1) plus the weighted average of its children; a node that only
  delegates calls `weighOwn(0)`. Roll-ups are monotonic: progress never rewinds.
- Every report bubbles to the root, so **one listener at the root sees the whole tree**.
  `snapshot()` returns the tree as plain data for a client or a log.

Wiring rules:
- **Core functions take an optional `reporter`** and substitute a detached one when the caller does
  not pass it (`const progress = opts.reporter ?? new ProgressReporter(name)`), so the reporting
  calls need no branches and `core/` still never prints.
- **The CLI** renders with `ProgressView` from `cli/ui.ts`: one line per node, redrawn in place,
  with a per-report fallback line when stdout is not a TTY. Never hand-roll ANSI in a command.
- **The console** does not block a request on the work: the route calls `startJob()`
  (`web/src/lib/server/jobs.ts`), answers with the job, and the page follows
  `/api/jobs/<id>?stream=1` with `followJob()` and renders `ProgressTree.svelte`. Progress frames
  are throttled server-side, since a chunked download reports hundreds of times.
- A failure is part of the report: the failing node's message is what tells the user *where* it
  broke, so report it before letting the error propagate.

### Web console
- **The existing console is the design reference**: match the dark token set and the metrics already
  in `web/src/app.scss` and the component library rather than introducing a new visual language.
  Where a value looks off-scale it is usually deliberate; check the comment before fixing it.
  Implementation patterns come from the user's vloom dashboard (cloned at `~/dashboard`).
- **Everything goes through the component library** in `web/src/lib/components/`: no hand-rolled
  buttons, tables, grids or panels inside pages. Extend the component when a page needs something
  new.
- **Tables on a main screen go through `ResourceTable`**, the wrapper bundling search, optional
  filter groups, pagination, the preferences dialog and a per-row context menu, with `tableId`
  mandatory so preferences persist. Row verbs are declared once as `rowActions(row)` and feed both
  the row's context menu and the screen's **Actions** dropdown, which lives in the `PageHeader`,
  never in the table's toolbar. The table bar is search + filters on the left, range/paging/
  preferences on the right. A page never wires `DataTable`, `SearchInput`, `PagingBar` and
  `ContextMenu` together by hand, and never re-implements search or paging.
- **A table never has an action column.** No trailing column of buttons, no icon-button column,
  whatever the table: row verbs live in the **row's context menu** (`rowActions(row)`, right-click
  or the ⋯ affordance), and the bulk form of the same verb lives in the screen's Actions dropdown. A
  button per row multiplies the same control by the row count, competes with the row's own data for
  width, shifts every other column when its label changes, and puts a destructive click one
  mis-scroll away. `DataTable` takes `rowActions`/`rowLabel` too, so a table on a *detail* screen
  gets the same menu without `ResourceTable`. A control that edits a value **in place** (a per-row
  toggle, an inline field) is not an action column and belongs in that value's own column.
- **A checkbox column promises multi-select, so default to `selectable="multi"`.** A square tickbox
  per row tells the user they may tick several; a screen that then honours one is broken, not
  minimal. Reach for `selectable="single"` only when the verbs genuinely take one target (picking a
  version, editing one variable), and `DataTable` then draws a **radio** so the affordance tells the
  truth. A multi-select screen's Actions dropdown must stay alive as the selection grows: declare
  the verbs once as `xActions(rows)` over the *selection*, have `rowActions(row)` forward the whole
  selection when the right-clicked row is inside it, disable a single-target verb **with its reason**
  ("pick a single pack") rather than killing the menu, and let a bulk verb target only the rows it
  applies to; enabling five packs of which two are already on is a three-pack job, reported as one
  outcome after a single reload (`web/src/routes/packs/+page.svelte`).
- **Dimming is not disabling.** `rowDim` de-emphasises a row (disabled, withheld, not deployed) and
  nothing more: it keeps its checkbox, its hover and its verbs, because the verb that un-dims it
  (enable, deploy, serve here) is usually the one the user opened the screen for, and locking that
  row out of the selection is what pushes an author back toward a per-row button. `rowLocked` is the
  separate, rare opt-out for rows **no** verb can apply to (an external server luna does not own);
  it dims *and* withholds the checkbox.
- **Every screen has a real action bar** in its `PageHeader`, modelled on the instances screen, in
  this order: `RefreshControl`, Actions dropdown for the selection, screen-wide operations, then the
  creating action last as `primary`. Actions apply to the table selection, an unavailable action is
  **disabled with the reason** rather than hidden, destructive ones confirm, and a bulk action
  reports per-target outcomes.
- **Global search indexes every object.** The index is a provider registry, so a new kind of object
  means a new provider, never a branch inside `GlobalSearch.svelte`
  (`web/src/lib/search/providers.ts`). Objects with no detail route link to `?q=<term>`, which
  `ResourceTable`'s `initialSearch` picks up. Keyboard contract: `Alt+S` focuses, `↑`/`↓` move the
  highlighted hit (scrolled into view), `Enter` opens it, `Escape` closes and restores focus.
  Ranking comes from `$lib/search/match`, which the tables share; never write a second matcher.
- Font is **Albula Pro**; icons are **Font Awesome v7** through the `<icon data-icon="name">`
  integration (both in `web/static/`, loaded from `app.html`). Never use unicode-glyph icons or an
  external icon package.
- **Icon styles**: four weights of the same glyph, `thin` (100), `light` (300), `regular` (400, the
  default) and `solid` (900), selected with the `style` prop on `Icon.svelte`, which maps to
  `icon.style-*` classes, i.e. plain `font-weight`. Use them to encode state rather than swapping
  icons: outline (`light`/`regular`) for idle, `solid` for active (e.g. the table's sort caret).
  Navigation and toolbar affordances use `solid`. Check a name exists first; the integration's own
  naming applies (`arrowUp/arrowDown/arrowLeft/arrowRight` are the *chevrons*, `up/down/left/right`
  are long arrows, `caretDown` is the filled dropdown caret).
- **Underlines carry meaning**: anything that navigates (links, breadcrumbs, resource names in
  tables) gets a solid underline; text that merely *reveals* more about itself (a status value, a
  timestamp with a popover) gets the `.info-trigger` dashed underline in body colour, never link
  blue. Chrome links (brand, side nav, tabs, buttons rendered as `<a>`) opt out in their own
  component.
- **A screen whose content *is* a viewport** (an editor, a scroller, a log) sizes itself against
  `100vh` minus the measured chrome and minus `var(--split-bottom)`, the terminal drawer's own
  height, so opening the drawer shortens the screen instead of covering it, with a `min-height`
  floor. `Panel` takes `fill` for this: the panel becomes a flex column taking the height its parent
  gives it (`height: 100%` in a grid cell, `flex: 1` beside siblings in a flex column) and its body
  flexes, so one child can own the remaining space. Never hand-roll a panel to get this, and measure
  the chrome offset in the browser rather than guessing: the page header's own `.split` is a
  different element from a page's, and reading the wrong one is how a layout ends up 66px too tall.
- **The sign-in screen is the one page without chrome.** `/login` renders bare (the root layout
  branches on it), because the side nav, the global search, the terminal drawer and the host vitals
  all need a session to have anything to say. Its layout follows the AWS console's sign-in page -
  centred mark, narrow credentials card, banner panel beside it; the banner is the plate from
  `docs/console.svg` through `LunaBanner.svelte`, and a washed copy of it is the page background. A
  console with no accounts offers the first-run form instead of a sign-in, and core refuses that path
  the moment one account exists.
- Streaming (instance console, terminal drawer, events) is **SSE only**. The terminal drawer runs
  the real compiled CLI and gets its Tab-completion and ghost text from the CLI's own `__complete`
  engine; completion logic is never reimplemented in the browser.
- Vite must run under Bun (`bunx --bun vite …`), because API routes use `Bun.spawn`/`Bun.file`. Use
  `--strictPort` so a stale server on 8330 cannot silently shadow a new one.

## Commands

```
sudo luna setup                   # install this machine: user, root, config, unit, start
luna setup --dry-run              # every change it would make, making none
luna daemon run                   # the daemon itself — everything else needs it running
luna daemon status|list|remove    # local handshake · cluster fleet · drop a registration
luna daemon show <name>           # one daemon: health, checks, per-instance memory
luna daemon upgrade [name]        # apply an upgrade: the primary's binary, else the release
luna daemon upgrade --check       # what each channel offers, applying nothing
luna daemon token                 # generate the shared cluster token
luna daemon service install       # just the unit file, for an already-configured host
luna env [--instance x|--machine y]   # variables; with --instance, what it resolves and why
luna env set NAME value [--machine m|--instance i] [--secret]
luna env inject <instance>            # rewrite its .luna-env (applies on next start)
luna env apply <instance>             # re-run plugin config templates + render managed files
luna configs [--instance x]           # managed config files: placeholders + drift state
luna configs ls|show <instance> …     # browse one level · print template or rendered file
luna configs manage|unmanage <instance> <file>
luna configs placeholder <instance> <file> NAME value [--all] [--machine m] [--secret]
luna configs render|readopt <instance> [file]
luna maps [instance]                  # web maps: provider, address, whether it survives a stop
luna accounts                     # console accounts: who may sign in to the web console
luna account show <name>          # one account: fields, identities, lockout state
luna account add <name> [--password x] [--no-password] [--must-change] [--disabled]
luna account password <name> [--reset]    # set it; --reset asks the owner for a new one
luna account enable|disable|unlock|remove <name>
luna account key <name> [label]           # mint an access key (secret shown once)
luna account link|unlink <name> …         # a Minecraft profile, or an identity id
luna sessions [--account x]               # open console sessions
luna sessions revoke <id>|--account x     # close one, or all of an account's
luna audit [--account x] [--limit n]      # the account audit trail, newest first
luna logs [--source s] [--level l] [--search x]   # this machine's console journal
luna version                      # build identity of the binary and of the daemon
bun run src/cli/index.ts <cmd…>   # run the CLI from source (this dir)
bun run build                     # compile the single binary → dist/luna
bun run typecheck                 # tsc --noEmit (web/ is excluded)
cd web && bun run build           # production console bundle
cd web && bun run check           # svelte-check
luna web [--dev] [--host 0.0.0.0] # serve the console (default 127.0.0.1:8330; primary only)
cd web && bun run dev             # same thing directly: Vite + HMR on 8330
docker build -t luna .            # the published image (binary + console + JRE + screen)
```

Daemon config: JSON file (`$LUNA_DAEMON_CONFIG` → `/etc/luna/daemon.json` →
`~/.config/luna/daemon.json`) with env overrides (`LUNA_MODE`, `LUNA_ROOT`, `LUNA_DAEMON_NAME`,
`LUNA_SOCKET`, `LUNA_LISTEN`, `LUNA_TOKEN`, `LUNA_PRIMARY_ADDRESS`, `LUNA_HOST`,
`LUNA_AUTO_UPGRADE` (or `autoUpgrade` in the file: `off` · `followers`, the default · `all`), plus
`LUNA_WEB_DIR` for a console outside the source tree, `LUNA_CURSEFORGE_KEY` (or `curseforgeApiKey`
in the file) to unlock the CurseForge provider, and
`LUNA_RELEASE_REPO`/`LUNA_GITHUB_API`/`LUNA_GITHUB_TOKEN` for the upgrade fallback). A daemon's name
defaults to the machine's hostname (short form, lowercased); it keys `cluster.json` and decides
instance ownership, so it must be unique across the cluster. No config plus a discoverable cluster
root = primary with defaults. For dev, start one with
`LUNA_ROOT=/mnt/shulker/mrds bun run src/cli/index.ts daemon run` before using the CLI or console; a
second daemon on the same host isolates itself with `LUNA_SOCKET` (that is how the follower
simulation runs on loopback).

Iterate on the console with `--dev`: Vite hot-reloads Svelte and CSS edits and restarts API routes
in place, so there is no rebuild/restart cycle. Only run `cd web && bun run build` when producing
the deployable bundle.

Server LAN address is `10.0.0.10`; the console is reachable at `http://10.0.0.10:8330` when bound
to `0.0.0.0`.

`LUNA_LANG=vi` switches the CLI and the daemon to Vietnamese (`en` is the default and the fallback
for any key a locale has not translated). The console picks its own locale in the status bar and
remembers it per browser, so the two are independent.
