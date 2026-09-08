import type { MessageResource } from "./models.js";
import type { MaybePromise, UploadCancellationSignal } from "./gateway.js";

export type ChatResourcePurpose = "display" | "open" | "download";
export interface ChatResourceRequest {
  readonly resource: MessageResource;
  readonly purpose: ChatResourcePurpose;
  readonly signal: UploadCancellationSignal;
  readonly conversationId?: string | undefined;
}
export interface ChatResolvedResource {
  readonly url: string;
  /** Release object URLs or other leases, including results arriving after cancellation. */
  readonly dispose?: (() => void) | undefined;
}
export interface ChatResourcePort {
  resolve?(request: ChatResourceRequest): MaybePromise<ChatResolvedResource>;
  open?(request: ChatResourceRequest): MaybePromise<void>;
  download?(request: ChatResourceRequest): MaybePromise<void>;
}
