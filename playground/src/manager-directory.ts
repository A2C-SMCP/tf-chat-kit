import type { AuthClient } from "../../packages/chat-auth/src/headless.js";

export interface PlaygroundRobotDescriptor {
  readonly id: string;
  readonly managerEmployeeId?: string | undefined;
  readonly name: string;
  readonly robotId?: string | undefined;
  readonly robotAccountId?: string | undefined;
  readonly namespace?: string | undefined;
  readonly robotType?: string | undefined;
  readonly rid?: string | undefined;
  readonly sioPath?: string | undefined;
  readonly status?: string | undefined;
  readonly templateType?: string | undefined;
  readonly socketBaseUrl?: string | undefined;
  readonly routingHeaders?: Readonly<Record<string, string>> | undefined;
  readonly canAutoConnect: boolean;
}

export interface PlaygroundManagerConnectionInfo {
  readonly socketBaseUrl: string;
  readonly sioPath?: string | undefined;
  readonly namespace: string;
  readonly rid: string;
  readonly robotType: string;
  readonly routingHeaders?: Readonly<Record<string, string>> | undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;

const asHeaders = (
  value: unknown,
): Readonly<Record<string, string>> | undefined => {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const sensitive = /token|authorization|cookie|x[-_]?api[-_]?key/iu;
  const headers = Object.fromEntries(
    Object.entries(record).flatMap(([key, item]) =>
      typeof item === "string" && !sensitive.test(key) ? [[key, item]] : [],
    ),
  );
  return Object.keys(headers).length > 0 ? headers : undefined;
};

const itemsFrom = (payload: unknown): readonly unknown[] => {
  if (Array.isArray(payload)) return payload;
  const envelope = asRecord(payload);
  const data = asRecord(envelope?.["data"]);
  const items = envelope?.["items"] ?? data?.["items"];
  return Array.isArray(items) ? items : [];
};

export const parsePlaygroundRobots = (
  payload: unknown,
): readonly PlaygroundRobotDescriptor[] =>
  itemsFrom(payload).flatMap((item) => {
    const record = asRecord(item);
    if (record === undefined) return [];
    const employeeId = asString(record["id"]);
    const robotId = asString(record["robotId"] ?? record["rid"]);
    const id = robotId ?? employeeId;
    if (id === undefined) return [];
    const robotAccountId = asString(record["robotAccountId"]);
    return [
      {
        id,
        ...(employeeId === undefined ? {} : { managerEmployeeId: employeeId }),
        name: asString(record["name"]) ?? id,
        ...(robotId === undefined ? {} : { robotId }),
        ...(robotAccountId === undefined ? {} : { robotAccountId }),
        ...(asString(record["namespace"]) === undefined
          ? {}
          : { namespace: asString(record["namespace"]) }),
        ...(asString(record["status"]) === undefined
          ? {}
          : { status: asString(record["status"]) }),
        ...(asString(record["templateType"] ?? record["template_type"]) ===
        undefined
          ? {}
          : {
              templateType: asString(
                record["templateType"] ?? record["template_type"],
              ),
            }),
        canAutoConnect: robotAccountId !== undefined,
      },
    ];
  });

export const parsePlaygroundConnectionInfo = (
  payload: unknown,
): Partial<PlaygroundManagerConnectionInfo> => {
  const envelope = asRecord(payload);
  const data = asRecord(envelope?.["data"]) ?? envelope;
  const namespace = asString(data?.["namespace"]);
  const rid = asString(data?.["rid"]);
  const robotType = asString(data?.["robotType"]);
  const socketBaseUrl = asString(
    data?.["socketBaseURL"] ?? data?.["socketBaseUrl"],
  );
  const sioPath = asString(data?.["sioPath"]);
  const routingHeaders = asHeaders(data?.["routingHeaders"]);
  return {
    ...(namespace === undefined ? {} : { namespace }),
    ...(rid === undefined ? {} : { rid }),
    ...(robotType === undefined ? {} : { robotType }),
    ...(socketBaseUrl === undefined ? {} : { socketBaseUrl }),
    ...(sioPath === undefined ? {} : { sioPath }),
    ...(routingHeaders === undefined ? {} : { routingHeaders }),
  };
};

export const loadManagerConnectionInfo = async (
  client: AuthClient,
  baseUrl: string,
  employeeId: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<PlaygroundManagerConnectionInfo> => {
  const session = await client.createSessionProvider().getSession();
  if (session?.kind !== "bearer") throw new Error("Manager 登录已失效");
  const response = await fetcher(
    `${baseUrl.replace(/\/$/u, "")}/api/v1/digital-employees/${encodeURIComponent(employeeId)}/connection-info`,
    { headers: { Authorization: `Bearer ${session.token}` } },
  );
  if (!response.ok)
    throw new Error(`RobotServer 连接信息加载失败（${response.status}）`);
  const parsed = parsePlaygroundConnectionInfo(await response.json());
  if (
    parsed.socketBaseUrl === undefined ||
    parsed.namespace === undefined ||
    parsed.rid === undefined ||
    parsed.robotType === undefined
  ) {
    throw new Error("Manager 返回的 RobotServer 连接信息不完整");
  }
  return {
    socketBaseUrl: parsed.socketBaseUrl,
    namespace: parsed.namespace,
    rid: parsed.rid,
    robotType: parsed.robotType,
    ...(parsed.sioPath === undefined ? {} : { sioPath: parsed.sioPath }),
    ...(parsed.routingHeaders === undefined
      ? {}
      : { routingHeaders: parsed.routingHeaders }),
  };
};

export const loadManagerRobotDirectory = async (
  client: AuthClient,
  baseUrl: string,
  _organizationId: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<readonly PlaygroundRobotDescriptor[]> => {
  const session = await client.createSessionProvider().getSession();
  if (session?.kind !== "bearer") return [];
  const response = await fetcher(
    `${baseUrl.replace(/\/$/u, "")}/api/v1/digital-employees`,
    { headers: { Authorization: `Bearer ${session.token}` } },
  );
  if (!response.ok) throw new Error("机器人列表加载失败");
  return parsePlaygroundRobots(await response.json());
};
