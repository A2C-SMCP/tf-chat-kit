const assessment = {
  protocol: {
    candidate: "AG-UI 0.0.57",
    inboundSemanticCoverage: [
      "message/event snapshots",
      "event updates",
      "run lifecycle",
      "unknown raw events",
    ],
    missingPublicSemantics: [
      "task-aware stale interrupt command",
      "SessionProvider authentication port",
      "conversation history pagination port",
    ],
    replacesWholePackage: false,
  },
  runtime: {
    candidate: "AI SDK 7.0.26",
    candidateOwned: ["request-scoped message stream", "message parts", "request abort"],
    bridgeStillOwned: [
      "independent socket subscription",
      "history/live merge and ordering",
      "run state",
      "task-aware interrupt",
      "gateway disposal",
    ],
    shadowStateRequired: true,
    replacesWholePackage: false,
  },
  react: {
    candidate: "assistant-ui 0.14.26",
    candidateOwned: ["React runtime context", "message/component primitives", "capability callbacks"],
    externalStoreStillOwned: [
      "ChatClient-to-React subscription adapter",
      "canonical state",
      "history/live merge",
      "authentication isolation",
      "gateway lifecycle",
    ],
    canSupplyUiRuntime: true,
    replacesWholePackage: false,
    replacesHeadlessRuntime: false,
  },
  recommendation: "Proceed with the six-package custom boundary. None of the candidates replaces a whole intended package without a custom bridge or shadow state; assistant-ui remains an optional internal UI dependency for a later product-level evaluation.",
};

console.log(JSON.stringify(assessment, null, 2));
