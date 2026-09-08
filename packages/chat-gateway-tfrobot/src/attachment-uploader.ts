import { z } from "zod/v4";

import type {
  GatewayRequestOptions,
  GatewayResult,
  UploadCancellationSignal,
  UploadedAttachment,
} from "@turingfocus/chat-protocol";

import { TFRobotHttpClient } from "./http.js";
import type { TFRobotGatewayOptions } from "./types.js";

const uploadResponseSchema = z.object({ uri: z.string().trim().min(1) });

export interface TFRobotAttachmentUploadInput extends GatewayRequestOptions {
  /** Opaque binary value validated by the concrete transport adapter. */
  readonly blob: unknown;
  readonly fileName: string;
  readonly mimeType?: string | undefined;
  readonly cancellation?: UploadCancellationSignal | undefined;
}

export interface TFRobotAttachmentUploader {
  upload(
    input: TFRobotAttachmentUploadInput,
  ): Promise<GatewayResult<UploadedAttachment>>;
  dispose(): void;
}

class DefaultTFRobotAttachmentUploader implements TFRobotAttachmentUploader {
  readonly #http: TFRobotHttpClient;

  constructor(options: TFRobotGatewayOptions) {
    this.#http = new TFRobotHttpClient(options);
  }

  async upload(
    input: TFRobotAttachmentUploadInput,
  ): Promise<GatewayResult<UploadedAttachment>> {
    if (typeof Blob === "undefined" || !(input.blob instanceof Blob)) {
      return {
        ok: false,
        error: {
          code: "validation",
          message: "Attachment content must be a browser Blob",
          retryable: false,
        },
      };
    }
    const controller = new AbortController();
    if (input.cancellation?.aborted === true) controller.abort();
    const unsubscribe = input.cancellation?.subscribe(() => {
      controller.abort();
    });
    const formData = new FormData();
    formData.append("file", input.blob, input.fileName);
    let result;
    try {
      result = await this.#http.request({
        method: "POST",
        path: "v1/dashboard/remote/source/cos/upload",
        operation: "send",
        options: input,
        formData,
        schema: uploadResponseSchema,
        signal: controller.signal,
      });
    } finally {
      unsubscribe?.();
    }
    return result.ok
      ? {
          ok: true,
          value: {
            uri: result.value.uri,
            mimeType:
              input.mimeType?.trim() ||
              input.blob.type ||
              "application/octet-stream",
            name: input.fileName,
            size: input.blob.size,
          },
        }
      : result;
  }

  dispose(): void {
    this.#http.dispose();
  }
}

/** Creates the zero-extra-config uploader used by the default Chat Kit facade. */
export const createTFRobotAttachmentUploader = (
  options: TFRobotGatewayOptions,
): TFRobotAttachmentUploader => new DefaultTFRobotAttachmentUploader(options);
