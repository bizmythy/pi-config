import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { updateActiveTools } from "./shared/tool-activation.js";

const READONLY_TOOL_NAMES = ["find", "grep", "ls"];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
    updateActiveTools(pi, { add: READONLY_TOOL_NAMES.filter((name) => allToolNames.has(name)) });
  });
}
