import { builtinProviderModelRegistry } from "~/lib/builtin-provider-models"
import {
  resolveEffectiveProviderType,
  type CodexReasoningEffort,
  type ModelConfig,
  type ProviderType,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import { getModelsDevModelMaxOutputTokens } from "~/lib/models-dev-cache"
import { toClientModelId } from "~/lib/models"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import type { Model } from "~/lib/types/models"
import type { SyntheticCodexModelCandidate } from "~/routes/models/codex-models-types"
import {
  deduplicateModels,
  getCopilotModelRecords,
  getModelsById,
  getProviderModelRecords,
  getStringField,
  isRecord,
} from "~/routes/models/model-discovery"

const logger = createHandlerLogger("models-handler")
const RESPONSES_ENDPOINTS = new Set(["/responses", "ws:/responses"])
const MESSAGES_ENDPOINT = "/v1/messages"
const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
])

export async function getSyntheticCodexModels(
  requestHeaders: Headers,
  providers: Array<string>,
): Promise<Array<SyntheticCodexModelCandidate>> {
  const copilotModels = getCopilotCodexCandidates()
  const providerResults = await Promise.allSettled(
    providers.map((provider) =>
      getProviderCodexCandidates(provider, requestHeaders),
    ),
  )
  const providerModels = providerResults.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  )

  return deduplicateModels(
    [...copilotModels, ...providerModels],
    (candidate) => candidate.slug,
  )
}

function getCopilotCodexCandidates(): Array<SyntheticCodexModelCandidate> {
  const candidates: Array<SyntheticCodexModelCandidate> = []
  for (const model of getCopilotModelRecords()) {
    try {
      if (isCopilotCodexCandidate(model)) {
        candidates.push(createCopilotCodexCandidate(model))
      }
    } catch (error) {
      logger.warn("models.codex.copilot_skip_error", {
        modelId: model.id,
        error,
      })
    }
  }
  return candidates
}

function isCopilotCodexCandidate(model: Model): boolean {
  const endpoints = model.supported_endpoints ?? []
  return (
    endpoints.some(
      (endpoint) =>
        endpoint === MESSAGES_ENDPOINT
        || endpoint === CHAT_COMPLETIONS_ENDPOINT
        || RESPONSES_ENDPOINTS.has(endpoint),
    ) && model.capabilities.supports.tool_calls !== false
  )
}

function describeCopilotAdapter(model: Model): string {
  const supportsResponses = model.supported_endpoints?.some((endpoint) =>
    RESPONSES_ENDPOINTS.has(endpoint),
  )
  // Codex clients only use the native Responses API for gpt-* models; other
  // models fall back to the Messages route even when they advertise native
  // /responses support (see shouldFallbackToMessages).
  if (model.id.startsWith("gpt") && supportsResponses) {
    return `${model.name} through the Copilot Responses API.`
  }
  // Mirrors the Messages route dispatch order: native Messages first, then
  // the Messages-to-Responses translation, then Messages-to-Chat.
  if (model.supported_endpoints?.includes(MESSAGES_ENDPOINT)) {
    return `${model.name} through the Copilot Messages adapter.`
  }
  if (supportsResponses) {
    return `${model.name} through the Copilot Messages-to-Responses adapter.`
  }
  return `${model.name} through the Copilot Messages-to-Chat adapter.`
}

function createCopilotCodexCandidate(
  model: Model,
): SyntheticCodexModelCandidate {
  const reasoningEfforts = normalizeReasoningEfforts(
    model.capabilities.supports.reasoning_effort,
  )
  return {
    slug: toClientModelId(model.id),
    catalogSlug: model.id,
    displayName: model.name,
    description: describeCopilotAdapter(model),
    contextWindow: positiveNumber(
      model.capabilities.limits.max_prompt_tokens,
      256_000,
    ),
    maxOutputTokens: positiveNumber(
      model.capabilities.limits.max_output_tokens,
      32_000,
    ),
    inputModalities:
      model.capabilities.supports.vision ? ["text", "image"] : ["text"],
    reasoningEfforts,
    defaultReasoningEffort: selectDefaultReasoningEffort(reasoningEfforts),
  }
}

