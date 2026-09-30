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
