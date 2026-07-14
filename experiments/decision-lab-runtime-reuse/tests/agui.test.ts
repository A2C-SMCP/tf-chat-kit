import { EventSchemas, EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import { aguiUnsupportedPublicSemantics, snapshotToAgui, updateToAgui } from "../src/agui-adapter.js";
import { initialSnapshot, scriptedUpdates } from "../src/fixtures.js";

describe("AG-UI protocol mapping probe", () => {
  it("validates TFRobot snapshots, activities and run lifecycle with public schemas", () => {
    const events = snapshotToAgui(initialSnapshot);
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
    ]);
    for (const event of events) expect(EventSchemas.safeParse(event).success).toBe(true);
  });

  it("preserves unknown server events through RAW", () => {
    const event = updateToAgui(initialSnapshot.conversationId, scriptedUpdates[1]!);
    expect(event).toMatchObject({
      type: EventType.RAW,
      source: "tfrobot",
      event: { eventType: "FutureServerEvent" },
    });
    expect(EventSchemas.safeParse(event).success).toBe(true);
  });

  it("does not replace TFRobot command, session and paging ports", () => {
    expect(aguiUnsupportedPublicSemantics).toEqual([
      "task-aware stale interrupt command",
      "SessionProvider authentication port",
      "conversation history pagination port",
    ]);
  });
});
