import type { AuthClient, AuthSnapshot, AuthSession } from "./headless.js";

export type ManagerOperation =
  "directory" | "connection-info" | "resolve" | "exchange";
export type ManagerErrorCode =
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "payment_required"
  | "rate_limited"
  | "server"
  | "network"
  | "invalid_response"
  | "unsupported_contract"
  | "cancelled"
  | "timeout"
  | "disposed";
/** An allowlisted projection, never the original response/error/URL or credentials. */
export interface ManagerDiagnostic {
  readonly requestId?: string | undefined;
  readonly operation: ManagerOperation;
  readonly code: ManagerErrorCode;
  readonly status?: number | undefined;
  readonly path?: string | undefined;
}
export class ManagerIntegrationError extends Error {
  readonly diagnostic: ManagerDiagnostic;
  readonly code: ManagerErrorCode;
  readonly status: number | undefined;
  constructor(
    operation: ManagerOperation,
    code: ManagerErrorCode,
    status?: number,
    path?: string,
    requestId?: string,
  ) {
    super(
      `Manager ${operation} failed (${code}${status === undefined ? "" : `, HTTP ${status}`}).`,
    );
    this.name = "ManagerIntegrationError";
    this.code = code;
    this.status = status;
    this.diagnostic = Object.freeze({
      operation,
      code,
      ...(status === undefined ? {} : { status }),
      ...(path === undefined ? {} : { path }),
      ...(requestId !== undefined &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        requestId,
      )
        ? { requestId }
        : {}),
    });
  }
}
const fail = (operation: ManagerOperation, code: ManagerErrorCode): never => {
  throw new ManagerIntegrationError(operation, code);
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== ""
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : undefined;
const unwrap = (value: unknown): Record<string, unknown> => {
  const envelope = record(value);
  if (!envelope || (envelope["code"] !== undefined && envelope["code"] !== 200))
    return fail("directory", "invalid_response");
  return record(envelope["data"]) ?? envelope;
};
export const managerIdentityScope = (
  snapshot: AuthSnapshot,
): string | undefined =>
  (snapshot.status === "authenticated" || snapshot.status === "refreshing") &&
  snapshot.account !== undefined
    ? JSON.stringify([
        snapshot.environment,
        snapshot.account.userId,
        snapshot.account.accountId,
        snapshot.account.organizationId ?? null,
      ])
    : undefined;

export type ManagerRobotEligibility =
  | "ready"
  | "missing_employee_id"
  | "missing_robot_id"
  | "missing_robot_account_id"
  | "not_running"
  | "unsupported_template";
export interface ManagerRobot {
  /** Stable directory key; never substituted for robot identity. */
  readonly id: string;
  readonly employeeId?: string | undefined;
  readonly managerEmployeeId?: string | undefined;
  readonly robotId?: string | undefined;
  readonly robotAccountId?: string | undefined;
  readonly name: string;
  readonly namespace?: string | undefined;
  readonly status?: string | undefined;
  readonly templateType?: string | undefined;
  readonly eligibility: ManagerRobotEligibility;
  readonly canAutoConnect: boolean;
}
export const managerRobotEligibility = (
  robot: Pick<
    ManagerRobot,
    "employeeId" | "robotId" | "robotAccountId" | "status" | "templateType"
  >,
): ManagerRobotEligibility =>
  !robot.employeeId
    ? "missing_employee_id"
    : !robot.robotId
      ? "missing_robot_id"
      : !robot.robotAccountId
        ? "missing_robot_account_id"
        : robot.status !== "running"
          ? "not_running"
          : robot.templateType !== "tfrserver"
            ? "unsupported_template"
            : "ready";
export const parseManagerRobots = (
  payload: unknown,
): readonly ManagerRobot[] => {
  const items: unknown = Array.isArray(payload)
    ? payload
    : unwrap(payload)["items"];
  if (!Array.isArray(items)) return fail("directory", "invalid_response");
  const robots = new Map<string, ManagerRobot>();
  for (const item of items) {
    const r = record(item);
    if (!r) return fail("directory", "invalid_response");
    const employeeId = text(r["id"]);
    const robotId = text(r["robotId"]);
    const id = employeeId ?? robotId;
    if (!id) return fail("directory", "invalid_response");
    const fields = {
      employeeId,
      managerEmployeeId: employeeId,
      robotId,
      robotAccountId: text(r["robotAccountId"]),
      namespace: text(r["namespace"]),
      status: text(r["status"]),
      templateType: text(r["templateType"] ?? r["template_type"]),
    };
    const eligibility = managerRobotEligibility(fields);
    robots.set(
      id,
      Object.freeze({
        ...fields,
        id,
        name: text(r["name"]) ?? id,
        eligibility,
        canAutoConnect: eligibility === "ready",
      }),
    );
  }
  return Object.freeze([...robots.values()]);
};
export interface ManagerDirectoryPage {
  readonly items: readonly ManagerRobot[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasMore: boolean;
}
export interface ManagerDirectorySnapshot {
  /** Changes only when identity is revoked/replaced, never on directory cancellation. */
  readonly identityRevision?: number | undefined;
  readonly status:
    "idle" | "loading" | "ready" | "error" | "auth_required" | "disposed";
  readonly items: readonly ManagerRobot[];
  readonly pagination?: Omit<ManagerDirectoryPage, "items"> | undefined;
  readonly error?: ManagerDiagnostic | undefined;
}
export interface ManagerRequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly deadlineAt?: number | undefined;
}
export interface ManagerConnectionInfo {
  readonly socketBaseUrl: string;
  readonly sioPath: string;
  readonly namespace: string;
  readonly rid: string;
  readonly robotType: string;
  readonly routingHeaders?: Readonly<Record<string, string>> | undefined;
}
export const parseManagerConnectionInfo = (
  payload: unknown,
): ManagerConnectionInfo => {
  const r = unwrap(payload);
  const socketBaseUrl = text(r["socketBaseURL"] ?? r["socketBaseUrl"]);
  const namespace = text(r["namespace"]),
    rid = text(r["rid"]),
    robotType = text(r["robotType"]),
    sioPath = text(r["sioPath"]);
  if (!socketBaseUrl || !namespace || !rid || !robotType || !sioPath)
    return fail("connection-info", "invalid_response");
  const routingHeaders: Record<string, string> = {};
  const headers = record(r["routingHeaders"]);
  const expected: Record<string, string> = {
    "x-tf-namespace": namespace,
    "x-tf-robotid": rid,
    "x-tf-robottype": robotType,
  };
  for (const [key, value] of Object.entries(headers ?? {})) {
    const normalized = key.toLowerCase();
    const expectedValue = Object.hasOwn(expected, normalized)
      ? expected[normalized]
      : undefined;
    if (expectedValue === undefined || value !== expectedValue)
      return fail("resolve", "unsupported_contract");
    routingHeaders[key] = expectedValue;
  }
  return Object.freeze({
    socketBaseUrl,
    namespace,
    rid,
    robotType,
    sioPath,
    routingHeaders: Object.freeze(routingHeaders),
  });
};
export interface ManagerTarget {
  readonly baseUrl: string;
  readonly socketNamespaceUrl: string;
  readonly socketPath: string;
  readonly namespace: string;
  readonly robotId: string;
  readonly robotType: string;
}
export interface ManagerRoutingPolicy {
  /** Explicit trusted origins. No implicit vendor-domain trust. */
  readonly allowedOrigins: readonly string[];
  readonly isTrustedOrigin?: ((origin: string) => boolean) | undefined;
  /** REST policy is independent of the Engine.IO path. BFF must forward exchanged Bearer tokens. */
  readonly http:
    | { readonly kind: "routed-api" }
    | { readonly kind: "direct" }
    | { readonly kind: "bff"; readonly baseUrl: string };
  /** Direct local servers use the unprefixed Engine.IO path. */
  readonly socket?: "routed" | "direct" | undefined;
}
const safeUrl = (value: string, originOnly = false): URL => {
  if (
    /[\\\s]/u.test(value) ||
    /%(?:2e|2f|5c)/iu.test(value) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/u.test(value)
  )
    return fail("resolve", "unsupported_contract");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("resolve", "unsupported_contract");
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (originOnly && url.pathname !== "/")
  )
    return fail("resolve", "unsupported_contract");
  return url;
};
export const resolveManagerTarget = (
  info: ManagerConnectionInfo,
  robot: Pick<ManagerRobot, "robotId" | "namespace">,
  policy: ManagerRoutingPolicy,
): ManagerTarget => {
  const origin = safeUrl(info.socketBaseUrl, true).origin;
  if (!(
    policy.allowedOrigins.includes(origin) || policy.isTrustedOrigin?.(origin)
  ))
    return fail("resolve", "authorization");
  if (
    ![info.namespace, info.rid].every((v) => /^[a-z0-9-]+$/u.test(v)) ||
    info.robotType !== "tfrobot" ||
    (robot.robotId !== undefined && info.rid !== robot.robotId) ||
    (robot.namespace !== undefined && info.namespace !== robot.namespace)
  )
    return fail("resolve", "unsupported_contract");
  const legacyPrefix = `/c/${info.robotType}/${info.namespace}/${info.rid}`;
  const aliasPrefix = `/c/${info.robotType}/${info.rid}`;
  const path = info.sioPath;
  // Exact known wire variants, never infer REST routing by removing a Socket suffix.
  const relative = path === "/socket.io" || path === "/socket.io/";
  const legacy =
    path === `${legacyPrefix}/socket.io` ||
    path === `${legacyPrefix}/socket.io/`;
  const alias =
    path === `${aliasPrefix}/socket.io` || path === `${aliasPrefix}/socket.io/`;
  if (!relative && !legacy && !alias)
    return fail("resolve", "unsupported_contract");
  if (policy.socket === "direct" && !relative)
    return fail("resolve", "unsupported_contract");
  const route = alias ? aliasPrefix : legacyPrefix;
  let baseUrl: string;
  switch (policy.http.kind) {
    case "direct":
      baseUrl = origin;
      break;
    case "routed-api":
      baseUrl = `${origin}${route}/api`;
      break;
    case "bff": {
      const url = safeUrl(policy.http.baseUrl);
      if (!(
        policy.allowedOrigins.includes(url.origin) ||
        policy.isTrustedOrigin?.(url.origin)
      ))
        return fail("resolve", "authorization");
      baseUrl = url.toString().replace(/\/$/u, "");
      break;
    }
    default:
      return fail("resolve", "unsupported_contract");
  }
  return Object.freeze({
    baseUrl,
    socketNamespaceUrl: `${origin}/chat`,
    socketPath:
      policy.socket === "direct" || !relative ? path : `${route}${path}`,
    namespace: info.namespace,
    robotId: info.rid,
    robotType: info.robotType,
  });
};
export interface ManagerRobotSessionProvider {
  getSession(request?: {
    readonly purpose?: "connect" | "reconnect" | "request";
    readonly operation?: "read" | "send" | "subscribe" | "remote-tool";
    readonly signal?: AbortSignal | undefined;
    readonly deadlineAt?: number | undefined;
  }): Promise<AuthSession>;
  onSessionInvalid(invalidation: {
    readonly reason: "expired" | "forbidden" | "rejected" | "unknown";
    readonly error: unknown;
  }): void;
  invalidate(): void;
  dispose(): void;
}
export interface ManagerRobotConnection {
  readonly target: ManagerTarget;
  readonly sessionProvider: ManagerRobotSessionProvider;
  dispose(): void;
}
export interface CreateManagerClientOptions {
  readonly auth: AuthClient;
  readonly baseUrl: string;
  readonly routing: ManagerRoutingPolicy;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly onDiagnostic?: ((diagnostic: ManagerDiagnostic) => void) | undefined;
}
const statusCode = (status: number): ManagerErrorCode =>
  status === 401
    ? "authentication"
    : status === 403
      ? "authorization"
      : status === 404
        ? "not_found"
        : status === 409
          ? "conflict"
          : status === 402
            ? "payment_required"
            : status === 429
              ? "rate_limited"
              : status >= 500
                ? "server"
                : "invalid_response";
