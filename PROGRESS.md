# Elon Sniper Bot — Progress Log

Last updated: 2026-09-30

---

## Status: PAPER TRADING on the minipc — $100 paper account, $10 per snipe. LIVE is locked (LIVE_TRADING_ALLOWED).

---

## Hardening log (2026-09-30)

Built with several coding agents in parallel (opencode, Cline, one aborted freebuff run); every stage was reviewed and re-tested by the lead agent before commit.

| Stage | What |
|---|---|
| 1 | Exit rules extracted to one pure `evaluateExit` (`src/strategy/exit-rules.ts`), shared by realtime callback and poll loop |
| 2 | Dashboard: request bodies forwarded, auth module, CSRF/CSWSH origin guard |
| 3 | Prisma + Supabase replaced by embedded PGlite via Drizzle (`data/sniper.pglite`, migrations in `drizzle/`) |
| 4 | Testable approval gate (`BUY_APPROVAL_ENABLED`), entry re-priced from the live feed after approval |
| 5 | Config edits validated (ranges, TP1 < TP2, atomic `.env` write) |
| 6 | `/set`, `/preset`, `/config` as pure tested functions; `/config` shows the real strategy |
| 7 | Latency/slippage instrumentation: `/latency`, `GET /api/latency`, event-loop lag, `LatencyTrace` table |
| 8 | Paper account: `PAPER_STARTING_CAPITAL_USD` (100), `BUY_AMOUNT_USD` (10, min `MIN_SNIPE_USD`), ledger rebuilt from trades |
| 9 | From an adversarial review: failed sells retry with backoff instead of bricking the position; moonbag remainder is trailed (`MOONBAG_TRAIL_PERCENT`); NaN safe; ghost placeholders fixed; restart recovery of open positions; LIVE lock; safe alert HTML; DB lock file |
| e2e | `src/dashboard/server.e2e.test.ts` runs the real server against a temp DB (29 tests) |

Known limits: paper fills use a fake constant price, so paper PnL ignores latency and slippage (use `/latency` before going live); a concurrent buy can pass `canAfford` twice before the debit; partial fills on live sells are not detected (remaining tokens assume a full fill); the wallet private key is still handled via the dashboard/`.env` (no HSM/keystore).

## Price feed (Stage 10, 2026-09-30)

