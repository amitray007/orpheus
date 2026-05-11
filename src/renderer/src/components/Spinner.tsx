import { useEffect, useState } from 'react'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export type SpinnerSize = 'sm' | 'md' | 'lg'

export interface SpinnerProps {
  size?: SpinnerSize
}

const sizeClasses: Record<SpinnerSize, string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base'
}

export function Spinner({ size = 'md' }: SpinnerProps): React.JSX.Element {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % FRAMES.length)
    }, 80)
    return () => clearInterval(id)
  }, [])

  return (
    <span role="status" aria-label="Loading" className={`inline-block ${sizeClasses[size]}`}>
      {FRAMES[index]}
    </span>
  )
}
