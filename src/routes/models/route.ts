import { Hono } from "hono"

import { isClaudeUserAgent } from "~/lib/claude-models"
import { forwardError } from "~/lib/error"
import { handleClaudeModels } from "~/routes/models/claude-models"
import {
  handleCodexModels,
  isCodexUserAgent,
} from "~/routes/models/codex-models"
import { handleDefaultModels } from "~/routes/models/default-models"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    const userAgent = c.req.header("user-agent")
    if (isCodexUserAgent(userAgent)) return await handleCodexModels(c)
    if (isClaudeUserAgent(userAgent)) return await handleClaudeModels(c)
    return await handleDefaultModels(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
