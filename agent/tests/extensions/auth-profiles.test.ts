import { afterEach, describe, expect, test } from "bun:test";
import { _test } from "../../extensions/auth-profiles";

const ORIGINAL_AWS_PROFILE = process.env.AWS_PROFILE;
const ORIGINAL_AWS_DEFAULT_PROFILE = process.env.AWS_DEFAULT_PROFILE;
const ORIGINAL_AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;

afterEach(() => {
  if (ORIGINAL_AWS_PROFILE === undefined) delete process.env.AWS_PROFILE;
  else process.env.AWS_PROFILE = ORIGINAL_AWS_PROFILE;

  if (ORIGINAL_AWS_DEFAULT_PROFILE === undefined) delete process.env.AWS_DEFAULT_PROFILE;
  else process.env.AWS_DEFAULT_PROFILE = ORIGINAL_AWS_DEFAULT_PROFILE;

  if (ORIGINAL_AWS_ACCESS_KEY_ID === undefined) delete process.env.AWS_ACCESS_KEY_ID;
  else process.env.AWS_ACCESS_KEY_ID = ORIGINAL_AWS_ACCESS_KEY_ID;
});

describe("auth profile refresh", () => {
  test("temporarily hides Bedrock credentials and restores them", async () => {
    process.env.AWS_PROFILE = "buildos-test";
    process.env.AWS_DEFAULT_PROFILE = "buildos-default-test";
    process.env.AWS_ACCESS_KEY_ID = "test-access-key";

    await _test.withBedrockAuthHidden(async () => {
      expect(process.env.AWS_PROFILE).toBeUndefined();
      expect(process.env.AWS_DEFAULT_PROFILE).toBeUndefined();
      expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    });

    expect(process.env.AWS_PROFILE).toBe("buildos-test");
    expect(process.env.AWS_DEFAULT_PROFILE).toBe("buildos-default-test");
    expect(process.env.AWS_ACCESS_KEY_ID).toBe("test-access-key");
  });

  test("restores credentials when refresh fails", async () => {
    process.env.AWS_PROFILE = "buildos-test";
    process.env.AWS_DEFAULT_PROFILE = "buildos-default-test";

    await expect(
      _test.withBedrockAuthHidden(async () => {
        throw new Error("refresh failed");
      }),
    ).rejects.toThrow("refresh failed");

    expect(process.env.AWS_PROFILE).toBe("buildos-test");
    expect(process.env.AWS_DEFAULT_PROFILE).toBe("buildos-default-test");
  });
});
