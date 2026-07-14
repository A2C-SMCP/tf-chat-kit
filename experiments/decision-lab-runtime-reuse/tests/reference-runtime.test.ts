import { describe, expect, it, vi } from "vitest";
import { ReferenceChatClient, ScriptedGateway } from "../src/canonical.js";
import { initialSnapshot, scriptedUpdates } from "../src/fixtures.js";

describe("custom reference runtime", () => {
  it("merges history and independent live updates by stable identity", async () => {
    const gateway = new ScriptedGateway("session-a", initialSnapshot);
    const client = new ReferenceChatClient(gateway, initialSnapshot.conversationId);
    await client.start();

    gateway.emit(scriptedUpdates[2]!);
    gateway.emit(scriptedUpdates[1]!);
    gateway.emit(scriptedUpdates[0]!);
    gateway.emit(scriptedUpdates[0]!);
    gateway.emit(scriptedUpdates[3]!);

    const snapshot = client.getSnapshot();
    expect(snapshot.items).toHaveLength(4);
    expect(snapshot.items.find((item) => item.id === "event-1")).toMatchObject({
      kind: "event",
      status: "completed",
    });
    expect(snapshot.items.find((item) => item.id === "event-unknown")).toMatchObject({
      kind: "unknown",
      eventType: "FutureServerEvent",
    });
    expect(snapshot.items.map((item) => item.id)).toEqual([
      "message-1",
      "event-1",
      "event-unknown",
      "message-2",
    ]);
    expect(snapshot.run.status).toBe("completed");
  });

  it("keeps instances, authentication and commands isolated", async () => {
    const gatewayA = new ScriptedGateway("session-a", initialSnapshot);
    const gatewayB = new ScriptedGateway("session-b", initialSnapshot);
    const clientA = new ReferenceChatClient(gatewayA, initialSnapshot.conversationId);
    const clientB = new ReferenceChatClient(gatewayB, initialSnapshot.conversationId);
    await Promise.all([clientA.start(), clientB.start()]);

    gatewayA.emit(scriptedUpdates[1]!);
    await clientA.sendText("from-a");
    await clientB.sendText("from-b");
    await clientA.interrupt();

    expect(clientA.getSnapshot().items).toHaveLength(3);
    expect(clientB.getSnapshot().items).toHaveLength(2);
    expect(gatewayA.sent).toEqual([{ conversationId: "conversation-1", text: "from-a" }]);
    expect(gatewayB.sent).toEqual([{ conversationId: "conversation-1", text: "from-b" }]);
    expect(gatewayA.interrupts).toEqual([{ conversationId: "conversation-1", runId: "run-1" }]);
    expect(gatewayB.interrupts).toEqual([]);
  });

  it("rejects stale interrupts after the run completes", async () => {
    const gateway = new ScriptedGateway("session-a", initialSnapshot);
    const client = new ReferenceChatClient(gateway, initialSnapshot.conversationId);
    await client.start();
    gateway.emit(scriptedUpdates[3]!);

    await expect(client.interrupt()).rejects.toThrow("not interruptible");
    expect(gateway.interrupts).toEqual([]);
  });

  it("stops notifications and releases the gateway on dispose", async () => {
    const gateway = new ScriptedGateway("session-a", initialSnapshot);
    const client = new ReferenceChatClient(gateway, initialSnapshot.conversationId);
    const listener = vi.fn();
    await client.start();
    client.subscribe(listener);
    client.dispose();
    gateway.emit(scriptedUpdates[1]!);

    expect(listener).not.toHaveBeenCalled();
    expect(gateway.disposed).toBe(true);
  });
});
