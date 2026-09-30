#!/usr/bin/env bash
# Runs on the watcher every minute. Alerts on Telegram when heartbeats stop (host dead / offline /
# hung) or when the reported health is bad (service inactive, bot log stale, disk full, low memory).
set -u
CONF="${MM_WATCH_ENV:-/etc/mm-watch/env}"; [ -f "$CONF" ] && . "$CONF"
MM_NAME="${MM_NAME:-minipc}"; MM_DIR="${MM_DIR:-$HOME/mm}"
MM_DEAD_SEC="${MM_DEAD_SEC:-180}"          # no heartbeat for this long => DOWN
MM_STALE_LOG_SEC="${MM_STALE_LOG_SEC:-300}"
MM_DISK_MAX="${MM_DISK_MAX:-90}"; MM_MEM_MIN_MB="${MM_MEM_MIN_MB:-250}"
MM_DEGRADED_RUNS="${MM_DEGRADED_RUNS:-2}"  # consecutive bad reports before alerting
MM_REMIND_MIN="${MM_REMIND_MIN:-30}"; MM_DRY_RUN="${MM_DRY_RUN:-0}"
mkdir -p "$MM_DIR"; STATE="$MM_DIR/state"; now=$(date +%s)
bad=0; since=0; last_alert=0; kind=""; started=$now
[ -f "$STATE" ] && . "$STATE"
save() { printf 'bad=%s\nsince=%s\nlast_alert=%s\nkind=%s\nstarted=%s\n' "$bad" "$since" "$last_alert" "$kind" "$started" > "$STATE"; }
human() { local s=$1; if [ "$s" -ge 3600 ]; then echo "$((s/3600)) jam $(((s%3600)/60)) menit"; elif [ "$s" -ge 60 ]; then echo "$((s/60)) menit"; else echo "${s} detik"; fi; }
notify() {
  echo "[$(date '+%F %T')] ALERT: $1"; [ "$MM_DRY_RUN" = "1" ] && return 0
  [ -n "${MM_TG_TOKEN:-}" ] && [ -n "${MM_TG_CHAT:-}" ] || { echo "telegram not configured" >&2; return 1; }
  local code; code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://api.telegram.org/bot${MM_TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${MM_TG_CHAT}" --data-urlencode "text=$1") || code="curl-error"
  [ "$code" = "200" ] || echo "[$(date '+%F %T')] telegram send FAILED (http=$code)" >&2
}
if [ "${1:-}" = "--test" ]; then notify "🔔 Pemantau ${MM_NAME} (VPS) aktif: menunggu detak tiap menit dari ${MM_NAME}."; exit 0; fi

problem=""; new_kind=""
last_seen=0; [ -f "$MM_DIR/last_seen" ] && last_seen=$(cat "$MM_DIR/last_seen" 2>/dev/null); [[ "$last_seen" =~ ^[0-9]+$ ]] || last_seen=0
if [ "$last_seen" -eq 0 ]; then
  # never heard from it: give the first heartbeat 10 minutes before calling it down
  if [ $((now - started)) -gt 600 ]; then problem="belum pernah menerima detak sejak pemantau dipasang"; new_kind=dead; fi
else
  age=$((now - last_seen))
  if [ "$age" -gt "$MM_DEAD_SEC" ]; then
    problem="tidak ada detak selama $(human "$age") (mati / offline / beku)"; new_kind=dead
  else
    get() { grep -m1 "^$1=" "$MM_DIR/status" 2>/dev/null | cut -d= -f2-; }
    svc=$(get svc); logage=$(get logage); disk=$(get disk); mem=$(get memavail); up=$(get up | tr '_' ' ')
    [ "${svc:-unknown}" != "active" ] && problem="service: ${svc:-unknown}"
    if [ -z "$problem" ] && [[ "$logage" =~ ^[0-9]+$ ]] && [ "$logage" -gt "$MM_STALE_LOG_SEC" ]; then problem="bot aktif tapi log terakhir $(human "$logage") lalu (mungkin beku)"; fi
    if [ -z "$problem" ] && [[ "$disk" =~ ^[0-9]+$ ]] && [ "$disk" -ge "$MM_DISK_MAX" ]; then problem="disk ${disk}% penuh"; fi
    if [ -z "$problem" ] && [[ "$mem" =~ ^[0-9]+$ ]] && [ "$mem" -lt "$MM_MEM_MIN_MB" ]; then problem="memori tersedia tinggal ${mem} MB"; fi
    [ -n "$problem" ] && new_kind=degraded
  fi
fi

if [ -z "$problem" ]; then
  if [ "$since" -gt 0 ]; then notify "✅ ${MM_NAME} pulih setelah $(human $((now - since))). ${up:-}"; fi
  bad=0; since=0; last_alert=0; kind=""; save; echo "[$(date '+%F %T')] ok (${up:-no-status-yet})"; exit 0
fi

bad=$((bad + 1)); echo "[$(date '+%F %T')] problem ($new_kind #$bad): $problem"
need=1; [ "$new_kind" = "degraded" ] && need=$MM_DEGRADED_RUNS
if [ "$bad" -ge "$need" ]; then
  if [ "$since" -eq 0 ]; then
    since=$now; [ "$new_kind" = "dead" ] && [ "$last_seen" -gt 0 ] && since=$last_seen
    kind=$new_kind; last_alert=$now; notify "🚨 ${MM_NAME} bermasalah: ${problem}"
  elif [ "$new_kind" != "$kind" ]; then
    kind=$new_kind; last_alert=$now; notify "🚨 ${MM_NAME} kondisi berubah: ${problem}"
  elif [ $((now - last_alert)) -ge $((MM_REMIND_MIN * 60)) ]; then
    last_alert=$now; notify "⏰ ${MM_NAME} masih bermasalah selama $(human $((now - since))): ${problem}"
  fi
fi
save
