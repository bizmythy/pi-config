import { describe, expect, test } from "bun:test";
import { _test } from "../../extensions/auth-profiles";

describe("auth profile refresh", () => {
  test("runs provider-scoped offline refresh without returning work to startup", async () => {
    let resolveOptions: (options: unknown) => void = () => {};
    const options = new Promise<unknown>((resolve) => {
      resolveOptions = resolve;
    });
    const registry = {
      refresh(received: unknown) {
        resolveOptions(received);
        return Promise.resolve({ aborted: false, errors: new Map() });
      },
    };

    expect(_test.refreshRegistryInBackground(registry, ["openai-codex"], async () => {})).toBeUndefined();
    expect(await options).toMatchObject({
      allowNetwork: false,
      providers: ["openai-codex"],
      signal: expect.any(AbortSignal),
    });
  });

  test("aborts a background refresh that exceeds its deadline", async () => {
    let resolveAborted: (aborted: boolean) => void = () => {};
    const aborted = new Promise<boolean>((resolve) => {
      resolveAborted = resolve;
    });
    const registry = {
      refresh(options: { signal: AbortSignal }) {
        return new Promise<{ aborted: boolean; errors: Map<string, Error> }>((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => {
              resolveAborted(options.signal.aborted);
              resolve({ aborted: true, errors: new Map() });
            },
            { once: true },
          );
        });
      },
    };

    expect(_test.refreshRegistryInBackground(registry, [], async () => {}, 1)).toBeUndefined();
    expect(await aborted).toBeTrue();
  });
});
