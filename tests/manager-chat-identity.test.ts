import { describe, expect, it } from "vitest";

import {
  managerChatIdentityMatches,
  managerChatInlineVisible,
  resolveManagerInteractionClient,
} from "../packages/chat-kit/src/manager-identity.js";

describe("managerChatIdentityMatches", () => {
  const actual = {
    accountId: "account",
    environment: "production",
    organizationId: "org",
    platformId: 17,
    robotId: "robot-a",
    userId: "user",
  };

  it("treats omitted expected fields as wildcards", () => {
    expect(managerChatIdentityMatches({ robotId: "robot-a" }, actual)).toBe(
      true,
    );
    expect(
      managerChatIdentityMatches(
        { environment: "production", platformId: 17, robotId: "robot-a" },
        actual,
      ),
    ).toBe(true);
  });

  it("rejects robot, platform, account, environment and user changes", () => {
    expect(managerChatIdentityMatches({ robotId: "robot-b" }, actual)).toBe(
      false,
    );
    expect(
      managerChatIdentityMatches(
        { platformId: 18, robotId: "robot-a" },
        actual,
      ),
    ).toBe(false);
    expect(
      managerChatIdentityMatches(
        { accountId: "other", robotId: "robot-a" },
        actual,
      ),
    ).toBe(false);
    expect(
      managerChatIdentityMatches(
        { environment: "staging", robotId: "robot-a" },
        actual,
      ),
    ).toBe(false);
    expect(
      managerChatIdentityMatches(
        { robotId: "robot-a", userId: "other" },
        actual,
      ),
    ).toBe(false);
  });

  it("resolves the interaction client against the current identity", () => {
    expect(resolveManagerInteractionClient("client", undefined, actual)).toBe(
      "client",
    );
    expect(
      resolveManagerInteractionClient("client", { robotId: "robot-a" }, actual),
    ).toBe("client");
    expect(
      resolveManagerInteractionClient("client", { robotId: "robot-b" }, actual),
    ).toBeNull();
    expect(
      resolveManagerInteractionClient(
        "client",
        { robotId: "robot-a" },
        undefined,
      ),
    ).toBeNull();
    expect(
      resolveManagerInteractionClient(
        undefined,
        { robotId: "robot-a" },
        actual,
      ),
    ).toBeUndefined();
  });

  it("limits inline visibility to the chat screen without a stale identity", () => {
    expect(managerChatInlineVisible("chat", false)).toBe(true);
    expect(managerChatInlineVisible("settings", false)).toBe(false);
    expect(managerChatInlineVisible("robot", false)).toBe(false);
    expect(managerChatInlineVisible("chat", true)).toBe(false);
  });
});
