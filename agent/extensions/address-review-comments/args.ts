import { REVIEW_COMMAND_USAGE } from "./constants.js";

export function parseAddressReviewArgs(args: string): { ok: true; prNumber?: number } | { ok: false; message: string } {
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  if (parts.includes("--auto")) {
    return { ok: false, message: `Automatic mode is not supported. Use ${REVIEW_COMMAND_USAGE}.` };
  }
  if (parts.some((part) => part.startsWith("-"))) {
    return { ok: false, message: `Unsupported option. Use ${REVIEW_COMMAND_USAGE}.` };
  }
  if (parts.length > 1) {
    return { ok: false, message: `Too many arguments. Use ${REVIEW_COMMAND_USAGE}.` };
  }
  if (parts[0] && !/^\d+$/.test(parts[0])) {
    return { ok: false, message: "PR number must be a positive integer." };
  }
  return { ok: true, prNumber: parts[0] ? Number(parts[0]) : undefined };
}
