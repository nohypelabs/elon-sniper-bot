# Elon Sniper Bot — Progress & Roadmap

## Overview
Bot yang monitor tweet @elonmusk, extract kata-kata unik/meme, cari token di pump.fun/DexScreener, dan snipe swap SOL→Token secepat mungkin. Target masuk di bawah $5K mcap.

## Current Status: MVP COMPLETE (Paper Trading)
Tanggal: 2026-04-04

---

## ✅ Completed

### 1. Project Setup
- TypeScript + Node.js project di `/DataPopOS/projects/elon-sniper-bot`
- Dependencies: @solana/web3.js, axios, bs58, dotenv, node-telegram-bot-api
- Systemd service file ready (`elon-sniper.service`)
- Paper trading mode ON by default

### 2. Tweet Monitor (`src/monitor/tweet.monitor.ts`)
- Polling @elonmusk tweets setiap 5 detik
- Source 1: Nitter RSS (rotating instances)
- Source 2: Twitter syndication embed endpoint (fallback, no auth)
- Auto-skip retweets, hanya original tweets
- Deduplicate seen tweets, cap memory at 1000 entries
- Skip old tweets saat first load (cuma proses yang baru)

### 3. Keyword Extractor (`src/monitor/keyword.extractor.ts`)
- Extract ALL CAPS words (high meme potential, score 10)
- Extract hashtags (score 8)
- Extract quoted phrases "like this" (score 9)
- Emoji → token name mapping (🚀→rocket, 🐸→pepe, 🐕→doge, dll)
- Filter common English stop words (500+ words)
- Detect meme-adjacent words (inu, pepe, chad, based, grok, dll)
- Generate compound keywords dari adjacent words
- Return top 15 keywords sorted by meme-score

### 4. Token Finder (`src/scanner/token.finder.ts`)
- Search pump.fun API (new launches, sorted by creation time)
- Search pump.fun search endpoint
- Search DexScreener (broader coverage)
- Parallel search across all sources
- Deduplicate by mint address
- Filter: mcap > 0 && mcap <= $5K (configurable)
- Sort by lowest mcap first (earliest entry opportunity)

### 5. Jupiter Swap (`src/swap/jupiter.swap.ts`)
- Buy: SOL → Token via Jupiter V6 Aggregator
- Sell: Token → SOL
- Auto slippage (default 15%)
- skipPreflight untuk max speed
- Priority fee: auto
- Paper trading mode (simulated buys/sells)
- Get token balance, SOL balance helpers

### 6. Telegram Bot (`src/telegram/bot.ts`)
- Commands: /sniper, /sell, /config, /help
- Alert: tweet detected, tokens found, buy/sell executed
- Inline keyboard buttons: one-tap BUY per token, SELL button
- Callback query handler untuk button presses
- Show token details: mcap, liquidity, volume, age, chart link

### 7. Orchestrator (`src/index.ts`)
- Wire: tweet monitor → keyword extractor → token finder → telegram alert → swap
- Active position tracking (Map by mint address)
- Position monitor loop (15s interval): auto TP/SL
- Retry token search at 30s and 60s after tweet (token might not exist yet)
- Graceful shutdown (SIGINT/SIGTERM)

---

## ⏳ TODO / Next Session

### High Priority
- [ ] **Test & start service** — `sudo systemctl start elon-sniper`
- [ ] **Test Telegram commands** — `/sniper`, `/config`, `/help`
- [ ] **Verify Nitter RSS** — Check if current instances are alive, update if needed
- [ ] **Add Helius RPC** — Isi HELIUS_API_KEY di .env buat RPC yang lebih cepat
- [ ] **Live wallet setup** — Isi WALLET_PRIVATE_KEY, switch PAPER_TRADING=false

