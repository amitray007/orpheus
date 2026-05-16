import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { DotmSquare13 } from './ui/dotm-square-13'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'
export type ButtonSize = 'md' | 'sm'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-on hover:bg-accent-hover focus-visible:ring-accent',
  secondary:
    'bg-transparent border border-border-default text-text-primary hover:bg-surface-raised focus-visible:ring-accent',
  ghost: 'bg-transparent text-text-primary hover:bg-surface-raised focus-visible:ring-accent',
  destructive: 'bg-red-500 text-white hover:bg-red-600 focus-visible:ring-red-500'
}

const sizeClasses: Record<ButtonSize, string> = {
  md: 'px-4 py-2 text-sm',
  sm: 'px-3 py-1 text-xs'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', disabled, loading, children, className = '', ...rest },
  ref
) {
  const isDisabled = disabled || loading

  return (
    <button
      ref={ref}
      disabled={isDisabled}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-md font-medium',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base',
        variantClasses[variant],
        sizeClasses[size],
        isDisabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : 'cursor-pointer',
        className
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {loading ? (
        <span className="inline-flex items-center gap-2">
          <DotmSquare13
            size={size === 'sm' ? 14 : 18}
            dotSize={size === 'sm' ? 2 : 3}
            speed={1.4}
            animated
          />
          {children}
        </span>
      ) : (
        children
      )}
    </button>
  )
})
