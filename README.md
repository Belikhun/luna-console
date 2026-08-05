<p align="center">
	<img src="docs/console.svg" alt="luna cluster console">
</p>

# Luna Console ` >_ `

The control centre for Luna Network: every Minecraft server across every machine in the cluster, with its plugins, config, ports and players, managed from a centralized web console or a terminal.

## ✨ Features

<img src="docs/instances.webp" alt="Instances screen" align="right" width="54%">

### 🎛️ The whole network on one screen

State, health, tick rate, memory and player count for every backend and the proxy, live. No SSH, no screen attaches.

Verbs apply to the selection, so restarting nine servers is one action. A verb that cannot run on what you picked is disabled with the reason.

<br clear="all">

Per instance: the command it launched with, the JVM flags it inherited, the address the proxy routes to, and the process behind it.

<img src="docs/instance-detail.webp" alt="Instance detail screen" width="100%">

<br clear="all">

<img src="docs/launch.webp" alt="Launch wizard" align="left" width="42%">

### 🚀 A new server in one form

Name, version, heap, machine. luna downloads the Paper build, allocates a port, writes the forwarding secret, registers the server with Velocity and deploys every plugin that targets it.

Each step reports as it runs, and a failure names the step that broke instead of leaving you to find what got half done.

<br clear="all">

<img src="docs/monitoring.webp" alt="Instance monitoring" align="right" width="60%">

### 📈 Lag you can see before players report it

CPU, memory, players, tick rate and JVM heap, sampled every five seconds and kept for an hour.

Tick rate and heap come from inside the server rather than from the outside of its process, so they match what players are feeling.

<br clear="all">

The log streams live, with a command line into the running server.

<img src="docs/instance-console.webp" alt="Live server console" width="100%">

<br clear="all">

<img src="docs/plugins.webp" alt="Plugin pool" align="left" width="58%">

### 🧩 One plugin pool for every server

Each server gets the newest build compatible with the Minecraft version it runs, or the version you pinned. Nine plugin folders stay in step without being touched.

Targets are rules, not lists: `*paper` covers every Paper backend including ones that do not exist yet. Updates stay on their channel and never move a server backwards.

<br clear="all">

Search and install from Modrinth, Hangar and CurseForge, plus Smithed for data packs. The source is recorded, so update checks still work months later.

<img src="docs/addon-browser.webp" alt="Addon browser" width="80%">

<br clear="all">

<img src="docs/settings.webp" alt="Server settings" align="right" width="52%">

### 🎚️ server.properties as typed fields

Real ranges, real choices, validated before anything reaches disk.

The keys that wire proxy forwarding are shown but locked. Editing one by hand breaks every login on that backend while the server still looks healthy.

<br clear="all">

<img src="docs/config-files.webp" alt="Config file editor" align="left" width="58%">

### 📄 Config edits that survive the plugin

Any file in an instance, edited in Monaco from the browser. A value you keep retyping becomes a placeholder backed by one variable.

When a plugin rewrites a managed config, the rewrite is reported as drift and its version is kept beside the file, so nothing is lost silently.

<br clear="all">

<img src="docs/environment.webp" alt="Environment variables" align="right" width="58%">

### 🔑 One value, every server

Variables layer builtin, global, machine, instance. Rotating a database password is one edit and a restart, not nine files.

Secrets are masked wherever they appear. Revealing one is recorded with the scope and the time, never with the value.

<br clear="all">

Per instance: what it resolves, which layer won, and which config files and plugin templates read it.

<img src="docs/env-resolution.webp" alt="Variable resolution per instance" width="90%">

<br clear="all">

<img src="docs/ports.webp" alt="Port ledger" align="left" width="58%">

### 🌐 Ports allocated, never guessed

Allocation comes from named pools and is tracked per machine, because two hosts can both bind 25565.

Deleting a server releases its port. An audit flags duplicates, configs that drifted from the registry, and addresses the proxy disagrees with.

<br clear="all">

Pools are cluster-wide so a provision can land on any machine; a machine sets only the range it hands out.

<img src="docs/port-pools.webp" alt="Port pools per machine" width="100%">

<br clear="all">

<img src="docs/proxy.webp" alt="Proxy routing" align="right" width="58%">

### 🔀 Proxy routing written from the registry

`[servers]` and `[forced-hosts]` are generated from the instance registry and diffed against disk before anything is saved.

Only the sections luna owns get replaced, so the rest of `velocity.toml` survives. A backend on another machine gets its LAN address filled in.

<br clear="all">