PumpPortal delivers `subscribeNewToken` for free but answers every `subscribeTokenTrade` with *"only available when connecting with an API key funded with at least 0.02 SOL"* — so with no key the observer never saw a trade and open positions had no real-time price (DexScreener fallback only). New default `PUMP_TRADE_FEED=auto`: uses the keyless **curve feed** (plain Solana `accountSubscribe` on the bonding-curve PDA via `SOLANA_WS_URL`, parsed with `src/scanner/bonding-curve.ts`, one shared socket with backoff reconnect + 30s ping + 90s watchdog in `src/scanner/curve-feed.ts`) unless `PUMPPORTAL_API_KEY` is set — and auto-switches at runtime if the rejection arrives mid-stream (one warning + one Telegram alert per process). Selection lives in `selectTradeSource` (`src/scanner/pumpfun.listener.ts`); `subscribeToTrades` keeps its signature so positions, approval tracking and restored positions all get live prices through the same path. Approximation: trader identities are invisible in account state, so in curve mode the observer (`TokenObserver.onCurveUpdate`) derives buy/sell events from consecutive `realSolReserves` deltas and the unique-buyers rule becomes **buy events ≥ `PUMP_MIN_BUY_EVENTS`**; zero updates yields `no_data` (a feed gap, not a market verdict). Feed health shows in `BotState.feed` + `/status`, and positions with no price for 120s get one Telegram stale alert. Probe: `scripts/probe-curve-feed.ts`. Fixture note: the spec's base64 snapshot and its quoted reserve numbers are two different slots of the same curve (same supply, same 30-SOL floor) — tests encode the quoted numbers exactly and assert the blob structurally.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Bot Process  (pnpm dev)                                │
│                                                         │
│  PumpFun Listener ──► Filter ──► Security Check ──► Buy │
│  (PumpPortal WS)       ↓                               │
│                   Price Sub (WS)                        │
│                   Real-time TP/SL                       │
│                                                         │
│  Tweet Monitor ──► Keyword ──► Token Finder ──► Buy     │
│  (Nitter poll)                 (DexScreener)            │
│                                                         │
│  Position Monitor (3s loop)                             │
│  TP1 / TP2 / SL / Trailing SL / Max Hold               │
│                                                         │
│  Hono :3001 ◄── PostgreSQL (Supabase + Prisma)          │
│  WebSocket /ws                                          │
│  React Dashboard                                        │
└─────────────────────────────────────────────────────────┘
```

---

## File Map

```
src/
├── index.ts                  Main orchestrator, position manager
├── config/index.ts           All env vars
├── scanner/
│   ├── pumpfun.listener.ts   PumpPortal WS — new token events + price feed
│   └── token.finder.ts       DexScreener keyword search
├── monitor/
│   └── tweet.monitor.ts      Nitter polling for @elonmusk
├── swap/
│   ├── gmgn.swap.ts          GMGN API (primary, Axiom-style fee, MEV off)
│   └── jupiter.swap.ts       Jupiter V6 (fallback)
├── backtest/
│   └── runner.ts             Monte Carlo TP/SL simulator
├── dashboard/
│   └── server.ts             Hono REST + WebSocket + pause/resume + backtest API
├── db/
│   └── client.ts             Prisma singleton + logEvent()
└── telegram/
    └── bot.ts                Alerts + /status /sell commands

dashboard/src/
├── App.tsx                   UI: Positions / Chart / History / Backtest tabs
├── hooks/useBot.ts           WS + polling + pause/resume/sell
└── types.ts
```

---

## Features Completed

### PumpFun Sniper
- PumpPortal WebSocket — receives new token creation in <100ms
- Multi-layer filter:
  - Dev buy range (0.3–5 SOL)
  - Mcap range (31–50 SOL)
  - Volume filter (min 0.5 SOL real in bonding curve = mcap - 30)
  - Creator cooldown 5 min
  - Blacklist words
  - Whitelist words (optional)
  - Max 5 concurrent positions
- GMGN honeypot check (4s timeout, fail-open)
- Real-time price via PumpPortal trade subscription after buy
- DexScreener fallback every 3s (kicks in ~2-5min)

### Multi-Level Take Profit
```
+30%  → TP1: sell 80%  (lock modal + profit)
         SL slides to breakeven
+50%  → TP2: sell 20%  (close all)
-25%  → SL (before TP1)
  0%  → Trailing SL (after TP1, price returns to entry)
