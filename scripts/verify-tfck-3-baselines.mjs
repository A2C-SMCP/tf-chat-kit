import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const contractRelativePath =
  "fixtures/tfck-3/v1/tfrobotserver-chat-contract.json";
const performanceRelativePath =
  "fixtures/tfck-3/v1/chat-player-performance.json";
const documentRelativePaths = [
  "docs/baselines/tfck-3/README.md",
  "docs/baselines/tfck-3/tfrobotserver-chat-contract.md",
  "docs/baselines/tfck-3/chat-player-v1-migration-matrix.md",
  "docs/baselines/tfck-3/performance-baseline.md",
];

// The value digests freeze parsed evidence semantics, while the source digests
// freeze the exact JSON bytes before JSON.parse can discard duplicate keys or
// other source-level content. Updating either is a deliberate baseline change.
const frozenContractSha256 =
  "987017feeb77b5b9e98a43a83840f810624e77be556a28425336054f1bc55769";
const frozenContractSourceSha256 =
  "8b6c582d0244a99b7f35fb70c64c36d943173663dda31935e53514bd176e7476";
const frozenPerformanceSha256 =
  "e95318c58a26520156edd6800838e536240605f7ddc21c2b54911e0bbeb93366";
const frozenPerformanceSourceSha256 =
  "8c93895cfb29a77e4aec330f658f29c342f3f4c2e080f403eb7e4ad4bc83d252";
const frozenDocumentSha256 = new Map([
  [
    "docs/baselines/tfck-3/README.md",
    "3f7f837ff48de126d4ce2f2bea62a81fb25cc50a2a366a1dce7b6b61e09ef35c",
  ],
  [
    "docs/baselines/tfck-3/tfrobotserver-chat-contract.md",
    "dd99cf87b2d35987aea8ab552d9d5f4d31dcd7e58d40fe139ab9c4f252332098",
  ],
  [
    "docs/baselines/tfck-3/chat-player-v1-migration-matrix.md",
    "ad89bda282a03176f2d1d9533b1c2d45860da8c97f41547a8196e8cd58e0966b",
  ],
  [
    "docs/baselines/tfck-3/performance-baseline.md",
    "7e3ddff52b42eb97db0a3056317173ba9bf7308fe404bde51256faf2617d3b14",
  ],
]);

const requiredRoutes = new Map([
  ["platform-list", ["GET", "/v1/chat/platforms", "chat:read"]],
  ["platform-create", ["POST", "/v1/chat/platforms", "chat:send"]],
  ["platform-update", ["PUT", "/v1/chat/platforms/{platformId}", "chat:send"]],
  [
    "platform-delete",
    ["DELETE", "/v1/chat/platforms/{platformId}", "chat:send"],
  ],
  ["conversation-list", ["GET", "/v1/chat/conversations", "chat:read"]],
  ["conversation-create", ["POST", "/v1/chat/conversations", "chat:send"]],
  [
    "conversation-update",
    ["PATCH", "/v1/chat/conversations/{conversationId}", "chat:send"],
  ],
  [
    "conversation-delete",
    ["DELETE", "/v1/chat/conversations/{conversationId}", "chat:send"],
  ],
  [
    "history-list",
    ["GET", "/v1/chat/conversations/{conversationId}/messages", "chat:read"],
  ],
  [
    "message-send",
    ["POST", "/v1/chat/conversations/{conversationId}/messages", "chat:send"],
  ],
  [
    "status-get",
    ["GET", "/v1/chat/conversations/{conversationId}/status", "chat:read"],
  ],
  [
    "conversation-interrupt",
    ["POST", "/v1/chat/conversations/{conversationId}/interrupt", "chat:send"],
  ],
]);

const requiredServerEvents = [
  "chat_message",
  "chat_event",
  "chat_error",
  "conversation_state_changed",
  "error",
];

const requiredInboundSocketMetadata = new Map([
  ["join_conversation", ["browser", true, null]],
  [
    "chat_message",
    ["legacy-browser-or-test", false, "TFCK-21-SOCKET-AUTHZ-01"],
  ],
  ["chat_event", ["worker", false, "TFCK-21-SOCKET-AUTHZ-01"]],
  ["chat_error", ["worker", false, "TFCK-21-SOCKET-AUTHZ-01"]],
  ["conversation_state_changed", ["worker", false, "TFCK-21-SOCKET-AUTHZ-01"]],
]);

