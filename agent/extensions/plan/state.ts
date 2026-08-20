export interface PlanState {
  path?: string;
  dir?: string;
  description?: string;
  createdAt?: string;
}

export interface PersistedPlanExtensionState {
  activePlan?: PlanState;
  planningInProgress?: boolean;
}

export interface RestoredPlanExtensionState {
  activePlan: PlanState;
  planningInProgress: boolean;
}

export function restorePlanExtensionState(
  persisted: PersistedPlanExtensionState | undefined,
): RestoredPlanExtensionState {
  return {
    activePlan: persisted?.activePlan ?? {},
    // Older entries did not persist the lifecycle flag. Treat them as inactive
    // rather than accidentally reviving a plan that the user cancelled.
    planningInProgress: persisted?.planningInProgress === true,
  };
}
