import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  // Solana
  RPC_URL: process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'),
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || '',

  // Sniper
  BUY_AMOUNT_SOL: parseFloat(process.env.BUY_AMOUNT_SOL || '0.5'),
  MAX_MCAP_USD: parseFloat(process.env.MAX_MCAP_USD || '5000'),
  TAKE_PROFIT_PERCENT: parseFloat(process.env.TAKE_PROFIT_PERCENT || '500'),
  STOP_LOSS_PERCENT: parseFloat(process.env.STOP_LOSS_PERCENT || '50'),
  MAX_SLIPPAGE_BPS: parseInt(process.env.MAX_SLIPPAGE_BPS || '1500'),
  AUTO_SELL: process.env.AUTO_SELL !== 'false',

  // Paper
  PAPER_TRADING: process.env.PAPER_TRADING !== 'false',

  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

  // Twitter
  ELON_USER_ID: process.env.ELON_USER_ID || '44196397',
  TWEET_POLL_INTERVAL_MS: parseInt(process.env.TWEET_POLL_INTERVAL_MS || '5000'),
  NITTER_INSTANCES: (process.env.NITTER_INSTANCES || 'https://nitter.net').split(',').map(s => s.trim()),
};

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const WSOL_MINT = SOL_MINT;
