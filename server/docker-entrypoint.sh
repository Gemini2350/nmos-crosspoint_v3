#!/bin/sh
# NMOS Crosspoint container entrypoint.
#
# The config + state directories are bind-mounted from the host. On a fresh
# host those mounts are EMPTY, which used to crash the server (it requires
# ./config/settings.json to exist). This script seeds the default config
# files from the image's ./config.default into the (mounted) ./config the
# first time round, without ever clobbering an operator's existing files.
#
# WORKDIR is /nmos-crosspoint/server, so all paths here are relative to it.

set -e

# Probe mode: the same image doubles as the multicast probe — a tiny helper
# on a media-network host that forwards multicast RTP to the crosspoint as
# unicast. No config/state mounts needed; driven entirely by env vars:
#   MODE=probe CROSSPOINT_URL=ws://<crosspoint> PROBE_TOKEN=<token>
#   [PROBE_NAME="Studio A"] [PROBE_IFACE=<local ip>]
if [ "$MODE" = "probe" ]; then
    exec node ./dist/probe.js
fi

CONFIG_DIR="./config"
DEFAULT_DIR="./config.default"

# Make sure the persistent directories exist (empty mounts may not have them).
mkdir -p "$CONFIG_DIR" ./state ./log

# Seed each default file only when it's missing — an existing operator config
# is left completely untouched.
if [ -d "$DEFAULT_DIR" ]; then
    for f in settings.json users.json; do
        if [ ! -f "$CONFIG_DIR/$f" ] && [ -f "$DEFAULT_DIR/$f" ]; then
            echo "[entrypoint] seeding default $f into $CONFIG_DIR"
            cp "$DEFAULT_DIR/$f" "$CONFIG_DIR/$f"
        fi
    done
fi

# Hand off to the Node server as PID 1 (exec → proper signal handling).
exec node ./dist/server.js
