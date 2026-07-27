import * as os from 'node:os'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ProviderUsageEntry, ProviderUsageLimit } from '../../shared/types'
import { parseCopilotUsage, parsePublicGithubCredential } from './parsers'
import {
  booleanValue,
  fetchBoundedJson,
  finiteNumber,
  isRecord,
  readBoundedText,
  readKeychainPassword,
  trimmedString,
  unknownArray,
  unwrapGoKeyring
} from './runtime'

const COPILOT_DEFINITION = { providerId: 'copilot', label: 'GitHub Copilot' } as const
const COPILOT_HOME = path.join(os.homedir(), '.config', 'github-copilot')
const GH_HOSTS_PATH = path.join(os.homedir(), '.config', 'gh', 'hosts.yml')
const COPILOT_USAGE_URL = 'https://api.github.com/copilot_internal/user'
const USER_ORGS_URL = 'https://api.github.com/user/orgs?per_page=100'
const REQUEST_TIMEOUT_MS = 8_000
const ORG_LOOKUP_BUDGET_MS = 12_000

type CopilotCredential = {
  token: string
  identityLabel: string | null
}

type OrgProbe =
  | { kind: 'found'; limits: ProviderUsageLimit[] }
  | { kind: 'definitive-miss' }
  | { kind: 'transient' }

let rememberedBillingOrg: string | null = null

function unavailable(
  reason: 'no-auth' | 'error',
  configured: boolean,
  identityLabel: string | null = null
): ProviderUsageEntry {
  return {
    ...COPILOT_DEFINITION,
    configured,
    enabled: configured,
    identityLabel,
    availability: 'unavailable',
    unavailableReason: reason,
    windows: [],
    limits: []
  }
}

function githubDotComConfig(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !isRecord(value['github.com'])) return null
  return value['github.com']
}

export function parseGithubDotComYamlCredential(text: string): CopilotCredential | null {
  try {
    const github = githubDotComConfig(parseYaml(text) as unknown)
    const token = github && trimmedString(github['oauth_token'])
    return token
      ? {
          token,
          identityLabel: trimmedString(github['user'])
        }
      : null
  } catch {
    return null
  }
}

async function loadCopilotCredential(): Promise<CopilotCredential | null> {
  for (const fileName of ['apps.json', 'hosts.json']) {
    const text = readBoundedText(path.join(COPILOT_HOME, fileName))
    if (!text) continue
    try {
      const credential = parsePublicGithubCredential(JSON.parse(text) as unknown)
      if (credential) return credential
    } catch {
      // Keep walking the documented credential chain.
    }
  }

  const ghHostsText = readBoundedText(GH_HOSTS_PATH)
  const ghCredential = ghHostsText ? parseGithubDotComYamlCredential(ghHostsText) : null
  if (ghCredential) return ghCredential

  const account = ghHostsText
    ? (() => {
        try {
          return trimmedString(githubDotComConfig(parseYaml(ghHostsText) as unknown)?.['user'])
        } catch {
          return null
        }
      })()
    : null
  if (account) {
    const scoped = await readKeychainPassword('gh:github.com', account)
    if (scoped.kind === 'found') {
      const token = unwrapGoKeyring(scoped.value)
      if (token) return { token, identityLabel: account }
    }
  }
  const serviceOnly = await readKeychainPassword('gh:github.com')
  if (serviceOnly.kind !== 'found') return null
  const token = unwrapGoKeyring(serviceOnly.value)
  return token ? { token, identityLabel: account } : null
}

