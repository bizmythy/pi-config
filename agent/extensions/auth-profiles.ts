import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PROFILE_NAMES = ["work", "personal"] as const;
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

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("expected a JSON object");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function ensureProfileFiles(): Promise<void> {
  await mkdir(profileDirectory(), { recursive: true, mode: 0o700 });
  for (const profile of PROFILE_NAMES) {
    const path = profileAuthPath(profile);
    try {
      await chmod(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(path, "{}\n", { mode: 0o600, flag: "wx" });
    }
  }
}

async function readActiveProfile(): Promise<ProfileName> {
  const config = (await readJson(profileConfigPath())) as ProfileConfig;
  return isProfileName(config.activeProfile) ? config.activeProfile : "work";
}

async function writeActiveProfile(profile: ProfileName): Promise<void> {
  const path = profileConfigPath();
  const config = await readJson(path);
  config.activeProfile = profile;
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
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

async function bindProfile(registry: ModelRegistry, profile: ProfileName): Promise<void> {
  const authStorage = getAuthStorage(registry);
  authStorage.storage.authPath = profileAuthPath(profile);
  authStorage.reload();
  await closeProviderSessions();
  await registry.refresh();
}

async function providersFor(profile: ProfileName): Promise<string[]> {
  const providers = Object.keys(await readJson(profileAuthPath(profile)));
  if (profile === "work") providers.push("azure-foundry");
  return providers.sort();
}

function setStatus(ctx: Pick<ExtensionContext, "ui">, profile: ProfileName): void {
  ctx.ui.setStatus("auth-profile", ctx.ui.theme.fg("accent", `profile: ${profile}`));
}

export default function authProfiles(pi: ExtensionAPI) {
  let activeProfile: ProfileName = "work";

  pi.on("session_start", async (_event, ctx) => {
    await ensureProfileFiles();
    activeProfile = await readActiveProfile();
    await bindProfile(ctx.modelRegistry, activeProfile);
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
      await ensureProfileFiles();

      const requested = args.trim();
      if (requested === "status") {
        const providers = await providersFor(activeProfile);
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
        const choices = await Promise.all(
          PROFILE_NAMES.map(async (profile) => {
            const providers = await providersFor(profile);
            return `${profile}${profile === activeProfile ? " (active)" : ""} — ${providers.join(", ") || "no logins"}`;
          }),
        );
        const choice = await ctx.ui.select("Select Pi login profile", choices);
        const index = choice === undefined ? -1 : choices.indexOf(choice);
        selected = PROFILE_NAMES[index];
      }

      if (!selected || selected === activeProfile) return;
      await bindProfile(ctx.modelRegistry, selected);
      await writeActiveProfile(selected);
      activeProfile = selected;
      pi.events.emit("auth-profile:changed", { profile: selected });
      setStatus(ctx, activeProfile);
      ctx.ui.notify(`Switched to ${selected}. /login and /logout now use only this profile.`, "info");
    },
  });
}
