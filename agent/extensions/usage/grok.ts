/**
 * Grok (x.ai) usage parsing for the grok-cli provider.
 *
 * Data sources (pi-grok-cli provider):
 * - GET {baseUrl}/billing                → monthly credit limit and usage
 * - GET {baseUrl}/billing?format=credits → optional weekly credit usage
 */

const DEFAULT_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

export interface GrokMonthlyUsage {
  /** Monthly credit limit. */
  limitCredits: number;
  usedCredits: number;
  /** ISO timestamp of the billing period end. */
  periodEnd: string;
}

export interface GrokWeeklyUsage {
  /** Percent of the weekly credit allowance already used. */
  usedPercent: number;
  periodEnd: string;
}

export interface GrokUsageData {
  baseUrl: string;
  monthly: GrokMonthlyUsage;
  weekly: GrokWeeklyUsage | null;
}

export function grokBaseUrl(credentials: { baseUrl?: unknown } | undefined): string {
  const raw = credentials?.baseUrl;
  return typeof raw === "string" && raw.trim() ? raw.replace(/\/+$/, "") : DEFAULT_BASE_URL;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

interface GrokBillingConfig {
  monthlyLimit?: unknown;
  used?: unknown;
  billingPeriodEnd?: unknown;
  currentPeriod?: unknown;
  creditUsagePercent?: unknown;
}

function configOf(payload: unknown): GrokBillingConfig | null {
  if (typeof payload !== "object" || payload === null) return null;
  const config = (payload as { config?: unknown }).config;
  return typeof config === "object" && config !== null ? (config as GrokBillingConfig) : null;
}

/** Parse the JSON body of GET {baseUrl}/billing. */
export function parseGrokMonthlyUsage(payload: unknown): GrokMonthlyUsage | null {
  const config = configOf(payload);
  if (!config) return null;
  const limit = finiteNumber((config.monthlyLimit as { val?: unknown } | undefined)?.val);
  const used = finiteNumber((config.used as { val?: unknown } | undefined)?.val);
  const periodEnd = isoTimestamp(config.billingPeriodEnd);
  if (limit === null || used === null || periodEnd === null) return null;
  return { limitCredits: limit, usedCredits: used, periodEnd };
}

/** Parse the JSON body of GET {baseUrl}/billing?format=credits. */
export function parseGrokWeeklyUsage(payload: unknown): GrokWeeklyUsage | null {
  const config = configOf(payload);
  if (!config) return null;
  const currentPeriod = config.currentPeriod;
  if (typeof currentPeriod !== "object" || currentPeriod === null) return null;
  if ((currentPeriod as { type?: unknown }).type !== "USAGE_PERIOD_TYPE_WEEKLY") return null;
  const usedPercent = finiteNumber(config.creditUsagePercent);
  const periodEnd = isoTimestamp(config.billingPeriodEnd);
  if (usedPercent === null || periodEnd === null) return null;
  return { usedPercent, periodEnd };
}