export function copilotPlanLabel(value: unknown): string | null {
  const raw = trimmedString(value)
  if (!raw) return null
  return raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1).toLowerCase()}`)
    .join(' ')
}

export function parseCopilotOrgLogins(value: unknown): string[] {
  const entries = unknownArray(value)
  if (!entries) return []
  return entries.flatMap((entry) => {
    const login = isRecord(entry) ? trimmedString(entry['login']) : null
    return login ? [login] : []
  })
}

export function parseCopilotOrgUsage(value: unknown): ProviderUsageLimit[] | null {
  if (!isRecord(value)) return null
  const usageItems = unknownArray(value['usageItems'])
  if (!usageItems) return null
  const creditItems = usageItems.filter((item): item is Record<string, unknown> => {
    if (!isRecord(item)) return false
    const product = trimmedString(item['product'])?.toLowerCase()
    const unit = trimmedString(item['unitType'])?.toLowerCase()
    return product === 'copilot' && (unit === 'ai-units' || unit === 'ai-credits')
  })
  if (creditItems.length === 0) return null
  const credits = creditItems.reduce((sum, item) => {
    const quantity = finiteNumber(item['grossQuantity'])
    return sum + Math.max(0, quantity ?? 0)
  }, 0)
  const spend = creditItems.reduce((sum, item) => {
    const amount = finiteNumber(item['netAmount'])
    return sum + Math.max(0, amount ?? 0)
  }, 0)
  return [
    {
      id: 'org-credits',
      label: 'Org Credits',
      utilization: null,
      resetsAt: null,
      modelName: null,
      valueKind: 'count',
      displayValue: `${credits}`
    },
    {
      id: 'org-spend',
      label: 'Org Spend',
      utilization: null,
      resetsAt: null,
      modelName: null,
      valueKind: 'currency',
      displayValue: `$${spend.toFixed(2)}`
    }
  ]
}

function githubHeaders(token: string, copilot = false): Record<string, string> {
  return copilot
    ? {
        Authorization: `token ${token}`,
        Accept: 'application/json',
        'Editor-Version': 'vscode/1.96.2',
        'Editor-Plugin-Version': 'copilot-chat/0.26.7',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
        'X-Github-Api-Version': '2025-04-01'
      }
    : {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Orpheus',
        'X-GitHub-Api-Version': '2022-11-28'
      }
}

async function probeOrg(org: string, token: string, deadline: number): Promise<OrgProbe> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return { kind: 'transient' }
  const result = await fetchBoundedJson(
    `https://api.github.com/orgs/${encodeURIComponent(org)}/settings/billing/usage/summary`,
    { method: 'GET', headers: githubHeaders(token) },
    Math.min(REQUEST_TIMEOUT_MS, remaining)
  )
  if (result.kind === 'ok') {
    const limits = parseCopilotOrgUsage(result.value)
    return limits ? { kind: 'found', limits } : { kind: 'definitive-miss' }
  }
  if (
    result.kind === 'unavailable' ||
    (result.kind === 'http' && (result.status === 429 || result.status >= 500))
  ) {
    return { kind: 'transient' }
  }
  return { kind: 'definitive-miss' }
}

async function orgBillingLimits(token: string): Promise<ProviderUsageLimit[]> {
  const deadline = Date.now() + ORG_LOOKUP_BUDGET_MS
  if (rememberedBillingOrg) {
    const cached = await probeOrg(rememberedBillingOrg, token, deadline)
    if (cached.kind === 'found') return cached.limits
    if (cached.kind === 'transient') return []
    rememberedBillingOrg = null
  }

  const remaining = deadline - Date.now()
  if (remaining <= 0) return []
  const orgResult = await fetchBoundedJson(
    USER_ORGS_URL,
    { method: 'GET', headers: githubHeaders(token) },
    Math.min(REQUEST_TIMEOUT_MS, remaining)
  )
  if (orgResult.kind !== 'ok') return []
  const orgs = parseCopilotOrgLogins(orgResult.value)
  for (const org of orgs) {
    const result = await probeOrg(org, token, deadline)
    if (result.kind === 'found') {
      rememberedBillingOrg = org
      return result.limits
    }
    if (Date.now() >= deadline) break
  }
  return []
}

function identityLabel(credential: CopilotCredential, plan: string | null): string | null {
  const parts = [credential.identityLabel, plan].filter(
    (value, index, values): value is string => value !== null && values.indexOf(value) === index
  )
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Real GitHub Copilot usage collector; credentials never leave this module. */
export async function collectCopilotUsage(): Promise<ProviderUsageEntry> {
  const credential = await loadCopilotCredential()
  if (!credential) return unavailable('no-auth', false)

  const result = await fetchBoundedJson(
    COPILOT_USAGE_URL,
    { method: 'GET', headers: githubHeaders(credential.token, true) },
    REQUEST_TIMEOUT_MS
  )
  if (result.kind === 'http' && (result.status === 401 || result.status === 403)) {
    return unavailable('no-auth', true, credential.identityLabel)
  }
  if (result.kind !== 'ok') return unavailable('error', true, credential.identityLabel)
  if (!isRecord(result.value)) return unavailable('error', true, credential.identityLabel)

  const parsed = parseCopilotUsage(result.value)
  if (!parsed) return unavailable('error', true, credential.identityLabel)
  const plan = copilotPlanLabel(result.value['copilot_plan'])
  const onlyOrgStatus =
    parsed.windows.length === 0 &&
    parsed.limits.length === 1 &&
    parsed.limits[0]?.id === 'organization-managed'
  const isOrgManaged = booleanValue(result.value['token_based_billing']) === true && onlyOrgStatus
  const limits = isOrgManaged
    ? (await orgBillingLimits(credential.token)).concat(
        parsed.limits.filter((limit) => limit.id !== 'organization-managed')
      )
    : parsed.limits

  return {
    ...COPILOT_DEFINITION,
    configured: true,
    enabled: true,
    identityLabel: identityLabel(credential, plan),
    availability: 'available',
    unavailableReason: null,
    windows: parsed.windows,
    limits: isOrgManaged && limits.length === 0 ? parsed.limits : limits
  }
}
