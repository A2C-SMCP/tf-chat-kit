import type { AssistantRuntime } from "@assistant-ui/react";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { ReferenceChatClient, ScriptedGateway } from "../src/canonical.js";
import { AssistantUiProbe, assistantUiExternalResponsibilities } from "../src/assistant-ui-adapter.js";
import { initialSnapshot, scriptedUpdates } from "../src/fixtures.js";

describe("assistant-ui ExternalStoreRuntime probe", () => {
  it("can expose canonical messages and capability callbacks through its public runtime", async () => {
    const gateway = new ScriptedGateway("session-a", initialSnapshot);
    const client = new ReferenceChatClient(gateway, initialSnapshot.conversationId);
    await client.start();
    let runtime: AssistantRuntime | undefined;
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <AssistantUiProbe client={client} onRuntime={(value) => { runtime = value; }} />,
      );
    });

    expect(runtime).toBeDefined();
    expect(runtime!.thread.getState().messages).toHaveLength(2);
    expect(runtime!.thread.getState().isRunning).toBe(true);

    await act(async () => gateway.emit(scriptedUpdates[1]!));
    expect(runtime!.thread.getState().messages).toHaveLength(3);

    await act(async () => runtime!.thread.cancelRun());
    expect(gateway.interrupts).toEqual([{ conversationId: "conversation-1", runId: "run-1" }]);

    await act(async () => renderer!.unmount());
    client.dispose();
  });

  it("requires the application to keep the headless state and gateway lifecycle", () => {
    expect(assistantUiExternalResponsibilities).toContain("ChatClient-to-React subscription adapter");
    expect(assistantUiExternalResponsibilities).toContain("REST/socket history and live merge");
    expect(assistantUiExternalResponsibilities).toContain("gateway lifecycle and disposal");
  });
});
