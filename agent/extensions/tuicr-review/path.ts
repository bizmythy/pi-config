import { resolveExtensionPath } from "../shared/paths.js";

export function resolveReviewPath(argument: string, cwd: string): string {
  let value = argument.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return resolveExtensionPath(value, cwd);
}
