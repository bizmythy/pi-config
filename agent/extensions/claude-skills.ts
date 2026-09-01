/**
 * Load Claude Code skills from `.claude/skills` directories.
 *
 * Pi only discovers skills in `~/.pi/agent/skills` and `<project>/.pi/skills`
 * by default. Many repos ship Claude-specific skills under `.claude/skills`,
 * so this extension adds those via the resources_discover hook: every
 * `.claude/skills` dir from cwd up to the filesystem root.
 *
 * The user-level `~/.claude/skills` is deliberately excluded: those skills are
 * already loaded natively by Claude Code, and mirroring them here collides with
 * the equivalents in `~/.pi/agent/skills`.
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function findClaudeSkillDirs(cwd: string): string[] {
  const dirs = new Set<string>();
  const home = path.resolve(os.homedir());
  let dir = path.resolve(cwd);
  while (true) {
    if (dir !== home) {
      const candidate = path.join(dir, ".claude", "skills");
      if (existsSync(candidate)) dirs.add(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...dirs];
}

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", (event) => {
    const skillPaths = findClaudeSkillDirs(event.cwd);
    return skillPaths.length > 0 ? { skillPaths } : undefined;
  });
}
