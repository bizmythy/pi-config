export function modeLabel(mode: string): string {
  if (mode.startsWith("cmdline")) return "COMMAND";
  if (mode === "visual_select") return "SELECT";
  const family = mode.split("_")[0] ?? mode;
  return (family || "normal").toUpperCase();
}
