import { redactLogString, redactLogValue } from './logRedaction'

const MAX_CONSOLE_ARGUMENTS = 64
const CONSOLE_METHODS = ['debug', 'error', 'info', 'log', 'warn'] as const

type ConsoleMethod = (typeof CONSOLE_METHODS)[number]
type ConsoleSink = (...args: unknown[]) => void

let installed = false

function redactConsoleArgument(value: unknown): unknown {
  if (typeof value === 'string') return redactLogString(value)
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  return redactLogValue(value)
}

export function redactConsoleArguments(args: readonly unknown[]): unknown[] {
  const bounded = args.slice(0, MAX_CONSOLE_ARGUMENTS).map(redactConsoleArgument)
  if (args.length > MAX_CONSOLE_ARGUMENTS) bounded.push('[ARGUMENTS_TRUNCATED]')
  return bounded
}

export function installSafeConsoleBoundary(): void {
  if (installed) return
  installed = true

  for (const method of CONSOLE_METHODS) {
    const original = console[method].bind(console) as ConsoleSink
    console[method] = ((...args: unknown[]) => {
      try {
        original(...redactConsoleArguments(args))
      } catch {
        original('[console output redaction failed]')
      }
    }) as Console[ConsoleMethod]
  }
}

export function isSafeConsoleBoundaryInstalled(): boolean {
  return installed
}

// Side-effect import from main/index.ts installs this before application
// bootstrap code emits any dynamic diagnostic output.
installSafeConsoleBoundary()
