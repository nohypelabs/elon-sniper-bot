#!/usr/bin/env bash
# Runs ON the monitored host (systemd user timer, every 60 s). Collects a few health facts and
# pushes them to the watcher over SSH. If this host dies, loses network or hangs, the heartbeat
# stops and the watcher alerts: a machine cannot report its own death, the silence does it.
set -u
CONF="${MM_HB_ENV:-$HOME/.config/mm-heartbeat/env}"; [ -f "$CONF" ] && . "$CONF"
: "${MM_WATCHER:?MM_WATCHER (user@host) missing in $CONF}"
MM_WATCHER_PORT="${MM_WATCHER_PORT:-22}"; MM_KEY="${MM_KEY:-$HOME/.ssh/mm_heartbeat}"; MM_SERVICE="${MM_SERVICE:-elon-sniper}"

now=$(date +%s)
svc=$(systemctl --user is-active "$MM_SERVICE" 2>/dev/null || true)
last=$(journalctl --user -u "$MM_SERVICE" -n 1 --no-pager -o short-unix 2>/dev/null | awk 'NR==1{split($1,a,"."); print a[1]}')
if [[ "$last" =~ ^[0-9]+$ ]]; then logage=$((now - last)); else logage=-1; fi
disk=$(df / --output=pcent 2>/dev/null | tail -1 | tr -dc '0-9')
mem=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)
up=$(uptime -p 2>/dev/null | tr -d '\n' | tr ' ' '_')

printf 'svc=%s\nlogage=%s\ndisk=%s\nmemavail=%s\nload=%s\nup=%s\n' \
  "${svc:-unknown}" "$logage" "${disk:-0}" "${mem:-0}" "${load:-0}" "${up:-unknown}" |
  ssh -i "$MM_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 \
      -p "$MM_WATCHER_PORT" "$MM_WATCHER" hb
