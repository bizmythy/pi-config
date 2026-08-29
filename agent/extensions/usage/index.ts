import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type CodexUsageData, parseCodexUsage } from "./codex.js";
import { clampPercent, formatMoney, humanizeSeconds } from "./format.js";
import { type GrokUsageData, grokBaseUrl, parseGrokMonthlyUsage, parseGrokWeeklyUsage } from "./grok.js";
import { applyOpenRouterCredits, type OpenRouterUsageData, parseOpenRouterKeyUsage } from "./openrouter.js";

const AGENT_DIR = getAgentDir();
const AUTH_FILE = join(AGENT_DIR, "auth.json");
const AUTH_PROFILES_CONFIG = join(AGENT_DIR, "auth-profiles.json");
const AUTH_PROFILES_DIR = join(AGENT_DIR, "auth-profiles");
const SECRETS_FILE = join(homedir(), ".pi", "secrets", "personal.json");

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/auth/key";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

const BAR_WIDTH = 24;

type ProviderResult<T> = { status: "ok"; data: T } | { status: "error"; message: string };

interface Snapshot {
  codex: ProviderResult<CodexUsageData> | null;
  openrouter: ProviderResult<OpenRouterUsageData> | null;
  /** Null when Grok is not available (no valid login). */
  grok: ProviderResult<GrokUsageData> | null;
  fetchedAt: number;
}

interface OAuthCredential {
  access: string;
  expiresAt: number | null;
  accountId: string | null;
  baseUrl: string | null;
  /** Where the credential was resolved from, for error messages. */
  source: string;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function oauthFrom(auth: unknown, provider: string, source: string): OAuthCredential | null {
  const providers = auth as Record<string, Record<string, unknown>> | null;
  const entry = providers?.[provider];
  if (!entry || typeof entry.access !== "string" || !entry.access) return null;
  return {
    access: entry.access,
    expiresAt: typeof entry.expires === "number" ? entry.expires : null,
    accountId: typeof entry.accountId === "string" ? entry.accountId : null,
    baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : null,
    source,
  };
}

/**
 * Resolve an OAuth provider credential downstream of the active auth profile,
 * mirroring the auth-profiles extension: auth-profiles.json names the active
 * profile and auth-profiles/<profile>.json holds its credentials. Falls back to
 * the default auth.json store when no profile is configured.
 */
async function resolveProviderCredential(provider: string): Promise<OAuthCredential | null> {
  const config = (await readJson(AUTH_PROFILES_CONFIG)) as { activeProfile?: unknown } | null;
  const profile = typeof config?.activeProfile === "string" ? config.activeProfile : null;
  if (profile) {
    const profileAuth = await readJson(join(AUTH_PROFILES_DIR, `${profile}.json`));
    const credentials = oauthFrom(profileAuth, provider, `auth profile "${profile}"`);
    if (credentials) return credentials;
  }
  return oauthFrom(await readJson(AUTH_FILE), provider, "default auth store");
}

function readCodexCredentials(): Promise<OAuthCredential | null> {
  return resolveProviderCredential("openai-codex");
}

/**
 * Grok is only shown when it is actually usable: either the env bypass token is
 * set, or the active profile holds an unexpired grok-cli login.
 */
async function readGrokCredentials(): Promise<OAuthCredential | null> {
  const envToken = process.env.GROK_CLI_OAUTH_TOKEN;
  if (envToken?.trim()) {
    return {
      access: envToken.trim(),
      expiresAt: null,
      accountId: null,
      baseUrl: null,
      source: "GROK_CLI_OAUTH_TOKEN",
    };
  }
  const credentials = await resolveProviderCredential("grok-cli");
  if (!credentials) return null;
  if (credentials.expiresAt !== null && credentials.expiresAt <= Date.now()) return null;
  return credentials;
}

async function readOpenRouterApiKey(): Promise<string | null> {
  const secrets = (await readJson(SECRETS_FILE)) as { openrouter?: { apiKey?: unknown } } | null;
  const key = secrets?.openrouter?.apiKey;
  if (typeof key === "string" && key.trim()) return key.trim();
  const fromEnv = process.env.OPENROUTER_API_KEY;
  return fromEnv?.trim() ? fromEnv.trim() : null;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  }
  return (await response.json()) as unknown;
}

