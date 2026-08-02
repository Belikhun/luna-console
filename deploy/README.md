# Deploying luna

Two ways to run a daemon: the binary under systemd (what the cluster on
`/mnt/shulker/mrds` does), or the container image. Both run the same build.

## Binary

```
curl -fsSLO https://github.com/Belikhun/luna-control/releases/latest/download/luna-linux-x64
chmod +x luna-linux-x64
sudo ./luna-linux-x64 setup
```

`setup` is the whole install: it creates the service account, prepares the
cluster root (seeding an empty registry on a primary), puts the one binary at
`<root>/.bin/luna` owned by that account, adds its directory to PATH, writes
`/etc/luna/daemon.json` and the systemd unit, installs shell completion, then
enables, starts and waits for the daemon to answer. It prompts for what you do
not pass; `--yes` takes the defaults and `--dry-run` prints every change without
making one:

```
sudo luna setup --yes --mode primary  --root /srv/luna
sudo luna setup --yes --mode follower --primary 10.0.0.10:8331 --token <token>
```

A daemon's name defaults to the machine's hostname, which is what you want unless
two machines share one — it keys `cluster.json` and decides instance ownership, so
pass `--name` only to break such a tie.

Re-running it reconfigures rather than resets — the existing config supplies the
defaults, so the cluster token survives and the service restarts onto the new
binary.

Two things follow from there being one binary rather than a system-wide copy:

- **Open a new shell** before `luna` resolves, or `source /etc/profile.d/luna.sh`.
- **`sudo` will not find it.** sudo replaces your PATH with its own `secure_path`,
  which does not include the cluster root, so privileged runs need the full path:
  `sudo <root>/.bin/luna setup`. The installer prints it when it finishes.

From then on the daemon upgrades itself: `luna daemon upgrade <name>` takes the
primary's binary when there is one and the GitHub release otherwise, replacing
`<root>/.bin/luna` in place — the same file you invoke, so nothing drifts. A
daemon started by hand from a directory its account cannot write (`/usr/local/bin`,
say) cannot upgrade itself at all, and says so instead of failing on an errno.

## Container

`ghcr.io/belikhun/luna-control:latest`, or a pinned `:1.2.3`. The image carries
the `luna` binary, the web console, a JRE and the tools the daemon shells out to
(`screen`, `df`, `ss`, `pgrep`, `unzip`) — a Minecraft backend runs *inside* the
container, in a screen session the daemon starts.

That is all it carries. The runtime stage starts from the JRE and copies in
three artifacts — `/usr/local/bin/luna`, `/opt/luna/web` (the adapter-node
bundle, source maps stripped) and `bun` to run the console. No source, no
lockfiles, no build tooling, no docs: everything the build reads stays in the
builder stage, and the build context itself is an allowlist (`.dockerignore`),
so a file nobody named cannot reach a layer.

```
cp .env.example .env                             # LUNA_TOKEN at minimum
docker compose -f docker-compose.primary.yml up -d
docker compose -f docker-compose.follower.yml up -d   # on the other machines
```

- `docker-compose.primary.yml` — the primary daemon plus the console as a second
  container. They meet on the daemon's unix socket in the shared volume, so
  restarting the console never touches the daemon.
- `docker-compose.follower.yml` — one follower. Set `LUNA_DAEMON_NAME` (unique,
  stable), `LUNA_PRIMARY_ADDRESS` and the same `LUNA_TOKEN`.

Two things a container changes about the daemon's assumptions:

- **The cluster root is a volume** (`/data`). Worlds, logs, the plugin pool and —
  on the primary — `cluster.json` all live there. Back that up, not the image.
- **Backend ports must be published.** The primary TCP-probes each follower's
  instances to decide whether velocity can reach them, and that probe comes from
  outside the container. Publish the port range the follower's instances use.

A self-upgrade inside a container replaces the binary in the container's writable
layer, which the next `docker compose pull` discards — pull a new image tag
instead. The daemon still reports what it *would* upgrade to, which is how you
know a release exists.
