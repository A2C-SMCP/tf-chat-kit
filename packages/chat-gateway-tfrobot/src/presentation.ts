import {
  toolAttachmentSchema,
  toolPresentationSchema,
  type ToolAttachment,
  type ToolPresentation,
} from "@turingfocus/chat-protocol";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const decode = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

function presentation(value: unknown): ToolPresentation | undefined {
  const data = record(decode(value));
  if (data === undefined) return undefined;
  const content = string(data["content"]);
  const url = string(data["url"]);
  const language = string(data["language"]);
  let candidate: unknown;
  if (
    typeof data["original"] === "string" &&
    typeof data["modified"] === "string"
  ) {
    candidate = {
      kind: "editor",
      original: data["original"],
      modified: data["modified"],
      language,
    };
  } else if (
    ["command", "username", "hostname"].some((key) => key in data) &&
    (content !== undefined ||
      ["command", "username", "hostname"].some(
        (key) => typeof data[key] === "string",
      ))
  ) {
    candidate = {
      kind: "shell",
      output: content ?? "",
      command: string(data["command"]),
      username: string(data["username"]),
      hostname: string(data["hostname"]),
      path: string(data["path"]),
    };
  } else if (content !== undefined && "language" in data) {
    candidate = { kind: "preview", code: content, language };
  } else if (
    url !== undefined ||
    typeof data["image"] === "string" ||
    content !== undefined
  ) {
    const downloadable =
      url !== undefined &&
      /\.(?:pdf|zip|xlsx?|docx?|csv|txt|mp[34]|wav|webm)(?:[?#]|$)/i.test(url);
    candidate = downloadable
      ? {
          kind: "download",
          resource: {
            uri: url,
            name: string(data["filename"]) ?? string(data["name"]),
          },
        }
      : {
          kind: "browser",
          url,
          markdown: content,
          image:
            typeof data["image"] === "string"
              ? { uri: data["image"] }
              : undefined,
        };
  }
  const result = toolPresentationSchema.safeParse(candidate);
  return result.success ? result.data : undefined;
}

/** Transformed display data never changes the existing origin/result field. */
export function mapToolPresentation(
  toolReturn: Record<string, unknown>,
): ToolPresentation | undefined {
  const mcp = record(record(toolReturn["meta"])?.["__MCP__"]);
  return (
    presentation(mcp?.["a2c_vrl_transformed"]) ??
    presentation(toolReturn["origin"])
  );
}

export function mapToolAttachments(value: unknown): readonly ToolAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item) => {
    const data = record(item);
    if (data === undefined) return [];
    const mimeType = string(data["mimeType"]);
    const category = string(data["category"]) ?? mimeType?.split("/")[0];
    const result = toolAttachmentSchema.safeParse({
      kind: ["image", "audio", "video", "file"].includes(category ?? "")
        ? category
        : "unknown",
      resource: {
        uri: data["attachment"],
        mimeType,
        name: string(data["name"]),
        size: data["size"],
      },
    });
    return result.success ? [result.data] : [];
  });
}
