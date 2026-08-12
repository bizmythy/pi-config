import { REVIEW_COMMAND_NAME } from "./constants.js";
import type { ReplyRequest } from "./types.js";

export function replyAttribution(githubUsername: string): string {
  return `> \`pi\` agent using \`${REVIEW_COMMAND_NAME}\`, supervised by @${githubUsername}`;
}

export function appendReplyAttribution(body: string, githubUsername: string): string {
  const trimmedBody = body.trimEnd();
  const attribution = replyAttribution(githubUsername);
  if (trimmedBody.endsWith(attribution)) return trimmedBody;
  return `${trimmedBody}\n\n${attribution}`;
}

export function createReplyRequest(
  threadId: string,
  draftReply: string,
  resolve: boolean,
  githubUsername: string,
): ReplyRequest {
  return {
    thread_id: threadId,
    comment: appendReplyAttribution(draftReply, githubUsername),
    resolve,
  };
}
