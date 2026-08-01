export const ROBOTSERVER_PROXY_PREFIX = "/__tfrobot_proxy";

const ROUTING_SEGMENT = /^[a-z0-9-]+$/u;

export interface TFRobotTargetInput {
  readonly namespace: string;
  readonly robotId: string;
  readonly serverOrigin: string;
}

export interface TFRobotTarget {
  readonly apiOrigin: string;
  readonly httpBaseUrl: string;
  readonly namespace: string;
  readonly robotId: string;
  readonly robotType: "tfrobot";
  readonly serverOrigin: string;
  readonly socketNamespaceUrl: string;
  readonly socketPath: string;
}

export type TFRobotTargetResult =
  | { readonly ok: true; readonly value: TFRobotTarget }
  | { readonly ok: false; readonly message: string };

const isTrustedTuringFocusOrigin = (url: URL): boolean =>
  url.protocol === "https:" &&
  (url.hostname === "turingfocus.cn" ||
    url.hostname.endsWith(".turingfocus.cn"));

const parseOrigin = (value: string): URL | undefined => {
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
};

const apiOriginForServer = (serverUrl: URL): string => {
  if (!isTrustedTuringFocusOrigin(serverUrl)) return serverUrl.origin;
  const apiUrl = new URL(serverUrl.origin);
  apiUrl.hostname = `api.${serverUrl.hostname}`;
  return apiUrl.origin;
};

export const parseTFRobotTarget = (
  input: TFRobotTargetInput,
  proxyOrigin: string,
  allowedServerOrigins: readonly string[] = [],
): TFRobotTargetResult => {
  const serverUrl = parseOrigin(input.serverOrigin);
  const localOrigin = parseOrigin(proxyOrigin);
  if (serverUrl === undefined || localOrigin === undefined) {
    return {
      ok: false,
      message:
        "请输入完整的 HTTP 或 HTTPS 服务地址，且不要包含路径、账号、查询参数或片段。",
    };
  }
  const explicitlyAllowed = allowedServerOrigins.some((allowed) => {
    const parsed = parseOrigin(allowed);
    return parsed !== undefined && parsed.origin === serverUrl.origin;
  });
  if (!isTrustedTuringFocusOrigin(serverUrl) && !explicitlyAllowed) {
    return {
      ok: false,
      message:
        "标准连接仅接受 TuringFocus 的 HTTPS 服务地址；其他地址请使用高级直连或显式本地测试白名单。",
    };
  }

  const namespace = input.namespace.trim();
  const robotId = input.robotId.trim();
  if (!ROUTING_SEGMENT.test(namespace) || !ROUTING_SEGMENT.test(robotId)) {
    return {
      ok: false,
      message: "Namespace 和 Robot ID 只能包含小写字母、数字与连字符。",
    };
  }

  const robotType = "tfrobot" as const;
  const apiOrigin = apiOriginForServer(serverUrl);
  const proxyTarget = [
    ROBOTSERVER_PROXY_PREFIX,
    encodeURIComponent(apiOrigin),
    robotType,
    namespace,
    robotId,
  ].join("/");

  return {
    ok: true,
    value: {
      apiOrigin,
      httpBaseUrl: `${localOrigin.origin}${proxyTarget}`,
      namespace,
      robotId,
      robotType,
      serverOrigin: serverUrl.origin,
      socketNamespaceUrl: `${serverUrl.origin}/chat`,
      socketPath: `/c/${robotType}/${namespace}/${robotId}/socket.io`,
    },
  };
};
