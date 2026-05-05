export interface ActivePositionInfo {
  tokenMint: string
  symbol: string
  name: string
  entryPrice: number
  currentPrice: number
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
  activePositions: ActivePositionInfo[]
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
