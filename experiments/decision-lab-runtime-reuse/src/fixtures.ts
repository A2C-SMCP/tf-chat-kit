import type { ChatSnapshot, ChatUpdate } from "./canonical.js";

export const initialSnapshot: ChatSnapshot = {
  conversationId: "conversation-1",
  items: [
    { kind: "message", id: "message-1", role: "user", text: "run a task", timestamp: 1 },
    {
      kind: "event",
      id: "event-1",
      eventType: "Shell",
      status: "running",
      summary: "running command",
      timestamp: 2,
      raw: { command: "safe-command", token: "[redacted]" },
    },
  ],
  run: { id: "run-1", status: "running", interruptible: true },
};

export const scriptedUpdates: readonly ChatUpdate[] = [
  {
    type: "upsert",
    item: {
      kind: "event",
      id: "event-1",
      eventType: "Shell",
      status: "completed",
      summary: "command completed",
      timestamp: 2,
      raw: { exitCode: 0, token: "[redacted]" },
    },
  },
  {
    type: "upsert",
    item: {
      kind: "unknown",
      id: "event-unknown",
      eventType: "FutureServerEvent",
      summary: "unknown event",
      timestamp: 3,
      raw: { newField: true, cookie: "[redacted]" },
    },
  },
  {
    type: "upsert",
    item: {
      kind: "message",
      id: "message-2",
      role: "assistant",
      text: "done",
      timestamp: 4,
    },
  },
  { type: "run", run: { id: "run-1", status: "completed", interruptible: false } },
];
