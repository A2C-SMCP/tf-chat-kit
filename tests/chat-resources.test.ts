import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import {
  ChatResourceProvider,
  useChatResource,
} from "../packages/chat-react/src/index.js";
import type { ChatResourceBinding } from "../packages/chat-react/src/index.js";
import type {
  ChatResolvedResource,
  ChatResourcePort,
} from "../packages/chat-protocol/src/index.js";

it("cancels authorization changes and releases both late and active private leases", async () => {
  const resource = { uri: "s3://private/report" };
  const pending: Array<(value: ChatResolvedResource) => void> = [];
  const aborted = vi.fn();
  const port: ChatResourcePort = {
    resolve: (request) => {
      request.signal.subscribe(aborted);
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  let binding: ChatResourceBinding | undefined;
  function Consumer() {
    binding = useChatResource(resource);
    return null;
  }
  const tree = (scope: string) =>
    createElement(
      ChatResourceProvider,
      { port, scope },
      createElement(Consumer),
    );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(tree("account-a"));
  });
  expect(binding?.status).toBe("loading");
  await act(async () => {
    renderer.update(tree("account-b"));
  });
  expect(aborted).toHaveBeenCalledTimes(1);
  const late = vi.fn();
  const active = vi.fn();
  await act(async () => {
    pending[0]?.({ url: "blob:https://example.com/old", dispose: late });
  });
  expect(late).toHaveBeenCalledOnce();
  expect(binding?.url).toBeUndefined();
  await act(async () => {
    pending[1]?.({ url: "https://example.com/current", dispose: active });
  });
  expect(binding?.url).toBe("https://example.com/current");
  act(() => renderer.unmount());
  expect(active).toHaveBeenCalledOnce();
});

it("recovers expired resources on explicit retry and rejects executable URLs", async () => {
  const resource = { uri: "private:avatar" };
  let attempt = 0;
  const port: ChatResourcePort = {
    resolve: () => {
      attempt += 1;
      if (attempt === 1) throw new Error("private diagnostic");
      return {
        url:
          attempt === 2 ? "javascript:alert(1)" : "https://example.com/avatar",
      };
    },
  };
  let binding: ChatResourceBinding | undefined;
  function Consumer() {
    binding = useChatResource(resource);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(ChatResourceProvider, { port }, createElement(Consumer)),
    );
  });
  expect(binding?.status).toBe("unavailable");
  await act(async () => binding?.retry());
  expect(binding?.status).toBe("unavailable");
  await act(async () => binding?.retry());
  expect(binding?.url).toBe("https://example.com/avatar");
  act(() => renderer.unmount());
});

it("exposes only safe cancellation state and clears it on explicit retry", async () => {
  let attempts = 0;
  let binding: ChatResourceBinding | undefined;
  function Consumer() {
    binding = useChatResource({ uri: "private:file" });
    return null;
  }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        createElement(
          ChatResourceProvider,
          {
            port: {
              resolve: () => {
                if (++attempts === 1)
                  throw {
                    code: "cancelled",
                    message: "token=secret",
                    stack: "private-stack",
                  };
                return { url: "https://example.test/file" };
              },
            },
          },
          createElement(Consumer),
        ),
      );
    });
    expect(binding?.error).toEqual({ code: "cancelled", retryable: false });
    expect(binding?.status).toBe("unavailable");
    expect(JSON.stringify(binding)).not.toContain("secret");
    await act(async () => binding?.retry());
    expect(binding?.status).toBe("ready");
    expect(binding?.error).toBeUndefined();
  } finally {
    act(() => renderer?.unmount());
  }
});
