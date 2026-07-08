# --------------------------------------------------------------------------
# NMOS Crosspoint — multi-stage build
#
#   Stage 1: ui-builder    — installs ui/ deps and runs `vite build`,
#                            which writes the bundle to /build/server/public.
#   Stage 2: server-builder — installs server/ deps (dev included) and runs
#                            tsc to produce server/dist.
#   Stage 3: runtime       — slim final image with only the server runtime
#                            and the pre-built UI assets. No build tooling.
#
# Layer-caching trick: package*.json is copied BEFORE the source tree, so
# the (slow) `npm ci` step is only re-run when dependencies actually change.
# Source-only edits skip straight to the tsc / vite step.
# --------------------------------------------------------------------------

# ============================== UI builder ===============================
FROM node:20 AS ui-builder
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
FROM node:20 AS server-builder
WORKDIR /build/server

# Native build deps for @discordjs/opus (libopus headers + a C++ toolchain)
# — needed by the audio-monitor feature. node:20 already ships Python.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential python3 \
        libopus-dev libopus0 \
 && rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./
RUN npm ci --no-audit --no-fund --prefer-offline

COPY server/ ./
RUN npm run build


# ============================== Runtime ==================================
FROM node:20-slim AS runtime
WORKDIR /nmos-crosspoint/server

# Runtime needs libopus so @discordjs/opus's native binding can load.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libopus0 \
 && rm -rf /var/lib/apt/lists/*

# node_modules come straight from the builder stage — the native bindings
# for @discordjs/opus/werift are compiled there against the same glibc as
# this node:20-slim image, so no rebuild is needed at runtime.
COPY server/package*.json ./
COPY --from=server-builder /build/server/node_modules ./node_modules
RUN npm prune --omit=dev --no-audit --no-fund \
 && npm cache clean --force

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

ENTRYPOINT ["./docker-entrypoint.sh"]
