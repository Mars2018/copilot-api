import type { Context } from "hono"

import { getBuiltinProviderModelRecords } from "~/lib/builtin-provider-models"
import {
  getRawProviderConfig,
  listEnabledProviders,
  type ProviderConfig,
  type ResolvedProviderConfig,
} from "~/lib/config"
import {
  GITHUB_COPILOT_PROVIDER,
  isGitHubCopilotEnabled,
} from "~/lib/github-copilot-provider"
import { createHandlerLogger } from "~/lib/logger"
import { withModelDisplayName } from "~/lib/model-display-name"
import { getOpencodeGoModelRecords } from "~/lib/models-dev-cache"
import { toClientModelId } from "~/lib/models"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { state } from "~/lib/state"
import type { Model } from "~/lib/types/models"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import { forwardProviderModels } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("models-handler")
const EPOCH_ISO = new Date(0).toISOString()

export type ClientModel = Record<string, unknown> & {
  id: string
  object: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeCopilotModel(model: Model): ClientModel {
  const clientId = toClientModelId(model.id)

  return {
    claude_model_id: `${clientId}[1m]`,
    ...withModelDisplayName(model, GITHUB_COPILOT_PROVIDER),
    id: clientId,
    object: "model",
    type: "model",
    created: 0,
    created_at: EPOCH_ISO,
    owned_by: model.vendor,
  }
}

export function getStringField(
  model: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = model[field]
  return typeof value === "string" && value.trim() ? value : undefined
}

type ProviderModelsFallbackReason = "error" | "invalid_body" | "non_ok"

function getFallbackProviderModelRecords(
  provider: string,
  reason: ProviderModelsFallbackReason,
  details: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const fallbackModels = getBuiltinProviderModelRecords(provider)
  logger.warn(`models.provider.fallback_${reason}`, {
    provider,
    ...details,
    fallbackModelCount: fallbackModels.length,
  })
  return fallbackModels
}

function normalizeProviderModel(
  provider: string,
  model: unknown,
): ClientModel | null {
  if (!isRecord(model)) {
    return null
  }

  const rawId = getStringField(model, "id")
  if (!rawId) {
    return null
  }

  const id = `${provider}/${rawId}`
  const ownedBy =
    getStringField(model, "owned_by")
    ?? getStringField(model, "vendor")
    ?? provider

  return {
    ...withModelDisplayName(model, provider),
    id,
    object: getStringField(model, "object") ?? "model",
    type: getStringField(model, "type") ?? "model",
    created: typeof model.created === "number" ? model.created : 0,
    created_at: getStringField(model, "created_at") ?? EPOCH_ISO,
    owned_by: ownedBy,
  }
}

function normalizeProviderModels(
  provider: string,
  models: Array<unknown>,
): Array<ClientModel> {
  return models
    .map((model) => normalizeProviderModel(provider, model))
    .filter((model): model is ClientModel => model !== null)
}

export async function getProviderModelRecords(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Promise<Array<Record<string, unknown>>> {
  if (providerConfig.name === "opencode-go") {
    return getOpencodeGoModelRecords()
  }
  if (providerConfig.name === "xai" && providerConfig.authType === "oauth2") {
    return getBuiltinProviderModelRecords("xai")
  }

  try {
    const response = await forwardProviderModels(providerConfig, requestHeaders)
    if (!response.ok) {
      return getFallbackProviderModelRecords(providerConfig.name, "non_ok", {
        statusCode: response.status,
      })
    }

    const body: unknown = await response.json()
    if (!isRecord(body) || !Array.isArray(body.data)) {
      return getFallbackProviderModelRecords(
        providerConfig.name,
        "invalid_body",
      )
    }

    return body.data.filter(isRecord)
  } catch (error) {
    return getFallbackProviderModelRecords(providerConfig.name, "error", {
      error,
    })
  }
}

type ProviderModelSelector = (
  providerConfig: ProviderConfig | null,
  models: Array<unknown>,
) => Array<unknown>

interface ModelSelectors {
  selectCopilotModels?: (models: Array<Model>) => Array<Model>
  selectProviderModels?: ProviderModelSelector
}

export function getCopilotModelRecords(): Array<Model> {
  return isGitHubCopilotEnabled() ? (state.models?.data ?? []) : []
}

export function getModelsById(
  models: Array<unknown>,
): Map<string, Record<string, unknown>> {
  return new Map(
    models.flatMap((model) => {
      if (!isRecord(model)) return []
      const id = getStringField(model, "id")
      return id ? [[id, model] as const] : []
    }),
  )
}

export function deduplicateModels<T>(
  models: Array<T>,
  getId: (model: T) => string,
): Array<T> {
  const seen = new Set<string>()
  return models.filter((model) => {
    const id = getId(model)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

async function getProviderModels(
  provider: string,
  requestHeaders: Headers,
  selectModels?: ProviderModelSelector,
): Promise<Array<ClientModel>> {
  try {
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig) return []

    const models =
      providerConfig.name === "codex" ?
        getCodexModels().data
      : await getProviderModelRecords(providerConfig, requestHeaders)
    return normalizeProviderModels(
      providerConfig.name,
      selectModels?.(providerConfig, models) ?? models,
    )
  } catch (error) {
    if (provider === "codex") {
      logger.warn("models.provider.skip_error", { provider, error })
      return []
    }

    const fallbackModels = getFallbackProviderModelRecords(provider, "error", {
      error,
    })
    return normalizeProviderModels(
      provider,
      selectModels?.(getRawProviderConfig(provider), fallbackModels)
        ?? fallbackModels,
    )
  }
}

export async function getAggregatedModels(
  requestHeaders: Headers,
  selectors: ModelSelectors = {},
): Promise<Array<ClientModel>> {
  const rawCopilotModels = getCopilotModelRecords()
  const copilotModels = (
    selectors.selectCopilotModels?.(rawCopilotModels) ?? rawCopilotModels
  ).map(normalizeCopilotModel)
  const providerModelsByProvider = await Promise.all(
    listEnabledProviders().map((provider) =>
      getProviderModels(
        provider,
        requestHeaders,
        selectors.selectProviderModels,
      ),
    ),
  )

  return deduplicateModels(
    [...copilotModels, ...providerModelsByProvider.flat()],
    (model) => model.id,
  )
}

export function createModelListResponse(
  c: Context,
  models: Array<ClientModel>,
): Response {
  return c.json({
    object: "list",
    data: models,
    has_more: false,
  })
}
