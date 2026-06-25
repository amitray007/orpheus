import { useEffect, useState } from 'react'
import type React from 'react'

export function DiagConsolePlaceholder(): React.JSX.Element {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const unsub = window.api.diag.onStream((batch) => {
      setCount((c) => c + batch.length)
    })
    return unsub
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 14,
        color: '#e5e5e5',
        background: '#0b0b0c'
      }}
    >
      diag-console placeholder — {count} events received
    </div>
  )
}
