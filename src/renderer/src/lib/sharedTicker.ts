/**
 * Shared ticker — ONE setInterval per distinct intervalMs, shared across all
 * subscribers. Prevents N×3 intervals when many ActivityIndicators mount.
 *
 * Intervals with zero subscribers are stopped immediately.
 *
 * Usage:
 *   useSharedFrame(80, active)   → current frame index (ticks at 80ms)
 *   useSharedFrame(200, active)  → current frame index (ticks at 200ms)
 */

import { useEffect, useState } from 'react'

// ---------------------------------------------------------------------------
// Internal per-intervalMs state
// ---------------------------------------------------------------------------

interface TickerState {
  intervalId: ReturnType<typeof setInterval> | null
  frame: number
  subscribers: Set<() => void>
}

const tickers = new Map<number, TickerState>()

function getOrCreateTicker(intervalMs: number): TickerState {
  let t = tickers.get(intervalMs)
  if (!t) {
    t = { intervalId: null, frame: 0, subscribers: new Set() }
    tickers.set(intervalMs, t)
  }
  return t
}

function startTicker(intervalMs: number, ticker: TickerState): void {
  if (ticker.intervalId !== null) return
  ticker.intervalId = setInterval(() => {
    ticker.frame = (ticker.frame + 1) % 65536 // large modulus; wraps safely
    ticker.subscribers.forEach((fn) => fn())
  }, intervalMs)
}

function stopTicker(ticker: TickerState): void {
  if (ticker.intervalId === null) return
  clearInterval(ticker.intervalId)
  ticker.intervalId = null
}

function subscribeToTicker(intervalMs: number, fn: () => void): () => void {
  const ticker = getOrCreateTicker(intervalMs)
  ticker.subscribers.add(fn)
  startTicker(intervalMs, ticker)
  return () => {
    ticker.subscribers.delete(fn)
    if (ticker.subscribers.size === 0) stopTicker(ticker)
  }
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Returns the current frame index for the given interval, incrementing at
 * `intervalMs` cadence. When `active` is false no subscription is created and
 * 0 is returned — callers should derive their display from the parent frame
 * array and this index.
 */
export function useSharedFrame(intervalMs: number, active: boolean): number {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) return
    const unsub = subscribeToTicker(intervalMs, () => {
      // Read the current frame from the ticker state and update this component.
      setFrame(tickers.get(intervalMs)!.frame)
    })
    return unsub
  }, [intervalMs, active])

  return active ? frame : 0
}
