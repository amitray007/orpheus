import { forwardRef, type InputHTMLAttributes } from 'react'

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  value: string
  onChange: (value: string) => void
  error?: string | boolean
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { value, onChange, error, className = '', ...rest },
  ref
) {
  const hasError = Boolean(error)

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={[
        'w-full rounded-md bg-surface-raised px-3 py-2 text-sm text-text-primary',
        'border transition-colors duration-150',
        'placeholder:text-text-muted',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base',
        hasError
          ? 'border-red-500 focus-visible:ring-red-500'
          : 'border-border-default focus-visible:border-border-focus focus-visible:ring-accent',
        rest.disabled ? 'opacity-40 cursor-not-allowed' : '',
        className
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  )
})
