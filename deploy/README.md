# Deploying mrds

Two ways to run a daemon: the binary under systemd (what the cluster on
`/mnt/shulker/mrds` does), or the container image. Both run the same build.

## Binary

```
curl -fsSLO https://github.com/Belikhun/luna-control/releases/latest/download/luna-linux-x64
chmod +x luna-linux-x64
sudo ./luna-linux-x64 setup
```

`setup` is the whole install: it creates the service account, puts the binary at
`/usr/local/bin/luna`, prepares the cluster root (seeding an empty registry on a
primary), writes `/etc/mrds/daemon.json` and the systemd unit, installs shell
completion, then enables, starts and waits for the daemon to answer. It prompts
for what you do not pass; `--yes` takes the defaults and `--dry-run` prints every
change without making one:

```
sudo luna setup --yes --mode primary  --name shulker --root /srv/mrds
sudo luna setup --yes --mode follower --name mc2 --primary 10.0.0.10:8331 --token <token>
```

Re-running it reconfigures rather than resets — the existing config supplies the
defaults, so the cluster token survives and the service restarts onto the new
binary.

From then on the daemon upgrades itself: `luna daemon upgrade <name>` takes the
primary's binary when there is one and the GitHub release otherwise.

## Container

`ghcr.io/belikhun/luna-control:latest`, or a pinned `:1.2.3`. The image carries
the `luna` binary, the web console, a JRE and the tools the daemon shells out to
(`screen`, `df`, `ss`, `pgrep`, `unzip`) — a Minecraft backend runs *inside* the
container, in a screen session the daemon starts.

That is all it carries. The runtime stage starts from the JRE and copies in
three artifacts — `/usr/local/bin/luna`, `/opt/mrds/web` (the adapter-node
bundle, source maps stripped) and `bun` to run the console. No source, no
lockfiles, no build tooling, no docs: everything the build reads stays in the
builder stage, and the build context itself is an allowlist (`.dockerignore`),
so a file nobody named cannot reach a layer.

```
cp .env.example .env                             # MRDS_TOKEN at minimum
docker compose -f docker-compose.primary.yml up -d
docker compose -f docker-compose.follower.yml up -d   # on the other machines
```

- `docker-compose.primary.yml` — the primary daemon plus the console as a second
  container. They meet on the daemon's unix socket in the shared volume, so
  restarting the console never touches the daemon.
- `docker-compose.follower.yml` — one follower. Set `MRDS_DAEMON_NAME` (unique,
  stable), `MRDS_PRIMARY_ADDRESS` and the same `MRDS_TOKEN`.

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
