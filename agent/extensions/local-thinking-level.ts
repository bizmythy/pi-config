import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type LocalPiSettings = {
  defaultThinkingLevel?: ThinkingLevel;
};

const validThinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const patchMarker = Symbol.for("pi.local-thinking-level.patch-installed");

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.cwd(), ".pi", "agent");
}

function getLocalSettingsPath(): string {
  return join(getAgentDir(), "local-settings.json");
}

function readLocalSettings(): LocalPiSettings {
  const path = getLocalSettingsPath();
  if (!existsSync(path)) return {};

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LocalPiSettings;
    if (parsed.defaultThinkingLevel !== undefined && !validThinkingLevels.has(parsed.defaultThinkingLevel)) {
      delete parsed.defaultThinkingLevel;
    }
    return parsed;
  } catch {
    return {};
  }
}

function writeLocalSettings(settings: LocalPiSettings): void {
  const path = getLocalSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function installPatch() {
  const proto = SettingsManager.prototype as SettingsManager & { [patchMarker]?: boolean };
  if (proto[patchMarker]) return;

  const originalGetDefaultThinkingLevel = proto.getDefaultThinkingLevel;

  proto.getDefaultThinkingLevel = function getDefaultThinkingLevelWithLocalOverride() {
    const localLevel = readLocalSettings().defaultThinkingLevel;
    return localLevel ?? originalGetDefaultThinkingLevel.call(this);
  };

  proto.setDefaultThinkingLevel = function setDefaultThinkingLevelLocally(level: ThinkingLevel) {
    const localSettings = readLocalSettings();
    localSettings.defaultThinkingLevel = level;
    writeLocalSettings(localSettings);

    // Keep the active SettingsManager instance in sync without marking
    // agent/settings.json modified. These fields are public in the runtime JS.
    const manager = this as unknown as {
      settings?: LocalPiSettings;
      globalSettings?: LocalPiSettings;
    };
    if (manager.settings) manager.settings.defaultThinkingLevel = level;
    if (manager.globalSettings) manager.globalSettings.defaultThinkingLevel = level;
  };

  proto[patchMarker] = true;
}

export default function (_pi: ExtensionAPI) {
  installPatch();
}