### Medium Priority
- [ ] **WebSocket tweet monitor** — Ganti polling ke WebSocket/streaming biar lebih cepat
- [ ] **pump.fun WebSocket** — Monitor new token launches realtime via pump.fun WS
- [ ] **Birdeye API integration** — Tambah source token search
- [ ] **Smart wallet tracker module** — Track profitable wallets, detect their buys
- [ ] **Position PnL tracking** — Realtime PnL update di Telegram
- [ ] **Multiple position support** — Bisa hold >1 token sekaligus
- [ ] **Database persistence** — Save positions & history ke SQLite

### Low Priority / Nice to Have
- [ ] **Auto-buy mode** — Option buat auto-buy tanpa perlu tap button (high risk)
- [ ] **Trailing stop loss** — Geser SL naik seiring profit naik
- [ ] **Partial sell** — Jual 50% di target pertama, sisanya trailing
- [ ] **Blacklist tokens** — Skip token yang udah pernah rug
- [ ] **Tweet sentiment analysis** — Score tweet positivity buat filter lebih baik
- [ ] **Multi-account support** — Monitor lebih dari Elon (Vitalik, CZ, dll)
- [ ] **Dashboard web UI** — Simple HTML dashboard buat monitoring

---

## Config Reference (.env)

| Variable | Default | Description |
|---|---|---|
| SOLANA_RPC_URL | mainnet public | RPC endpoint |
| HELIUS_API_KEY | (empty) | Helius RPC key (recommended) |
| WALLET_PRIVATE_KEY | (empty) | Base58 private key |
| BUY_AMOUNT_SOL | 0.5 | SOL per buy |
| MAX_MCAP_USD | 5000 | Max market cap to buy |
| TAKE_PROFIT_PERCENT | 500 | Auto sell at +500% |
| STOP_LOSS_PERCENT | 50 | Auto sell at -50% |
| MAX_SLIPPAGE_BPS | 1500 | 15% slippage |
| AUTO_SELL | true | Auto TP/SL |
| PAPER_TRADING | true | Simulated trades |
| TWEET_POLL_INTERVAL_MS | 5000 | Tweet check interval |
| NITTER_INSTANCES | nitter.net,... | Comma-separated |

## Architecture

```
src/
├── config/index.ts          — Config dari .env
├── monitor/
│   ├── tweet.monitor.ts     — Poll @elonmusk tweets
│   └── keyword.extractor.ts — Extract meme keywords
├── scanner/
│   └── token.finder.ts      — Search pump.fun + DexScreener
├── swap/
│   └── jupiter.swap.ts      — Jupiter V6 swap executor
├── telegram/
│   └── bot.ts               — Telegram alerts & commands
├── utils/
│   └── logger.ts            — Logger
└── index.ts                 — Main orchestrator
```

## Flow Diagram

```
@elonmusk tweets "GROK is amazing! 🚀"
     ↓ (5s poll)
Keyword Extractor → ["GROK", "grok", "rocket", "amazing"]
     ↓
Token Finder (parallel)
  ├─ pump.fun search "grok" → found $GROK at $2K mcap ✅
  ├─ pump.fun search "rocket" → found $ROCKET at $8K mcap ❌ (over max)
  └─ DexScreener "grok" → found $GROK at $2K mcap (dedup)
     ↓
Telegram: "🎯 1 TOKEN FOUND! ⭐ GROK — $2K mcap"
          [⭐ BUY GROK (0.5 SOL)]
     ↓ (user taps)
Jupiter Swap: 0.5 SOL → $GROK
     ↓
Position Monitor (every 15s)
  ├─ +500% → Auto sell ✅ 🎯
  └─ -50%  → Auto sell ❌ 🛑
```

## Related Projects
- **DLMM LP Agent**: `/DataPopOS/projects/dlmm-lp-agent` — Meteora DLMM liquidity provider
- **Solana Token Scanner**: `~/solana-token-scanner.js` — Basic token scanner
- **Solana Wallet Monitor**: `~/solana-wallet-monitor` — Wallet tracking tool
