import { describe, expect, it } from "vitest";

import {
  loadTfck3Baselines,
  validateChatPlayerPerformance,
  validateTfck3Baselines,
  validateTfck3Documents,
  validateTfrobotserverContract,
} from "../scripts/verify-tfck-3-baselines.mjs";

describe("TFCK-3 migration baselines", () => {
  it("accepts the committed redacted contract, migration evidence and performance anchor", async () => {
    const baselines = await loadTfck3Baselines();

    expect(validateTfck3Baselines(baselines)).toEqual([]);
  });

  it("rejects a missing critical REST contract", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      rest: Array<{ id: string }>;
    };
    mutated.rest = mutated.rest.filter(({ id }) => id !== "message-send");

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining("REST route set is incomplete"),
    );
  });

  it("rejects a critical REST route whose ID hides path drift", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      rest: Array<{ id: string; path: string }>;
    };
    const send = mutated.rest.find(({ id }) => id === "message-send")!;
    send.path = "/v1/chat/not-the-send-route";

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining("does not match frozen contract"),
    );
  });

  it("rejects a verified runtime probe without deployment provenance", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      evidenceStatus: string;
      sources: {
        runtimeProbe: {
          status: string;
          environment: null;
          deployedCommit: null;
        };
      };
    };
    mutated.evidenceStatus = "runtime-verified";
    mutated.sources.runtimeProbe.status = "verified";

    const errors = validateTfrobotserverContract(mutated);
    expect(errors).toContainEqual(
      expect.stringContaining("must identify its environment"),
    );
    expect(errors).toContainEqual(
      expect.stringContaining("must contain a deployed commit"),
    );
  });

  it("rejects making deferred runtime evidence block the source/test freeze", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      unknowns: Array<{
        id: string;
        blocksBaselineFreeze: boolean;
        deferredTo?: string;
        blocksProductionValidation: boolean;
      }>;
    };
    const liveEvidence = mutated.unknowns.find(
      ({ id }) => id === "TFCK-21-LIVE-01",
    )!;
    liveEvidence.blocksBaselineFreeze = true;
    liveEvidence.blocksProductionValidation = false;
    delete liveEvidence.deferredTo;

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining(
        "must be deferred to TFCK-37 without blocking the source/test baseline freeze",
      ),
    );
  });

  it("rejects losing downstream ownership for the Socket authorization gate", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      securityGates: Array<{
        id: string;
        blocksBaselineFreeze: boolean;
        blocksProductionValidation: boolean;
        trackingIssue: string;
        blockedItems: string[];
      }>;
    };
    const gate = mutated.securityGates.find(
      ({ id }) => id === "TFCK-21-SOCKET-AUTHZ-01",
    )!;
    gate.blocksBaselineFreeze = true;
    gate.blocksProductionValidation = false;
    gate.trackingIssue = "TFCK-21";
    gate.blockedItems = [];

    expect(validateTfrobotserverContract(mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "must not block the source/test baseline freeze",
        ),
        expect.stringContaining("must block production validation"),
        expect.stringContaining("must be tracked by TFRS-297"),
        expect.stringContaining("must block TFCK-7 and TFCK-37"),
      ]),
    );
  });

  it("rejects a credential accidentally copied into a fixture", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      authentication: {
        socket: { canonicalAuthExamples: Array<{ token?: string }> };
      };
    };
    mutated.authentication.socket.canonicalAuthExamples[0]!.token =
      "real-production-token-value";

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining("non-placeholder credential"),
    );
  });

  it("rejects a credential hidden behind a duplicate JSON key", async () => {
    const baselines = await loadTfck3Baselines();
    const contractSource = baselines.contractSource.replace(
      '  "authentication": {',
      '  "authentication": {"token": "real-production-token-value"},\n  "authentication": {',
    );
    const mutated = {
      ...baselines,
      contract: JSON.parse(contractSource) as unknown,
      contractSource,
    };

    expect(mutated.contract).toEqual(baselines.contract);
    expect(validateTfck3Baselines(mutated)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("contract fixture source does not match"),
        expect.stringContaining("non-placeholder token assignment"),
      ]),
    );
  });

  it("rejects source-byte drift that JSON parsing would ignore", async () => {
    const baselines = await loadTfck3Baselines();
    const mutated = {
      ...baselines,
      performanceSource: `${baselines.performanceSource}\n`,
    };

    expect(validateTfck3Baselines(mutated)).toContainEqual(
      expect.stringContaining(
        "performance fixture source does not match the frozen SHA-256 baseline",
      ),
    );
  });

  it("rejects drift in canonical authentication metadata", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      authentication: {
        socket: { canonicalAuthExamples: Array<Record<string, string>> };
      };
    };
    mutated.authentication.socket.canonicalAuthExamples[0] = {
      session_token: "<redacted-user-jwt>",
    };

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining("frozen SHA-256 baseline"),
    );
  });

  it("rejects drift in run and cancellation response DTOs", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      rest: Array<{ id: string; successDataExample: unknown }>;
    };
    mutated.rest.find(({ id }) => id === "message-send")!.successDataExample =
      {};
    mutated.rest.find(
      ({ id }) => id === "conversation-interrupt",
    )!.successDataExample = { interruptedRunId: "run-task-redacted" };

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining("frozen SHA-256 baseline"),
    );
  });

  it("rejects drift in the frozen HTTP error body", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      errors: Array<{ status: number | null; example: unknown }>;
    };
    mutated.errors.find(({ status }) => status === 401)!.example = {
      detail: "Authentication failed",
    };

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining("frozen SHA-256 baseline"),
    );
  });

  it("rejects a credential accidentally copied into baseline Markdown", async () => {
    const { documents } = await loadTfck3Baselines();
    const mutated = structuredClone(documents);
    mutated["docs/baselines/tfck-3/README.md"] +=
      `\nAuthorization: Bearer ${"a".repeat(32)}\n`;

    expect(validateTfck3Documents(mutated)).toContainEqual(
      expect.stringContaining("forbidden Bearer credential"),
    );
  });

  it("rejects reversing a documented migration gate", async () => {
    const { documents } = await loadTfck3Baselines();
    const mutated = structuredClone(documents);
    const readme = mutated["docs/baselines/tfck-3/README.md"]!;
    mutated["docs/baselines/tfck-3/README.md"] = readme.replace(
      "the required comparison still blocks migration cutover",
      "the required comparison does not block migration cutover",
    );

    expect(validateTfck3Documents(mutated)).toContainEqual(
      expect.stringContaining("frozen SHA-256 baseline"),
    );
  });

  it("rejects a baseline that hides an exposed worker Socket handler", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      socket: { clientToServer: Array<{ event: string }> };
    };
    mutated.socket.clientToServer = mutated.socket.clientToServer.filter(
      ({ event }) => event !== "chat_error",
    );

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining("inbound handler set is incomplete"),
    );
  });

  it("rejects a cross-confirmed Socket event without independent evidence", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      socket: {
        clientToServer: Array<{
          event: string;
          evidence: string[];
        }>;
      };
    };
    const chatEvent = mutated.socket.clientToServer.find(
      ({ event }) => event === "chat_event",
    )!;
    chatEvent.evidence = chatEvent.evidence.filter((item) =>
      item.startsWith("server-source:"),
    );

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining(
        "inbound chat_event: missing independent supporting evidence",
      ),
    );
  });

  it("rejects incomplete ownership for source-only Socket evidence", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      socket: {
        serverToClient: Array<{
          event: string;
          owner?: string;
          verification?: string;
        }>;
      };
    };
    const errorEvent = mutated.socket.serverToClient.find(
      ({ event }) => event === "error",
    )!;
    delete errorEvent.owner;
    delete errorEvent.verification;

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining(
        "outbound error: source-only evidence must be owned by TFRobotServer",
      ),
    );
  });

  it("rejects an ambiguous generic blocking field on an unknown", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      unknowns: Array<{ id: string; blocking?: boolean }>;
    };
    mutated.unknowns[0]!.blocking = false;

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining("generic blocking is ambiguous"),
    );
  });

  it("requires TFCK-21 ownership markers in each relevant document", async () => {
    const { documents } = await loadTfck3Baselines();
    const mutated = structuredClone(documents);
    mutated["docs/baselines/tfck-3/README.md"] = mutated[
      "docs/baselines/tfck-3/README.md"
    ]!.replaceAll("TFRS-297", "TFRS-REDACTED");
    mutated["docs/baselines/tfck-3/performance-baseline.md"] +=
      "\nUnrelated marker: TFRS-297\n";

    expect(validateTfck3Documents(mutated)).toContainEqual(
      expect.stringContaining(
        "docs/baselines/tfck-3/README.md must contain TFRS-297",
      ),
    );
  });

  it("rejects worker Socket ingress relabeled as a public browser API", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      socket: {
        clientToServer: Array<{
          event: string;
          intendedCaller: string;
          publicBrowserApi: boolean;
          securityGapId?: string;
        }>;
      };
    };
    const chatEvent = mutated.socket.clientToServer.find(
      ({ event }) => event === "chat_event",
    )!;
    chatEvent.intendedCaller = "browser";
    chatEvent.publicBrowserApi = true;
    delete chatEvent.securityGapId;

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining("does not match frozen exposure"),
    );
  });

  it("rejects removing the security gate from legacy Socket message injection", async () => {
    const { contract } = await loadTfck3Baselines();
    const mutated = structuredClone(contract) as {
      socket: {
        clientToServer: Array<{
          event: string;
          publicBrowserApi: boolean;
          securityGapId?: string;
        }>;
      };
    };
    const chatMessage = mutated.socket.clientToServer.find(
      ({ event }) => event === "chat_message",
    )!;
    chatMessage.publicBrowserApi = true;
    delete chatMessage.securityGapId;

    expect(validateTfrobotserverContract(mutated)).toContainEqual(
      expect.stringContaining("does not match frozen exposure"),
    );
  });

  it("rejects a performance baseline that hides missing pagination evidence", async () => {
    const { performance } = await loadTfck3Baselines();
    const mutated = structuredClone(performance) as {
      requiredDimensions: Array<{
        id: string;
        status: string;
        gapId?: string;
      }>;
    };
    const pagination = mutated.requiredDimensions.find(
      ({ id }) => id === "history-pagination",
    )!;
    pagination.status = "measured";
    delete pagination.gapId;

    expect(validateChatPlayerPerformance(mutated)).toContainEqual(
      expect.stringContaining("history-pagination"),
    );
  });

  it("rejects moving the unified performance comparison back into TFCK-3", async () => {
    const { performance } = await loadTfck3Baselines();
    const mutated = structuredClone(performance) as {
      measurementPlan: {
        owner: string;
        blockingForTfck3: boolean;
      };
    };
    mutated.measurementPlan.owner = "TFCK-20";
    mutated.measurementPlan.blockingForTfck3 = true;

    expect(validateChatPlayerPerformance(mutated)).toContainEqual(
      expect.stringContaining("defer the unified comparison to TFCK-37"),
    );
  });

  it("rejects removing conversation switch from the required comparison", async () => {
    const { performance } = await loadTfck3Baselines();
    const mutated = structuredClone(performance) as {
      requiredDimensions: Array<{ id: string }>;
    };
    mutated.requiredDimensions = mutated.requiredDimensions.filter(
      ({ id }) => id !== "conversation-switch",
    );

    expect(validateChatPlayerPerformance(mutated)).toContainEqual(
      expect.stringContaining("required-dimension set is incomplete"),
    );
  });

  it("rejects invalid or negative performance metrics", async () => {
    const { performance } = await loadTfck3Baselines();
    const mutated = structuredClone(performance) as {
      scenarios: Array<{ id: string; metrics: Record<string, number> }>;
    };
    mutated.scenarios[0]!.metrics["fcpMs"] = -1;

    expect(validateChatPlayerPerformance(mutated)).toContainEqual(
      expect.stringContaining("must be a finite non-negative number"),
    );
  });

  it("rejects drift in a historical performance measurement", async () => {
    const { performance } = await loadTfck3Baselines();
    const mutated = structuredClone(performance) as {
      scenarios: Array<{ id: string; metrics: Record<string, number> }>;
    };
    mutated.scenarios.find(({ id }) => id === "conversation-switch")!.metrics[
      "wallClockMs"
    ] = 999_999_999;

    expect(validateChatPlayerPerformance(mutated)).toContainEqual(
      expect.stringContaining("frozen SHA-256 baseline"),
    );
  });
});
