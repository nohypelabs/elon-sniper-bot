import { useState, useEffect } from 'react'
import { Activity, TrendingUp, Zap, ShoppingCart, Wallet, Clock, Radio, Pause, Play, FlaskConical, Download, Settings } from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell,
} from 'recharts'
import { useBot } from './hooks/useBot'
import type { Trade, PairedTrade, PnlPoint, Stats, BotConfig } from './types'

function fmt(n: number, d = 2) { return n.toFixed(d) }
function fmtPrice(n: number): string {
  if (n === 0) return '0'
  if (n >= 0.01) return `$${n.toFixed(4)}`
  // Count leading zeros after decimal point
  const zeros = Math.max(0, -Math.floor(Math.log10(n)) - 1)
  const sig = n * Math.pow(10, zeros + 4)
  return `$0.0${zeros > 0 ? '0'.repeat(zeros - 1) : ''}${Math.round(sig)}`
}
function fmtMcap(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}
function fmtAge(min: number) {
  if (min < 60) return `${Math.floor(min)}m`
  return `${(min / 60).toFixed(1)}h`
}
function fmtUptime(ms: number) {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return `${h}h ${m}m`
}
function pnlColor(v: number) {
  if (v > 0) return 'text-emerald-400'
  if (v < 0) return 'text-red-400'
  return 'text-slate-400'
}

// ─── Backtest types ───────────────────────────────────────────────

interface BacktestConfig {
  tp1Percent: number
  tp1SellPercent: number
  tp2Percent: number
  slPercent: number
  maxHoldMinutes: number
  buyAmountSol: number
  numTokens: number
}

interface BacktestResult {
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  totalPnlSol: number
  avgPnlPercent: number
  avgWinPercent: number
  avgLossPercent: number
  expectancy: number
  bestTrade:  { pnlPercent: number; exitReason: string; scenario: string }
  worstTrade: { pnlPercent: number; exitReason: string; scenario: string }
  byScenario: Record<string, { count: number; wins: number; avgPnl: number }>
}

// ─── Backtest Tab ─────────────────────────────────────────────────

