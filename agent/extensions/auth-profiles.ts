import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PROFILE_NAMES = ["work", "personal"] as const;
const PROFILE_REFRESH_TIMEOUT_MS = 1_000;
type ProfileName = (typeof PROFILE_NAMES)[number];

type AuthStorageInternals = {
  reload(): void;
  storage: { authPath: string };
};

type RegistryInternals = {
  runtime?: {
    credentials?: {
      store?: AuthStorageInternals;
    };
  };
};

type ProfileConfig = {
  activeProfile?: unknown;
};

const profileDirectory = () => join(getAgentDir(), "auth-profiles");
const profileConfigPath = () => join(getAgentDir(), "auth-profiles.json");
const profileAuthPath = (profile: ProfileName) => join(profileDirectory(), `${profile}.json`);

function isProfileName(value: unknown): value is ProfileName {
  return typeof value === "string" && PROFILE_NAMES.includes(value as ProfileName);
}

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("expected a JSON object");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function ensureProfileFiles(): void {
  mkdirSync(profileDirectory(), { recursive: true, mode: 0o700 });
  for (const profile of PROFILE_NAMES) {
    const path = profileAuthPath(profile);
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      writeFileSync(path, "{}\n", { mode: 0o600, flag: "wx" });
    }
  }
}

function readActiveProfile(): ProfileName {
  const config = readJson(profileConfigPath()) as ProfileConfig;
  return isProfileName(config.activeProfile) ? config.activeProfile : "work";
}

function writeActiveProfile(profile: ProfileName): void {
  const path = profileConfigPath();
  const config = readJson(path);
  config.activeProfile = profile;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function getAuthStorage(registry: ModelRegistry): AuthStorageInternals {
  // Pi 0.80 no longer exports AuthStorage, so preserve its existing backend and
  // change only that backend's path. The shape check fails safely after API changes.
  const storage = (registry as unknown as RegistryInternals).runtime?.credentials?.store;
  if (!storage || typeof storage.reload !== "function" || typeof storage.storage?.authPath !== "string") {
    throw new Error(
      "This Pi version does not expose a switchable file credential store. Run ./install.nu after updating this config.",
    );
  }
  return storage;
}

async function closeProviderSessions(): Promise<void> {
  try {
    const piAi = await import("@earendil-works/pi-ai");
    const cleanup = piAi as typeof piAi & {
      cleanupSessionResources?: () => void;
      closeOpenAICodexWebSocketSessions?: () => void;
    };
    cleanup.cleanupSessionResources?.();
    cleanup.closeOpenAICodexWebSocketSessions?.();
  } catch {
    // Credential rebinding still works when the optional transport cleanup API is unavailable.
  }
}

function refreshRegistryInBackground(
  registry: Pick<ModelRegistry, "refresh">,
  providers: readonly string[],
  cleanup: () => Promise<void> = closeProviderSessions,
  timeoutMs = PROFILE_REFRESH_TIMEOUT_MS,
): void {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  // A provider refresh is optional bookkeeping. Never return its promise to a
  // Pi lifecycle handler: network, credential helpers, or third-party providers
  // must not be able to leave the TUI half-initialized.
  void Promise.resolve()
    .then(cleanup)
    .then(() =>
      registry.refresh({
        allowNetwork: false,
        providers,
        signal: controller.signal,
      }),
    )
    .catch(() => {})
    .finally(() => clearTimeout(timeout));
}

function bindProfile(registry: ModelRegistry, profile: ProfileName): void {
  const authStorage = getAuthStorage(registry);
  authStorage.storage.authPath = profileAuthPath(profile);
  authStorage.reload();
  refreshRegistryInBackground(registry, providersFor(profile));
}

function providersFor(profile: ProfileName): string[] {
  return Object.keys(readJson(profileAuthPath(profile))).sort();
}

function setStatus(ctx: Pick<ExtensionContext, "ui">, profile: ProfileName): void {
  ctx.ui.setStatus("auth-profile", ctx.ui.theme.fg("accent", `profile: ${profile}`));
}

export default function authProfiles(pi: ExtensionAPI) {
  let activeProfile: ProfileName = "work";

  pi.on("session_start", (_event, ctx) => {
    ensureProfileFiles();
    activeProfile = readActiveProfile();
    bindProfile(ctx.modelRegistry, activeProfile);
    setStatus(ctx, activeProfile);
  });

  pi.registerCommand("profile", {
    description: "Switch between the independent work and personal login profiles",
    getArgumentCompletions: (prefix) => {
      const values = [...PROFILE_NAMES, "status"];
      return values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      ensureProfileFiles();

      const requested = args.trim();
      if (requested === "status") {
        const providers = providersFor(activeProfile);
        ctx.ui.notify(
          `Auth profile: ${activeProfile}\nFile: ${profileAuthPath(activeProfile)}\nProviders: ${providers.join(", ") || "none — run /login"}`,
          "info",
        );
        return;
      }

      let selected: ProfileName | undefined;
      if (isProfileName(requested)) {
        selected = requested;
      } else if (requested.length > 0) {
        ctx.ui.notify("Usage: /profile [work|personal|status]", "warning");
        return;
      } else {
        const choices = PROFILE_NAMES.map((profile) => {
          const providers = providersFor(profile);
          return `${profile}${profile === activeProfile ? " (active)" : ""} — ${providers.join(", ") || "no logins"}`;
        });
        const choice = await ctx.ui.select("Select Pi login profile", choices);
        const index = choice === undefined ? -1 : choices.indexOf(choice);
        selected = PROFILE_NAMES[index];
      }

      if (!selected || selected === activeProfile) return;
      bindProfile(ctx.modelRegistry, selected);
      writeActiveProfile(selected);
      activeProfile = selected;
      pi.events.emit("auth-profile:changed", { profile: selected });
      setStatus(ctx, activeProfile);
      ctx.ui.notify(`Switched to ${selected}. /login and /logout now use only this profile.`, "info");
    },
  });
}

export const _test = { refreshRegistryInBackground };
