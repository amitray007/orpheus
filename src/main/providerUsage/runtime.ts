import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'

export const PROVIDER_RESPONSE_LIMIT_BYTES = 1024 * 1024
export const PROVIDER_CREDENTIAL_FILE_LIMIT_BYTES = 1024 * 1024

export type KeychainReadResult =
  | { kind: 'found'; value: string }
  | { kind: 'missing' }
  | { kind: 'unreadable' }

export type JsonHttpResult =
  | { kind: 'ok'; status: number; value: unknown }
  | { kind: 'http'; status: number }
  | { kind: 'invalid'; status: number }
  | { kind: 'unavailable' }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function unknownArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null
}

export function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0
  if (typeof value === 'string') {
    switch (value.trim().toLowerCase()) {
      case 'true':
      case '1':
        return true
      case 'false':
      case '0':
        return false
    }
  }
  return null
}

export function strictFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

export function isoTimestamp(value: unknown): string | null {
  const raw = trimmedString(value)
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function readBoundedText(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > PROVIDER_CREDENTIAL_FILE_LIMIT_BYTES) {
      return null
    }
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

export function unwrapGoKeyring(raw: string): string | null {
  let text = raw.trim()
  const prefix = 'go-keyring-base64:'
  if (text.startsWith(prefix)) {
    const encoded = text.slice(prefix.length).trim()
    if (
      encoded.length === 0 ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    ) {
      return null
    }
    const decoded = Buffer.from(encoded, 'base64')
    if (decoded.toString('base64') !== encoded) return null
    text = decoded.toString('utf8').trim()
  }
  return text || null
}

export function readKeychainPassword(
  service: string,
  account?: string
): Promise<KeychainReadResult> {
  const args = ['find-generic-password', '-s', service]
  if (account) args.push('-a', account)
  args.push('-w')
  return new Promise((resolve) => {
    childProcess.execFile(
      '/usr/bin/security',
      args,
      { timeout: 3_000, maxBuffer: PROVIDER_RESPONSE_LIMIT_BYTES },
      (error, stdout) => {
        if (!error) {
          const value = trimmedString(stdout)
          resolve(value ? { kind: 'found', value } : { kind: 'missing' })
          return
        }
        const exitCode = typeof error.code === 'number' ? error.code : null
        resolve(exitCode === 44 ? { kind: 'missing' } : { kind: 'unreadable' })
      }
    )
  })
}

async function readResponseJson(response: Awaited<ReturnType<typeof fetch>>): Promise<unknown> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > PROVIDER_RESPONSE_LIMIT_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(next.value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown
  } catch {
    return null
  }
}

export async function fetchBoundedJson(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  timeoutMs: number
): Promise<JsonHttpResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) return { kind: 'http', status: response.status }
    const value = await readResponseJson(response)
    return value === null
      ? { kind: 'invalid', status: response.status }
      : { kind: 'ok', status: response.status, value }
  } catch {
    return { kind: 'unavailable' }
  } finally {
    clearTimeout(timer)
  }
}