const requiredDocumentMarkers = new Map([
  [
    "docs/baselines/tfck-3/README.md",
    [
      "d085c12dd8f603477dfb445bc5f5b0fd099caf15",
      "af3b4e2fa8d7a94c458d7c0812435ad17df0eb2e",
      "TFCK-21-LIVE-01",
      "TFCK-21-ERR-01",
      "TFCK-21-SOCKET-AUTHZ-01",
      "TFRS-297",
      "TFCK-37-PAGE-01",
      "TFCK-37-RERUN-01",
    ],
  ],
  [
    "docs/baselines/tfck-3/tfrobotserver-chat-contract.md",
    [
      "d085c12dd8f603477dfb445bc5f5b0fd099caf15",
      "af3b4e2fa8d7a94c458d7c0812435ad17df0eb2e",
      "TFCK-21-LIVE-01",
      "TFCK-21-ERR-01",
      "TFCK-21-SOCKET-AUTHZ-01",
      "TFRS-297",
    ],
  ],
]);

const requiredScenarioIds = [
  "initial-populated-timeline",
  "large-list-scroll",
  "realtime-progressive-update",
  "conversation-switch",
];

const requiredDimensionIds = [
  "first-render",
  "history-pagination",
  "large-list-updates",
  "realtime-updates",
  "conversation-switch",
];

const requiredDimensionCoverage = new Map([
  ["first-render", "approximation"],
  ["history-pagination", "missing"],
  ["large-list-updates", "measured"],
  ["realtime-updates", "approximation"],
  ["conversation-switch", "approximation"],
]);

const commitPattern = /^[0-9a-f]{40}$/u;
const documentedPlaceholder =
  /^(?:<[^>]+>|\$\{[^}]+\}|redacted|example|placeholder|dummy|not-a-real-)/iu;
const sensitiveKeyPattern =
  /(?:authorization|admin[_-]?key|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|password|cookie|secret|token)$/iu;
const sensitiveAssignment =
  /(?:^|[^A-Za-z0-9_])["']?(_authToken|npmAuthToken|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|admin[_-]?key|_auth|_password|token|api[_-]?key|secret|password|cookie|authorization)["']?\s*[:=]\s*(?:(['"`])([^'"`\s]{8,})\2|([^\s,'"`;\]}]{8,}))/gimu;
const forbiddenText = [
  {
    label: "private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  },
  {
    label: "Bearer credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/u,
  },
  {
    label: "JWT credential",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  },
  {
    label: "GitHub credential",
    pattern: /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
  },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** @param {string} value */
const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** @param {unknown} value */
const jsonSha256 = (value) => sha256(JSON.stringify(value));

/** @param {unknown} value */
const sortedStrings = (value) =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === "string").sort()
    : [];

/** @param {unknown} value */
const recordArray = (value) =>
  Array.isArray(value) ? value.filter((item) => isRecord(item)) : [];

/**
 * @param {unknown} value
 * @param {string} location
 * @param {string[]} errors
 */
const scanSensitiveValues = (value, location, errors) => {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanSensitiveValues(item, `${location}[${index}]`, errors),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (
      sensitiveKeyPattern.test(key) &&
      typeof child === "string" &&
      child.length >= 8 &&
      !documentedPlaceholder.test(child)
    ) {
      errors.push(`${childLocation} contains a non-placeholder credential`);
    }
    scanSensitiveValues(child, childLocation, errors);
  }
};

/**
 * @param {unknown} value
 * @param {string} label
 * @param {string[]} errors
 */
const scanForbiddenText = (value, label, errors) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const forbidden of forbiddenText) {
    if (forbidden.pattern.test(text)) {
      errors.push(`${label} contains forbidden ${forbidden.label}`);
    }
  }
  for (const match of text.matchAll(sensitiveAssignment)) {
    const credential = match[3] ?? match[4] ?? "";
    if (!documentedPlaceholder.test(credential)) {
      errors.push(
        `${label} contains a non-placeholder ${match[1] ?? "credential"} assignment`,
      );
    }
  }
  scanSensitiveValues(value, label, errors);
};

/**
 * @param {unknown} source
 * @param {string} label
 * @param {string} expectedSha256
 * @returns {string[]}
 */
const validateJsonSource = (source, label, expectedSha256) => {
  /** @type {string[]} */
  const errors = [];
  if (typeof source !== "string") return [`${label} source is missing`];
  if (sha256(source) !== expectedSha256) {
    errors.push(`${label} source does not match the frozen SHA-256 baseline`);
  }
  scanForbiddenText(source, `${label} source`, errors);
  return errors;
};