async function getProviderCodexCandidates(
  provider: string,
  requestHeaders: Headers,
): Promise<Array<SyntheticCodexModelCandidate>> {
  if (provider === "codex") return []

  try {
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig || providerConfig.name === "codex") return []

    const remoteModels = await getProviderModelRecords(
      providerConfig,
      requestHeaders,
    )
    const remoteById = getModelsById(remoteModels)
    const modelIds = new Set([
      ...remoteById.keys(),
      ...((
        providerConfig.name === "xai" && providerConfig.authType === "oauth2"
      ) ?
        []
      : Object.keys(providerConfig.models ?? {})),
    ])

    const candidates: Array<SyntheticCodexModelCandidate> = []
    for (const modelId of modelIds) {
      const effectiveType = resolveEffectiveProviderType(
        providerConfig,
        modelId,
      )
      const usesMessagesFallback = isMessagesFallbackProviderType(effectiveType)
      if (!usesMessagesFallback && effectiveType !== "openai-responses") {
        continue
      }
      const modelConfig = providerConfig.models?.[modelId]
      candidates.push(
        createProviderCodexCandidate(
          providerConfig,
          modelId,
          remoteById.get(modelId),
          modelConfig,
          effectiveType,
        ),
      )
    }
    return candidates
  } catch (error) {
    logger.warn("models.codex.provider_skip_error", { provider, error })
    return []
  }
}

function isMessagesFallbackProviderType(type: ProviderType): boolean {
  return type === "anthropic" || type === "openai-compatible"
}

function describeProviderAdapter(type: ProviderType): string {
  if (type === "anthropic") return "Messages"
  if (type === "openai-responses") return "Messages-to-Responses"
  return "Messages-to-Chat"
}

function createProviderCodexCandidate(
  providerConfig: ResolvedProviderConfig,
  modelId: string,
  remoteModel: Record<string, unknown> | undefined,
  modelConfig: ModelConfig | undefined,
  effectiveType: ProviderType,
): SyntheticCodexModelCandidate {
  const builtinModelConfig = builtinProviderModelRegistry.getModelConfig(
    providerConfig.name,
    modelId,
  )
  const configuredReasoningEfforts = normalizeReasoningEfforts(
    modelConfig?.reasoningEfforts,
  )
  const remoteReasoningEfforts = normalizeRemoteReasoningEfforts(remoteModel)
  const builtinReasoningEfforts = normalizeReasoningEfforts(
    builtinModelConfig?.reasoningEfforts,
  )
  const reasoningEfforts =
    configuredReasoningEfforts.length > 0 ? configuredReasoningEfforts
    : remoteReasoningEfforts.length > 0 ? remoteReasoningEfforts
    : builtinReasoningEfforts
  const configuredModalities = normalizeInputModalities(
    modelConfig?.inputModalities,
  )
  // OpenRouter nests the modalities under `architecture`, e.g.
  // ["file", "image", "text"] for vision models:
  // https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
  const remoteModalities = normalizeInputModalities(
    remoteModel?.input_modalities
      ?? remoteModel?.modalities
      ?? getRecordField(remoteModel, "architecture")?.input_modalities,
  )
  const builtinModalities = normalizeInputModalities(
    builtinModelConfig?.inputModalities,
  )
  const displayName =
    getStringField(remoteModel ?? {}, "display_name")
    ?? getStringField(remoteModel ?? {}, "name")
    ?? modelId
  const adapterName = describeProviderAdapter(effectiveType)
  // Codex clients only drive gpt-* models through the native Responses API;
  // other Responses-capable models fall back to the Messages adapter (see
  // shouldFallbackToMessages), so only gpt-* models require upstream catalog
  // metadata and the rest can be synthesized like Messages-fallback models.
  const requiresCatalogMatch =
    effectiveType === "openai-responses" && modelId.startsWith("gpt")

  return {
    slug: `${providerConfig.name}/${modelId}`,
    catalogSlug: modelId,
    catalogMatchRequired: requiresCatalogMatch,
    providerName: providerConfig.name,
    displayName: `${displayName} (${providerConfig.name})`,
    description: `${displayName} through the ${providerConfig.name} ${adapterName} adapter.`,
    contextWindow: positiveNumber(
      modelConfig?.contextWindow
        ?? getFirstPositiveNumber(remoteModel, [
          "context_window",
          "context_length",
          "max_context_length",
          "max_model_len",
        ])
        ?? builtinModelConfig?.contextWindow,
      256_000,
    ),
    maxOutputTokens: positiveNumber(
      modelConfig?.maxOutputTokens
        ?? getFirstPositiveNumber(remoteModel, ["max_output_tokens"])
        ?? getModelsDevModelMaxOutputTokens(
          providerConfig.modelsDevProviderId || providerConfig.name,
          modelId,
        )
        ?? builtinModelConfig?.maxOutputTokens,
      32_000,
    ),
    inputModalities: resolveInputModalities(
      providerConfig.name,
      configuredModalities,
      remoteModalities,
      builtinModalities,
    ),
    reasoningEfforts,
    defaultReasoningEffort: selectDefaultReasoningEffort(
      reasoningEfforts,
      modelConfig?.defaultReasoningEffort
        ?? builtinModelConfig?.defaultReasoningEffort,
    ),
  }
}

