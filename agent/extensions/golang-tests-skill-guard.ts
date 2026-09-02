/**
 * Require the `golang-tests` skill to be in context before writing Go tests.
 *
 * The first `write`/`edit` of a `*_test.go` file is blocked when the skill text
 * is not present in the current context (session start or last compaction),
 * and the skill is handed to the agent as the block reason so the retry has it.
 * No-op wherever the skill is not among the loaded skills.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

const SKILL_NAME = "golang-tests";

function skillBody(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content);
  return (match ? content.slice(match[0].length) : content).trim();
}

/** Longest early line of the body, used to detect the body verbatim in context. */
function bodyMarker(body: string): string {
  const candidate = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length >= 60);
  return candidate ?? body.slice(0, 60);
}

function isInContext(entries: unknown[], marker: string): boolean {
  const escaped = JSON.stringify(marker).slice(1, -1);
  return JSON.stringify(entries).includes(escaped);
}

export default function (pi: ExtensionAPI) {
  let skill: Skill | undefined;
  let cached: { filePath: string; body: string; marker: string } | undefined;
  // Siblings in a parallel tool batch preflight before the session sees each
  // other's results, so the body would otherwise be repeated per blocked call.
  let bodySent = false;

  pi.on("before_agent_start", (event) => {
    skill = event.systemPromptOptions.skills?.find((s) => s.name === SKILL_NAME);
    return undefined;
  });

  pi.on("session_start", () => {
    bodySent = false;
    return undefined;
  });

  pi.on("session_compact", () => {
    bodySent = false;
    return undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    if (!skill) return undefined;
    if (typeof event.input.path !== "string" || !event.input.path.endsWith("_test.go")) return undefined;

    if (cached?.filePath !== skill.filePath) {
      const body = skillBody(skill.filePath);
      cached = { filePath: skill.filePath, body, marker: bodyMarker(body) };
    }
    if (isInContext(ctx.sessionManager.buildContextEntries(), cached.marker)) return undefined;

    if (bodySent) {
      return {
        block: true,
        reason: `Blocked: apply the \`${SKILL_NAME}\` skill (already provided above) before writing Go tests, then retry the edit.`,
      };
    }

    bodySent = true;
    return {
      block: true,
      reason: [
        `Blocked: you must load the \`${SKILL_NAME}\` skill before writing Go tests. Its content follows — apply it, then retry the edit.`,
        "",
        `<skill name="${skill.name}" location="${skill.filePath}">`,
        `References are relative to ${skill.baseDir}.`,
        "",
        cached.body,
        "</skill>",
      ].join("\n"),
    };
  });
}
