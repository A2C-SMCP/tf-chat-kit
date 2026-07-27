import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { createGatewayContractCases } from "../packages/chat-testing/src/index.js";
import { createTFRobotGatewayContractHarness } from "./support/tfrobot-gateway-contract-harness.js";

describe("TFRobot Gateway framework-neutral contract", () => {
  const cases = createGatewayContractCases(createTFRobotGatewayContractHarness);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_773_705_600_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const contractCase of cases) {
    it(contractCase.name, () => contractCase.run());
  }
});
