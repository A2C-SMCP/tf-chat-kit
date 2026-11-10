import { describe, expect, it } from "vitest";

import {
  managerChatIdentityMatches,
  managerChatIdentityScope,
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

  it("requires every asserted field to match by default", () => {
    expect(managerChatIdentityMatches(actual, actual)).toBe(true);
    expect(managerChatIdentityMatches({ robotId: "robot-a" }, actual)).toBe(
      false,
    );
    expect(
      managerChatIdentityMatches(
        { environment: "production", platformId: 17, robotId: "robot-a" },
        actual,
      ),
    ).toBe(false);
  });

  it("treats omitted expected fields as wildcards only when opted in", () => {
    expect(
      managerChatIdentityMatches({ robotId: "robot-a" }, actual, {
        allowWildcards: true,
      }),
    ).toBe(true);
    expect(
      managerChatIdentityMatches(
        { environment: "production", platformId: 17, robotId: "robot-a" },
        actual,
        { allowWildcards: true },
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
    expect(
      resolveManagerInteractionClient("client", undefined, actual),
    ).toBeNull();
    expect(
      resolveManagerInteractionClient("client", undefined, actual, {
        allowUnscoped: true,
      }),
    ).toBe("client");
    expect(resolveManagerInteractionClient("client", actual, actual)).toBe(
      "client",
    );
    expect(
      resolveManagerInteractionClient("client", { robotId: "robot-a" }, actual),
    ).toBeNull();
    expect(
      resolveManagerInteractionClient(
        "client",
        { robotId: "robot-a" },
        actual,
        { allowWildcards: true },
      ),
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

  it("builds a stable draft scope from the full identity", () => {
    expect(managerChatIdentityScope(actual)).toBe(
      JSON.stringify(["production", "user", "account", "org", 17, "robot-a"]),
    );
    expect(
      managerChatIdentityScope({ ...actual, robotId: "robot-b" }),
    ).not.toBe(managerChatIdentityScope(actual));
    expect(
      managerChatIdentityScope({ environment: "a|b", robotId: "c" }),
    ).not.toBe(managerChatIdentityScope({ environment: "a", robotId: "b|c" }));
  });

  it("limits inline visibility to the chat screen without a stale identity", () => {
    expect(managerChatInlineVisible("chat", false)).toBe(true);
    expect(managerChatInlineVisible("settings", false)).toBe(false);
    expect(managerChatInlineVisible("robot", false)).toBe(false);
    expect(managerChatInlineVisible("chat", true)).toBe(false);
  });
});
