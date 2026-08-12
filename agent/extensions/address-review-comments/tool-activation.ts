export interface ToolActivationRuntime {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface LazyToolActivation {
  setEnabled(enabled: boolean): void;
  isRegistered(): boolean;
}

export function createLazyToolActivation(
  runtime: ToolActivationRuntime,
  toolName: string,
  register: () => void,
): LazyToolActivation {
  let registered = false;

  return {
    setEnabled(enabled) {
      if (enabled && !registered) {
        register();
        registered = true;
      }
      if (!registered) return;

      const active = runtime.getActiveTools();
      if (enabled && !active.includes(toolName)) runtime.setActiveTools([...active, toolName]);
      if (!enabled && active.includes(toolName)) {
        runtime.setActiveTools(active.filter((name) => name !== toolName));
      }
    },
    isRegistered: () => registered,
  };
}
