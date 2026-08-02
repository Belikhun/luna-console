# luna — the luna cluster control binary, its web console, and everything a
# Minecraft backend needs to actually run inside the container.
#
# The daemon does not embed a server: it starts `run.sh` inside a GNU screen
# session and manages it from outside, so the runtime image needs screen, a JRE
# and the small POSIX tools the daemon shells out to (ss, pgrep, unzip). Bun is
# here for the web console only — the CLI/daemon binary is self-contained.
#
# The runtime stage is built from scratch on top of the JRE and copies in three
# things: the binary, the console bundle and bun. No source, no build tooling,
# no lockfiles, no docs — everything the builds read stays in the builder stage,
# which is discarded.

# --- build ------------------------------------------------------------------
FROM oven/bun:1-debian AS builder

WORKDIR /src

# dependencies first, so a source-only change reuses the install layer
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY web/package.json web/bun.lock ./web/
RUN cd web && bun install --frozen-lockfile

# only what the two builds actually read — editing docs or deploy/ must not
# invalidate this layer, and a file nobody named cannot end up in the image
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web

# the release workflow passes the tag and the commit; a local build falls back
# to package.json and "dev" (the image context has no .git to read)
ARG MRDS_VERSION
ARG MRDS_COMMIT
ENV MRDS_VERSION=${MRDS_VERSION} \
	MRDS_COMMIT=${MRDS_COMMIT}

RUN bun run build && cd web && bun run build

# Stage the console exactly as it ships: the adapter's output, minus the source
# maps (debugging metadata a server never reads — and a source map is the source
# itself, in JSON form) and the now-dangling `sourceMappingURL` comments that
# point at them, plus a package.json that says nothing except "this directory is
# ESM" — the one in the source tree carries the whole dev dependency list and has
# no business in an image. The bundle itself is minified (see vite.config.ts), so
# it carries no comments and no `src/…` module markers either.
RUN mkdir -p /out/web \
	&& cp -r web/build /out/web/build \
	&& find /out/web -name '*.map' -delete \
	&& find /out/web -name '*.js' -exec sed -i '/^\/\/# sourceMappingURL=/d' {} + \
	&& printf '{\n\t"name": "mrds-console",\n\t"private": true,\n\t"type": "module"\n}\n' > /out/web/package.json

# --- runtime ----------------------------------------------------------------
FROM eclipse-temurin:21-jre-noble AS runtime

# screen: the daemon's process model. procps/iproute2: the probes it runs
# (pgrep java, ss -tuln). unzip: reading plugin.yml out of a jar. coreutils (df,
# tail) is essential in the base, so it is not installed again here.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		iproute2 \
		procps \
		screen \
		tini \
		unzip \
	&& rm -rf /var/lib/apt/lists/*

# the console is a SvelteKit adapter-node bundle, which needs a JS runtime
COPY --from=oven/bun:1-debian /usr/local/bin/bun /usr/local/bin/bun

COPY --from=builder /src/dist/luna /usr/local/bin/luna
COPY --from=builder /out/web /opt/mrds/web

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