/**
 * @param {unknown} contract
 * @returns {string[]}
 */
export function validateTfrobotserverContract(contract) {
  /** @type {string[]} */
  const errors = [];
  if (!isRecord(contract)) return ["contract must be a JSON object"];

  if (jsonSha256(contract) !== frozenContractSha256) {
    errors.push("contract content does not match the frozen SHA-256 baseline");
  }

  if (contract["schemaVersion"] !== 2) {
    errors.push("contract schemaVersion must be 2");
  }
  if (contract["baselineId"] !== "tfck-3/tfrobotserver-chat/v1") {
    errors.push("contract baselineId is invalid");
  }

  const sources = contract["sources"];
  const server = isRecord(sources) ? sources["server"] : undefined;
  const front = isRecord(sources) ? sources["front"] : undefined;
  const runtimeProbe = isRecord(sources) ? sources["runtimeProbe"] : undefined;
  if (!isRecord(server) || !commitPattern.test(String(server["commit"]))) {
    errors.push("contract server source must contain a full commit");
  }
  if (!isRecord(server) || typeof server["version"] !== "string") {
    errors.push("contract server source must contain a version");
  }
  if (!isRecord(front) || !commitPattern.test(String(front["commit"]))) {
    errors.push("contract front source must contain a full commit");
  }
  if (
    !isRecord(runtimeProbe) ||
    !["verified", "unavailable"].includes(String(runtimeProbe["status"]))
  ) {
    errors.push(
      "contract runtime probe status must be verified or unavailable",
    );
  }
  if (
    isRecord(runtimeProbe) &&
    runtimeProbe["status"] === "unavailable" &&
    contract["evidenceStatus"] !== "source-test-derived"
  ) {
    errors.push("an unavailable runtime probe must remain source-test-derived");
  }
  if (isRecord(runtimeProbe) && runtimeProbe["status"] === "verified") {
    if (contract["evidenceStatus"] !== "runtime-verified") {
      errors.push(
        "a verified runtime probe must set runtime-verified evidence",
      );
    }
    if (
      !isRecord(runtimeProbe["environment"]) ||
      Object.keys(runtimeProbe["environment"]).length === 0
    ) {
      errors.push("a verified runtime probe must identify its environment");
    }
    if (!commitPattern.test(String(runtimeProbe["deployedCommit"]))) {
      errors.push("a verified runtime probe must contain a deployed commit");
    }
    if (typeof runtimeProbe["serverVersion"] !== "string") {
      errors.push("a verified runtime probe must contain a Server version");
    }
    if (typeof runtimeProbe["capturedAt"] !== "string") {
      errors.push("a verified runtime probe must contain a capture timestamp");
    }
  }

  const routes = recordArray(contract["rest"]);
  const routeIds = sortedStrings(routes.map((route) => route["id"]));
  if (
    JSON.stringify(routeIds) !==
    JSON.stringify([...requiredRoutes.keys()].sort())
  ) {
    errors.push("contract REST route set is incomplete or contains drift");
  }
  for (const route of routes) {
    const id = String(route["id"]);
    const method = String(route["method"]);
    const routePath = String(route["path"]);
    const scope = String(route["scope"]);
    const expectedRoute = requiredRoutes.get(id);
    if (
      expectedRoute !== undefined &&
      (method !== expectedRoute[0] ||
        routePath !== expectedRoute[1] ||
        scope !== expectedRoute[2])
    ) {
      errors.push(
        `${id}: method, path or scope does not match frozen contract`,
      );
    }
    const evidence = sortedStrings(route["evidence"]);
    if (!evidence.some((item) => item.startsWith("server-source:"))) {
      errors.push(`${id}: missing server-source evidence`);
    }
    if (
      !evidence.some(
        (item) =>
          item.startsWith("server-test:") || item.startsWith("front-caller:"),
      )
    ) {
      errors.push(`${id}: missing independent supporting evidence`);
    }
  }

  const socket = contract["socket"];
  if (!isRecord(socket) || socket["namespace"] !== "/chat") {
    errors.push("Socket namespace must be /chat");
  } else {
    /** @param {Record<string, unknown>} event @param {string} direction */
    const validateSocketEvidence = (event, direction) => {
      const eventName = String(event["event"]);
      const label = `${direction} ${eventName}`;
      const evidence = sortedStrings(event["evidence"]);
      if (!evidence.some((item) => item.startsWith("server-source:"))) {
        errors.push(`${label}: missing server-source evidence`);
      }
      if (event["evidenceStatus"] === "cross-confirmed") {
        if (
          !evidence.some(
            (item) =>
              item.startsWith("server-test:") ||
              item.startsWith("front-caller:"),
          )
        ) {
          errors.push(`${label}: missing independent supporting evidence`);
        }
      } else if (event["evidenceStatus"] === "source-only-deferred") {
        if (
          event["owner"] !== "TFRobotServer" ||
          event["deferredTo"] !== "TFRS-297" ||
          event["blocksBaselineFreeze"] !== false ||
          event["blocksProductionValidation"] !== true ||
          typeof event["verification"] !== "string" ||
          event["verification"].trim() === ""
        ) {
          errors.push(
            `${label}: source-only evidence must be owned by TFRobotServer, deferred to TFRS-297, preserve scoped gates and name verification evidence`,
          );
        }
      } else {
        errors.push(
          `${label}: evidenceStatus must be cross-confirmed or source-only-deferred`,
        );
      }
    };

    const inboundEvents = recordArray(socket["clientToServer"]);
    const inboundEventNames = sortedStrings(
      inboundEvents.map((event) => event["event"]),
    );
    if (
      JSON.stringify(inboundEventNames) !==
      JSON.stringify([...requiredInboundSocketMetadata.keys()].sort())
    ) {
      errors.push("Socket inbound handler set is incomplete or contains drift");
    }
    for (const event of inboundEvents) {
      const eventName = String(event["event"]);
      validateSocketEvidence(event, "inbound");
      if (event["authorizationEnforcement"] !== "handshake-only:chat:read") {
        errors.push(`${eventName}: must record handshake-only authorization`);
      }
      const expectedMetadata = requiredInboundSocketMetadata.get(eventName);
      if (
        expectedMetadata !== undefined &&
        (event["intendedCaller"] !== expectedMetadata[0] ||
          event["publicBrowserApi"] !== expectedMetadata[1] ||
          (event["securityGapId"] ?? null) !== expectedMetadata[2])
      ) {
        errors.push(
          `${eventName}: caller, public API or security-gap metadata does not match frozen exposure`,
        );
      }
    }
    const serverEvents = recordArray(socket["serverToClient"]);
    const events = sortedStrings(serverEvents.map((event) => event["event"]));
    if (
      JSON.stringify(events) !==
      JSON.stringify([...requiredServerEvents].sort())
    ) {
      errors.push("Socket server event set is incomplete or contains drift");
    }
    for (const event of serverEvents) {
      validateSocketEvidence(event, "outbound");
    }
    const unsupported = sortedStrings(socket["unsupported"]);
    for (const event of [
      "leave_conversation",
      "chat_stream_start",
      "chat_stream_chunk",
      "chat_stream_end",
    ]) {
      if (!unsupported.includes(event)) {
        errors.push(`Socket unsupported set must contain ${event}`);
      }
    }
    if (
      JSON.stringify(sortedStrings(socket["eventStatuses"])) !==
      JSON.stringify(["aborted", "failed", "running", "success"])
    ) {
      errors.push("Socket event status set must match Server source");
    }
  }

  const socketSecurityGate = recordArray(contract["securityGates"]).find(
    (gate) => gate["id"] === "TFCK-21-SOCKET-AUTHZ-01",
  );
  if (!socketSecurityGate) {
    errors.push(
      "contract must preserve the Socket authorization security gate",
    );
  } else {
    if (socketSecurityGate["blocksBaselineFreeze"] !== false) {
      errors.push(
        "Socket authorization security gate must not block the source/test baseline freeze",
      );
    }
    if (socketSecurityGate["blocksProductionValidation"] !== true) {
      errors.push(
        "Socket authorization security gate must block production validation",
      );
    }
    if (socketSecurityGate["trackingIssue"] !== "TFRS-297") {
      errors.push(
        "Socket authorization security gate must be tracked by TFRS-297",
      );
    }
    if (
      JSON.stringify(sortedStrings(socketSecurityGate["blockedItems"])) !==
      JSON.stringify(["TFCK-37", "TFCK-7"])
    ) {
      errors.push(
        "Socket authorization security gate must block TFCK-7 and TFCK-37",
      );
    }
  }

  const errorStatuses = recordArray(contract["errors"])
    .map((error) => error["status"])
    .filter((status) => typeof status === "number")
    .sort((left, right) => left - right);
  for (const status of [401, 403, 422, 500]) {
    if (!errorStatuses.includes(status)) {
      errors.push(`contract error baseline is missing HTTP ${status}`);
    }
  }

  const unknowns = recordArray(contract["unknowns"]);
  for (const unknown of unknowns) {
    const id = String(unknown["id"]);
    if (Object.hasOwn(unknown, "blocking")) {
      errors.push(
        `${id}: generic blocking is ambiguous; use blocksBaselineFreeze and blocksProductionValidation`,
      );
    }
    if (
      typeof unknown["blocksBaselineFreeze"] !== "boolean" ||
      typeof unknown["blocksProductionValidation"] !== "boolean"
    ) {
      errors.push(`${id}: must declare both scoped blocking fields`);
    }
  }
  for (const id of ["TFCK-21-LIVE-01", "TFCK-21-ERR-01"]) {
    const unknown = unknowns.find((candidate) => candidate["id"] === id);
    if (
      !unknown ||
      unknown["blocksBaselineFreeze"] !== false ||
      unknown["deferredTo"] !== "TFCK-37" ||
      unknown["blocksProductionValidation"] !== true
    ) {
      errors.push(
        `${id} must be deferred to TFCK-37 without blocking the source/test baseline freeze`,
      );
    }
  }
  if (unknowns.some((unknown) => unknown["id"] === "TFCK-21-SOCKET-AUTHZ-01")) {
    errors.push(
      "Socket authorization exposure is a tracked security gate, not an unresolved contract unknown",
    );
  }

  scanForbiddenText(contract, "contract fixture", errors);
  return errors;
}