30min → Max Hold auto-sell
```
- `isSelling` flag prevents double-sell race conditions
- Immediate SL/TP check in PumpPortal price callback (not just 3s loop)

### Fee Config — Axiom-equivalent
```
Priority fee:  0.0000712 SOL (~$0.01/tx)   vs old 0.001 SOL ($0.15/tx) — 14x cheaper
Max fee cap:   0.00009 SOL
MEV/JITO:      OFF (pump.fun bonding curve can't be sandwiched)
Slippage:      20%
```

### Dashboard (http://localhost:3001)
- Real-time WS push every 5s
- **Pause / Resume** bot from UI (no terminal restart needed)
- Manual sell per position
- 4 tabs:
  - **Positions** — live PnL, age, entry vs current price
  - **Chart** — cumulative PnL line chart
  - **History** — full trade table with Solscan links
  - **Backtest** — Monte Carlo simulator (below)

### Backtest Tab
- Configurable: TP1, TP2, SL, max hold, buy amount, num simulations
- 4 weighted price scenarios (real pump.fun distribution):
  - Dead 35% — bleed to near zero
  - Dump 40% — quick pump then hard dump
  - Pump 20% — healthy pump, may hit TP
  - Moon 5%  — sustained uptrend
- Shows: win rate, total PnL, expectancy per trade, breakdown by scenario
- Change strategy params and re-run without restarting bot

### Telegram Alerts
- New token found
- Buy executed
- Sell executed (with PnL %)
- Honeypot detected / errors
- `/status` — positions + uptime + PnL
- `/sell` — sell all positions

### Database (Supabase PostgreSQL)
- `Trade` — full buy/sell history with PnL, reason, source
- `Position` — active open positions
- `BotEvent` — lifecycle events

---

## Current `.env` Settings

```env
PAPER_TRADING=true           ← change to false for live

BUY_AMOUNT_SOL=0.5
TP1_PERCENT=30
TP1_SELL_PERCENT=80
TP2_PERCENT=50
STOP_LOSS_PERCENT=25
MAX_SLIPPAGE_BPS=2000

PRIORITY_FEE_BUY_SOL=0.0000712
PRIORITY_FEE_SELL_SOL=0.0000712
MAX_FEE_SOL=0.00009
ANTI_MEV=false

PUMP_SNIPE_ENABLED=true
PUMP_MIN_DEV_BUY_SOL=0.3
PUMP_MAX_DEV_BUY_SOL=5
PUMP_MIN_MCAP_SOL=31
PUMP_MAX_MCAP_SOL=50
PUMP_MIN_VOLUME_SOL=0.5
PUMP_MAX_POSITIONS=5
PUMP_SECURITY_CHECK=true
PUMP_FAST_MODE=false
PUMP_CREATOR_COOLDOWN_MS=300000
PUMP_MAX_HOLD_MINUTES=30
```

---

## How to Run

```bash
# Start bot + dashboard
pnpm dev

# Dashboard
http://localhost:3001

# Stop
pkill -f "tsx src/index.ts"
```

---

## Go-Live Checklist

- [ ] Run Backtest tab — verify expectancy > 0 SOL per trade
- [ ] Paper trade 24h — check win rate, avg hold time, max loss
- [ ] Wallet has enough SOL: min `BUY_AMOUNT_SOL × PUMP_MAX_POSITIONS + fees`
      (default: 0.5 × 5 = 2.5 SOL + ~0.01 SOL fees)
- [ ] Set `PAPER_TRADING=false`
- [ ] Set `PUMP_FAST_MODE=false` (security check on for first live runs)
- [ ] Watch first 10 live trades manually via dashboard + Telegram

---

## Pending / Next Session

### Done (2026-09-30)
- [x] **Cloudflare Tunnel** — Telegram `/tunnel`; refused unless `DASHBOARD_PASSWORD` is set
- [x] **Dashboard basic auth** — `DASHBOARD_USER` / `DASHBOARD_PASSWORD` in .env (HTTP + `/ws`)
- [x] **CT whale monitor** — Tier 2 accounts in `tweet.monitor.ts` + `scanner/whale-tracker.ts`
- [x] **Trailing TP** — `TRAILING_TP_ENABLED`, `TRAILING_TP_DROP_PERCENT` (after TP1 the rest rides; exit at peak - drop, floor breakeven)
- [x] **Export CSV** — History tab
- [x] **Telegram approve/reject** — `BUY_APPROVAL_ENABLED`, `BUY_APPROVAL_TIMEOUT_SEC` (timeout = reject)
- [x] **Telegram config** — `/set <name> <value>`, `/preset lowrisk`, `/config`

## Known Behaviors (Not Bugs)

| Behavior | Why |
|---|---|
| SL exits at -35% when set to -25% | pump.fun single candle can move -30% instantly; 3s loop + realtime callback minimizes but can't eliminate |
| PnL shows 0% right after buy | Normal — price only updates when someone else trades that token |
| Multiple same-symbol positions (e.g. 3x CHARLIE) | Different mint + creator, symbol dedup not yet implemented |
