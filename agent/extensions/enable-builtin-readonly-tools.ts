import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READONLY_TOOL_NAMES = ["find", "grep", "ls"];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
    const activeToolNames = new Set(pi.getActiveTools().map((tool) => tool.name));

    for (const name of READONLY_TOOL_NAMES) {
      if (allToolNames.has(name)) {
        activeToolNames.add(name);
      }
    }

    pi.setActiveTools([...activeToolNames]);

  });
}
