import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FetchResponse } from "./types.js";

const GENERATED_FILE_PATTERNS = [
  /(?:^|\/)[^/]*\.connect\.go$/,
  /(?:^|\/)[^/]*\.grpc\.pb\.(?:cc|h)$/,
  /(?:^|\/)[^/]*\.pb\.(?:cc|go|h)$/,
  /(?:^|\/)[^/]*\.sql\.go$/,
  /(?:^|\/)[^/]*_(?:connect|pb)\.(?:d\.ts|js|ts)$/,
  /(?:^|\/)[^/]*_gen\.(?:json|md)$/,
  /(?:^|\/)[^/]*_grpc\.pb\.go$/,
  /(?:^|\/)[^/]*_pb2(?:_grpc)?\.(?:py|pyi)$/,
  /(?:^|\/)build\/cpp\/CMakeFiles\//,
  /(?:^|\/)gen\//,
  /(?:^|\/)oas_[^/]*_gen\.go$/,
  /(?:^|\/)table_definitions\.yaml$/,
  /(?:^|\/)web\/src\/(?:api\/gen|gen)\//,
];

export function isGeneratedPath(filePath: string): boolean {
  return GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function filterGeneratedDiff(diff: string): string {
  const sections = diff.split(/(?=^diff --git )/m);
  return sections
    .filter((section) => {
      const header = section.match(/^diff --git a\/.+? b\/(.+)$/m);
      return !header || !isGeneratedPath(header[1] ?? "");
    })
    .join("");
}

export async function writeReviewArtifacts(
  diff: string,
  responseWithoutPath: Omit<FetchResponse, "authored_diff_path">,
): Promise<{ directory: string; diffPath: string; responsePath: string; response: FetchResponse }> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-review-comments-"));
  const diffPath = path.join(directory, "authored.diff");
  const responsePath = path.join(directory, "fetch.json");
  const response: FetchResponse = { ...responseWithoutPath, authored_diff_path: diffPath };
  await Promise.all([
    writeFile(diffPath, filterGeneratedDiff(diff), "utf8"),
    writeFile(responsePath, `${JSON.stringify(response, null, 2)}\n`, "utf8"),
  ]);
  return { directory, diffPath, responsePath, response };
}
