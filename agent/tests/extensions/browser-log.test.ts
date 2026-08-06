import assert from "node:assert/strict";
import test from "node:test";
import { _test } from "../../extensions/browser-log.js";

const {
  normalizeBrowserLogOptions,
  parseBrowserLogArgs,
  isInspectablePage,
  scoreTarget,
  formatConsoleArgs,
  normalizeConsoleEvent,
  normalizeExceptionEvent,
  normalizeLogEntry,
  summarizeEntries,
} = _test;

test("browser-log options normalize command arguments and reject invalid durations", () => {
  assert.deepEqual(parseBrowserLogArgs("--port=9333 --cdp-url=http://localhost:9444/// --duration-ms=45000"), {
    cdpUrl: "http://localhost:9444",
    durationMs: 30_000,
  });
  assert.deepEqual(parseBrowserLogArgs("250 'https://example.test:9222/'"), {
    cdpUrl: "https://example.test:9222",
    durationMs: 250,
  });
  assert.deepEqual(normalizeBrowserLogOptions({ cdpUrl: "http://localhost:9222///", durationMs: -1 }), {
    cdpUrl: "http://localhost:9222",
    durationMs: 1_500,
  });
  assert.equal(
    normalizeBrowserLogOptions({ cdpUrl: "http://localhost:9222", durationMs: Number.NaN }).durationMs,
    1_500,
  );
});

test("target filtering and scoring prefer a focused visible web page", () => {
  const focusedPage = {
    id: "focused",
    type: "page",
    title: "Application",
    url: "https://example.test",
    webSocketDebuggerUrl: "ws://localhost/focused",
  };

  assert.equal(isInspectablePage(focusedPage), true);
  assert.equal(
    isInspectablePage({ ...focusedPage, id: "devtools", url: "devtools://devtools/bundled/inspector.html" }),
    false,
  );
  assert.equal(isInspectablePage({ ...focusedPage, id: "worker", type: "service_worker" }), false);
  assert.equal(isInspectablePage({ ...focusedPage, id: "detached", webSocketDebuggerUrl: undefined }), false);

  assert.deepEqual(scoreTarget(focusedPage, { hasFocus: true, visibilityState: "visible" }), {
    score: 161,
    reason: "document.hasFocus() is true; document.visibilityState is visible; HTTP(S) page; has title",
  });
  assert.equal(
    scoreTarget({ ...focusedPage, title: "", url: "about:blank" }, { hasFocus: false, visibilityState: "hidden" })
      .score,
    0,
  );
});

test("console formatting follows CDP format specifiers and preserves remaining values", () => {
  const message = formatConsoleArgs([
    { type: "string", value: "loaded %s in %dms %% %cstyled" },
    { type: "string", value: "app" },
    { type: "number", value: 12 },
    { type: "string", value: "color: green" },
    { type: "object", description: "Object {ready: true}" },
  ]);

  assert.equal(message, "loaded app in 12ms % styled Object {ready: true}");
  assert.equal(
    formatConsoleArgs([
      { type: "number", unserializableValue: "NaN" },
      { type: "object", value: { ok: true } },
    ]),
    'NaN {"ok":true}',
  );
});

test("normalized CDP events produce stable messages and aggregate summaries", () => {
  const entries = [
    normalizeConsoleEvent(0, {
      type: "warning",
      timestamp: 3_000,
      args: [
        { type: "string", value: "slow %dms" },
        { type: "number", value: 80 },
      ],
    }),
    normalizeExceptionEvent(1, {
      timestamp: 1_000,
      exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: failed" } },
    }),
    normalizeLogEntry(2, { entry: { level: "warning", text: "deprecated", timestamp: 2_000 } }),
  ];

  assert.equal(entries[0]?.message, "slow 80ms");
  assert.equal(entries[1]?.message, "TypeError: failed");
  assert.equal(entries[2]?.message, "deprecated");
  assert.deepEqual(summarizeEntries(entries), {
    totalEntries: 3,
    byKind: { console: 1, exception: 1, "browser-log": 1 },
    byLevel: { warning: 2, error: 1 },
    firstTimestampIso: "1970-01-01T00:00:01.000Z",
    lastTimestampIso: "1970-01-01T00:00:03.000Z",
  });
});
