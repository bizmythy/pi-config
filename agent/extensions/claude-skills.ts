/**
 * Load Claude Code skills from `.claude/skills` directories.
 *
 * Pi only discovers skills in `~/.pi/agent/skills` and `<project>/.pi/skills`
 * by default. Many repos ship Claude-specific skills under `.claude/skills`,
 * so this extension adds those via the resources_discover hook: every
 * `.claude/skills` dir from cwd up to the filesystem root, plus the user-level
 * `~/.claude/skills`.
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function findClaudeSkillDirs(cwd: string): string[] {
  const dirs = new Set<string>();
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, ".claude", "skills");
    if (existsSync(candidate)) dirs.add(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const userSkills = path.join(os.homedir(), ".claude", "skills");
  if (existsSync(userSkills)) dirs.add(userSkills);
  return [...dirs];
}

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", (event) => {
    const skillPaths = findClaudeSkillDirs(event.cwd);
    return skillPaths.length > 0 ? { skillPaths } : undefined;
  });
}
