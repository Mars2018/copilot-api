import type { Context } from "hono"

import { toClaudeDiscoveryModelId } from "~/lib/claude-models"
import { getRawProviderConfig, type ProviderConfig } from "~/lib/config"
import { GITHUB_COPILOT_PROVIDER } from "~/lib/github-copilot-provider"
import { stripInternalRequestHeaders } from "~/lib/internal-headers"
import { toClientModelId } from "~/lib/models"
import { getProviderAgentModels } from "~/lib/provider-management"
import type { Model } from "~/lib/types/models"
import {
  createModelListResponse,
  getAggregatedModels,
  getModelsById,
} from "~/routes/models/model-discovery"

function selectClaudeCopilotModels(models: Array<Model>): Array<Model> {
  const selection = getProviderAgentModels(
    getRawProviderConfig(GITHUB_COPILOT_PROVIDER),
  )
  if (selection === undefined) return models
  return models.filter(
    (model) =>
      selection.includes(model.id)
      || selection.includes(toClientModelId(model.id)),
  )
}

function selectClaudeProviderModels(
  providerConfig: ProviderConfig | null,
  models: Array<unknown>,
): Array<unknown> {
  const selection = getProviderAgentModels(providerConfig)
  if (selection === undefined) return models
  const modelsById = getModelsById(models)
  return selection.map((id) => modelsById.get(id) ?? { id })
}

export async function handleClaudeModels(c: Context): Promise<Response> {
  const models = await getAggregatedModels(
    stripInternalRequestHeaders(c.req.raw.headers),
    {
      selectCopilotModels: selectClaudeCopilotModels,
      selectProviderModels: selectClaudeProviderModels,
    },
  )
  return createModelListResponse(
    c,
    models.map((model) => ({
      ...model,
      id: toClaudeDiscoveryModelId(model.id),
      ...(typeof model.claude_model_id === "string" ?
        { claude_model_id: toClaudeDiscoveryModelId(model.claude_model_id) }
      : {}),
    })),
  )
}
