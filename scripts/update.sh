#!/usr/bin/env bash
# Build this checkout and switch the running Crosspoint container to it, in
# one step that keeps running in the background. A dropped SSH/RDP session
# can then no longer leave the plant without a controller halfway through
# (container stopped and removed, new one never started).
#
#   scripts/update.sh                   build, then switch; if the new
#                                       version does not come up, start the
#                                       one that ran before again
#   scripts/update.sh rollback [image]  switch back to the image that ran
#                                       before the last update (or to the
#                                       image given)
#
# Progress goes to ~/crosspoint-update.log (CROSSPOINT_UPDATE_LOG to change).
# The container is started like the README's docker run: host network,
# restart unless-stopped, config and state from this checkout's server/.
# Nothing is stopped before the new image has been built and checked.

set -u

NAME=nmos-crosspoint_v3
IMAGE=nmos-crosspoint_v3:local
PREVIOUS=nmos-crosspoint_v3:previous
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${CROSSPOINT_UPDATE_LOG:-$HOME/crosspoint-update.log}"
WAIT="${CROSSPOINT_UPDATE_WAIT:-20}"
MODE="${1:-update}"

case "$MODE" in
    update|rollback) ;;
    *) echo "usage: $0 [rollback [image]]"; exit 2 ;;
esac

# Detach first: everything below has to survive the terminal going away.
if [ "${CROSSPOINT_UPDATE_DETACHED:-}" != 1 ]; then
    export CROSSPOINT_UPDATE_DETACHED=1
    if command -v setsid >/dev/null 2>&1; then
        setsid nohup bash "${BASH_SOURCE[0]}" "$@" >>"$LOG" 2>&1 </dev/null &
    else
        nohup bash "${BASH_SOURCE[0]}" "$@" >>"$LOG" 2>&1 </dev/null &
    fi
    echo "Running in the background; a dropped connection does not stop it."
    echo "Follow it with:  tail -f $LOG"
    exit 0
fi

say(){ echo "$(date '+%F %T')  $*"; }

version_in_file(){
    sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1" | head -n1
}

version_of_image(){
    docker run --rm --entrypoint cat "$1" package.json 2>/dev/null \
        | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -n1
}

start(){
    docker run -d --restart unless-stopped --network host \
        --name "$NAME" --hostname "$NAME" \
        -v "$REPO/server/config:/nmos-crosspoint/server/config" \
        -v "$REPO/server/state:/nmos-crosspoint/server/state" \
        "$1" >/dev/null
}

# Running after $WAIT seconds, and not restarted once in between.
healthy(){
    sleep "$WAIT"
    [ "$(docker container inspect -f '{{.State.Running}} {{.State.Restarting}} {{.RestartCount}}' "$NAME" 2>/dev/null)" = "true false 0" ]
}

remove_running(){
    docker stop "$NAME" >/dev/null 2>&1
    docker rm "$NAME" >/dev/null 2>&1
}

# Start $1; if it does not come up, show why and start $2 (if any) instead.
switch_to(){
    local target="$1" fallback="$2"
    remove_running
    if start "$target" && healthy; then
        return 0
    fi
    say "$target did not come up. Its last log lines:"
    docker logs --tail 40 "$NAME" 2>&1
    docker rm -f "$NAME" >/dev/null 2>&1
    if [ -z "$fallback" ]; then
        say "NO IMAGE TO FALL BACK TO. Crosspoint is NOT running. Start one by hand (README)."
        return 1
    fi
    say "starting $fallback again"
    if start "$fallback" && healthy; then
        say "back on $fallback ($(version_of_image "$fallback"))."
    else
        say "$fallback DID NOT COME UP EITHER. Crosspoint is NOT running. Check: docker ps -a; docker logs $NAME"
    fi
    return 1
}

if [ "$MODE" = "rollback" ]; then
    target="${2:-$PREVIOUS}"
    say "=== rollback to $target"
    if ! docker image inspect "$target" >/dev/null 2>&1; then
        say "there is no image $target; nothing was changed."
        exit 1
    fi
    if switch_to "$target" ""; then
        say "OK: $target ($(version_of_image "$target")) is running. Reload every open browser tab."
        exit 0
    fi
    exit 1
fi

branch="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null)"
commit="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)"
want="$(version_in_file "$REPO/server/package.json")"
say "=== update to $want ($branch $commit)"
say "building $IMAGE; the running container is not touched while it builds"
if ! docker build -t "$IMAGE" "$REPO"; then
    say "docker build failed, trying docker buildx"
    if ! docker buildx build --load -t "$IMAGE" "$REPO"; then
        say "BUILD FAILED. Nothing was switched; the running version stays."
        exit 1
    fi
fi
got="$(version_of_image "$IMAGE")"
if [ -z "$want" ] || [ "$got" != "$want" ]; then
    say "the new image reports version '$got', expected '$want'. Nothing was switched."
    exit 1
fi

# Keep whatever runs now as the fallback (and for "rollback").
running="$(docker container inspect -f '{{.Image}}' "$NAME" 2>/dev/null)"
if [ -n "$running" ]; then
    docker tag "$running" "$PREVIOUS"
    say "kept the running image as $PREVIOUS ($(version_of_image "$PREVIOUS"))"
else
    say "no container $NAME is running right now"
fi
fallback=""
if docker image inspect "$PREVIOUS" >/dev/null 2>&1; then fallback="$PREVIOUS"; fi

say "switching to $IMAGE ($want)"
if switch_to "$IMAGE" "$fallback"; then
    say "OK: $want is running. Reload every open browser tab (Ctrl+Shift+R)."
    exit 0
fi
exit 1
