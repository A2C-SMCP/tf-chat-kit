import { describe, expect, it, vi } from "vitest";

import { createSocketIoFactoryWith } from "../packages/chat-gateway-tfrobot/src/socket.js";

describe("TFRobot production Socket factory", () => {
  it("uses websocket-only transport without polling fallback", () => {
    const io = vi.fn(() => ({ mocked: true }));
    const factory = createSocketIoFactoryWith(
      io as unknown as Parameters<typeof createSocketIoFactoryWith>[0],
    );
    factory({
      namespaceUrl: "https://robot.example/chat",
      path: "/socket.io",
      getAuth: vi.fn(async () => ({ token: "session-token" })),
    });

    expect(io).toHaveBeenCalledWith(
      "https://robot.example/chat",
      expect.objectContaining({
        autoConnect: false,
        path: "/socket.io",
        reconnection: true,
        transports: ["websocket"],
      }),
    );
  });
});
