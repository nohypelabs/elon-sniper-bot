# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Run bot + dashboard in dev mode (tsx with hot reload)
pnpm dev

# Build everything (backend TypeScript + dashboard frontend)
pnpm build

# Run compiled production build
pnpm start

# Database operations
pnpm db:generate    # Generate SQL migration via drizzle-kit after schema changes
pnpm db:backfill-pnl  # Backfill PnL for existing trades

# Run dashboard only (Vite dev server)
pnpm dashboard:dev

# Systemd service management (production)
sudo systemctl restart elon-sniper
sudo systemctl status elon-sniper
journalctl -u elon-sniper -f  # View logs
```

## Architecture Overview

This is a Solana meme coin trading bot with two primary sniping modes:

1. **Tweet Sniper**: Monitors Twitter/X accounts (Elon, Trump, CT whales) via Nitter RSS polling. When a tweet contains keywords, searches for matching tokens on PumpFun/DexScreener and executes buys.

2. **PumpFun Sniper**: Connects to PumpPortal WebSocket for real-time (<100ms) new token creation events. Filters by dev buy amount, market cap, volume, and executes rapid snipes.

### Core Components

**Main Orchestrator** (`src/index.ts` - `ElonSniper` class)
- Manages active positions as in-memory `Map<string, ActivePosition>`
- Implements multi-level TP/SL strategy:
  - TP1 (+30%): sell configurable % (default 80%), lock profit, SL moves to breakeven
  - TP2 (+50%): close remaining position (or keep moonbag %)
  - SL (-25%): stop loss before TP1 hit
  - Trailing SL: after TP1, exit if price returns to breakeven
  - Max hold time: auto-sell after N minutes
- Real-time price updates via PumpPortal WebSocket subscription (primary) + DexScreener polling (fallback, ~2-5min delay)
- Risk controls: max concurrent positions, max session loss, max consecutive losses (auto-pause on trigger)

**Tweet Monitor** (`src/monitor/tweet.monitor.ts`)
- Multi-account Nitter RSS polling with Tier 1/2 system
- Tier 1 (always): elonmusk, realDonaldTrump, sama
- Tier 2 (round-robin): CT whales (blknoiz06, MustStopMurad, cobie, etc.)
- Warmup phase on startup: pre-polls all accounts to avoid false positives

**Token Scanner** (`src/scanner/token.finder.ts`)
- Searches PumpFun API and DexScreener for tokens matching tweet keywords
- Filters by market cap range, chain (Solana only), liquidity
- Returns sorted by lowest mcap (earliest entry opportunity)

**PumpFun Listener** (`src/scanner/pumpfun.listener.ts`)
- WebSocket connection to `wss://pumpportal.fun/api/data`
- Receives new token creation events in real-time
- Multi-layer filtering:
  - Dev buy range (0.3-5 SOL)
  - Initial mcap range (31-50 SOL)
  - Volume filter (min SOL in bonding curve)
  - Creator cooldown (5 min)
  - Blacklist/whitelist words
  - Symbol dedup (skip if already holding same symbol)
- After buy, subscribes to real-time trade feed for immediate SL/TP checks

**Swap Executors**
- **GMGN** (`src/swap/gmgn.swap.ts`) - Primary, Anti-MEV (JITO) support, honeypot check API
- **Jupiter V6** (`src/swap/jupiter.swap.ts`) - Fallback when GMGN fails or no API key
- Both support paper trading mode for backtesting

**Dashboard** (`src/dashboard/server.ts` + `dashboard/src/`)
- Hono HTTP server + WebSocket on port 3001
- React SPA with real-time state updates (5s WS push)
- Tabs: Positions (live PnL), Chart (cumulative PnL), History (trade table), Backtest (Monte Carlo simulator)
- API endpoints: `/api/status`, `/api/positions`, `/api/trades`, `/api/pnl`, `/api/stats`, `/api/config`, `/api/wallet/*`
- Runtime config editing (persists to .env)

**Telegram Bot** (`src/telegram/bot.ts`)
- Polling-based (no webhooks)
- Commands: `/status`, `/saldo`, `/pnl`, `/history`, `/sell`, `/pause`, `/resume`, `/live`, `/paper`, `/tunnel`, `/config`, `/help`
- Inline buttons for buy/sell confirmation
- Cloudflare Tunnel integration for remote dashboard access

**Database** (`src/db/schema.ts`, migrations in `drizzle/`)
- Embedded local Postgres via PGlite (file-backed at `DB_PATH`, default `data/sniper.pglite`), Drizzle ORM
- `Trade`: BUY/SELL records with PnL, reason, source (gmgn/jupiter/paper), tx signature
- `Position`: Active positions (in-memory primary, DB for persistence)
- `BotEvent`: Lifecycle events for debugging/auditing

