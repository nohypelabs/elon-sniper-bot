# Minipc monitor

Runs on a **different machine** than the bot (e.g. your laptop) and alerts on Telegram when the
minipc or the bot is unhealthy. A machine cannot report its own death, so this must live elsewhere.

Every minute it checks, in order: SSH reachable, `systemctl --user is-active <service>`, and that the bot's
last log line is fresh (the bot logs a stats line every 30 s, so a stale log means hung, not just quiet).
It alerts after `MM_FAIL_THRESHOLD` consecutive failures (default 3), repeats every `MM_REMIND_MIN`
minutes (default 30) while down, and sends a recovery message with the downtime.

## Install (systemd user timer)
```bash
install -m 755 deploy/monitor/minipc-monitor.sh ~/.local/bin/
install -m 644 deploy/monitor/minipc-monitor.{service,timer} ~/.config/systemd/user/
mkdir -p ~/.config/minipc-monitor && cp deploy/monitor/env.example ~/.config/minipc-monitor/env
chmod 600 ~/.config/minipc-monitor/env && $EDITOR ~/.config/minipc-monitor/env
systemctl --user daemon-reload && systemctl --user enable --now minipc-monitor.timer
~/.local/bin/minipc-monitor.sh --test        # sends one Telegram message
```
Logs: `journalctl --user -u minipc-monitor.service -f`. Dry run: `MM_DRY_RUN=1 ~/.local/bin/minipc-monitor.sh`.

## Limits
- It only watches while the machine running it is on and awake. For 24/7 coverage run the same script on an
  always-on host (e.g. a VPS joined to the same tailnet).
- Telegram sends reuse the sniper bot's token (sendMessage only; it does not conflict with the bot's getUpdates polling).
- A network outage on the *monitor's* side looks like a minipc outage; you get a recovery message when it clears.

---
# Push mode (dead-man switch), recommended for 24/7

The pull monitor above only works while the watching machine is awake. **Push mode** inverts it: the
monitored host sends a heartbeat every minute to an always-on watcher (a VPS); the watcher alerts when heartbeats
stop (host dead, offline or hung) or when the reported health is bad (service inactive, bot log stale, disk >= 90 %,
available memory < 250 MB). The watcher stores no credentials for the monitored host.

- `push/mm-heartbeat.sh` (+ `.service`/`.timer`): runs on the monitored host, pipes a small status block over SSH.
- `push/mm-hb-recv.sh`: installed on the watcher as the **forced command** of a dedicated key
  (`restrict,command="/usr/local/bin/mm-hb-recv"`): that key can only overwrite one status file (max 2 KiB), no shell.
- `push/mm-watch.sh`: runs on the watcher every minute (systemd timer as an unprivileged user).
  Dead = no heartbeat for `MM_DEAD_SEC` (180 s); degraded alerts need `MM_DEGRADED_RUNS` (2) consecutive bad reports;
  first heartbeat gets a 10 minute grace after install; reminders every `MM_REMIND_MIN` (30) minutes; recovery message.

Config never goes in git: `~/.config/mm-heartbeat/env` (host side: `MM_WATCHER`, `MM_KEY`, `MM_SERVICE`) and
`/etc/mm-watch/env` (watcher side: `MM_TG_TOKEN`, `MM_TG_CHAT`, `MM_NAME`).
Test the alert path: `sudo -u minimon MM_WATCH_ENV=/etc/mm-watch/env /usr/local/bin/mm-watch.sh --test`.
