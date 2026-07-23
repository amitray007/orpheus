// ---------------------------------------------------------------------------
// src/main/ipc/providers.ts
//
// Provider framework IPC (model-routing unit 05, part E). Thin translation
// layer between src/main/routingProxy/providers/storage.ts's typed
// ProviderConfig rows and the renderer-facing ProviderConfigSummary/
// ProviderDescriptorSummary wire shapes (src/shared/types.ts) — mirrors
// src/main/ipc/routingProxy.ts's "thin passthrough to a manager module"
// shape. Every mutating handler regenerates config.yaml immediately via
// routingProxy/manager.ts's regenerateConfigNow() so an edit takes effect
// without requiring the user to toggle the proxy off/on (a no-op when the
// proxy isn't installed yet).
// ---------------------------------------------------------------------------

import type {
  ProviderApiKeyEntrySummary,
  ProviderConfigSummary,
  ProviderDescriptorSummary
} from '../../shared/types'
import { PROVIDERS, getProviderDescriptor } from '../routingProxy/providers/registry'
import {
  getProviderConfig,
  listProviderConfigs,
  replaceProviderApiKeys,
  upsertProviderRow
} from '../routingProxy/providers/storage'
import { getRoutingProxySnapshot, regenerateConfigNow } from '../routingProxy/manager'
import { handle } from './handle'

function toDescriptorSummary(id: string): ProviderDescriptorSummary | null {
  const d = getProviderDescriptor(id)
  if (!d) return null
  return {
    id: d.id,
    label: d.label,
    authMethods: d.authMethods,
    oauthLoginFlag: d.oauthLoginFlag,
    apiKeyConfigKey: d.apiKeyConfigKey,
    openaiCompatibleDefaultBaseUrl: d.openaiCompatible?.defaultBaseUrl,
    docsUrl: d.docsUrl
  }
}

function toApiKeySummary(k: {
  id: string
  apiKey: string
  prefix?: string
  baseUrl?: string
}): ProviderApiKeyEntrySummary {
  return { id: k.id, apiKey: k.apiKey, prefix: k.prefix, baseUrl: k.baseUrl }
}

/** Merge every configured provider's stored row with its live connection
 *  status (from the routing-proxy snapshot's authFiles, matched by provider
 *  id) into one summary list. Providers with no stored row at all are
 *  omitted — the renderer renders those from providers:descriptors instead
 *  and offers a "configure" affordance rather than a populated row. */
function buildProviderSummaries(): ProviderConfigSummary[] {
  const snapshot = getRoutingProxySnapshot()
  const configs = listProviderConfigs()

  return configs.map((cfg) => {
    const connection = snapshot.authFiles.find((f) => f.provider === cfg.providerId) ?? null
    return {
      providerId: cfg.providerId,
      enabled: cfg.enabled,
      authMethod: cfg.authMethod,
      apiKeys: cfg.apiKeys.map(toApiKeySummary),
      baseUrl: cfg.baseUrl,
      displayName: cfg.displayName,
      prefix: cfg.prefix,
      connection
    }
  })
}

export function registerProvidersIpc(): void {
  handle('providers:descriptors', () => {
    return PROVIDERS.map((p) => toDescriptorSummary(p.id)).filter(
      (d): d is ProviderDescriptorSummary => d !== null
    )
  })

  handle('providers:list', () => buildProviderSummaries())

  handle('providers:setEnabled', async (_e, { providerId, enabled }) => {
    const descriptor = getProviderDescriptor(providerId)
    if (!descriptor) throw new Error(`Unknown provider id: ${providerId}`)

    const existing = getProviderConfig(providerId)
    upsertProviderRow(providerId, {
      enabled,
      authMethod: existing?.authMethod ?? descriptor.authMethods[0]
    })
    await regenerateConfigNow()
    return buildProviderSummaries()
  })

  handle('providers:setApiKeys', async (_e, { providerId, apiKeys }) => {
    const descriptor = getProviderDescriptor(providerId)
    if (!descriptor) throw new Error(`Unknown provider id: ${providerId}`)

    const existing = getProviderConfig(providerId)
    const authMethod = descriptor.authMethods.includes('apiKey')
      ? 'apiKey'
      : (descriptor.authMethods.find((m) => m === 'openaiCompatible') ?? descriptor.authMethods[0])

    // Ensure a parent row exists (first-time key add for a provider with no
    // row yet must not violate the api-key table's FK on provider_id).
    upsertProviderRow(providerId, {
      enabled: existing?.enabled ?? true,
      authMethod: existing?.authMethod ?? authMethod
    })
    replaceProviderApiKeys(
      providerId,
      apiKeys.map((k) => ({ id: k.id, apiKey: k.apiKey, prefix: k.prefix, baseUrl: k.baseUrl }))
    )
    await regenerateConfigNow()
    return buildProviderSummaries()
  })

  handle('providers:setBaseUrl', async (_e, { providerId, baseUrl }) => {
    const descriptor = getProviderDescriptor(providerId)
    if (!descriptor) throw new Error(`Unknown provider id: ${providerId}`)

    const existing = getProviderConfig(providerId)
    upsertProviderRow(providerId, {
      enabled: existing?.enabled ?? true,
      authMethod: existing?.authMethod ?? 'openaiCompatible',
      baseUrl
    })
    await regenerateConfigNow()
    return buildProviderSummaries()
  })
}
