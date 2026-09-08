import { z } from "zod/v4";
import { createRuntimeSchema } from "./internal-runtime-schema.js";
import type { MessageResource } from "./models.js";
import { sanitizeDiagnosticText } from "./raw.js";

/** Stable readonly display data independent of the schema implementation. */
export type ToolPresentation =
  | {
      readonly kind: "browser";
      readonly url?: string | undefined;
      readonly image?: MessageResource | undefined;
      readonly markdown?: string | undefined;
    }
  | {
      readonly kind: "preview";
      readonly code: string;
      readonly language?: string | undefined;
    }
  | {
      readonly kind: "editor";
      readonly original: string;
      readonly modified: string;
      readonly language?: string | undefined;
    }
  | {
      readonly kind: "shell";
      readonly output: string;
      readonly command?: string | undefined;
      readonly username?: string | undefined;
      readonly hostname?: string | undefined;
      readonly path?: string | undefined;
    }
  | { readonly kind: "download"; readonly resource: MessageResource };
export interface ToolAttachment {
  readonly kind: "image" | "audio" | "video" | "file" | "unknown";
  readonly resource: MessageResource;
}

const text = z.string().max(262_144).transform(sanitizeDiagnosticText);
const resource = z.object({
  uri: text,
  name: text.optional(),
  mimeType: text.optional(),
  size: z.number().finite().nonnegative().optional(),
});

/** Stable display data; resource access remains owned by the integrating app. */
export const toolPresentationParser: z.ZodType<ToolPresentation> =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("browser"),
      url: text.optional(),
      image: resource.optional(),
      markdown: text.optional(),
    }),
    z.object({
      kind: z.literal("preview"),
      code: text,
      language: text.optional(),
    }),
    z.object({
      kind: z.literal("editor"),
      original: text,
      modified: text,
      language: text.optional(),
    }),
    z.object({
      kind: z.literal("shell"),
      output: text,
      command: text.optional(),
      username: text.optional(),
      hostname: text.optional(),
      path: text.optional(),
    }),
    z.object({ kind: z.literal("download"), resource }),
  ]);

export const toolPresentationSchema = createRuntimeSchema(
  toolPresentationParser,
);

export const toolAttachmentParser: z.ZodType<ToolAttachment> = z.object({
  kind: z.enum(["image", "audio", "video", "file", "unknown"]),
  resource,
});
export const toolAttachmentSchema = createRuntimeSchema(toolAttachmentParser);
