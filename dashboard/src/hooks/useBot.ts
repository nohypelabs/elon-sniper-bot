import { useState, useEffect, useRef } from 'react'
import type { BotState } from '../types'

const DEFAULT_STATE: BotState = {
  mode: 'PAPER', running: false, paused: false, uptime: 0,
  tweetsDetected: 0, buysExecuted: 0, solBalance: 0, solPriceUsd: 0,
  activePositions: [],
}

export function useBot() {
  const [state, setState] = useState<BotState>(DEFAULT_STATE)
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/ws`)
      wsRef.current = ws

      ws.onopen  = () => setConnected(true)
      ws.onclose = () => { setConnected(false); setTimeout(connect, 3_000) }
      ws.onerror = () => ws.close()

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'state') setState(msg.data)
        } catch { /* ignore */ }
      }
    }
    connect()
    return () => wsRef.current?.close()
  }, [])

  // Fallback polling if WS fails
  useEffect(() => {
    if (connected) return
    const id = setInterval(async () => {
      try {
        const r = await fetch('/api/status')
        setState(await r.json())
      } catch { /* ignore */ }
    }, 5_000)
    return () => clearInterval(id)
  }, [connected])

  const sell   = async (mint: string) => { await fetch(`/api/sell/${mint}`, { method: 'POST' }) }
  const pause  = async () => { await fetch('/api/bot/pause',  { method: 'POST' }) }
  const resume = async () => { await fetch('/api/bot/resume', { method: 'POST' }) }

  return { state, connected, sell, pause, resume }
}
