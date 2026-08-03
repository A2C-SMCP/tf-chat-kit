import { Empty } from "antd";
import { useMemo, type CSSProperties } from "react";

import type { TimelineItem } from "@turingfocus/chat-protocol";

import {
  ChatTimelineItem,
  createChatRendererRegistry,
  formatChatTimestampUtc,
  type ChatRendererFailure,
  type ChatRendererRegistry,
} from "./renderer-registry.js";
import type { ChatUiLabelOverrides } from "./types.js";
import { resolveChatUiLabels } from "./labels.js";

export type ChatEventDetailMode = "auto" | "modal" | "split";
export type ResolvedChatEventDetailMode = Exclude<ChatEventDetailMode, "auto">;
export type ChatEventItem = Exclude<TimelineItem, { readonly kind: "message" }>;

export const isChatEventItem = (
  item: TimelineItem | null | undefined,
): item is ChatEventItem =>
  item?.kind === "agent-event" || item?.kind === "unknown-event";

export interface ChatEventDetailProps {
  readonly className?: string | undefined;
  readonly formatTimestamp?: ((timestamp: number) => string) | undefined;
  readonly item: ChatEventItem;
  readonly onRendererError?:
    ((failure: ChatRendererFailure) => void) | undefined;
  readonly renderers?: ChatRendererRegistry | undefined;
  readonly style?: CSSProperties | undefined;
}

export const ChatEventDetail = ({
  className,
  formatTimestamp = formatChatTimestampUtc,
  item,
  onRendererError,
  renderers,
  style,
}: ChatEventDetailProps) => {
  const registry = useMemo(
    () => createChatRendererRegistry(renderers),
    [renderers],
  );
  return (
    <div className={className} style={style}>
      <ChatTimelineItem
        displayMode="detail"
        formatTimestamp={formatTimestamp}
        item={item}
        onRendererError={onRendererError}
        registry={registry}
        selected
      />
    </div>
  );
};

export const ChatEventDetailEmpty = ({
  labels: labelOverrides,
}: {
  readonly labels?: ChatUiLabelOverrides | undefined;
}) => {
  const labels = resolveChatUiLabels(labelOverrides);
  return <Empty description={labels.eventDetailEmpty} />;
};
