export function neovimGridHeight(displayHeight: number, terminalRows: number): number {
  const contentHeight = Number.isFinite(displayHeight) ? Math.max(1, Math.floor(displayHeight)) : 1;
  const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));
  return Math.min(contentHeight, maxVisibleLines);
}
