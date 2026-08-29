import { MODEL_BLACKLIST } from "./patterns.js";

type ModelLike = { provider: string; id: string; name?: string };
type PatchState = { patterns: readonly RegExp[] };
type ModelSource<T extends ModelLike> = { getAvailableSnapshot(): readonly T[]; [patchMarker]?: PatchState };

const patchMarker = Symbol.for("pi.model-blacklist.patch-installed");

export function isBlacklisted(model: ModelLike, patterns: readonly RegExp[] = MODEL_BLACKLIST): boolean {
  const candidates = [model.id, `${model.provider}/${model.id}`, model.name].filter((value): value is string =>
    Boolean(value),
  );
  return patterns.some((pattern) =>
    candidates.some((candidate) => {
      pattern.lastIndex = 0;
      return pattern.test(candidate);
    }),
  );
}

export function filterModels<T extends ModelLike>(
  models: readonly T[],
  patterns: readonly RegExp[] = MODEL_BLACKLIST,
): T[] {
  return models.filter((model) => !isBlacklisted(model, patterns));
}

export function installModelBlacklist<T extends ModelLike>(
  proto: ModelSource<T>,
  patterns: readonly RegExp[] = MODEL_BLACKLIST,
): void {
  const existingState = proto[patchMarker];
  if (existingState) {
    existingState.patterns = patterns;
    return;
  }

  const state: PatchState = { patterns };
  const originalGetAvailableSnapshot = proto.getAvailableSnapshot;
  proto.getAvailableSnapshot = function getFilteredAvailableSnapshot() {
    return filterModels(originalGetAvailableSnapshot.call(this), state.patterns);
  };
  proto[patchMarker] = state;
}

export const _test = { filterModels, installModelBlacklist, isBlacklisted };
