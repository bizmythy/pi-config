import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFindTool, createGrepTool } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  pi.registerTool(createGrepTool(cwd));
  pi.registerTool(createFindTool(cwd));
}
