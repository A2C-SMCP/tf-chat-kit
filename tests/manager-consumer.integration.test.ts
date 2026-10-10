import { describe, it } from "vitest";
import { runManagerConsumerVerification } from "./consumers/manager/consumer.js";
describe("public Manager HTTP/Socket consumer chain", () => {
  it.each(["web", "office"] as const)(
    "runs %s against real TCP facilities",
    async (host) => {
      await runManagerConsumerVerification(host);
    },
    20_000,
  );
});
