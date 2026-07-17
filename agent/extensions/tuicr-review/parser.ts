import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

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

type MarkdownNode =
  | Root
  | Root["children"][number]
  | { type: string; value?: string; alt?: string; children?: MarkdownNode[] };

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

function inlineText(node: MarkdownNode): string {
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code" || node.type === "html") {
    return "value" in node ? (node.value ?? "") : "";
  }
  if (node.type === "break") return "\n";
  if (node.type === "image") return "alt" in node ? (node.alt ?? "") : "";
  return "children" in node && node.children ? node.children.map(inlineText).join("") : "";
}

function blockText(node: MarkdownNode): string {
  if (node.type === "paragraph" || node.type === "heading") return inlineText(node);
  if (node.type === "code" || node.type === "html") return "value" in node ? (node.value ?? "") : "";
  if (!("children" in node) || !node.children) return inlineText(node);

  if (node.type === "list") {
    const list = node as MarkdownNode & { ordered?: boolean; start?: number };
    return node.children
      .map((item, index) => {
        const marker = list.ordered ? `${(list.start ?? 1) + index}. ` : "- ";
        const text = blockText(item);
        return marker + text.replaceAll("\n", `\n${" ".repeat(marker.length)}`);
      })
      .join("\n");
  }

  if (node.type === "blockquote") {
    return node.children
      .map(blockText)
      .join("\n\n")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }

  const separator = node.type === "listItem" || node.type === "root" ? "\n\n" : "";
  return node.children.map(blockText).filter(Boolean).join(separator);
}

function parseComment(item: MarkdownNode, ordinal: number, index: number): TuicrComment | undefined {
  if (!("children" in item) || !item.children) return undefined;
  const firstParagraphIndex = item.children.findIndex((child) => child.type === "paragraph");
  if (firstParagraphIndex < 0) return undefined;

  const paragraph = item.children[firstParagraphIndex];
  if (!("children" in paragraph) || !paragraph.children) return undefined;
  const locationIndex = paragraph.children.findIndex((child) => child.type === "inlineCode");
  if (locationIndex < 0) return undefined;

  const locationNode = paragraph.children[locationIndex];
  const location = inlineText(locationNode).trim();
  if (!location) return undefined;

  const prefixNodes = paragraph.children.slice(0, locationIndex);
  const typeNode = prefixNodes.find((node) => node.type === "strong");
  const typeMatch = typeNode
    ? inlineText(typeNode)
        .trim()
        .match(/^\[([^\]]+)]$/)
    : undefined;
  const type = typeMatch?.[1].trim() || undefined;
  const suffix = paragraph.children
    .slice(locationIndex + 1)
    .map(inlineText)
    .join("")
    .trim();
  const separator = suffix.match(/^([\s\S]*?)\s+-\s+([\s\S]*)$/);
  const context = separator?.[1].trim() || undefined;
  const firstBody = separator?.[2] ?? suffix.replace(/^-\s*/, "");
  const remainingBlocks = item.children
    .slice(firstParagraphIndex + 1)
    .map(blockText)
    .filter((text) => text.length > 0);
  const body = [firstBody, ...remainingBlocks].join("\n\n").trimEnd();

  return {
    id: `comment-${index + 1}`,
    ordinal,
    type,
    location,
    ...parseLocation(location),
    context,
    body,
  };
}

/** Parse tuicr's markdown exporter output into comments using a Markdown AST. */
export function parseTuicrReview(markdown: string): TuicrReview {
  const tree = unified().use(remarkParse).parse(markdown) as Root;
  const comments: TuicrComment[] = [];
  let session: string | undefined;
  let summary: string | undefined;

  const visit = (node: MarkdownNode) => {
    if (node.type === "heading") {
      const heading = inlineText(node).trim();
      const match = heading.match(/^Session:\s*(.+)$/i);
      if (match) session = match[1].trim();
    } else if (node.type === "paragraph") {
      const paragraph = inlineText(node).trim();
      const match = paragraph.match(/^Summary:\s*([\s\S]+)$/i);
      if (match && summary === undefined) summary = match[1].trim();
    }

    if (node.type === "list" && "ordered" in node && node.ordered && "children" in node && node.children) {
      const start = "start" in node && typeof node.start === "number" ? node.start : 1;
      for (const [itemIndex, item] of node.children.entries()) {
        const comment = parseComment(item, start + itemIndex, comments.length);
        if (comment) comments.push(comment);
      }
      return;
    }

    if ("children" in node && node.children) {
      for (const child of node.children) visit(child);
    }
  };

  visit(tree);
  return { session, summary, comments };
}
