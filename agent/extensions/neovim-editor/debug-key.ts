interface DebugHandlerOwner {
  onDebug?: () => void;
}

/** Lets the configured editor action receive Pi TUI's otherwise-global debug chord. */
export function releaseGlobalDebugHandler(owner: DebugHandlerOwner): () => void {
  const previous = owner.onDebug;
  owner.onDebug = undefined;
  return () => {
    if (owner.onDebug === undefined) owner.onDebug = previous;
  };
}