function normalizeRemoteReasoningEfforts(
  model: Record<string, unknown> | undefined,
): Array<CodexReasoningEffort> {
  if (!model) return []
  const value = model.reasoning_efforts ?? model.supported_reasoning_levels
  if (!Array.isArray(value)) return []
  return normalizeReasoningEfforts(
    value.map((entry: unknown) =>
      isRecord(entry) && typeof entry.effort === "string" ?
        entry.effort
      : entry,
    ),
  )
}

function normalizeReasoningEfforts(
  value: unknown,
): Array<CodexReasoningEffort> {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value.filter(
        (effort): effort is CodexReasoningEffort =>
          typeof effort === "string"
          && CODEX_REASONING_EFFORTS.has(effort as CodexReasoningEffort),
      ),
    ),
  ]
}

function normalizeInputModalities(value: unknown): Array<"text" | "image"> {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value.filter(
        (modality): modality is "text" | "image" =>
          modality === "text" || modality === "image",
      ),
    ),
  ]
}

function fallbackModalities(
  remoteModalities: Array<"text" | "image">,
  builtinModalities: Array<"text" | "image">,
): Array<"text" | "image"> {
  if (remoteModalities.length > 0) return remoteModalities
  return builtinModalities.length > 0 ? builtinModalities : ["text"]
}

function resolveInputModalities(
  providerName: string,
  configuredModalities: Array<"text" | "image">,
  remoteModalities: Array<"text" | "image">,
  builtinModalities: Array<"text" | "image">,
): Array<"text" | "image"> {
  if (configuredModalities.length > 0) return configuredModalities
  const modalities = fallbackModalities(remoteModalities, builtinModalities)
  if (providerName === "kimi") {
    return [...new Set<"text" | "image">([...modalities, "image"])]
  }
  return modalities
}

function selectDefaultReasoningEffort(
  efforts: Array<CodexReasoningEffort>,
  configured?: CodexReasoningEffort,
): CodexReasoningEffort {
  if (configured && efforts.includes(configured)) return configured
  if (efforts.includes("max")) return "max"
  return efforts[0] ?? "max"
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ?
      Math.floor(value)
    : fallback
}

function getRecordField(
  model: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> | undefined {
  const value = model?.[field]
  return isRecord(value) ? value : undefined
}

function getFirstPositiveNumber(
  model: Record<string, unknown> | undefined,
  fields: Array<string>,
): number | undefined {
  if (!model) return undefined
  for (const field of fields) {
    const value = model[field]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value
    }
  }
  return undefined
}
