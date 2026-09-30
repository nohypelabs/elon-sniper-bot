# Deploy to minipc (24h paper-testing box)

Runs as a **systemd user service** (`elon-sniper`) on the minipc; linger is enabled so it survives logout/reboot.

```bash
deploy/deploy.sh            # commit first; ships git HEAD (no .env / node_modules / data)
deploy/deploy.sh --no-restart
```

Set the target once: `cp deploy/local.env.example deploy/local.env` and fill in host/port/key (git-ignored, this repo is public).

## First time
1. Copy `.env` once (never in git): `scp -i <key> -P <port> .env <user>@<host>:elon-sniper-bot/.env`
   - keep `PAPER_TRADING=true`
   - set `DASHBOARD_PASSWORD` (any non-empty value enables Basic auth)
2. **Stop the local bot first.** Two instances polling the same `TELEGRAM_BOT_TOKEN` fight over `getUpdates` and both paper-trade the same feed.
3. `deploy/deploy.sh`

## Operate
```bash
S="ssh -i <key> -p <port> <user>@<host>"
$S 'systemctl --user status elon-sniper'
$S 'journalctl --user -u elon-sniper -f'
$S 'systemctl --user restart elon-sniper'
```

## Dashboard from your laptop (nothing exposed to the internet)
```bash
ssh -i <key> -p <port> -L 3001:localhost:3001 <user>@<host>
# then http://localhost:3001  (user: DASHBOARD_USER, default admin)
```
`cloudflared` is not installed on the minipc, so Telegram `/tunnel` won't work there; use the SSH tunnel.
Telegram `/status`, `/config`, `/set`, `/preset` work as usual.
