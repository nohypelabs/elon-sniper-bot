import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  // Solana
  RPC_URL: process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'),
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || '',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',

  // Sniper
  BUY_AMOUNT_SOL: parseFloat(process.env.BUY_AMOUNT_SOL || '0.5'),
  BUY_AMOUNT_SECONDARY: parseFloat(process.env.BUY_AMOUNT_SECONDARY || '0.05'),
  PUMP_PRIORITY_MODE: process.env.PUMP_PRIORITY_MODE === 'true',
  PUMP_MAX_POSITIONS: parseInt(process.env.PUMP_MAX_POSITIONS || '3'),
  MIN_MCAP_USD: parseFloat(process.env.MIN_MCAP_USD || '0'),
  MAX_MCAP_USD: parseFloat(process.env.MAX_MCAP_USD || '5000'),
  TAKE_PROFIT_PERCENT: parseFloat(process.env.TAKE_PROFIT_PERCENT || '60'),
  STOP_LOSS_PERCENT: parseFloat(process.env.STOP_LOSS_PERCENT || '18'),
  MAX_SLIPPAGE_BPS: parseInt(process.env.MAX_SLIPPAGE_BPS || '1500'),
  AUTO_SELL: process.env.AUTO_SELL !== 'false',
  PRIORITY_FEE_BUY_SOL:  parseFloat(process.env.PRIORITY_FEE_BUY_SOL  || '0.0000712'),
  PRIORITY_FEE_SELL_SOL: parseFloat(process.env.PRIORITY_FEE_SELL_SOL || '0.0000712'),
  MAX_FEE_SOL:           parseFloat(process.env.MAX_FEE_SOL            || '0.00009'),
  ANTI_MEV:              process.env.ANTI_MEV !== 'false',

  // Paper
  PAPER_TRADING: process.env.PAPER_TRADING !== 'false',
  PAPER_STARTING_CAPITAL_USD: parseFloat(process.env.PAPER_STARTING_CAPITAL_USD || '100'),
  BUY_AMOUNT_USD: parseFloat(process.env.BUY_AMOUNT_USD || '0'),
  MIN_SNIPE_USD: parseFloat(process.env.MIN_SNIPE_USD || '10'),

  // Dashboard auth (HTTP Basic). Empty password = auth disabled.
  DASHBOARD_USER:     process.env.DASHBOARD_USER || 'admin',
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || '',

  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

  // GMGN
  GMGN_API_KEY: process.env.GMGN_API_KEY || '',

  // Twitter
  ELON_USER_ID: process.env.ELON_USER_ID || '44196397',
  TWEET_POLL_INTERVAL_MS: parseInt(process.env.TWEET_POLL_INTERVAL_MS || '5000'),
  NITTER_INSTANCES: (process.env.NITTER_INSTANCES || 'https://nitter.net').split(',').map(s => s.trim()),

  // PumpFun Sniper mode
  PUMP_SNIPE_ENABLED:    process.env.PUMP_SNIPE_ENABLED === 'true',
  PUMP_MIN_DEV_BUY_SOL: parseFloat(process.env.PUMP_MIN_DEV_BUY_SOL || '0.5'),
  PUMP_MAX_DEV_BUY_SOL: parseFloat(process.env.PUMP_MAX_DEV_BUY_SOL || '10'),
  PUMP_MIN_MCAP_SOL:    parseFloat(process.env.PUMP_MIN_MCAP_SOL || '0'),
  PUMP_MAX_MCAP_SOL:    parseFloat(process.env.PUMP_MAX_MCAP_SOL || '50'),
  PUMP_MIN_VOLUME_SOL:  parseFloat(process.env.PUMP_MIN_VOLUME_SOL || '1.2'), // real SOL in curve = mcap - 30
  PUMP_SECURITY_CHECK:  process.env.PUMP_SECURITY_CHECK !== 'false',
  PUMP_FAST_MODE:       process.env.PUMP_FAST_MODE === 'true', // buy first, check after
  PUMP_BLOCK_MAYHEM:    process.env.PUMP_BLOCK_MAYHEM !== 'false',
  PUMP_ONLY_NEW_PAIR:   process.env.PUMP_ONLY_NEW_PAIR !== 'false',
  PUMP_CREATOR_COOLDOWN_MS: parseInt(process.env.PUMP_CREATOR_COOLDOWN_MS || '300000'), // 5 min
  PUMP_MIN_NAME_LEN:    parseInt(process.env.PUMP_MIN_NAME_LEN || '3'),
  PUMP_MIN_SYMBOL_LEN:  parseInt(process.env.PUMP_MIN_SYMBOL_LEN || '2'),
  PUMP_REQUIRE_SOCIALS: process.env.PUMP_REQUIRE_SOCIALS === 'true',
  PUMP_MAX_SESSION_LOSS_SOL: parseFloat(process.env.PUMP_MAX_SESSION_LOSS_SOL || '0.8'),
  PUMP_MAX_CONSECUTIVE_LOSSES: parseInt(process.env.PUMP_MAX_CONSECUTIVE_LOSSES || '4'),
  PUMP_BLACKLIST_WORDS: (process.env.PUMP_BLACKLIST_WORDS || 'test,rug,scam,honeypot,fake,copy,dupe').split(',').map(s => s.trim().toLowerCase()),
  PUMP_WHITELIST_WORDS: (process.env.PUMP_WHITELIST_WORDS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  PUMP_MAX_HOLD_MINUTES: parseInt(process.env.PUMP_MAX_HOLD_MINUTES || '30'),
  PUMP_MAX_HOLD_LOSS_MINUTES: parseInt(process.env.PUMP_MAX_HOLD_LOSS_MINUTES || '5'),
  PUMP_SOL_PRICE_USD: parseFloat(process.env.PUMP_SOL_PRICE_USD || '150'),

  // Dev wallet history check (Helius API)
  PUMP_DEV_WALLET_CHECK:     process.env.PUMP_DEV_WALLET_CHECK === 'true',
  PUMP_MAX_LAUNCHES_24H:     parseInt(process.env.PUMP_MAX_LAUNCHES_24H || '3'),
  PUMP_DEV_CHECK_TIMEOUT_MS: parseInt(process.env.PUMP_DEV_CHECK_TIMEOUT_MS || '2000'),

  // Token observation (pre-buy trade analysis)
  PUMP_OBSERVE_ENABLED:    process.env.PUMP_OBSERVE_ENABLED === 'true',
  PUMP_OBSERVE_SECONDS:    parseInt(process.env.PUMP_OBSERVE_SECONDS || '60'),
  PUMP_MIN_UNIQUE_BUYERS:  parseInt(process.env.PUMP_MIN_UNIQUE_BUYERS || '5'),
  PUMP_MIN_BUY_RATIO:      parseFloat(process.env.PUMP_MIN_BUY_RATIO || '0.7'),
  PUMP_MIN_SOL_VELOCITY:   parseFloat(process.env.PUMP_MIN_SOL_VELOCITY || '0.1'),
  PUMP_MAX_OBSERVE_TOKENS: parseInt(process.env.PUMP_MAX_OBSERVE_TOKENS || '20'),

  // Multi-level take profit
  TP1_PERCENT:      parseFloat(process.env.TP1_PERCENT || '30'),   // first TP
  TP1_SELL_PERCENT: parseFloat(process.env.TP1_SELL_PERCENT || '50'), // sell 50% at TP1
  TP2_PERCENT:      parseFloat(process.env.TP2_PERCENT || '80'),   // second TP — sell all
  MOONBAG_ENABLED:  process.env.MOONBAG_ENABLED !== 'false',
  MOONBAG_PERCENT:  parseFloat(process.env.MOONBAG_PERCENT || '15'),
  // Moonbag remainder management: exit the kept remainder when its value
  // ratio falls MOONBAG_TRAIL_PERCENT below the peak ratio (Stage 9a).
  MOONBAG_TRAIL_PERCENT: parseFloat(process.env.MOONBAG_TRAIL_PERCENT || '30'),

  // Trailing TP: after TP1 the rest rides (no fixed TP2) and exits when price
  // falls TRAILING_TP_DROP_PERCENT points below its peak PnL (floor: breakeven).
  TRAILING_TP_ENABLED:      process.env.TRAILING_TP_ENABLED === 'true',
  TRAILING_TP_DROP_PERCENT: parseFloat(process.env.TRAILING_TP_DROP_PERCENT || '15'),

  // Ask on Telegram (Buy/Reject buttons) before each auto-snipe buy.
  BUY_APPROVAL_ENABLED:    process.env.BUY_APPROVAL_ENABLED === 'true',
  BUY_APPROVAL_TIMEOUT_SEC: parseInt(process.env.BUY_APPROVAL_TIMEOUT_SEC || '20'),

  // ── Stage 9b-A: LIVE-mode lock (separate block; do not merge above so a
  // 3-way merge with the MOONBAG_TRAIL_PERCENT addition stays trivial).
  // Env-only unlock: NOT in EDITABLE_CONFIG, never persisted by tryApplyConfig.
  LIVE_TRADING_ALLOWED: process.env.LIVE_TRADING_ALLOWED === 'true',
};

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const WSOL_MINT = SOL_MINT;