function BacktestTab() {
  const [cfg, setCfg] = useState<BacktestConfig>({
    tp1Percent: 30, tp1SellPercent: 80, tp2Percent: 50,
    slPercent: 25, maxHoldMinutes: 30, buyAmountSol: 0.5, numTokens: 500,
  })
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [running, setRunning] = useState(false)

  const run = async () => {
    setRunning(true)
    try {
      const r = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      })
      setResult(await r.json())
    } finally {
      setRunning(false)
    }
  }

  const scenarios = ['dead', 'dump', 'pump', 'moon']
  const scenarioColors: Record<string, string> = {
    dead: '#ef4444', dump: '#f97316', pump: '#22c55e', moon: '#8b5cf6',
  }

  return (
    <div className="space-y-4">
      {/* Config */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-4">Strategy Config</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {[
            { key: 'tp1Percent',     label: 'TP1 %',         min: 5,  max: 200 },
            { key: 'tp1SellPercent', label: 'TP1 Sell %',    min: 10, max: 100 },
            { key: 'tp2Percent',     label: 'TP2 %',         min: 10, max: 500 },
            { key: 'slPercent',      label: 'SL %',          min: 5,  max: 90  },
            { key: 'maxHoldMinutes', label: 'Max Hold (min)', min: 5, max: 120  },
            { key: 'buyAmountSol',   label: 'Buy (SOL)',     min: 0.1, max: 10, step: 0.1 },
            { key: 'numTokens',      label: 'Simulations',  min: 100, max: 2000, step: 100 },
          ].map(({ key, label, min, max, step = 1 }) => (
            <div key={key}>
              <label className="text-xs text-slate-500 block mb-1">{label}</label>
              <input
                type="number"
                min={min} max={max} step={step}
                value={(cfg as any)[key]}
                onChange={e => setCfg(p => ({ ...p, [key]: parseFloat(e.target.value) }))}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
              />
            </div>
          ))}
        </div>
        <button
          onClick={run}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-all"
        >
          <FlaskConical size={14} />
          {running ? 'Running...' : `Run ${cfg.numTokens} Simulations`}
        </button>
      </div>

      {result && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard icon={<TrendingUp size={14}/>} label="Win Rate"     value={`${fmt(result.winRate, 0)}%`}              valueClass={result.winRate > 50 ? 'text-emerald-400' : 'text-red-400'} />
            <StatCard icon={<Wallet size={14}/>}     label="Total PnL"   value={`${result.totalPnlSol >= 0 ? '+' : ''}${fmt(result.totalPnlSol, 3)} SOL`} valueClass={pnlColor(result.totalPnlSol)} />
            <StatCard icon={<Activity size={14}/>}   label="Expectancy"  value={`${result.expectancy >= 0 ? '+' : ''}${fmt(result.expectancy, 4)} SOL`}   valueClass={pnlColor(result.expectancy)} sub="per trade avg" />
            <StatCard icon={<ShoppingCart size={14}/>} label="Trades"    value={`${result.wins}W / ${result.losses}L`}       sub={`${result.totalTrades} total`} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard icon={<TrendingUp size={14}/>} label="Avg Win"      value={`+${fmt(result.avgWinPercent, 1)}%`}  valueClass="text-emerald-400" />
            <StatCard icon={<TrendingUp size={14}/>} label="Avg Loss"     value={`${fmt(result.avgLossPercent, 1)}%`}  valueClass="text-red-400" />
            <StatCard icon={<Zap size={14}/>}        label="Best Trade"   value={`+${fmt(result.bestTrade.pnlPercent, 1)}%`}  valueClass="text-emerald-400" sub={result.bestTrade.exitReason} />
            <StatCard icon={<Zap size={14}/>}        label="Worst Trade"  value={`${fmt(result.worstTrade.pnlPercent, 1)}%`} valueClass="text-red-400"    sub={result.worstTrade.exitReason} />
          </div>

          {/* By scenario */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-slate-300 mb-3">Results by Scenario</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {scenarios.map(s => {
                const d = result.byScenario[s]
                if (!d) return null
                return (
                  <div key={s} className="bg-slate-800/50 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-2 h-2 rounded-full" style={{ background: scenarioColors[s] }} />
                      <span className="text-xs font-semibold text-slate-300 capitalize">{s}</span>
                      <span className="text-xs text-slate-500 ml-auto">{d.count}x</span>
                    </div>
                    <p className={`text-sm font-bold ${pnlColor(d.avgPnl)}`}>
                      {d.avgPnl >= 0 ? '+' : ''}{fmt(d.avgPnl * 1000, 2)} mSOL
                    </p>
                    <p className="text-xs text-slate-500">{fmt(d.wins / d.count * 100, 0)}% win</p>
                  </div>
                )
              })}
            </div>
          </div>

          {/* PnL distribution chart */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-slate-300 mb-3">PnL Distribution (SOL)</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={scenarios.map(s => ({
                  name: s,
                  pnl: result.byScenario[s] ? parseFloat((result.byScenario[s].avgPnl * 1000).toFixed(3)) : 0,
                }))}
              >
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#475569' }} />
                <YAxis tick={{ fontSize: 10, fill: '#475569' }} tickFormatter={v => `${v}m`} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                  formatter={(v) => [`${Number(v)} mSOL`, 'Avg PnL']}
                />
                <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                  {scenarios.map(s => (
                    <Cell key={s} fill={scenarioColors[s]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Settings Tab ─────────────────────────────────────────────────

function WalletConnect() {
  const [wallet, setWallet]     = useState<{ connected: boolean; address: string | null; hasStoredKey: boolean } | null>(null)
  const [input, setInput]       = useState('')
  const [show, setShow]         = useState(false)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')

  const load = () => fetch('/api/wallet').then(r => r.json()).then(setWallet)
  useEffect(() => { load() }, [])

  const connect = async () => {
    setError(''); setLoading(true)
    const r = await fetch('/api/wallet/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ privateKey: input.trim() }),
    })
    const d = await r.json()
    setLoading(false)
    if (d.ok) { setInput(''); setShow(false); load() }
    else setError(d.error || 'Gagal connect wallet')
  }

  const disconnect = async () => {
    if (!confirm('Disconnect wallet? Private key akan dihapus dari server.')) return
    await fetch('/api/wallet/disconnect', { method: 'POST' })
    load()
  }

  if (!wallet) return null

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-slate-300 mb-4">Wallet</h3>

      {wallet.connected ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-3 py-2.5 bg-emerald-900/20 border border-emerald-800/40 rounded-lg">
            <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-emerald-400 font-medium">Connected</p>
              <p className="text-xs text-slate-400 font-mono truncate">{wallet.address}</p>
            </div>
          </div>
          <button onClick={disconnect}
            className="w-full py-2 rounded-lg bg-red-900/30 text-red-400 border border-red-900/50 text-xs font-medium hover:bg-red-900/50 transition-all">
            Disconnect Wallet
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-3 py-2 bg-slate-800/50 border border-slate-700 rounded-lg">
            <span className="w-2 h-2 rounded-full bg-slate-600 shrink-0" />
            <p className="text-xs text-slate-500">No wallet connected</p>
          </div>

          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              placeholder="Paste private key (base58)..."
              value={input}
              onChange={e => { setInput(e.target.value); setError('') }}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-xs text-white font-mono focus:outline-none focus:border-violet-500 pr-16"
            />
            <button onClick={() => setShow(s => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500 hover:text-slate-300 px-2 py-1">
              {show ? 'Hide' : 'Show'}
            </button>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button onClick={connect} disabled={!input.trim() || loading}
            className="w-full py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-xs font-semibold transition-all">
            {loading ? 'Connecting...' : 'Import Wallet'}
          </button>

          <p className="text-xs text-slate-600 text-center">
            Private key dienkripsi AES-256 sebelum disimpan. Tidak pernah dikirim ke pihak ketiga.
          </p>
        </div>
      )}
    </div>
  )
}

function SettingsTab() {
  const [cfg, setCfg] = useState<BotConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(setCfg)
  }, [])

  const save = async () => {
    if (!cfg) return
    setSaving(true)
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (!cfg) return <div className="text-center py-12 text-slate-600 text-sm">Loading config...</div>

  const numField = (key: keyof BotConfig, label: string, hint: string, step = 0.01, min = 0) => (
    <div key={key}>
      <label className="text-xs text-slate-500 block mb-1">{label}</label>
      <input
        type="number" step={step} min={min}
        value={cfg[key] as number}
        onChange={e => setCfg(p => p ? { ...p, [key]: parseFloat(e.target.value) || 0 } : p)}
        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
      />
      <p className="text-xs text-slate-600 mt-0.5">{hint}</p>
    </div>
  )

  const toggle = (key: keyof BotConfig, label: string, hint: string) => (
    <div key={key} className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm text-slate-300">{label}</p>
        <p className="text-xs text-slate-600">{hint}</p>
      </div>
      <button
        onClick={() => setCfg(p => p ? { ...p, [key]: !p[key] } : p)}
        className={`shrink-0 w-10 h-5 rounded-full transition-all relative ${cfg[key] ? 'bg-violet-600' : 'bg-slate-700'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${cfg[key] ? 'left-5' : 'left-0.5'}`} />
      </button>
    </div>
  )

  return (
    <div className="space-y-4">

      <WalletConnect />

      {/* Trading */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-4">Trading</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {numField('BUY_AMOUNT_SOL',     'Buy Amount (SOL)',    'SOL per trade', 0.05, 0.01)}
          {numField('STOP_LOSS_PERCENT',  'Stop Loss %',         'Max loss sebelum cut', 1, 1)}
          {numField('TP1_PERCENT',        'TP1 %',              'Take profit level 1', 1, 1)}
          {numField('TP1_SELL_PERCENT',   'TP1 Sell %',         '% posisi dijual di TP1', 1, 1)}
          {numField('TP2_PERCENT',        'TP2 %',              'Take profit level 2 (close all)', 1, 1)}
          {numField('PUMP_MAX_POSITIONS', 'Max Posisi',         'Max posisi bersamaan', 1, 1)}
          {numField('PUMP_MAX_HOLD_MINUTES', 'Max Hold (menit)', 'Auto-sell setelah X menit (0=off)', 1, 0)}
        </div>
      </div>

      {/* Fee & Slippage */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-4">Fee & Slippage</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {numField('MAX_SLIPPAGE_BPS',       'Slippage (BPS)',         '2000 = 20%. 100 BPS = 1%', 100, 100)}
          {numField('PRIORITY_FEE_BUY_SOL',  'Priority Fee Buy (SOL)', 'Bribe ke validator saat BUY', 0.00001, 0)}
          {numField('PRIORITY_FEE_SELL_SOL', 'Priority Fee Sell (SOL)','Bribe ke validator saat SELL', 0.00001, 0)}
          {numField('MAX_FEE_SOL',            'Max Fee Cap (SOL)',       'Total fee tidak melebihi ini', 0.00001, 0)}
        </div>
      </div>

      {/* PumpFun Filter */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-4">PumpFun Filter</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {numField('PUMP_MIN_DEV_BUY_SOL', 'Min Dev Buy (SOL)', 'Dev harus beli minimal X SOL', 0.1, 0)}
          {numField('PUMP_MAX_DEV_BUY_SOL', 'Max Dev Buy (SOL)', 'Dev tidak boleh beli lebih dari X SOL', 0.5, 0)}
          {numField('PUMP_MIN_MCAP_SOL',    'Min MCap (SOL)',     'MCap minimal saat launch', 1, 0)}
          {numField('PUMP_MAX_MCAP_SOL',    'Max MCap (SOL)',     'MCap maksimal saat launch', 1, 0)}
        </div>
      </div>

      {/* Toggles */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-4">Mode</h3>
        <div className="space-y-4">
          {toggle('AUTO_SELL',     'Auto Sell',     'Bot otomatis jual berdasarkan TP/SL')}
          {toggle('ANTI_MEV',      'Anti-MEV',      'Gunakan Jito bundle untuk anti front-run')}
          {toggle('PAPER_TRADING', 'Paper Trading', '⚠️ Matikan untuk go LIVE — uang nyata!')}
        </div>
        {!cfg.PAPER_TRADING && (
          <div className="mt-3 px-3 py-2 bg-red-900/30 border border-red-800/50 rounded-lg text-xs text-red-400">
            ⚠️ LIVE MODE — setiap trade menggunakan SOL asli dari wallet kamu
          </div>
        )}
      </div>

      {/* Save */}
      <button
        onClick={save}
        disabled={saving}
        className={`w-full py-3 rounded-xl text-sm font-semibold transition-all ${
          saved ? 'bg-emerald-600 text-white' : 'bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white'
        }`}
      >
        {saved ? '✓ Saved!' : saving ? 'Saving...' : 'Save Config'}
      </button>
      <p className="text-xs text-slate-600 text-center">Perubahan langsung aktif + tersimpan ke .env (persist restart)</p>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────

export default function App() {
  const { state, connected, sell, pause, resume } = useBot()
  const [trades, setTrades]       = useState<Trade[]>([])
  const [paired, setPaired]       = useState<PairedTrade[]>([])
  const [pnlData, setPnlData]     = useState<PnlPoint[]>([])
  const [stats, setStats]         = useState<Stats | null>(null)
  const [period, setPeriod]       = useState<'1d' | '7d' | '30d' | 'all'>('all')
  const [tab, setTab]             = useState<'positions' | 'history' | 'backtest' | 'settings'>('positions')

  // History table state
  const [histPage, setHistPage]   = useState(1)
  const [histPageSize, setHistPageSize] = useState(20)
  const [sortCol, setSortCol]     = useState<keyof PairedTrade>('sellTime')
  const [sortDir, setSortDir]     = useState<'asc' | 'desc'>('desc')

  const sortedPaired = [...paired].sort((a, b) => {
    const av = a[sortCol] ?? 0
    const bv = b[sortCol] ?? 0
    if (av < bv) return sortDir === 'asc' ? -1 : 1
    if (av > bv) return sortDir === 'asc' ? 1 : -1
    return 0
  })

  function toggleSort(col: keyof PairedTrade) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
    setHistPage(1)
  }
  function SortTh({ col, label, right }: { col: keyof PairedTrade, label: string, right?: boolean }) {
    const active = sortCol === col
    return (
      <th
        className={`px-4 py-3 cursor-pointer select-none hover:text-slate-300 transition-colors ${right ? 'text-right' : 'text-left'}`}
        onClick={() => toggleSort(col)}
      >
        <span className="inline-flex items-center gap-1">
          {!right && label}
          {active ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ' ↕'}
          {right && label}
        </span>
      </th>
    )
  }

  useEffect(() => {
    fetch('/api/trades?limit=100').then(r => r.json()).then(d => setTrades(d.trades ?? []))
    fetch('/api/trades/paired?limit=100').then(r => r.json()).then(setPaired)
  }, [state.buysExecuted])

  useEffect(() => {
    fetch(`/api/pnl?period=${period}`).then(r => r.json()).then(setPnlData)
    fetch(`/api/stats?period=${period}`).then(r => r.json()).then(setStats)
  }, [period, state.buysExecuted])

  const totalPnlSol = stats?.totalPnlSol ?? (pnlData.at(-1)?.cumulative ?? 0)
  const totalPnlUsd = totalPnlSol * (state.solPriceUsd || 0)
  const winRate     = stats?.winRate ?? 0
  const winTrades   = stats?.wins ?? 0
  const sellTrades  = stats?.total ?? 0

  const exportCSV = () => {
    const headers = ['Time', 'Type', 'Symbol', 'Name', 'SOL Amount', 'Token Amount', 'Price USD', 'Mcap USD', 'PnL %', 'PnL SOL', 'Reason', 'Source', 'DEX', 'TX Signature']
    const rows = trades.map(t => [
      new Date(t.createdAt).toISOString(),
      t.type,
      t.symbol,
      t.name,
      t.solAmount,
      t.tokenAmount,
      t.priceUsd,
      t.mcapUsd,
      t.pnlPercent ?? '',
      t.pnlSol ?? '',
      t.reason ?? '',
      t.source,
      t.dex,
      t.txSignature,
    ])
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `sniper-trades-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="min-h-screen p-4 md:p-6 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center">
            <Zap size={16} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Sniper Bot</h1>
            <p className="text-xs text-slate-500">@elonmusk monitor</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${
            state.mode === 'LIVE'
              ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-800'
              : 'bg-amber-900/50 text-amber-400 border border-amber-800'
          }`}>
            {state.mode}
          </span>

          {/* Pause / Resume */}
          <button
            onClick={state.paused ? resume : pause}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
              state.paused
                ? 'bg-emerald-900/40 text-emerald-400 border-emerald-800 hover:bg-emerald-900/60'
                : 'bg-amber-900/30 text-amber-400 border-amber-800 hover:bg-amber-900/50'
            }`}
          >
            {state.paused
              ? <><Play size={12} /> Resume</>
              : <><Pause size={12} /> Pause</>
            }
          </button>

          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
        </div>
      </div>

      {/* Paused banner */}
      {state.paused && (
        <div className="mb-4 px-4 py-2.5 bg-amber-900/20 border border-amber-800/50 rounded-lg text-amber-400 text-sm flex items-center gap-2">
          <Pause size={14} />
          Bot paused — no new positions will be opened
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard icon={<Wallet size={14} />} label="SOL Balance" value={`${fmt(state.solBalance, 3)} SOL`}
          sub={state.solPriceUsd > 0 ? `≈ $${fmt(state.solBalance * state.solPriceUsd, 0)}` : undefined} />
        <StatCard
          icon={<TrendingUp size={14} />}
          label="Total PnL"
          value={`${totalPnlSol >= 0 ? '+' : ''}${fmt(totalPnlSol, 3)} SOL`}
          valueClass={pnlColor(totalPnlSol)}
          sub={state.solPriceUsd > 0 ? `≈ ${totalPnlUsd >= 0 ? '+' : ''}$${fmt(Math.abs(totalPnlUsd), 2)}` : undefined}
        />
        <StatCard icon={<Radio size={14} />} label="Tweets" value={state.tweetsDetected.toString()} />
        <StatCard icon={<ShoppingCart size={14} />} label="Win Rate" value={`${fmt(winRate, 0)}%`} sub={`${winTrades}/${sellTrades} sells`} />
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <MiniStat label="Uptime" value={fmtUptime(state.uptime)} icon={<Clock size={12} />} />
        <MiniStat label="Active" value={state.activePositions.length.toString()} icon={<Activity size={12} />} />
        <MiniStat label="Buys"   value={state.buysExecuted.toString()} icon={<ShoppingCart size={12} />} />
      </div>

      {/* PnL Chart — always visible */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-300">Cumulative PnL (SOL)</h3>
          <div className="flex gap-1 bg-slate-800 rounded-lg p-0.5">
            {(['1d', '7d', '30d', 'all'] as const).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                  period === p ? 'bg-violet-600 text-white' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {p === 'all' ? 'All' : p.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        {pnlData.length === 0 ? (
          <Empty text="No completed trades yet" />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={pnlData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#475569' }} tickFormatter={v => new Date(v).toLocaleDateString()} />
              <YAxis tick={{ fontSize: 10, fill: '#475569' }} tickFormatter={v => `${v}`} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                labelStyle={{ color: '#94a3b8', fontSize: 11 }}
                formatter={(v) => [`${Number(v).toFixed(4)} SOL`, 'Cumulative PnL']}
                labelFormatter={v => new Date(v).toLocaleString()}
              />
              <ReferenceLine y={0} stroke="#334155" strokeDasharray="3 3" />
              <Line type="monotone" dataKey="cumulative" stroke="#8b5cf6" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: '#8b5cf6' }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-slate-900 rounded-lg p-1 w-fit">
        {([
          ['positions', `Positions (${state.activePositions.length})`],
          ['history',   'History'],
          ['backtest',  'Backtest'],
          ['settings',  'Settings'],
        ] as [string, string][]).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t as any)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-all ${
              tab === t ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {t === 'backtest' ? <span className="flex items-center gap-1"><FlaskConical size={11} />{label}</span>
            : t === 'settings' ? <span className="flex items-center gap-1"><Settings size={11} />{label}</span>
            : label}
          </button>
        ))}
      </div>

      {/* Positions */}
      {tab === 'positions' && (
        <div className="space-y-3">
          {state.activePositions.length === 0 ? (
            <Empty text={state.paused ? 'Bot paused — resume to start sniping' : 'No active positions — waiting for token...'} />
          ) : (
            state.activePositions.map(pos => (
              <div key={pos.tokenMint} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white">${pos.symbol}</span>
                      <span className="text-xs text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full">{pos.dex}</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">{pos.name}</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-lg font-bold ${pnlColor(pos.pnlPercent)}`}>
                      {pos.pnlPercent >= 0 ? '+' : ''}{fmt(pos.pnlPercent, 1)}%
                    </p>
                    <p className={`text-xs ${pnlColor(pos.pnlSol)}`}>
                      {pos.pnlSol >= 0 ? '+' : ''}{fmt(pos.pnlSol, 3)} SOL
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs text-slate-400 mb-2">
                  <div><span className="text-slate-600">Entry Price</span><br />{fmtPrice(pos.entryPrice)}</div>
                  <div><span className="text-slate-600">Current Price</span><br /><span className={pnlColor(pos.pnlPercent)}>{fmtPrice(pos.currentPrice)}</span></div>
                  <div><span className="text-slate-600">Age</span><br />{fmtAge(pos.ageMinutes)}</div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-slate-400 mb-3">
                  <div><span className="text-slate-600">Entry MCap</span><br />${fmtMcap(pos.entryMcapUsd)}</div>
                  <div><span className="text-slate-600">Current MCap</span><br /><span className={pnlColor(pos.pnlPercent)}>${fmtMcap(pos.currentMcapUsd)}</span></div>
                </div>
                <div
                  className="flex items-center gap-2 mb-3 px-2 py-1.5 bg-slate-800/60 rounded-lg cursor-pointer hover:bg-slate-700/60 transition-all group"
                  onClick={() => navigator.clipboard.writeText(pos.tokenMint)}
                  title="Click to copy CA"
                >
                  <span className="text-xs text-slate-600">CA</span>
                  <span className="text-xs text-slate-400 font-mono truncate flex-1">{pos.tokenMint}</span>
                  <span className="text-xs text-slate-600 group-hover:text-violet-400 transition-colors shrink-0">copy</span>
                </div>
                {pos.tweetText && (
                  <p className="text-xs text-slate-600 italic mb-3 truncate">"{pos.tweetText}"</p>
                )}
                <button
                  onClick={() => sell(pos.tokenMint)}
                  className="w-full py-2 rounded-lg bg-red-900/40 text-red-400 border border-red-900 text-xs font-medium hover:bg-red-900/60 transition-all"
                >
                  Sell {pos.symbol}
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Trade History */}
      {tab === 'history' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-3 border-b border-slate-800">
            <span className="text-xs text-slate-500 mr-auto">{paired.length} completed trades</span>

            {/* Filter by result */}
            <select
              className="bg-slate-800 border border-slate-700 text-xs text-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:border-violet-500"
              onChange={() => { setHistPage(1); setSortCol('sellTime'); setSortDir('desc'); }}
              id="hist-filter"
            >
              <option value="all">All trades</option>
              <option value="win">Wins only</option>
              <option value="loss">Losses only</option>
              <option value="rug">Rugs (&lt;-40%)</option>
            </select>

            {/* Rows per page */}
            <select
              className="bg-slate-800 border border-slate-700 text-xs text-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:border-violet-500"
              value={histPageSize}
              onChange={e => { setHistPageSize(parseInt(e.target.value)); setHistPage(1) }}
            >
              {[10, 20, 50, 100].map(n => <option key={n} value={n}>{n} / page</option>)}
            </select>

            <button
              onClick={exportCSV}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-medium transition-all"
            >
              <Download size={12} /> Export CSV
            </button>
          </div>

          {paired.length === 0 ? (
            <div className="p-8"><Empty text="No completed trades yet" /></div>
          ) : (() => {
            // Apply filter
            const filterVal = (document.getElementById('hist-filter') as HTMLSelectElement)?.value ?? 'all'
            const filtered = sortedPaired.filter(t => {
              if (filterVal === 'win')  return (t.pnlSol ?? 0) > 0
              if (filterVal === 'loss') return (t.pnlSol ?? 0) <= 0
              if (filterVal === 'rug')  return (t.pnlPercent ?? 0) < -40
              return true
            })
            const totalPages = Math.ceil(filtered.length / histPageSize)
            const rows = filtered.slice((histPage - 1) * histPageSize, histPage * histPageSize)

            return (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-500">
                        <th className="text-right px-4 py-3">#</th>
                        <SortTh col="symbol"      label="Token" />
                        <SortTh col="buyMcapUsd"  label="Buy MCap"  right />
                        <SortTh col="sellMcapUsd" label="Sell MCap" right />
                        <SortTh col="pnlPercent"  label="PnL %"     right />
                        <SortTh col="pnlSol"      label="PnL SOL"   right />
                        <SortTh col="reason"      label="Reason" />
                        <SortTh col="sellTime"    label="Time" />
                        <th className="text-left px-4 py-3 text-slate-500">TX</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((t, i) => (
                        <tr key={t.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                          <td className="px-4 py-3 text-right text-slate-600 tabular-nums">
                            {(histPage - 1) * histPageSize + i + 1}
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-white">${t.symbol}</div>
                            <div className="text-slate-600">{t.dex}</div>
                          </td>
                          <td className="px-4 py-3 text-right text-slate-400">
                            {t.buyMcapUsd != null ? `$${fmtMcap(t.buyMcapUsd)}` : '—'}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-300">
                            ${fmtMcap(t.sellMcapUsd)}
                          </td>
                          <td className={`px-4 py-3 text-right font-medium ${t.pnlPercent != null ? pnlColor(t.pnlPercent) : 'text-slate-600'}`}>
                            {t.pnlPercent != null ? `${t.pnlPercent >= 0 ? '+' : ''}${fmt(t.pnlPercent, 1)}%` : '—'}
                          </td>
                          <td className={`px-4 py-3 text-right font-medium ${t.pnlSol != null ? pnlColor(t.pnlSol) : 'text-slate-600'}`}>
                            {t.pnlSol != null ? `${t.pnlSol >= 0 ? '+' : ''}${fmt(t.pnlSol, 4)}` : '—'}
                          </td>
                          <td className="px-4 py-3 text-slate-500">{t.reason ?? '—'}</td>
                          <td className="px-4 py-3 text-slate-500">
                            <div>{new Date(t.sellTime).toLocaleDateString()}</div>
                            <div className="text-slate-600">{new Date(t.sellTime).toLocaleTimeString()}</div>
                          </td>
                          <td className="px-4 py-3">
                            <a href={`https://solscan.io/tx/${t.txSignature}`} target="_blank" rel="noreferrer"
                              className="text-violet-400 hover:text-violet-300 underline">
                              {t.txSignature.slice(0, 8)}...
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800">
                    <span className="text-xs text-slate-500">
                      {(histPage - 1) * histPageSize + 1}–{Math.min(histPage * histPageSize, filtered.length)} of {filtered.length}
                    </span>
                    <div className="flex gap-1">
                      <button onClick={() => setHistPage(1)} disabled={histPage === 1}
                        className="px-2 py-1 rounded text-xs bg-slate-800 text-slate-400 hover:text-white disabled:opacity-30 transition-all">«</button>
                      <button onClick={() => setHistPage(p => Math.max(1, p - 1))} disabled={histPage === 1}
                        className="px-2 py-1 rounded text-xs bg-slate-800 text-slate-400 hover:text-white disabled:opacity-30 transition-all">‹</button>
                      {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                        const start = Math.max(1, Math.min(histPage - 2, totalPages - 4))
                        const p = start + i
                        return (
                          <button key={p} onClick={() => setHistPage(p)}
                            className={`px-2.5 py-1 rounded text-xs transition-all ${p === histPage ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}>
                            {p}
                          </button>
                        )
                      })}
                      <button onClick={() => setHistPage(p => Math.min(totalPages, p + 1))} disabled={histPage === totalPages}
                        className="px-2 py-1 rounded text-xs bg-slate-800 text-slate-400 hover:text-white disabled:opacity-30 transition-all">›</button>
                      <button onClick={() => setHistPage(totalPages)} disabled={histPage === totalPages}
                        className="px-2 py-1 rounded text-xs bg-slate-800 text-slate-400 hover:text-white disabled:opacity-30 transition-all">»</button>
                    </div>
                  </div>
                )}
              </>
            )
          })()}
        </div>
      )}

      {tab === 'backtest' && <BacktestTab />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  )
}

function StatCard({ icon, label, value, sub, valueClass = 'text-white' }: {
  icon: React.ReactNode, label: string, value: string, sub?: string, valueClass?: string
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <div className="flex items-center gap-1.5 text-slate-500 mb-2">{icon}<span className="text-xs">{label}</span></div>
      <p className={`text-lg font-bold ${valueClass}`}>{value}</p>
      {sub && <p className="text-xs text-slate-600 mt-0.5">{sub}</p>}
    </div>
  )
}

function MiniStat({ icon, label, value }: { icon: React.ReactNode, label: string, value: string }) {
  return (
    <div className="bg-slate-900/50 border border-slate-800/50 rounded-lg px-3 py-2 flex items-center gap-2">
      <span className="text-slate-600">{icon}</span>
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-xs font-semibold text-slate-300 ml-auto">{value}</span>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="text-center py-12 text-slate-600 text-sm">{text}</div>
}
