import type { Context } from "hono"

import { stripInternalRequestHeaders } from "~/lib/internal-headers"
import {
  createModelListResponse,
  getAggregatedModels,
} from "~/routes/models/model-discovery"

export async function handleDefaultModels(c: Context): Promise<Response> {
  const models = await getAggregatedModels(
    stripInternalRequestHeaders(c.req.raw.headers),
  )
  return createModelListResponse(c, models)
}
