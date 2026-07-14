import {
  EventSchemas,
  EventType,
  type AGUIEvent,
} from "@ag-ui/core";
import type { ChatSnapshot, ChatUpdate, TimelineItem } from "./canonical.js";

function itemToEvent(item: TimelineItem): AGUIEvent {
  if (item.kind === "message") {
    return EventSchemas.parse({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: item.id,
      activityType: "message",
      content: { role: item.role, text: item.text },
      timestamp: item.timestamp,
    });
  }

  if (item.kind === "unknown") {
    return EventSchemas.parse({
      type: EventType.RAW,
      source: "tfrobot",
      event: {
        id: item.id,
        eventType: item.eventType,
        summary: item.summary,
        raw: item.raw,
      },
      timestamp: item.timestamp,
    });
  }

  return EventSchemas.parse({
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: item.id,
    activityType: item.eventType,
    content: {
      status: item.status,
      summary: item.summary,
      raw: item.raw,
    },
    timestamp: item.timestamp,
  });
}

export function snapshotToAgui(snapshot: ChatSnapshot): AGUIEvent[] {
  return [
    EventSchemas.parse({
      type: EventType.RUN_STARTED,
      threadId: snapshot.conversationId,
      runId: snapshot.run.id,
    }),
    ...snapshot.items.map(itemToEvent),
  ];
}

export function updateToAgui(conversationId: string, update: ChatUpdate): AGUIEvent {
  if (update.type === "upsert") return itemToEvent(update.item);
  if (update.run.status === "error") {
    return EventSchemas.parse({
      type: EventType.RUN_ERROR,
      message: "TFRobot run failed",
      code: "TF_RUN_ERROR",
    });
  }
  if (update.run.status === "completed") {
    return EventSchemas.parse({
      type: EventType.RUN_FINISHED,
      threadId: conversationId,
      runId: update.run.id,
      outcome: { type: "success" },
    });
  }
  return EventSchemas.parse({
    type: EventType.RUN_STARTED,
    threadId: conversationId,
    runId: update.run.id,
  });
}

export const aguiUnsupportedPublicSemantics = [
  "task-aware stale interrupt command",
  "SessionProvider authentication port",
  "conversation history pagination port",
] as const;
