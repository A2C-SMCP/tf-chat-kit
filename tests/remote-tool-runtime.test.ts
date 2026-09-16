import { describe, expect, it, vi } from "vitest";
import {
  createRemoteToolClient,
  defineRemoteTool,
  type RemoteToolExecutionContext,
  type RemoteToolResult,
} from "../packages/chat-kit/src/headless.js";
import { MemoryRemoteToolTransport } from "../packages/chat-testing/src/remote-tool.js";

const definition = {
  toolName: "host_tool",
  description: "Host operation",
  parameters: { type: "object" },
  tags: ["Read"],
} as const;
const flush = async () => {
  for (let i = 0; i < 12; ++i) await Promise.resolve();
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const call = (requestId = "r1") => ({
  requestId,
  toolName: "host_tool",
  params: { value: "hello" },
});
const success = { ok: true, resultForLlm: "done" } as const;

describe("RemoteTool execution ownership", () => {
  it("rejects invalid results and unknown tools without exposing host data", async () => {
    const transport = new MemoryRemoteToolTransport();
    const execute = vi.fn(
      () =>
        ({
          ok: true,
          origin: () => "not-json",
          resultForLlm: "value",
        }) as unknown as RemoteToolResult,
    );
    const client = createRemoteToolClient({
      transport,
      tools: [defineRemoteTool({ definition, validate: (p) => p, execute })],
    });
    client.start();
    transport.setConnectionState({ status: "ready" });
    const reply = vi.fn();
    transport.invoke(call(), reply);
    await flush();
    expect(reply).toHaveBeenCalledWith({ ok: false, code: "invalid-result" });
    transport.invoke({ ...call("unknown"), toolName: "absent" }, reply);
    await flush();
    expect(reply).toHaveBeenCalledWith({ ok: false, code: "unknown-tool" });
    expect(execute).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("finishes release when the injected transport throws and ignores retry while registering", () => {
    const transport = new MemoryRemoteToolTransport();
    const retry = vi.spyOn(transport, "retry");
    const client = createRemoteToolClient({
      transport,
      tools: [
        defineRemoteTool({
          definition,
          validate: (p) => p,
          execute: () => success,
        }),
      ],
    });
    client.start();
    client.retry();
    expect(retry).not.toHaveBeenCalled();
    vi.spyOn(transport, "dispose").mockImplementation(() => {
      throw new Error("host cleanup failure");
    });
    expect(() => client.dispose()).not.toThrow();
    expect(client.getSnapshot()).toMatchObject({
      status: "disposed",
      activeCalls: 0,
    });
  });
  it("waits for registration, validates input, deduplicates for its whole lifetime and isolates instances", async () => {
    const execute = vi.fn((value: string) => ({
      ok: true as const,
      resultForLlm: value,
    }));
    const tool = defineRemoteTool({
      definition,
      validate: (params) => String(params["value"]),
      execute,
    });
    const transport = new MemoryRemoteToolTransport();
    const client = createRemoteToolClient({ transport, tools: [tool] });
    const replies = vi.fn();
    client.start();
    transport.invoke(call(), replies);
    await flush();
    expect(execute).not.toHaveBeenCalled();
    transport.setConnectionState({ status: "ready" });
    transport.invoke(call(), replies);
    transport.invoke(call(), replies);
    await flush();
    transport.setConnectionState({ status: "disconnected" });
    transport.setConnectionState({ status: "ready" });
    transport.invoke(call(), replies);
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(replies.mock.calls).toEqual([[{ ok: true, resultForLlm: "hello" }]]);
    const otherTransport = new MemoryRemoteToolTransport();
    const other = createRemoteToolClient({
      transport: otherTransport,
      tools: [tool],
    });
    other.start();
    otherTransport.setConnectionState({ status: "ready" });
    otherTransport.invoke(call(), replies);
    await flush();
    expect(execute).toHaveBeenCalledTimes(2);
    client.dispose();
    other.dispose();
    expect(client.getSnapshot().status).toBe("disposed");
  });

  it.each(["cancelled", "timeout", "disconnected", "disposed"] as const)(
    "settles %s once, cancels host work and ignores late results",
    async (reason) => {
      const pending = deferred<RemoteToolResult>();
      let context: RemoteToolExecutionContext | undefined;
      const aborted = vi.fn();
      const transport = new MemoryRemoteToolTransport();
      const client = createRemoteToolClient({
        transport,
        tools: [
          defineRemoteTool({
            definition,
            validate: (p) => p,
            execute: (_params, input) => {
              context = input;
              input.signal.subscribe(aborted);
              return pending.promise;
            },
          }),
        ],
      });
      client.start();
      transport.setConnectionState({ status: "ready" });
      const reply = vi.fn();
      transport.invoke(call(), reply);
      await flush();
      expect(context?.deadlineAt).toBe(110_000);
      if (reason === "timeout") {
        transport.advanceTo(109_999);
        await flush();
        expect(reply).not.toHaveBeenCalled();
        transport.advanceTo(110_000);
      } else if (reason === "cancelled") expect(client.cancel("r1")).toBe(true);
      else if (reason === "disconnected")
        transport.setConnectionState({ status: "disconnected" });
      else client.dispose();
      await flush();
      expect(context?.signal.aborted).toBe(true);
      expect(aborted).toHaveBeenCalledTimes(1);
      expect(client.getSnapshot().activeCalls).toBe(0);
      pending.resolve(success);
      await flush();
      expect(reply.mock.calls).toEqual(
        reason === "disconnected" ? [] : [[{ ok: false, code: reason }]],
      );
      expect(client.cancel("r1")).toBe(false);
      client.dispose();
    },
  );

  it("does not execute validation completing after timeout, and does not leak exception details", async () => {
    const pending = deferred<unknown>();
    const execute = vi.fn(() => success);
    const transport = new MemoryRemoteToolTransport();
    const client = createRemoteToolClient({
      transport,
      tools: [
        defineRemoteTool({
          definition,
          validate: () => pending.promise,
          execute,
        }),
      ],
    });
    client.start();
    transport.setConnectionState({ status: "ready" });
    const reply = vi.fn();
    transport.invoke(call(), reply);
    await flush();
    transport.advanceTo(110_000);
    pending.resolve({});
    await flush();
    expect(execute).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ ok: false, code: "timeout" });
    client.dispose();
    for (const stage of ["validate", "execute"]) {
      const nextTransport = new MemoryRemoteToolTransport();
      const fail = () => {
        throw new Error("private-session-secret");
      };
      const next = createRemoteToolClient({
        transport: nextTransport,
        tools: [
          defineRemoteTool({
            definition,
            validate: stage === "validate" ? fail : () => ({}),
            execute: fail,
          }),
        ],
      });
      next.start();
      nextTransport.setConnectionState({ status: "ready" });
      const result = vi.fn();
      nextTransport.invoke(call(), result);
      await flush();
      expect(result).toHaveBeenCalledWith({
        ok: false,
        code: stage === "validate" ? "invalid-parameters" : "handler-failed",
      });
      expect(JSON.stringify(next.getSnapshot())).not.toContain("secret");
      next.dispose();
    }
  });

  it("bounds concurrent calls and retained IDs without evicting and replaying old work", async () => {
    const transport = new MemoryRemoteToolTransport();
    const execute = vi.fn(() => new Promise<RemoteToolResult>(() => undefined));
    const client = createRemoteToolClient({
      transport,
      tools: [defineRemoteTool({ definition, validate: (p) => p, execute })],
      maxConcurrentCalls: 1,
      maxRememberedCalls: 2,
    });
    client.start();
    transport.setConnectionState({ status: "ready" });
    const replies = vi.fn();
    transport.invoke(call("1"), replies);
    await flush();
    transport.invoke(call("2"), replies);
    transport.invoke(call("3"), replies);
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot()).toMatchObject({
      status: "disposed",
      activeCalls: 0,
      lastCallError: "capacity",
    });
    expect(transport.disposed).toBe(true);
  });

  it("isolates subscribers and handles disposal during registration without starting the transport", () => {
    const transport = new MemoryRemoteToolTransport();
    const client = createRemoteToolClient({
      transport,
      tools: [
        defineRemoteTool({
          definition,
          validate: (p) => p,
          execute: () => success,
        }),
      ],
    });
    client.subscribe(() => {
      throw new Error("host listener");
    });
    client.subscribe(() => client.dispose());
    client.start();
    expect(client.getSnapshot().status).toBe("disposed");
    expect(transport.definitions).toEqual([]);
  });
});
