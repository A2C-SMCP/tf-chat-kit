import type { AuthClient } from "../../packages/chat-auth/src/headless.js";
import {
  loadManagerConnectionInfo,
  type PlaygroundManagerConnectionInfo,
  type PlaygroundRobotDescriptor,
} from "./manager-directory.js";
import {
  ManagerRobotTokenSource,
  managerTokenExchangeDefaults,
} from "./manager-token-exchange.js";
import {
  validateRobotServerTarget,
  type RobotServerConnectionTargetDraft,
  type RobotServerConnectionConfig,
} from "./robotserver-session.js";

export interface ManagerRobotServerSessionOptions {
  readonly client: AuthClient;
  readonly managerBaseUrl: string;
  readonly robot: PlaygroundRobotDescriptor;
  readonly proxyOrigin: string;
  readonly allowedServerOrigins?: readonly string[] | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly creator?:
    { readonly name: string; readonly uid: string } | undefined;
}

const serverOriginOf = (socketBaseUrl: string): string => {
  try {
    const url = new URL(socketBaseUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error("invalid-origin");
    }
    return url.origin;
  } catch {
    throw new Error("Manager 返回了无效的 RobotServer 地址");
  }
};

const socketPathOf = (info: PlaygroundManagerConnectionInfo): string => {
  const suffix = info.sioPath?.trim() || "/socket.io";
  return `/c/${info.robotType}/${info.namespace}/${info.rid}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
};

export const managerRobotServerTargetDraft = (
  info: PlaygroundManagerConnectionInfo,
  proxyOrigin: string,
  allowedServerOrigins: readonly string[] = [],
): RobotServerConnectionTargetDraft => ({
  allowedServerOrigins,
  connectionKind: "standard",
  creatorName: "",
  creatorUid: "",
  httpBaseUrl: "",
  namespace: info.namespace,
  platformId: "",
  proxyOrigin,
  robotId: info.rid,
  serverOrigin: serverOriginOf(info.socketBaseUrl),
  socketNamespaceUrl: "",
  socketPath: socketPathOf(info),
  ...(info.routingHeaders === undefined
    ? {}
    : { routingHeaders: info.routingHeaders }),
});

/**
 * Resolves the current Manager employee and creates a dynamic RobotServer
 * session. The returned config intentionally has no static credential.
 */
export const createManagerRobotServerConnection = async (
  options: ManagerRobotServerSessionOptions,
): Promise<RobotServerConnectionConfig> => {
  const employeeId = options.robot.managerEmployeeId;
  const robotAccountId = options.robot.robotAccountId;
  if (employeeId === undefined || employeeId.trim().length === 0) {
    throw new Error("当前机器人缺少 Manager employeeId，无法自动连接。");
  }
  if (robotAccountId === undefined || robotAccountId.trim().length === 0) {
    throw new Error(
      "当前机器人缺少 robotAccountId，请使用手工 RobotServer 连接。",
    );
  }
  if (
    options.robot.status !== undefined &&
    options.robot.status !== "running"
  ) {
    throw new Error("当前机器人未处于 running 状态，暂时不能建立真实连接。");
  }
  if (
    options.robot.templateType !== undefined &&
    options.robot.templateType !== "tfrserver"
  ) {
    throw new Error(
      "当前机器人不是 tfrserver 类型，暂时不能使用 ChatKit 连接。",
    );
  }
  const connectionInfo = await loadManagerConnectionInfo(
    options.client,
    options.managerBaseUrl,
    employeeId,
    options.fetch,
  );
  const target = validateRobotServerTarget(
    managerRobotServerTargetDraft(
      connectionInfo,
      options.proxyOrigin,
      options.allowedServerOrigins,
    ),
  );
  if (!target.ok) throw new Error(target.message);

  const managerSessionProvider = options.client.createSessionProvider();
  const tokenSource = new ManagerRobotTokenSource({
    tokenUrl: `${options.managerBaseUrl.replace(/\/$/u, "")}/api/v1/oauth/token`,
    getManagerUserJwt: async () =>
      (await managerSessionProvider.getSession()).token,
    robotAccountId,
    scope: managerTokenExchangeDefaults.scope,
    tokenProfile: managerTokenExchangeDefaults.tokenProfile,
    fetch: options.fetch,
    now: options.now,
  });
  // Resolve once during the explicit button action so Token Exchange errors
  // are shown in the connection panel instead of being flattened by Gateway.
  await tokenSource.getToken();
  const creator =
    options.creator ??
    ({
      name: "Manager 用户",
      uid: options.client.getSnapshot().account?.userId ?? "manager-user",
    } satisfies { readonly name: string; readonly uid: string });
  return {
    ...target.value,
    creator,
    sessionProvider: tokenSource,
    disposeSession: () => tokenSource.invalidate(),
  };
};