async function fetchCodex(signal: AbortSignal | undefined): Promise<ProviderResult<CodexUsageData>> {
  const credentials = await readCodexCredentials();
  if (!credentials) {
    return { status: "error", message: "not logged in (run /login for openai-codex)" };
  }
  if (credentials.expiresAt !== null && credentials.expiresAt <= Date.now()) {
    return {
      status: "error",
      message: `access token expired in ${credentials.source} (run /login to refresh)`,
    };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.access}`,
    Accept: "application/json",
    "User-Agent": "codex_cli_rs",
    originator: "codex_cli_rs",
  };
  if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
  try {
    const payload = await fetchJson(CODEX_USAGE_URL, headers, signal);
    const data = parseCodexUsage(payload);
    if (!data) return { status: "error", message: "unexpected response payload" };
    return { status: "ok", data };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchOpenRouter(signal: AbortSignal | undefined): Promise<ProviderResult<OpenRouterUsageData>> {
  const apiKey = await readOpenRouterApiKey();
  if (!apiKey) {
    return { status: "error", message: `no API key found (openrouter.apiKey in ${SECRETS_FILE})` };
  }
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  try {
    const keyPayload = await fetchJson(OPENROUTER_KEY_URL, headers, signal);
    const data = parseOpenRouterKeyUsage(keyPayload);
    if (!data) return { status: "error", message: "unexpected response payload" };
    try {
      const creditsPayload = await fetchJson(OPENROUTER_CREDITS_URL, headers, signal);
      return { status: "ok", data: applyOpenRouterCredits(data, creditsPayload) };
    } catch {
      return { status: "ok", data };
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchGrok(signal: AbortSignal | undefined): Promise<ProviderResult<GrokUsageData> | null> {
  const credentials = await readGrokCredentials();
  if (!credentials) return null;
  const baseUrl = grokBaseUrl({ baseUrl: credentials.baseUrl });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.access}`,
    "x-xai-token-auth": "xai-grok-cli",
    Accept: "application/json",
  };
  try {
    const monthly = parseGrokMonthlyUsage(await fetchJson(`${baseUrl}/billing`, headers, signal));
    if (!monthly) return { status: "error", message: "unexpected billing payload" };
    let weekly = null;
    try {
      weekly = parseGrokWeeklyUsage(await fetchJson(`${baseUrl}/billing?format=credits`, headers, signal));
    } catch {
      // Weekly usage is optional.
    }
    return { status: "ok", data: { baseUrl, monthly, weekly } };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

async function loadSnapshot(signal: AbortSignal | undefined): Promise<Snapshot> {
  const [codex, openrouter, grok] = await Promise.all([fetchCodex(signal), fetchOpenRouter(signal), fetchGrok(signal)]);
  return { codex, openrouter, grok, fetchedAt: Date.now() };
}

function remainingColor(remainingPercent: number): string {
  return remainingPercent <= 10 ? "error" : remainingPercent <= 30 ? "warning" : "success";
}

function percentColor(
  theme: { fg: (color: string, text: string) => string },
  remainingPercent: number,
  text: string,
): string {
  return theme.fg(remainingColor(remainingPercent), text);
}

/** Bar filled by the remaining share of the limit. */
function renderBar(theme: { fg: (color: string, text: string) => string }, remainingPercent: number): string {
  const filled = Math.round((clampPercent(remainingPercent) / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return theme.fg(remainingColor(remainingPercent), "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
}

function percentLeftText(remainingPercent: number): string {
  const remaining = clampPercent(remainingPercent);
  const label = remaining >= 9.95 ? `${Math.round(remaining)}% left` : `${remaining.toFixed(2)}% left`;
  return label;
}

function snapshotLines(
  snapshot: Snapshot,
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
): string[] {
  const lines: string[] = [];
  const dim = (text: string) => theme.fg("dim", text);
  const muted = (text: string) => theme.fg("muted", text);

  const codex = snapshot.codex;
  if (codex) {
    lines.push(theme.bold("OpenAI Codex"));
    if (codex.status === "error") {
      lines.push(`  ${dim("unavailable:")} ${theme.fg("error", codex.message)}`);
    } else {
      const data = codex.data;
      const windows = data.windows.length ? data.windows : [{ label: "?", usedPercent: 0, resetAfterSeconds: null }];
      for (const win of windows) {
        const remaining = 100 - clampPercent(win.usedPercent);
        const reset =
          win.resetAfterSeconds !== null ? dim(`  resets in ${humanizeSeconds(win.resetAfterSeconds)}`) : "";
        lines.push(
          `  ${muted(win.label.padEnd(3))} window  ${renderBar(theme, remaining)}  ${percentColor(theme, remaining, percentLeftText(remaining))}${reset}`,
        );
      }
      if (data.rateLimitReached) lines.push(`  ${theme.fg("error", "rate limit reached")}`);
      if (data.creditsSummary) lines.push(`  ${dim("credits:")} ${data.creditsSummary}`);
      const spend = data.spendControl;
      if (spend) {
        const remaining = 100 - clampPercent(spend.usedPercent);
        const limitText = spend.limit !== null ? formatMoney(spend.limit) : "unknown limit";
        const reset = spend.resetAfterSeconds !== null ? `, resets in ${humanizeSeconds(spend.resetAfterSeconds)}` : "";
        lines.push(
          `  ${dim("spend control:")} ${percentColor(theme, remaining, percentLeftText(remaining))} of ${limitText}${reset} ${dim(`(${spend.source})`)}`,
        );
      }
    }
    lines.push("");
  }

  const grok = snapshot.grok;
  if (grok) {
    lines.push(theme.bold("Grok (x.ai)"));
    if (grok.status === "error") {
      lines.push(`  ${dim("unavailable:")} ${theme.fg("error", grok.message)}`);
    } else {
      const data = grok.data;
      const monthly = data.monthly;
      const monthlyLeft = Math.max(0, monthly.limitCredits - monthly.usedCredits);
      const monthlyPercent = monthly.limitCredits > 0 ? clampPercent((monthlyLeft / monthly.limitCredits) * 100) : 100;
      const monthlyReset = humanizeSeconds((new Date(monthly.periodEnd).getTime() - Date.now()) / 1000);
      lines.push(
        `  ${muted("monthly")}  ${renderBar(theme, monthlyPercent)}  ${percentColor(theme, monthlyPercent, percentLeftText(monthlyPercent))}${dim(`  resets in ${monthlyReset}`)}`,
      );
      lines.push(
        `  ${dim("credits:")} ${Math.round(monthlyLeft).toLocaleString("en-US")} of ${Math.round(monthly.limitCredits).toLocaleString("en-US")} left`,
      );
      const weekly = data.weekly;
      if (weekly) {
        const weeklyPercent = 100 - clampPercent(weekly.usedPercent);
        const weeklyReset = humanizeSeconds((new Date(weekly.periodEnd).getTime() - Date.now()) / 1000);
        lines.push(
          `  ${muted("weekly ")}  ${renderBar(theme, weeklyPercent)}  ${percentColor(theme, weeklyPercent, percentLeftText(weeklyPercent))}${dim(`  resets in ${weeklyReset}`)}`,
        );
      }
    }
    lines.push("");
  }

  const openrouter = snapshot.openrouter;
  if (openrouter) {
    lines.push(theme.bold("OpenRouter"));
    if (openrouter.status === "error") {
      lines.push(`  ${dim("unavailable:")} ${theme.fg("error", openrouter.message)}`);
    } else {
      const data = openrouter.data;
      if (data.limit !== null) {
        const remaining = data.limit > 0 ? clampPercent(((data.limit - data.usage) / data.limit) * 100) : 100;
        const remainingMoney =
          data.limitRemaining !== null ? formatMoney(data.limitRemaining) : formatMoney(data.limit - data.usage);
        const reset = data.limitReset ? dim(` (${data.limitReset})`) : "";
        lines.push(`  ${renderBar(theme, remaining)}  ${percentColor(theme, remaining, percentLeftText(remaining))}`);
        lines.push(
          `  ${remainingMoney} left of ${formatMoney(data.limit)}${reset} ${dim(`(${formatMoney(data.usage)} used)`)}`,
        );
      } else {
        lines.push(`  ${formatMoney(data.usage)} used (no key limit)`);
      }
      if (data.totalCredits !== null) {
        const left = Math.max(0, data.totalCredits - (data.totalUsage ?? data.usage));
        lines.push(`  ${dim("credits:")} ${formatMoney(left)} of ${formatMoney(data.totalCredits)} remaining`);
      }
    }
  }

  if (!codex && !openrouter) {
    lines.push(dim("No provider credentials found."));
  }
  return lines;
}

function plainSnapshotText(snapshot: Snapshot): string {
  const lines = snapshotLines(snapshot, {
    fg: (_color, text) => text,
    bold: (text) => text,
  });
  return lines.join("\n").replace(/█|░/g, (c) => (c === "█" ? "#" : "-"));
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show Codex rate-limit windows and OpenRouter credit usage",
    handler: async (_args, ctx) => {
      let snapshot: Snapshot | null = null;

      if (ctx.mode !== "tui") {
        snapshot = await loadSnapshot(undefined);
        ctx.ui.notify(plainSnapshotText(snapshot), "info");
        return;
      }

      snapshot = await ctx.ui.custom<Snapshot | null>((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, "Fetching provider usage...");
        loader.onAbort = () => done(null);
        loadSnapshot(loader.signal)
          .then(done)
          .catch(() => done(null));
        return loader;
      });

      if (!snapshot) return;

      let refreshing = false;
      await ctx.ui.custom((_tui, theme, _keybindings, done) => {
        let cached: { width: number; lines: string[] } | undefined;

        const refresh = async () => {
          if (refreshing) return;
          refreshing = true;
          cached = undefined;
          _tui.requestRender();
          try {
            snapshot = await loadSnapshot(undefined);
          } catch {
            // keep previous snapshot on refresh failure
          }
          refreshing = false;
          cached = undefined;
          _tui.requestRender();
        };

        const refreshPromise = refresh();
        void refreshPromise;

        return {
          render(width: number): string[] {
            if (cached && cached.width === width) return cached.lines;
            const current = snapshot;
            if (!current) return [truncateToWidth("Usage unavailable", width)];

            const title = theme.bold("Provider usage");
            const stamp = theme.fg("dim", new Date(current.fetchedAt).toLocaleTimeString());
            const spinner = refreshing ? theme.fg("accent", "  refreshing…") : "";
            const content = [
              ` ${title}  ${stamp}${spinner}`,
              ...snapshotLines(current, theme),
              ` ${theme.fg("dim", "r refresh · esc close")}`,
            ];

            const inner = Math.min(width - 4, Math.max(...content.map((line) => visibleWidth(line)), 40));
            const boxLines = [
              `╭─${"─".repeat(inner + 2)}─╮`,
              ...content.map((line) => {
                const padded = line + " ".repeat(Math.max(0, inner + 2 - visibleWidth(line)));
                return `│ ${padded} │`;
              }),
              `╰─${"─".repeat(inner + 2)}─╯`,
            ];
            cached = { width, lines: boxLines.map((line) => truncateToWidth(line, width)) };
            return cached.lines;
          },
          invalidate() {
            cached = undefined;
          },
          handleInput(data: string) {
            if (matchesKey(data, Key.escape) || data === "q") {
              done(undefined);
              return;
            }
            if (data === "r" || data === "R") {
              void refresh();
            }
          },
        };
      });
    },
  });
}
