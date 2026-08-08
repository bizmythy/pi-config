import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyId } from "@earendil-works/pi-tui";

const KEYBINDINGS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../keybindings.json");

export function configuredShortcut(name: string): KeyId | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(KEYBINDINGS_FILE, "utf8")) as Record<string, unknown>;
    const value = parsed[name];
    return typeof value === "string" ? (value as KeyId) : undefined;
  } catch {
    return undefined;
  }
}
