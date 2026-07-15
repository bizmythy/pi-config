export interface TuicrComment {
  id: string;
  ordinal: number;
  type?: string;
  location: string;
  path: string;
  startLine?: number;
  endLine?: number;
  side?: "old" | "new";
  context?: string;
  body: string;
}

export interface TuicrReview {
  session?: string;
  summary?: string;
  comments: TuicrComment[];
}

interface PendingComment {
  ordinal: number;
  firstLine: string;
  continuationIndent: number;
  continuation: string[];
}

function parseLocation(location: string): Pick<TuicrComment, "path" | "startLine" | "endLine" | "side"> {
  const range = location.match(/^(.*):(~?\d+)(?:-(~?\d+))?$/);
  if (!range) return { path: location };

  const startText = range[2];
  const endText = range[3];
  const oldSide = startText.startsWith("~") || endText?.startsWith("~");
  const startLine = Number.parseInt(startText.replace("~", ""), 10);
  const endLine = endText ? Number.parseInt(endText.replace("~", ""), 10) : startLine;

  return {
    path: range[1],
    startLine,
    endLine,
    side: oldSide ? "old" : "new",
  };
}

function finishComment(pending: PendingComment, index: number): TuicrComment | undefined {
  const header = pending.firstLine.match(/^(?:\*\*\[([^\]]+)]\*\*\s*)?`([^`]+)`(.*)$/);
  if (!header) return undefined;

  const type = header[1]?.trim() || undefined;
  const location = header[2].trim();
  const suffix = header[3].trim();
  const separator = suffix.match(/^(.*?)\s+-\s+([\s\S]*)$/);
  const context = separator?.[1].trim() || undefined;
  const firstBodyLine = separator?.[2] ?? suffix.replace(/^-\s*/, "");
  const body = [firstBodyLine, ...pending.continuation].join("\n").trimEnd();

  return {
    id: `comment-${index + 1}`,
    ordinal: pending.ordinal,
    type,
    location,
    ...parseLocation(location),
    context,
    body,
  };
}

/** Parse the numbered comments emitted by tuicr's markdown exporter. */
export function parseTuicrReview(markdown: string): TuicrReview {
  const comments: TuicrComment[] = [];
  let pending: PendingComment | undefined;

  const flush = () => {
    if (!pending) return;
    const parsed = finishComment(pending, comments.length);
    if (parsed) comments.push(parsed);
    pending = undefined;
  };

  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const item = line.match(/^(\d+)\.\s+(.*)$/);
    if (item) {
      flush();
      pending = {
        ordinal: Number.parseInt(item[1], 10),
        firstLine: item[2],
        continuationIndent: item[1].length + 2,
        continuation: [],
      };
      continue;
    }

    if (!pending) continue;
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    if (indentation >= pending.continuationIndent) {
      pending.continuation.push(line.slice(pending.continuationIndent));
    } else {
      flush();
    }
  }
  flush();

  const session = markdown.match(/^## Session:\s*(.+)$/m)?.[1].trim();
  const summary = markdown.match(/^Summary:\s*(.+)$/m)?.[1].trim();
  return { session, summary, comments };
}
