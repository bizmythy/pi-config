import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexUsage, windowLabelFromSeconds } from "../extensions/usage/codex.js";
import { clampPercent, formatMoney, humanizeSeconds } from "../extensions/usage/format.js";
import { applyOpenRouterCredits, parseOpenRouterKeyUsage } from "../extensions/usage/openrouter.js";

const CODEX_PAYLOAD = {
  user_id: "user-x",
  plan_type: "team",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42.5,
      limit_window_seconds: 18000,
      reset_after_seconds: 3600,
      reset_at: 1788046788,
    },
    secondary_window: {
      used_percent: 80,
      limit_window_seconds: 604800,
      reset_after_seconds: 7200,
      reset_at: 1788633588,
    },
  },
  credits: { has_credits: true, unlimited: false, balance: null },
  spend_control: {
    reached: true,
    individual_limit: {
      source: "workspace_spend_controls",
      limit: "0",
      used: "0.0",
      remaining: "0.0",
      used_percent: 100,
      reset_after_seconds: 192012,
    },
  },
  rate_limit_reached_type: null,
};

test("Codex usage payload parses rate limit windows and spend control", () => {
  const data = parseCodexUsage(CODEX_PAYLOAD);
  assert.ok(data);
  assert.equal(data.plan, "team");
  assert.deepEqual(
    data.windows.map((w) => [w.label, w.usedPercent, w.resetAfterSeconds]),
    [
      ["5h", 42.5, 3600],
      ["7d", 80, 7200],
    ],
  );
  assert.equal(data.rateLimitReached, false);
  assert.ok(data.spendControl);
  assert.equal(data.spendControl.source, "workspace_spend_controls");
  assert.equal(data.spendControl.limit, 0);
  assert.equal(data.spendControl.usedPercent, 100);
  assert.equal(data.creditsSummary, "credits available");
});

test("Codex usage parser handles missing or malformed payloads", () => {
  assert.equal(parseCodexUsage(null), null);
  assert.equal(parseCodexUsage("nope"), null);
  assert.equal(parseCodexUsage({}), null);
  assert.equal(parseCodexUsage({ rate_limit: {}, credits: {} }), null);
  assert.equal(parseCodexUsage({ plan_type: "team" }), null);
});

test("OpenRouter key usage parses the auth/key payload", () => {
  const data = parseOpenRouterKeyUsage({
    data: {
      label: "sk-or-v1-88a...b0d",
      limit: 50,
      limit_reset: "monthly",
      limit_remaining: 49.999336775,
      usage: 0.000663225,
      usage_monthly: 0.000663225,
    },
  });
  assert.ok(data);
  assert.equal(data.limit, 50);
  assert.equal(data.limitReset, "monthly");
  assert.equal(data.usage, 0.000663225);
  assert.equal(data.totalCredits, null);
});

test("OpenRouter credits payload merges into the key usage", () => {
  const base = parseOpenRouterKeyUsage({ data: { usage: 1.25, limit: 50 } });
  assert.ok(base);
  const merged = applyOpenRouterCredits(base, { data: { total_credits: 50, total_usage: 1.25 } });
  assert.equal(merged.totalCredits, 50);
  assert.equal(merged.totalUsage, 1.25);
  assert.equal(applyOpenRouterCredits(base, null).totalCredits, null);
});

test("Formatting helpers produce human-readable output", () => {
  assert.equal(windowLabelFromSeconds(18000), "5h");
  assert.equal(windowLabelFromSeconds(604800), "7d");
  assert.equal(windowLabelFromSeconds(2700), "45m");
  assert.equal(humanizeSeconds(45), "45s");
  assert.equal(humanizeSeconds(3600), "1h");
  assert.equal(humanizeSeconds(3900), "1h 5m");
  assert.equal(humanizeSeconds(192012), "2d 5h");
  assert.equal(humanizeSeconds(0), "now");
  assert.equal(formatMoney(50), "$50.00");
  assert.equal(formatMoney(0.000663225), "$0.0007");
  assert.equal(formatMoney(null), "?");
  assert.equal(clampPercent(120), 100);
  assert.equal(clampPercent("42.5"), 42.5);
  assert.equal(clampPercent("nan"), 0);
});
