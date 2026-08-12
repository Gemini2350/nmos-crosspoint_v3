# --------------------------------------------------------------------------
# NMOS Crosspoint — multi-stage build
#
#   Stage 1: ui-builder    — installs ui/ deps and runs `vite build`,
#                            which writes the bundle to /build/server/public.
#   Stage 2: server-builder — installs server/ deps (dev included) and runs
#                            tsc to produce server/dist.
#   Stage 3: prod-deps     — production node_modules for the TARGET arch.
#   Stage 4: runtime       — slim final image with only the server runtime
#                            and the pre-built UI assets. No build tooling.
#
# Multi-arch: both builders are pinned to $BUILDPLATFORM so vite and tsc
# always run NATIVELY on the build host — their output is plain JavaScript
# and therefore architecture-independent. Only the stages that produce
# native binaries (prod-deps) and the final image run under the target
# platform, so an arm64 build costs one npm install under emulation instead
# of a fully emulated tsc + vite run (which took 30-60+ min and was the
# reason arm64 was dropped before).
#
# Layer-caching trick: package*.json is copied BEFORE the source tree, so
# the (slow) `npm ci` step is only re-run when dependencies actually change.
# Source-only edits skip straight to the tsc / vite step.
# --------------------------------------------------------------------------

# ============================== UI builder ===============================
FROM --platform=$BUILDPLATFORM node:20 AS ui-builder
WORKDIR /build/ui

# Dependency install — cached unless package*.json changes.
COPY ui/package*.json ./
RUN npm ci --no-audit --no-fund --prefer-offline

# Source + build. Vite's outDir is `../server/public`, so we create that
# sibling directory now and let it land there.
RUN mkdir -p /build/server/public
COPY ui/ ./
RUN npm run build


# ============================ Server builder =============================
FROM --platform=$BUILDPLATFORM node:20 AS server-builder
WORKDIR /build/server

# Only tsc runs here — no native modules are compiled in this stage, so it
# needs no toolchain and can stay on the build host's architecture.
COPY server/package*.json ./
RUN npm ci --no-audit --no-fund --prefer-offline

COPY server/ ./
RUN npm run build


# ============================ Production deps ============================
# Runs under the TARGET platform: @discordjs/opus ships a native binding, so
# these modules must match the architecture of the final image.
FROM node:20 AS prod-deps
WORKDIR /build/server

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential python3 \
        libopus-dev libopus0 \
 && rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund --prefer-offline \
 && npm cache clean --force


# ============================== Runtime ==================================
FROM node:20-slim AS runtime
WORKDIR /nmos-crosspoint/server

# Runtime needs libopus so @discordjs/opus's native binding can load.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libopus0 \
 && rm -rf /var/lib/apt/lists/*

# node_modules come from the prod-deps stage — same architecture and the
# same glibc as this node:20-slim image, so no rebuild is needed here.
COPY server/package*.json ./
COPY --from=prod-deps /build/server/node_modules ./node_modules

# Compiled JS and the UI bundle (from the two previous stages).
COPY --from=server-builder /build/server/dist  ./dist
COPY --from=ui-builder     /build/server/public ./public

# Default config shipped inside the image. The entrypoint copies these into
# the (bind-mounted, possibly empty) ./config on first boot so a fresh host
# starts without manual setup. Operator-edited config is never overwritten.
COPY server/config.default ./config.default
COPY server/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Settings + state come from volume mounts; create the directories so the
# server doesn't error out on first boot when nothing is mounted yet.
RUN mkdir -p ./config ./state ./log

# Web UI + WebSocket sync (settings.json server.port, default 80).
# Documentation metadata: with --net=host it has no effect, and in probe
# mode (MODE=probe) the process only opens outgoing connections.
EXPOSE 80

ENTRYPOINT ["./docker-entrypoint.sh"]
