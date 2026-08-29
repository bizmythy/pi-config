/**
 * OpenAI Codex usage parsing.
 *
 * Data source: GET https://chatgpt.com/backend-api/wham/usage (ChatGPT OAuth).
 */

import { clampPercent } from "./format.js";

export interface CodexWindow {
  /** Human label derived from the window size, e.g. "5h" or "7d". */
  label: string;
  usedPercent: number;
  /** Seconds until the window resets, when the API provides it. */
  resetAfterSeconds: number | null;
}

export interface CodexSpendControl {
  source: string;
  limit: number | null;
  used: number | null;
  usedPercent: number;
  resetAfterSeconds: number | null;
}

export interface CodexUsageData {
  plan: string | null;
  windows: CodexWindow[];
  /** e.g. "unlimited credits", "$5.00 credits", or null when not applicable. */
  creditsSummary: string | null;
  spendControl: CodexSpendControl | null;
  rateLimitReached: boolean;
}

export function windowLabelFromSeconds(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "?";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours < 48) return `${hours}h`;
  const days = seconds / 86400;
  if (Number.isInteger(days)) return `${days}d`;
  if (hours < 48) return `${Math.floor(hours)}h ${minutes % 60}m`;
  return `${Math.floor(days)}d`;
}

function parseWindow(raw: unknown): CodexWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const win = raw as {
    used_percent?: unknown;
    limit_window_seconds?: unknown;
    reset_after_seconds?: unknown;
  };
  const usedPercent = Number(win.used_percent);
  if (!Number.isFinite(usedPercent)) return null;
  const seconds = Number(win.limit_window_seconds);
  const resetAfter = Number(win.reset_after_seconds);
  return {
    label: windowLabelFromSeconds(Number.isFinite(seconds) ? seconds : null),
    usedPercent: clampPercent(usedPercent),
    resetAfterSeconds: Number.isFinite(resetAfter) ? resetAfter : null,
  };
}

function parseCodexSpendControl(raw: unknown): CodexSpendControl | null {
  if (typeof raw !== "object" || raw === null) return null;
  const sc = raw as {
    individual_limit?: {
      source?: unknown;
      limit?: unknown;
      used?: unknown;
      used_percent?: unknown;
      reset_after_seconds?: unknown;
    };
  };
  const limit = sc.individual_limit;
  if (typeof limit !== "object" || limit === null) return null;
  const limitValue = Number(limit.limit);
  const usedValue = Number(limit.used);
  const resetAfter = Number(limit.reset_after_seconds);
  return {
    source: typeof limit.source === "string" ? limit.source : "unknown",
    limit: Number.isFinite(limitValue) ? limitValue : null,
    used: Number.isFinite(usedValue) ? usedValue : null,
    usedPercent: clampPercent(limit.used_percent),
    resetAfterSeconds: Number.isFinite(resetAfter) ? resetAfter : null,
  };
}

/** Parse the JSON body of GET https://chatgpt.com/backend-api/wham/usage. */
export function parseCodexUsage(payload: unknown): CodexUsageData | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = payload as {
    plan_type?: unknown;
    rate_limit?: Record<string, unknown>;
    credits?: Record<string, unknown>;
    spend_control?: unknown;
    rate_limit_reached?: unknown;
  };

  const rateLimit = typeof data.rate_limit === "object" && data.rate_limit !== null ? data.rate_limit : {};
  const windows: CodexWindow[] = [];
  for (const key of ["primary_window", "secondary_window"] as const) {
    const win = parseWindow(rateLimit[key]);
    if (win) windows.push(win);
  }

  let creditsSummary: string | null = null;
  const credits = data.credits;
  if (typeof credits === "object" && credits !== null) {
    if (credits.unlimited === true) {
      creditsSummary = "unlimited credits";
    } else if (credits.has_credits === true) {
      creditsSummary = typeof credits.balance === "string" ? `${credits.balance} credits` : "credits available";
    }
  }

  const spendControl = parseCodexSpendControl(data.spend_control);
  if (windows.length === 0 && creditsSummary === null && spendControl === null) return null;

  return {
    plan: typeof data.plan_type === "string" ? data.plan_type : null,
    windows,
    creditsSummary,
    spendControl,
    rateLimitReached: data.rate_limit_reached === true,
  };
}