/**
 * @param {unknown} performance
 * @returns {string[]}
 */
export function validateChatPlayerPerformance(performance) {
  /** @type {string[]} */
  const errors = [];
  if (!isRecord(performance)) return ["performance must be a JSON object"];

  if (jsonSha256(performance) !== frozenPerformanceSha256) {
    errors.push(
      "performance content does not match the frozen SHA-256 baseline",
    );
  }

  if (performance["schemaVersion"] !== 1) {
    errors.push("performance schemaVersion must be 1");
  }
  if (performance["baselineId"] !== "tfck-3/chat-player-performance/v1") {
    errors.push("performance baselineId is invalid");
  }

  const measurementPlan = performance["measurementPlan"];
  if (
    !isRecord(measurementPlan) ||
    measurementPlan["owner"] !== "TFCK-37" ||
    measurementPlan["timing"] !==
      "after-v1-development-before-default-cutover" ||
    measurementPlan["blockingForTfck3"] !== false ||
    measurementPlan["blockingForDefaultCutover"] !== true
  ) {
    errors.push(
      "performance measurement plan must defer the unified comparison to TFCK-37 before default cutover",
    );
  }

  const source = performance["source"];
  for (const field of [
    "artifactCommit",
    "measuredApplicationCommit",
    "currentInspectedCommit",
  ]) {
    if (!isRecord(source) || !commitPattern.test(String(source[field]))) {
      errors.push(`performance source ${field} must be a full commit`);
    }
  }

  const scenarios = recordArray(performance["scenarios"]);
  const scenarioIds = sortedStrings(
    scenarios.map((scenario) => scenario["id"]),
  );
  if (
    JSON.stringify(scenarioIds) !==
    JSON.stringify([...requiredScenarioIds].sort())
  ) {
    errors.push("performance scenario set is incomplete or contains drift");
  }
  for (const scenario of scenarios) {
    const id = String(scenario["id"]);
    const metrics = scenario["metrics"];
    if (!isRecord(metrics) || Object.keys(metrics).length === 0) {
      errors.push(`${id}: metrics must be a non-empty object`);
      continue;
    }
    for (const [name, value] of Object.entries(metrics)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        errors.push(
          `${id}: metric ${name} must be a finite non-negative number`,
        );
      }
    }
  }

  const dimensions = recordArray(performance["requiredDimensions"]);
  const dimensionIds = sortedStrings(
    dimensions.map((dimension) => dimension["id"]),
  );
  if (
    JSON.stringify(dimensionIds) !==
    JSON.stringify([...requiredDimensionIds].sort())
  ) {
    errors.push(
      "performance required-dimension set is incomplete or contains drift",
    );
  }
  for (const dimension of dimensions) {
    const id = String(dimension["id"]);
    const status = String(dimension["status"]);
    if (!["measured", "approximation", "missing"].includes(status)) {
      errors.push(`${id}: invalid coverage status`);
    }
    if (status !== "measured" && typeof dimension["gapId"] !== "string") {
      errors.push(`${id}: non-measured coverage must name a gap`);
    }
    const expectedStatus = requiredDimensionCoverage.get(id);
    if (expectedStatus !== undefined && status !== expectedStatus) {
      errors.push(
        `${id}: coverage status must remain ${expectedStatus} in the V1 historical baseline`,
      );
    }
    for (const scenarioId of sortedStrings(dimension["scenarioIds"])) {
      if (!scenarioIds.includes(scenarioId)) {
        errors.push(`${id}: references unknown scenario ${scenarioId}`);
      }
    }
  }

  const gaps = recordArray(performance["gaps"]);
  const gapIds = gaps.map((gap) => String(gap["id"]));
  for (const id of [
    "TFCK-37-PAGE-01",
    "TFCK-37-RERUN-01",
    "TFCK-37-STREAM-01",
    "TFCK-37-ENV-01",
  ]) {
    const gap = gaps.find((candidate) => candidate["id"] === id);
    if (!gap || gap["blocking"] !== false || gap["deferredTo"] !== "TFCK-37") {
      errors.push(`performance must preserve TFCK-37 deferral ${id}`);
    }
  }
  for (const dimension of dimensions) {
    const gapId = dimension["gapId"];
    if (typeof gapId === "string" && !gapIds.includes(gapId)) {
      errors.push(`${String(dimension["id"])}: gap ${gapId} is not declared`);
    }
  }

  scanForbiddenText(performance, "performance fixture", errors);
  return errors;
}

