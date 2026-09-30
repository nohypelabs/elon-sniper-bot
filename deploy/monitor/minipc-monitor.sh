#!/usr/bin/env bash
# External health monitor for the minipc (runs on ANOTHER machine, e.g. the laptop).
# Checks, in order: SSH reachable -> service active -> bot log fresh. Alerts via Telegram with
# hysteresis (N consecutive failures), reminders while down, and a recovery message.
# Config (secrets/host) lives in ~/.config/minipc-monitor/env, never in git. See README.md.
set -u

CONF="${MINIPC_MONITOR_ENV:-$HOME/.config/minipc-monitor/env}"
[ -f "$CONF" ] && . "$CONF"

: "${MM_HOST:?MM_HOST (user@host) missing in $CONF}"
MM_PORT="${MM_PORT:-22}"
MM_KEY="${MM_KEY:-$HOME/.ssh/id_ed25519}"
MM_NAME="${MM_NAME:-minipc}"
MM_SERVICE="${MM_SERVICE:-elon-sniper}"
MM_FAIL_THRESHOLD="${MM_FAIL_THRESHOLD:-3}"     # consecutive failing runs before alerting
MM_REMIND_MIN="${MM_REMIND_MIN:-30}"            # reminder interval while still down
MM_STALE_LOG_SEC="${MM_STALE_LOG_SEC:-300}"     # bot logs a stats line every 30 s
MM_DRY_RUN="${MM_DRY_RUN:-0}"                   # 1 = print instead of sending Telegram
MM_STATE_DIR="${MM_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/minipc-monitor}"
mkdir -p "$MM_STATE_DIR"; STATE="$MM_STATE_DIR/state"

now=$(date +%s)
fails=0; down_since=0; last_alert=0
[ -f "$STATE" ] && . "$STATE"
save() { printf 'fails=%s\ndown_since=%s\nlast_alert=%s\n' "$fails" "$down_since" "$last_alert" > "$STATE"; }

notify() {
  local text="$1"
  echo "[$(date '+%F %T')] ALERT: $text"
  [ "$MM_DRY_RUN" = "1" ] && return 0
  [ -n "${MM_TG_TOKEN:-}" ] && [ -n "${MM_TG_CHAT:-}" ] || { echo "telegram not configured" >&2; return 1; }
  local code
  code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://api.telegram.org/bot${MM_TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${MM_TG_CHAT}" --data-urlencode "text=${text}") || code="curl-error"
  [ "$code" = "200" ] || echo "[$(date '+%F %T')] telegram send FAILED (http=$code)" >&2
}

human() { local s=$1; if [ "$s" -ge 3600 ]; then echo "$((s/3600)) jam $(((s%3600)/60)) menit"; elif [ "$s" -ge 60 ]; then echo "$((s/60)) menit"; else echo "${s} detik"; fi; }

if [ "${1:-}" = "--test" ]; then notify "🔔 Pemantau ${MM_NAME} aktif: memeriksa SSH, service ${MM_SERVICE}, dan kesegaran log tiap menit."; exit 0; fi

# --- probe -------------------------------------------------------------------
problem=""
out=$(ssh -i "$MM_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 \
  -p "$MM_PORT" "$MM_HOST" \
  "echo OK; systemctl --user is-active $MM_SERVICE; journalctl --user -u $MM_SERVICE -n 1 --no-pager -o short-unix 2>/dev/null | awk 'NR==1{split(\$1,a,\".\"); print a[1]}'; date +%s; uptime -p" 2>&1)
rc=$?
if [ $rc -ne 0 ] || ! printf '%s\n' "$out" | head -1 | grep -qx OK; then
  reason=$(printf '%s' "$out" | tail -1 | cut -c1-90)
  problem="SSH tidak terjangkau (${reason:-rc=$rc})"
else
  svc=$(printf '%s\n' "$out" | sed -n 2p)
  lastlog=$(printf '%s\n' "$out" | sed -n 3p)
  rnow=$(printf '%s\n' "$out" | sed -n 4p)
  up=$(printf '%s\n' "$out" | sed -n 5p)
  if [ "$svc" != "active" ]; then
    problem="service $MM_SERVICE: ${svc:-unknown}"
  elif printf '%s' "$lastlog" | grep -qE '^[0-9]+$' && printf '%s' "$rnow" | grep -qE '^[0-9]+$'; then
    age=$((rnow - lastlog))
    [ "$age" -gt "$MM_STALE_LOG_SEC" ] && problem="bot aktif tapi log terakhir $(human "$age") lalu (mungkin beku)"
  else
    problem="tidak bisa membaca log service"
  fi
fi

# --- state machine -----------------------------------------------------------
if [ -z "$problem" ]; then
  if [ "$down_since" -gt 0 ]; then
    notify "✅ ${MM_NAME} pulih setelah $(human $((now - down_since))). ${up:-}"
  fi
  fails=0; down_since=0; last_alert=0; save
  echo "[$(date '+%F %T')] ok (${up:-})"
  exit 0
fi

fails=$((fails + 1))
echo "[$(date '+%F %T')] problem ($fails/$MM_FAIL_THRESHOLD): $problem"
if [ "$fails" -ge "$MM_FAIL_THRESHOLD" ]; then
  if [ "$down_since" -eq 0 ]; then
    down_since=$((now - (fails - 1) * 60)); last_alert=$now
    notify "🚨 ${MM_NAME} bermasalah: ${problem}"
  elif [ $((now - last_alert)) -ge $((MM_REMIND_MIN * 60)) ]; then
    last_alert=$now
    notify "⏰ ${MM_NAME} masih bermasalah selama $(human $((now - down_since))): ${problem}"
  fi
fi
save
exit 0