## Key Patterns

**Callback Registration System**
- Components (telegram, dashboard) register callbacks into main orchestrator at startup
- Pattern: `registerHandlers({ getState, onSell, onPause, onResume, ... })`
- Allows decoupled control flow from UI/commands to bot logic

**Position State Machine**
```typescript
interface ActivePosition {
  token: FoundToken;
  buyResult: SwapResult;
  entryTime: number;
  entryPriceUsd: number;
  currentPriceUsd: number; // Updated in realtime via WS
  solSpent: number;
  remainingTokens: number; // Tracks partial sells (TP1)
  tp1Hit: boolean;
  tp2Hit: boolean;
  isSelling: boolean;  // Prevents double-sell race conditions
  tweetText?: string;
}
```

**Dual Price Update System**
1. **PumpPortal WS** (after buy): Immediate price feed, fires TP/SL checks instantly
2. **DexScreener polling** (3s loop): Fallback for when pair not yet indexed by PumpPortal (~2-5min)

**Configuration System** (`src/config/index.ts`)
- Single `CONFIG` object with all env vars
- `EDITABLE_CONFIG` in dashboard/server.ts defines which values can be changed at runtime
- Changes persist to `.env` file

**Paper Trading Mode**
- Set `PAPER_TRADING=true` in .env
- Swap executors return fake transactions (paper_buy/paper_sell prefixes)
- DB still records all trades for backtesting/analysis

## Important Environment Variables

```env
# Core
PAPER_TRADING=true              # Must be false for live trading
WALLET_PRIVATE_KEY_ENCRYPTED=   # Auto-managed by dashboard connect
DB_PATH=                        # PGlite file path (default data/sniper.pglite)

# Trading
BUY_AMOUNT_SOL=0.5
TP1_PERCENT=30
TP1_SELL_PERCENT=80
TP2_PERCENT=50
STOP_LOSS_PERCENT=25
MAX_SLIPPAGE_BPS=2000
AUTO_SELL=true

# PumpFun Sniper
PUMP_SNIPE_ENABLED=true
PUMP_MIN_DEV_BUY_SOL=0.3
PUMP_MAX_DEV_BUY_SOL=5
PUMP_MIN_MCAP_SOL=31
PUMP_MAX_MCAP_SOL=50
PUMP_MIN_VOLUME_SOL=0.5
PUMP_MAX_POSITIONS=5
PUMP_MAX_HOLD_MINUTES=30
PUMP_SECURITY_CHECK=true
PUMP_FAST_MODE=false
PUMP_ONLY_NEW_PAIR=true

# Fees (Axiom-style low cost)
PRIORITY_FEE_BUY_SOL=0.0000712
PRIORITY_FEE_SELL_SOL=0.0000712
MAX_FEE_SOL=0.00009
ANTI_MEV=false

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# APIs
GMGN_API_KEY=               # Required for GMGN swaps (primary)
HELIUS_API_KEY=             # Optional Helius RPC

# Twitter
ELON_USER_ID=44196397
TWEET_POLL_INTERVAL_MS=5000
NITTER_INSTANCES=https://nitter.net
```

## Database Schema Notes

- `Trade.reason` contains exit reason: "TP1 +30%", "TP2 +50%", "SL -25%", "trailing-SL", "max-hold-30min", "manual", "honeypot-detected"
- `Trade.source` indicates executor: "gmgn", "jupiter", or "paper"
- PnL is calculated only on SELL trades (BUY trades have null pnlSol/pnlPercent)
- `Position` table is mostly for persistence on restarts; primary position tracking is in-memory

## Backtest System

Located in `src/backtest/runner.ts`:
- Monte Carlo simulation with weighted scenarios (dead 35%, dump 40%, pump 20%, moon 5%)
- Configurable via dashboard Backtest tab or API
- Returns win rate, expectancy, scenario breakdown
- Used to validate TP/SL parameters before going live

## Monitoring & Logs

- Bot logs via `src/utils/logger.ts` (console with timestamps)
- Telegram alerts for all major events (tweet detected, tokens found, buy/sell executed, errors)
- Dashboard shows real-time state with WebSocket updates every 5s
- Database `BotEvent` table logs all lifecycle events for post-mortem

## Deployment

- Systemd service: `elon-sniper.service`
- Dashboard port: 3001 (auto-increments if occupied)
- Remote access: `/tunnel` Telegram command spawns Cloudflare Quick Tunnel (cloudflared)
- Wallet key encrypted in .env as `WALLET_PRIVATE_KEY_ENCRYPTED`
