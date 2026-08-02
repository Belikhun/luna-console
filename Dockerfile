# mrds — the luna cluster control binary, its web console, and everything a
# Minecraft backend needs to actually run inside the container.
#
# The daemon does not embed a server: it starts `run.sh` inside a GNU screen
# session and manages it from outside, so the runtime image needs screen, a JRE
# and the small POSIX tools the daemon shells out to (df, ss, pgrep, unzip,
# tail). Bun is here for the web console only — the CLI/daemon binary is
# self-contained.

# --- build ------------------------------------------------------------------
FROM oven/bun:1-debian AS builder

WORKDIR /src

# dependencies first, so a source-only change reuses the install layer
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY web/package.json web/bun.lock* ./web/
RUN cd web && bun install

COPY . .

# the release workflow passes the tag and the commit; a local build falls back
# to package.json and "dev" (the image context has no .git to read)
ARG MRDS_VERSION
ARG MRDS_COMMIT
ENV MRDS_VERSION=${MRDS_VERSION} \
	MRDS_COMMIT=${MRDS_COMMIT}

RUN bun run build && cd web && bun run build

# --- runtime ----------------------------------------------------------------
FROM eclipse-temurin:21-jre-noble AS runtime

# screen: the daemon's process model. procps/iproute2/coreutils: the probes it
# runs (pgrep java, ss -tuln, df). unzip: reading plugin.yml out of a jar.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		coreutils \
		curl \
		iproute2 \
		procps \
		screen \
		tini \
		unzip \
	&& rm -rf /var/lib/apt/lists/*

# the console is a SvelteKit adapter-node bundle, which needs a JS runtime
COPY --from=oven/bun:1-debian /usr/local/bin/bun /usr/local/bin/bun

COPY --from=builder /src/dist/luna /usr/local/bin/luna
COPY --from=builder /src/web/build /opt/mrds/web/build
COPY --from=builder /src/web/package.json /opt/mrds/web/package.json

# MRDS_WEB_DIR keeps the console outside the cluster root, which is a volume
ENV MRDS_ROOT=/data \
	MRDS_WEB_DIR=/opt/mrds/web \
	MRDS_SOCKET=/data/run/daemon.sock

WORKDIR /data
VOLUME ["/data"]

# 8331 followers · 8330 console · 25565 proxy · 32560-32599 backends
EXPOSE 8330 8331 25565

# tini reaps the screen sessions' orphans; without it PID 1 collects zombies
ENTRYPOINT ["/usr/bin/tini", "--", "luna"]
CMD ["daemon", "run"]
