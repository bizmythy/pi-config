import assert from "node:assert/strict";
import test from "node:test";
import { parseAddressReviewArgs } from "../../extensions/address-review-comments/args.js";
import { filterGeneratedDiff } from "../../extensions/address-review-comments/artifacts.js";
import {
  fetchGitHubReviewData,
  GitHubClient,
  ReviewThreadResolveError,
} from "../../extensions/address-review-comments/github.js";
import type { CommandExecutor, ExecResult } from "../../extensions/address-review-comments/types.js";

function success(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: "" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const emptyThreadsResponse = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  },
});

test("starts diff and review-thread requests concurrently", async () => {
  const diff = deferred<ExecResult>();
  const threads = deferred<ExecResult>();
  const started: string[] = [];
  const exec: CommandExecutor = async (_command, args) => {
    if (args[0] === "pr" && args[1] === "diff") {
      started.push("diff");
      return diff.promise;
    }
    if (args[0] === "api" && args[1] === "graphql") {
      started.push("threads");
      return threads.promise;
    }
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  };

  const request = fetchGitHubReviewData(new GitHubClient(exec, "/repo"), "owner/repo", 42);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["diff", "threads"]);

  diff.resolve(success("diff --git a/file.ts b/file.ts\n"));
  threads.resolve(success(emptyThreadsResponse));
  assert.deepEqual(await request, { diff: "diff --git a/file.ts b/file.ts\n", threads: [] });
});

test("maps review-thread pagination and fetches extra comment pages", async () => {
  const calls: string[][] = [];
  const exec: CommandExecutor = async (_command, args) => {
    calls.push(args);
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("query($owner:")) {
      return success(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      isOutdated: true,
                      path: "src/file.ts",
                      line: 12,
                      startLine: 10,
                      comments: {
                        nodes: [
                          {
                            body: "First",
                            diffHunk: "@@ -1 +1 @@",
                            author: { __typename: "User", login: "reviewer" },
                          },
                        ],
                        pageInfo: { hasNextPage: true, endCursor: "comments-next" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      );
    }
    if (query.includes("query($id:")) {
      return success(
        JSON.stringify({
          data: {
            node: {
              __typename: "PullRequestReviewThread",
              comments: {
                nodes: [
                  {
                    body: "Bot follow-up",
                    diffHunk: "",
                    author: { __typename: "Bot", login: "custom-review-bot" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      );
    }
    throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
  };

  const result = await new GitHubClient(exec, "/repo").fetchReviewThreads("owner/repo", 42);
  assert.deepEqual(result, [
    {
      id: "thread-1",
      is_resolved: false,
      is_outdated: true,
      path: "src/file.ts",
      diff_hunk: "@@ -1 +1 @@",
      current_start_line: 10,
      current_end_line: 12,
      comments: [
        { body: "First", author: "reviewer", author_is_bot: false },
        { body: "Bot follow-up", author: "custom-review-bot", author_is_bot: true },
      ],
    },
  ]);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.includes("-F"));
  assert.ok(calls[0]?.includes("number=42"));
  assert.ok(calls[1]?.includes("after=comments-next"));
});

test("posts a reply before resolving and returns the structured mutation payload", async () => {
  const operations: string[] = [];
  const exec: CommandExecutor = async (_command, args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("addPullRequestReviewThreadReply")) {
      operations.push("reply");
      return success(
        JSON.stringify({
          data: {
            addPullRequestReviewThreadReply: {
              comment: {
                id: "comment-1",
                databaseId: 123,
                url: "https://github.test/comment/123",
                body: "Fixed.",
                createdAt: "2026-01-01T00:00:00Z",
                author: { login: "author" },
              },
            },
          },
        }),
      );
    }
    if (query.includes("resolveReviewThread")) {
      operations.push("resolve");
      return success(
        JSON.stringify({
          data: { resolveReviewThread: { thread: { id: "thread-1", isResolved: true } } },
        }),
      );
    }
    throw new Error(`Unexpected mutation: ${query.slice(0, 80)}`);
  };

  const response = await new GitHubClient(exec, "/repo").submitReply("thread-1", "Fixed.", true);
  assert.deepEqual(operations, ["reply", "resolve"]);
  assert.equal(response.reply.url, "https://github.test/comment/123");
  assert.deepEqual(response.resolved_thread, { id: "thread-1", is_resolved: true });
});

test("preserves the posted reply when the follow-up resolve mutation fails", async () => {
  const exec: CommandExecutor = async (_command, args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("addPullRequestReviewThreadReply")) {
      return success(
        JSON.stringify({
          data: {
            addPullRequestReviewThreadReply: {
              comment: {
                id: "comment-1",
                databaseId: 123,
                url: "https://github.test/comment/123",
                body: "Fixed.",
                createdAt: "2026-01-01T00:00:00Z",
                author: { login: "author" },
              },
            },
          },
        }),
      );
    }
    return { code: 1, stdout: "", stderr: "resolution denied" };
  };

  await assert.rejects(new GitHubClient(exec, "/repo").submitReply("thread-1", "Fixed.", true), (error: unknown) => {
    assert.ok(error instanceof ReviewThreadResolveError);
    assert.equal(error.reply.url, "https://github.test/comment/123");
    assert.match(error.message, /resolution denied/);
    return true;
  });
});

test("filters generated files from the authored diff without dropping normal files", () => {
  const authored = "diff --git a/src/feature.ts b/src/feature.ts\n+authored\n";
  const generated = "diff --git a/web/src/api/gen/client_pb.ts b/web/src/api/gen/client_pb.ts\n+generated\n";
  assert.equal(filterGeneratedDiff(authored + generated), authored);
});

test("validates review command arguments", () => {
  assert.deepEqual(parseAddressReviewArgs(""), { ok: true, prNumber: undefined });
  assert.deepEqual(parseAddressReviewArgs("4098"), { ok: true, prNumber: 4098 });
  assert.deepEqual(parseAddressReviewArgs("--auto 4098"), {
    ok: false,
    message: "Automatic mode is not supported. Use /address-review-comments [PR_NUMBER].",
  });
  assert.deepEqual(parseAddressReviewArgs("abc"), { ok: false, message: "PR number must be a positive integer." });
});
