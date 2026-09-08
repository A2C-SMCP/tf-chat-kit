import type {
  GatewayRequestOptions,
  GatewayResult,
  UploadCancellationSignal,
  UploadedAttachment,
} from "@turingfocus/chat-runtime";

export interface ChatAttachmentUploadInput extends GatewayRequestOptions {
  /** Binary value supplied by the rendering host (normally a browser File). */
  readonly blob: unknown;
  readonly fileName: string;
  readonly mimeType?: string | undefined;
  readonly cancellation?: UploadCancellationSignal | undefined;
}

/** Narrow host-overridable port consumed by React composer UIs. */
export interface ChatAttachmentUploader {
  upload(
    input: ChatAttachmentUploadInput,
  ): Promise<GatewayResult<UploadedAttachment>>;
  dispose?(): void | PromiseLike<void>;
}
