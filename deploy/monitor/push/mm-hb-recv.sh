#!/bin/sh
# Installed on the watcher. Used as the forced command of the heartbeat key: the key can ONLY write
# the status file, nothing else (no shell, no forwarding). The watcher's own clock stamps last_seen.
umask 077
d="${MM_DIR:-$HOME/mm}"; mkdir -p "$d"
head -c 2048 > "$d/status.tmp" && mv "$d/status.tmp" "$d/status" && date +%s > "$d/last_seen"
