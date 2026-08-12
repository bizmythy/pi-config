import path from "node:path";
import { resolveExtensionPath } from "../shared/paths.js";

export function isPlanTargetPath(filePath: string, cwd: string, dir: string): boolean {
  const resolvedPath = resolveExtensionPath(filePath, cwd);
  return (
    path.dirname(resolvedPath) === resolveExtensionPath(dir, cwd) && path.basename(resolvedPath).endsWith("-plan.md")
  );
}
