/**
 * OpenRouter usage parsing.
 *
 * Data sources:
 * - GET https://openrouter.ai/api/v1/auth/key (key spend limit and usage)
 * - GET https://openrouter.ai/api/v1/credits (account credit balance)
 */

export interface OpenRouterUsageData {
  label: string | null;
  /** Key spend limit, null when unlimited. */
  limit: number | null;
  limitReset: string | null;
  usage: number;
  usageMonthly: number;
  limitRemaining: number | null;
  totalCredits: number | null;
  totalUsage: number | null;
}

/** Parse the JSON body of GET https://openrouter.ai/api/v1/auth/key. */
export function parseOpenRouterKeyUsage(payload: unknown): OpenRouterUsageData | null {
  if (typeof payload !== "object" || payload === null) return null;
  const outer = payload as { data?: Record<string, unknown> };
  const data = typeof outer.data === "object" && outer.data !== null ? outer.data : null;
  if (!data) return null;
  const usage = Number(data.usage);
  return {
    label: typeof data.label === "string" ? data.label : null,
    limit: typeof data.limit === "number" ? data.limit : null,
    limitReset: typeof data.limit_reset === "string" ? data.limit_reset : null,
    usage: Number.isFinite(usage) ? usage : 0,
    usageMonthly: Number.isFinite(Number(data.usage_monthly)) ? Number(data.usage_monthly) : 0,
    limitRemaining: Number.isFinite(Number(data.limit_remaining)) ? Number(data.limit_remaining) : null,
    totalCredits: null,
    totalUsage: null,
  };
}

/** Merge GET /api/v1/credits data into an existing OpenRouter usage snapshot. */
export function applyOpenRouterCredits(data: OpenRouterUsageData, payload: unknown): OpenRouterUsageData {
  if (typeof payload !== "object" || payload === null) return data;
  const outer = payload as { data?: Record<string, unknown> };
  const credits = typeof outer.data === "object" && outer.data !== null ? outer.data : null;
  if (!credits) return data;
  return {
    ...data,
    totalCredits: Number.isFinite(Number(credits.total_credits)) ? Number(credits.total_credits) : null,
    totalUsage: Number.isFinite(Number(credits.total_usage)) ? Number(credits.total_usage) : null,
  };
}
