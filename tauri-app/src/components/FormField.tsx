import type { ReactNode } from 'react'

export interface FormFieldProps {
  label: string
  htmlFor?: string
  helper?: string
  error?: string | boolean
  children: ReactNode
}

export function FormField({
  label,
  htmlFor,
  helper,
  error,
  children
}: FormFieldProps): React.JSX.Element {
  const errorText = typeof error === 'string' ? error : undefined

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-xs font-medium text-text-secondary uppercase tracking-wide"
      >
        {label}
      </label>

      {children}

      {helper && !errorText && <p className="text-xs text-text-muted">{helper}</p>}

      {errorText && <p className="text-xs text-red-500">{errorText}</p>}
    </div>
  )
}
