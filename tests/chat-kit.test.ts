import { describe, expect, it } from "vitest";

import {
  createConversationWorkspaceController,
  createTFRobotChatClient,
  type SessionProvider,
  type TFRobotSession,
} from "../packages/chat-kit/src/headless.js";
import {
  createTFRobotChatClientFactory,
  useConversationWorkspace,
} from "../packages/chat-kit/src/react.js";
import { ChatWorkspace } from "../packages/chat-kit/src/antd.js";

const createOptions = () => {
  let identityReads = 0;
  let sessionReads = 0;
  const sessionProvider: SessionProvider<TFRobotSession> = {
    getSession() {
      sessionReads += 1;
      return { kind: "bearer", token: "facade-test-token" };
    },
    onSessionInvalid: () => undefined,
  };
  return {
    options: {
      baseUrl: "https://facade.example.test/api/",
      messageCreatorProvider: () => {
        identityReads += 1;
        return { uid: "facade-user", name: "Facade User" };
      },
      sessionProvider,
      socketFactory: () => {
        throw new Error("the facade must not create a Socket eagerly");
      },
    },
    identityReads: () => identityReads,
    sessionReads: () => sessionReads,
  };
};

describe("@turingfocus/chat-kit facade", () => {
  it("exports the managed workspace API from the matching layered entries", () => {
    expect(createConversationWorkspaceController).toBeTypeOf("function");
    expect(useConversationWorkspace).toBeTypeOf("function");
    expect(ChatWorkspace).toBeTypeOf("function");
  });

  it("creates an instance-owned client without eagerly reading host identity or session material", async () => {
    const fixture = createOptions();
    const client = createTFRobotChatClient(fixture.options);

    expect(fixture.identityReads()).toBe(0);
    expect(fixture.sessionReads()).toBe(0);
    expect(client.disposed).toBe(false);

    await client.dispose({ deadlineAt: Date.now() + 1_000 });
    expect(client.disposed).toBe(true);
  });

  it("returns a fresh client and fresh cleanup options for every provider lifecycle", async () => {
    const fixture = createOptions();
    let deadlineAt = 10_000;
    const factory = createTFRobotChatClientFactory({
      ...fixture.options,
      getDisposeOptions: () => ({ deadlineAt: ++deadlineAt }),
    });

    const first = factory.create();
    const second = factory.create();
    const uploader = factory.createAttachmentUploader?.();
    expect(first).not.toBe(second);
    expect(factory.getDisposeOptions()).toEqual({ deadlineAt: 10_001 });
    expect(factory.getDisposeOptions()).toEqual({ deadlineAt: 10_002 });
    expect(fixture.identityReads()).toBe(0);
    expect(fixture.sessionReads()).toBe(0);
    expect(uploader).toBeDefined();

    await first.dispose({ deadlineAt: Date.now() + 1_000 });
    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(false);
    await second.dispose({ deadlineAt: Date.now() + 1_000 });
    await uploader?.dispose?.();
  });
});