<img src="docs/machines.webp" alt="Machine fleet" align="left" width="58%">

### 🖧 More machines, same console

A follower joins the cluster and its servers appear on the same screens. Instances are launched onto it from the same form.

Reachability is TCP-probed from the primary rather than inferred from the control link. Upgrades roll out by command, not by SSH.

<br clear="all">

Per machine: checks, resource headroom, owned instances and the build each daemon is running.

<img src="docs/machine-health.webp" alt="Machine health checks" width="100%">

<br clear="all">

<img src="docs/players.webp" alt="Player directory" align="right" width="58%">

### 👥 One profile per player, network-wide

Everyone the network has seen, with first and last seen, the backend they were last on, playtime, sessions and auth type.

Recorded across the network rather than per server, so moderation and support are a lookup instead of a grep through seven log directories.

<br clear="all">

Balance, playtime by backend, chat, commands, permissions and moderation history on one page.

<img src="docs/player-profile.webp" alt="Player profile" width="90%">

<br clear="all">

<img src="docs/permissions.webp" alt="Permission groups" align="left" width="58%">

### 🛡️ Ranks that apply everywhere

LuckPerms groups from one shared database, so a promotion lands on every server at once.

Group detail lists every node it carries, including what it inherits, with contexts and expiry.

<br clear="all">

<img src="docs/packs.webp" alt="Resource packs" align="right" width="58%">

### 🎒 Pack changes without kicking anyone

Resource packs stack by priority, are scoped per server, and apply on a proxy reload.

Rules exclude as well as include, so `*, !create` is the whole network except the modded server.

<br clear="all">

The chest players open with `/servers`, edited as a chest: MiniMessage names, and tooltips drawn the way the client draws them with live status filled in.

<img src="docs/selector.webp" alt="Server selector editor" width="100%">

<br clear="all">

<img src="docs/schedules.webp" alt="Schedules" align="left" width="58%">

### ⏰ Restarts the daemon owns

Start, stop or restart on a cron expression, a fixed time or a rate. Nothing depends on a shell staying open.

Every run is kept with its outcome, so a restart that failed last Tuesday is on the record. Stops are graceful, not kills.

<br clear="all">

### ⌨️ The full CLI in the browser

The compiled binary, with the completion engine the shell uses: Tab completion, ghost text and the same history. Everything the console cannot do yet is a command away.

The drawer shortens the page instead of covering it.

<img src="docs/terminal.webp" alt="Terminal drawer" width="100%">

<br clear="all">

<img src="docs/search.webp" alt="Global search" align="right" width="50%">

### 🔍 One search over everything

`Alt+S` indexes instances, addon groups, packs, schedules, ports, proxy routes, players, machines and variables.

Enter opens the hit. Objects without a page of their own hand their term to the table that lists them.

<br clear="all">

## 🛠️ Running this project

luna-console is built to run the luna ecosystem, and it leans on it. Without a copy of the luna suite of plugins and mods, the instance, addon, network and fleet screens still work; the player, permission and economy screens will be empty.

The host needs a JRE, GNU `screen`, and MariaDB and RabbitMQ if you want the player-facing screens to have anything in them. Everything else ships in one compiled binary.

```
sudo luna setup                    # install this machine: user, root, config, unit, start
luna setup --dry-run               # every change it would make, making none
luna daemon run                    # the daemon that owns the cluster
luna web --host 0.0.0.0            # the console, on 8330
```

Building from source needs Bun:

```
bun install
bun run build                      # compile the single binary -> dist/luna
cd web && bun run build            # the console bundle
docker build -t luna .             # or the published image: binary + console + JRE + screen
```

> [!WARNING]
> This repository is public for transparency and to ship release artifacts to the machines that run it. It is **not** open source, and none of the above is permission to run it. See the licence below before you clone it.

## 🤝 Contributions

This project does not take outside contributions. Issues and pull requests will be closed unread, and there is no roadmap to sign up to. Read the code if it is useful to you. The licence does not grant permission to build on it.

## 📄 License

Copyright (c) 2026 Belikhun. All rights reserved.

Publishing this source does not place it in the public domain and does not make it open source. No permission is granted to any person to use, copy, modify, merge, publish, distribute, sublicense, create derivative works of, or sell this software or any part of it, in any form, without prior written permission from the copyright holder. Viewing the source, and the forking mechanics GitHub's Terms of Service afford to public repositories hosted there, are permitted. Nothing further is.

Third-party components are not covered by that notice. This includes the vendored assets under `web/static/` and every dependency resolved at build time.

The full text is in [LICENSE](LICENSE).