const positive = (value: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new TypeError("Invalid Manager request bound");
  return value;
};

const bounded = async <T>(
  operation: () => Promise<T>,
  request: ManagerRequestOptions,
  timeoutMs: number,
  now: () => number,
): Promise<T> => {
  const signal = request.signal;
  const remaining = Math.min(
    timeoutMs,
    (request.deadlineAt ?? Infinity) - now(),
  );
  if (signal?.aborted) return fail("exchange", "cancelled");
  if (remaining <= 0) return fail("exchange", "timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const gate = new Promise<never>((_, reject) => {
    abort = () => reject(new ManagerIntegrationError("exchange", "cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => reject(new ManagerIntegrationError("exchange", "timeout")),
      remaining,
    );
  });
  try {
    return await Promise.race([operation(), gate]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
};

/** Instance-local Manager integration. Identity revocation is event driven. */
export class ManagerClient {
  readonly #options: CreateManagerClientOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #base: string;
  readonly #timeout: number;
  readonly #unsubscribe: () => void;
  readonly #unsubscribeDispose: (() => void) | undefined;
  readonly #listeners = new Set<(snapshot: ManagerDirectorySnapshot) => void>();
  readonly #controllers = new Set<AbortController>();
  readonly #connections = new Set<ManagerRobotConnection>();
  readonly #providers = new Set<ManagerRobotSessionProvider>();
  readonly #diagnostics: ManagerDiagnostic[] = [];
  #snapshot: ManagerDirectorySnapshot = Object.freeze({
    status: "idle",
    items: Object.freeze([]),
  });
  #scope: string | undefined;
  #generation = 0;
  #directoryGeneration = 0;
  #directoryController: AbortController | undefined;
  #disposed = false;
  constructor(options: CreateManagerClientOptions) {
    this.#options = options;
    this.#base = safeUrl(options.baseUrl).toString().replace(/\/$/u, "");
    const transport = options.fetch;
    this.#fetch =
      transport == null
        ? (input, init) => globalThis.fetch(input, init)
        : (input, init) => transport(input, init);
    this.#now = options.now ?? Date.now;
    this.#timeout = positive(options.timeoutMs ?? 10_000, 60_000);
    this.#scope = managerIdentityScope(options.auth.getSnapshot());
    this.#unsubscribe = options.auth.subscribe((snapshot) =>
      this.#changeScope(managerIdentityScope(snapshot)),
    );
    this.#unsubscribeDispose = options.auth.onDispose?.(() =>
      this.#changeScope(undefined),
    );
  }
  #changeScope(scope: string | undefined): void {
    if (scope === this.#scope || this.#disposed) return;
    this.#scope = scope;
    this.#generation++;
    this.cancel();
    for (const connection of [...this.#connections]) connection.dispose();
    for (const provider of [...this.#providers]) provider.dispose();
    this.#update({
      status: scope === undefined ? "auth_required" : "idle",
      items: Object.freeze([]),
    });
  }
  getSnapshot(): ManagerDirectorySnapshot {
    return this.#snapshot;
  }
  getDiagnostics(): readonly ManagerDiagnostic[] {
    return Object.freeze([...this.#diagnostics]);
  }
  subscribe(
    listener: (snapshot: ManagerDirectorySnapshot) => void,
  ): () => void {
    if (this.#disposed) return () => {};
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #update(snapshot: ManagerDirectorySnapshot): void {
    if (this.#disposed) return;
    this.#snapshot = Object.freeze({
      ...snapshot,
      identityRevision: this.#generation,
    });
    for (const listener of this.#listeners) {
      try {
        listener(this.#snapshot);
      } catch {
        /* Isolate observers. */
      }
    }
  }
  #assert(
    generation = this.#generation,
    operation: ManagerOperation = "directory",
  ): void {
    this.#changeScope(managerIdentityScope(this.#options.auth.getSnapshot()));
    if (this.#disposed) return fail(operation, "disposed");
    if (generation !== this.#generation) return fail(operation, "cancelled");
    if (!this.#scope) return fail(operation, "authentication");
  }
  #report(error: ManagerIntegrationError): void {
    if (error.code === "cancelled" || error.code === "disposed") return;
    this.#diagnostics.push(error.diagnostic);
    if (this.#diagnostics.length > 50) this.#diagnostics.shift();
    try {
      this.#options.onDiagnostic?.(error.diagnostic);
    } catch {
      /* Diagnostics cannot break a request. */
    }
  }
  async #request(
    operation: ManagerOperation,
    path: string,
    init: RequestInit,
    options: ManagerRequestOptions,
    managerAuth: boolean,
  ): Promise<unknown> {
    this.#assert();
    const generation = this.#generation;
    const controller = new AbortController();
    this.#controllers.add(controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    let timedOut = false;
    const remaining = Math.min(
      this.#timeout,
      (options.deadlineAt ?? Infinity) - this.#now(),
    );
    if (remaining <= 0) {
      timedOut = true;
      controller.abort();
    }
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(0, remaining),
    );
    const check = () => {
      this.#assert(generation);
      if (controller.signal.aborted)
        return fail(operation, timedOut ? "timeout" : "cancelled");
    };
    // Race even injected transports/session providers that fail to honor AbortSignal.
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort(
        new ManagerIntegrationError(
          operation,
          timedOut ? "timeout" : "cancelled",
        ),
      );
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    const work = async () => {
      check();
      const provider = this.#options.auth.createSessionProvider();
      const headers = new Headers(init.headers);
      if (managerAuth) {
        const session = await provider.getSession({
          signal: controller.signal,
        });
        check();
        headers.set("Authorization", `Bearer ${session.token}`);
      }
      const response = await this.#fetch(`${this.#base}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      });
      check();
      if (!response.ok) {
        if (response.status === 401) {
          // No Manager refresh contract is assumed and the failed operation is not replayed.
          void provider
            .onSessionInvalid({ reason: "rejected", error: { status: 401 } })
            .catch(() => undefined);
        }
        throw new ManagerIntegrationError(
          operation,
          statusCode(response.status),
          response.status,
          operation === "directory"
            ? "/api/v1/digital-employees"
            : operation === "exchange"
              ? "/api/v1/oauth/token"
              : "/api/v1/digital-employees/:employeeId/connection-info",
          response.headers.get("x-request-id") ?? undefined,
        );
      }
      const payload: unknown = await response.json();
      check();
      return payload;
    };
    try {
      return await Promise.race([work(), aborted]);
    } catch (error) {
      const safe =
        error instanceof ManagerIntegrationError
          ? error
          : new ManagerIntegrationError(
              operation,
              controller.signal.aborted
                ? timedOut
                  ? "timeout"
                  : "cancelled"
                : error instanceof SyntaxError
                  ? "invalid_response"
                  : "network",
            );
      throw safe;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
      this.#controllers.delete(controller);
    }
  }
  cancel(): void {
    this.#directoryGeneration++;
    for (const controller of this.#controllers) controller.abort();
    if (this.#snapshot.status === "loading")
      this.#update({ ...this.#snapshot, status: "idle" });
  }
  async loadPage(
    page = 1,
    pageSize = 20,
    options: ManagerRequestOptions = {},
  ): Promise<ManagerDirectoryPage> {
    positive(page, 1_000_000);
    positive(pageSize, 100);
    this.#assert();
    this.#directoryController?.abort();
    const controller = new AbortController();
    this.#directoryController = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const sequence = ++this.#directoryGeneration;
    this.#update({ ...this.#snapshot, status: "loading", error: undefined });
    try {
      const payload = await this.#request(
        "directory",
        `/api/v1/digital-employees?page=${page}&pageSize=${pageSize}`,
        {},
        { ...options, signal: controller.signal },
        true,
      );
      if (sequence !== this.#directoryGeneration)
        return fail("directory", "cancelled");
      const r = unwrap(payload),
        items = parseManagerRobots(payload);
      const total = r["total"],
        actualPage = r["page"],
        actualSize = r["pageSize"];
      if (
        typeof total !== "number" ||
        !Number.isSafeInteger(total) ||
        total < 0 ||
        actualPage !== page ||
        actualSize !== pageSize
      )
        return fail("directory", "invalid_response");
      const result = Object.freeze({
        items,
        page,
        pageSize,
        total,
        hasMore: page * pageSize < total,
      });
      const merged = new Map(
        (page === 1 ? [] : this.#snapshot.items).map((item) => [item.id, item]),
      );
      for (const item of items) merged.set(item.id, item);
      const pagination = { page, pageSize, total, hasMore: result.hasMore };
      this.#update({
        status: "ready",
        items: Object.freeze([...merged.values()]),
        pagination: Object.freeze(pagination),
      });
      return result;
    } catch (error) {
      if (error instanceof ManagerIntegrationError) this.#report(error);
      if (
        sequence === this.#directoryGeneration &&
        error instanceof ManagerIntegrationError
      )
        this.#update({
          ...this.#snapshot,
          status:
            error.code === "authentication"
              ? "auth_required"
              : error.code === "cancelled"
                ? "idle"
                : "error",
          error: error.diagnostic,
        });
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
  refresh(options?: ManagerRequestOptions): Promise<ManagerDirectoryPage> {
    return this.loadPage(1, this.#snapshot.pagination?.pageSize ?? 20, options);
  }
  async getConnectionInfo(
    employeeId: string,
    options: ManagerRequestOptions = {},
  ): Promise<ManagerConnectionInfo> {
    if (!/^[a-zA-Z0-9-]+$/u.test(employeeId))
      return fail("connection-info", "invalid_response");
    try {
      const payload = await this.#request(
        "connection-info",
        `/api/v1/digital-employees/${encodeURIComponent(employeeId)}/connection-info`,
        {},
        options,
        true,
      );
      return parseManagerConnectionInfo(payload);
    } catch (error) {
      const safe =
        error instanceof ManagerIntegrationError
          ? new ManagerIntegrationError(
              "connection-info",
              error.code,
              error.status,
              error.diagnostic.path,
              error.diagnostic.requestId,
            )
          : new ManagerIntegrationError("connection-info", "invalid_response");
      this.#report(safe);
      throw safe;
    }
  }
  async connect(
    robot: ManagerRobot,
    options: ManagerRequestOptions = {},
  ): Promise<ManagerRobotConnection> {
    this.#assert();
    const generation = this.#generation;
    if (managerRobotEligibility(robot) !== "ready")
      return fail("resolve", "unsupported_contract");
    const info = await this.getConnectionInfo(robot.employeeId!, options);
    this.#assert(generation);
    let target: ManagerTarget;
    try {
      target = resolveManagerTarget(info, robot, this.#options.routing);
    } catch (error) {
      if (error instanceof ManagerIntegrationError) this.#report(error);
      throw error;
    }
    const provider = this.createRobotSessionProvider(robot.robotAccountId!);
    const abort = () => provider.dispose();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await provider.getSession(options);
      this.#assert(generation);
    } catch (error) {
      provider.dispose();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    const connection: ManagerRobotConnection = Object.freeze({
      target,
      sessionProvider: provider,
      dispose: () => {
        provider.dispose();
        this.#connections.delete(connection);
      },
    });
    this.#connections.add(connection);
    return connection;
  }
  createRobotSessionProvider(
    robotAccountId: string,
  ): ManagerRobotSessionProvider {
    this.#assert();
    if (!robotAccountId.trim())
      throw new TypeError("robotAccountId is required");
    const generation = this.#generation;
    let cached: { token: string; expiresAt: number } | undefined;
    let pending: Promise<AuthSession> | undefined;
    let controller = new AbortController();
    let revision = 0;
    let disposed = false;
    let forbidden = false;
    const guard = () => {
      this.#assert(generation, "exchange");
      if (disposed) return fail("exchange", "disposed");
      if (forbidden) return fail("exchange", "authorization");
    };
    const invalidate = () => {
      revision++;
      cached = undefined;
      pending = undefined;
      controller.abort();
      controller = new AbortController();
    };
    const exchange = async (
      request: ManagerRequestOptions,
    ): Promise<AuthSession> => {
      const current = revision;
      guard();
      const signal = controller.signal;
      const manager = await bounded(
        () => this.#options.auth.createSessionProvider().getSession({ signal }),
        { signal, deadlineAt: request.deadlineAt },
        this.#timeout,
        this.#now,
      );
      guard();
      if (current !== revision || signal.aborted)
        return fail("exchange", "cancelled");
      const started = this.#now();
      const payload = await this.#request(
        "exchange",
        "/api/v1/oauth/token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams([
            ["grant_type", "urn:ietf:params:oauth:grant-type:token-exchange"],
            ["subject_token", manager.token],
            ["subject_token_type", "urn:ietf:params:oauth:token-type:jwt"],
            ["audience", `robot:${robotAccountId}`],
            ["scope", "chat:read chat:send"],
            ["token_profile", "session"],
          ]),
        },
        { signal, deadlineAt: request.deadlineAt },
        false,
      );
      guard();
      if (current !== revision) return fail("exchange", "cancelled");
      const r = record(payload),
        token = r?.["access_token"],
        ttl = Number(r?.["expires_in"]);
      if (
        typeof token !== "string" ||
        !token.trim() ||
        !Number.isFinite(ttl) ||
        ttl <= 0 ||
        ttl > 86_400 ||
        (r?.["token_type"] !== undefined && r["token_type"] !== "Bearer") ||
        (r?.["issued_token_type"] !== undefined &&
          r["issued_token_type"] !==
            "urn:ietf:params:oauth:token-type:access_token" &&
          r["issued_token_type"] !== "urn:ietf:params:oauth:token-type:jwt")
      )
        return fail("exchange", "invalid_response");
      const expiresAt = started + ttl * 1000;
      if (expiresAt <= this.#now()) return fail("exchange", "authentication");
      cached = { token, expiresAt };
      return { kind: "bearer", token, expiresAt };
    };
    const provider: ManagerRobotSessionProvider = {
      getSession: async (request) => {
        guard();
        if (request?.signal?.aborted) return fail("exchange", "cancelled");
        const current = revision;
        if (cached && cached.expiresAt - 30_000 > this.#now())
          return { kind: "bearer", ...cached };
        if (!pending) {
          const work = exchange({}).catch((error: unknown) => {
            if (error instanceof ManagerIntegrationError) this.#report(error);
            if (
              error instanceof ManagerIntegrationError &&
              error.code === "authorization"
            )
              forbidden = true;
            throw error;
          });
          pending = work;
          void work
            .finally(() => {
              if (pending === work) pending = undefined;
            })
            .catch(() => undefined);
        }
        const work = pending;
        const result = await bounded(
          () => work,
          request ?? {},
          this.#timeout,
          this.#now,
        );
        guard();
        if (request?.signal?.aborted || current !== revision)
          return fail("exchange", "cancelled");
        return result;
      },
      onSessionInvalid: (invalidation) => {
        invalidate();
        if (invalidation.reason === "forbidden") forbidden = true;
      },
      invalidate,
      dispose: () => {
        disposed = true;
        invalidate();
        this.#providers.delete(provider);
      },
    };
    this.#providers.add(provider);
    return provider;
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.cancel();
    this.#generation++;
    this.#unsubscribe();
    this.#unsubscribeDispose?.();
    for (const connection of [...this.#connections]) connection.dispose();
    for (const provider of [...this.#providers]) provider.dispose();
    this.#snapshot = Object.freeze({
      status: "disposed",
      items: Object.freeze([]),
    });
    for (const listener of this.#listeners) {
      try {
        listener(this.#snapshot);
      } catch {
        /* Isolate observers. */
      }
    }
    this.#listeners.clear();
    this.#disposed = true;
  }
}
export const createManagerClient = (
  options: CreateManagerClientOptions,
): ManagerClient => new ManagerClient(options);
