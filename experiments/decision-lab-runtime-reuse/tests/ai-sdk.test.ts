import { describe, expect, it } from "vitest";
import { ScriptedGateway } from "../src/canonical.js";
import { TfAiSdkBridge } from "../src/ai-sdk-adapter.js";
import { initialSnapshot, scriptedUpdates } from "../src/fixtures.js";

describe("AI SDK custom transport probe", () => {
  it("supports request-scoped send and streaming through the real Chat API", async () => {
    const gateway = new ScriptedGateway("session-a", initialSnapshot);
    const bridge = new TfAiSdkBridge(gateway, initialSnapshot.conversationId);
    await bridge.start();
    await bridge.sendText("hello");

    expect(gateway.sent).toEqual([{ conversationId: "conversation-1", text: "hello" }]);
    expect(bridge.chat.messages.at(-1)?.parts).toContainEqual({
      type: "text",
      text: "accepted",
      state: "done",
    });
  });

  it("needs a separate canonical snapshot for independent socket updates", async () => {
    const gateway = new ScriptedGateway("session-a", initialSnapshot);
    const bridge = new TfAiSdkBridge(gateway, initialSnapshot.conversationId);
    await bridge.start();
    await bridge.sendText("hello");
    gateway.emit(scriptedUpdates[1]!);

    const unknown = bridge.chat.messages.find((message) => message.id === "event-unknown");
    expect(unknown?.parts[0]).toMatchObject({
      type: "data-tfEvent",
      data: { kind: "unknown", eventType: "FutureServerEvent" },
    });
    expect(bridge.chat.messages.some((message) => message.id === "request-scoped-response")).toBe(false);
  });

  it("leaves gateway disposal to the TFRobot bridge", async () => {
    const gateway = new ScriptedGateway("session-a", initialSnapshot);
    const bridge = new TfAiSdkBridge(gateway, initialSnapshot.conversationId);
    await bridge.start();
    bridge.dispose();
    expect(gateway.disposed).toBe(true);
  });
});
