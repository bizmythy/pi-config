import type { TuicrComment } from "./parser.js";

const FEEDBACK_EMOJI: Record<string, string> = {
  suggestion: "💡",
  nitpick: "🔧",
  question: "❓",
  issue: "⚠️",
  praise: "🙌",
};

export function commentLabel(comment: TuicrComment): string {
  const emoji = comment.type ? (FEEDBACK_EMOJI[comment.type.toLowerCase()] ?? "💬") : "💬";
  const context = comment.context ? ` ${comment.context}` : "";
  const body = comment.body.replace(/\s+/g, " ").trim();
  return `${emoji} ${comment.location}${context} — ${body}`;
}
