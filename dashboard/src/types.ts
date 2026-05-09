export interface ActivePositionInfo {
  tokenMint: string
  symbol: string
  name: string
  apedAt: string
  entryPrice: number
  currentPrice: number
  entryMcapUsd: number
  currentMcapUsd: number
  pnlPercent: number
  pnlSol: number
  solSpent: number
  ageMinutes: number
  dex: string
  tweetText?: string
}

export interface BotState {
  mode: 'PAPER' | 'LIVE'
  running: boolean
  paused: boolean
  uptime: number
  tweetsDetected: number
  buysExecuted: number
  solBalance: number
  solPriceUsd: number
  activePositions: ActivePositionInfo[]
}

export interface BotConfig {
  BUY_AMOUNT_SOL: number
  MAX_SLIPPAGE_BPS: number
  STOP_LOSS_PERCENT: number
  TP1_PERCENT: number
  TP1_SELL_PERCENT: number
  TP2_PERCENT: number
  MOONBAG_PERCENT: number
  PRIORITY_FEE_BUY_SOL: number
  PRIORITY_FEE_SELL_SOL: number
  MAX_FEE_SOL: number
  PUMP_MAX_POSITIONS: number
  PUMP_MAX_HOLD_MINUTES: number
  PUMP_MIN_DEV_BUY_SOL: number
  PUMP_MAX_DEV_BUY_SOL: number
  PUMP_MIN_MCAP_SOL: number
  PUMP_MAX_MCAP_SOL: number
  AUTO_SELL: boolean
  ANTI_MEV: boolean
  MOONBAG_ENABLED: boolean
  PAPER_TRADING: boolean
}

export interface Stats {
  totalPnlSol: number
  wins: number
  losses: number
  total: number
  winRate: number
  avgPnlPercent: number
}

export interface Trade {
  id: string
  type: 'BUY' | 'SELL'
  tokenMint: string
  symbol: string
  name: string
  solAmount: number
  tokenAmount: number
  priceUsd: number
  mcapUsd: number
  pnlPercent: number | null
  pnlSol: number | null
  txSignature: string
  source: string
  reason: string | null
  dex: string
  createdAt: string
}

export interface PairedTrade {
  id: string
  symbol: string
  name: string
  dex: string
  reason: string | null
  pnlPercent: number | null
  pnlSol: number | null
  solAmount: number
  buyMcapUsd: number | null
  sellMcapUsd: number
  buyTime: string | null
  sellTime: string
  txSignature: string
  source: string
}

export interface PnlPoint {
  date: string
  pnlSol: number | null
  pnlPercent: number | null
  cumulative: number
  symbol: string
}