/**
 * @param {Record<string, string>} documents
 * @returns {string[]}
 */
export function validateTfck3Documents(documents) {
  /** @type {string[]} */
  const errors = [];
  for (const relativePath of documentRelativePaths) {
    const content = documents[relativePath];
    if (typeof content !== "string" || content.trim() === "") {
      errors.push(`${relativePath} is missing or empty`);
    } else {
      if (sha256(content) !== frozenDocumentSha256.get(relativePath)) {
        errors.push(
          `${relativePath} content does not match the frozen SHA-256 baseline`,
        );
      }
      scanForbiddenText(content, relativePath, errors);
    }
  }
  for (const [relativePath, markers] of requiredDocumentMarkers) {
    const content = documents[relativePath] ?? "";
    for (const marker of markers) {
      if (!content.includes(marker)) {
        errors.push(`${relativePath} must contain ${marker}`);
      }
    }
  }
  return errors;
}

/**
 * @param {string} [root]
 */
export async function loadTfck3Baselines(root = process.cwd()) {
  /** @param {string} relativePath */
  const readJson = async (relativePath) => {
    const source = await readFile(path.join(root, relativePath), "utf8");
    return { source, value: JSON.parse(source) };
  };
  /** @type {Record<string, string>} */
  const documents = {};
  const [contract, performance] = await Promise.all([
    readJson(contractRelativePath),
    readJson(performanceRelativePath),
  ]);
  await Promise.all(
    documentRelativePaths.map(async (relativePath) => {
      documents[relativePath] = await readFile(
        path.join(root, relativePath),
        "utf8",
      );
    }),
  );
  return {
    contract: contract.value,
    contractSource: contract.source,
    performance: performance.value,
    performanceSource: performance.source,
    documents,
  };
}

/**
 * @param {{ contract: unknown; contractSource: unknown; performance: unknown; performanceSource: unknown; documents: Record<string, string> }} baselines
 */
export function validateTfck3Baselines(baselines) {
  return [
    ...validateJsonSource(
      baselines.contractSource,
      "contract fixture",
      frozenContractSourceSha256,
    ),
    ...validateTfrobotserverContract(baselines.contract),
    ...validateJsonSource(
      baselines.performanceSource,
      "performance fixture",
      frozenPerformanceSourceSha256,
    ),
    ...validateChatPlayerPerformance(baselines.performance),
    ...validateTfck3Documents(baselines.documents),
  ];
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const errors = validateTfck3Baselines(await loadTfck3Baselines());
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      "TFCK-3 baselines are content-frozen, structurally valid and redacted.",
    );
  }
}
