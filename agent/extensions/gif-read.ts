import { open } from "node:fs/promises";
import { extname } from "node:path";
import { type ExtensionAPI, isReadToolResult } from "@earendil-works/pi-coding-agent";
import { generateContactSheet } from "./gif-read-support/core.js";
import { resolveExtensionPath } from "./shared/paths.js";

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };

async function looksLikeGif(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(6);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead < header.length) return false;
    const signature = header.toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  } finally {
    await file.close();
  }
}

function formatTimestampList(timestamps: number[]): string {
  return timestamps.map((timestamp) => `${timestamp.toFixed(2)}s`).join(", ");
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (!isReadToolResult(event) || event.isError) return;

    const rawPath = event.input.path;
    if (typeof rawPath !== "string" || extname(rawPath).toLowerCase() !== ".gif") return;

    const absolutePath = resolveExtensionPath(rawPath, ctx.cwd);
    if (!(await looksLikeGif(absolutePath))) return;

    try {
      const contactSheet = await generateContactSheet(
        (command, args, options) => pi.exec(command, args, options),
        absolutePath,
        ctx.signal,
      );
      const durationNote =
        contactSheet.durationSeconds === undefined
          ? "duration unknown"
          : `${contactSheet.durationSeconds.toFixed(2)}s duration`;
      const imageNote =
        ctx.model && !ctx.model.input.includes("image")
          ? "\n[Current model does not support images. The contact sheet image will be omitted from this request.]"
          : "";
      const text =
        `Read animated GIF file [image/gif]\n` +
        `Generated contact sheet [image/png] with ${contactSheet.sampleCount} sampled frame(s) (${durationNote}).\n` +
        `Sample timestamps: ${formatTimestampList(contactSheet.sampledTimestamps)}${imageNote}`;

      return {
        content: [
          { type: "text", text } satisfies TextContent,
          { type: "image", data: contactSheet.data, mimeType: "image/png" } satisfies ImageContent,
        ],
        details: {
          ...(event.details ?? {}),
          gifRead: {
            contactSheet: true,
            sampleCount: contactSheet.sampleCount,
            durationSeconds: contactSheet.durationSeconds,
            sampledTimestamps: contactSheet.sampledTimestamps,
          },
        },
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const originalText = event.content.filter((part) => part.type === "text") as TextContent[];

      return {
        content: [
          ...originalText,
          {
            type: "text",
            text: `[gif-read] Could not generate a GIF contact sheet with ffmpeg/magick: ${message}`,
          } satisfies TextContent,
        ],
        details: { ...(event.details ?? {}), gifRead: { contactSheet: false, error: message } },
      };
    }
  });
}
