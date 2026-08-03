export const ROBOTSERVER_DEBUG_PREFILL_PATH =
  "/__tf_chat_playground/robotserver-prefill";

export type RobotServerDebugAuthKind = "admin" | "bearer" | "password";
export type RobotServerDebugConnectionKind = "direct" | "standard";

export interface RobotServerDebugPrefill {
  readonly authKind?: RobotServerDebugAuthKind | undefined;
  readonly connectionKind?: RobotServerDebugConnectionKind | undefined;
  readonly creatorName?: string | undefined;
  readonly creatorUid?: string | undefined;
  readonly httpBaseUrl?: string | undefined;
  readonly namespace?: string | undefined;
  readonly platformId?: string | undefined;
  readonly robotId?: string | undefined;
  readonly secret?: string | undefined;
  readonly serverOrigin?: string | undefined;
  readonly socketNamespaceUrl?: string | undefined;
  readonly socketPath?: string | undefined;
}

export type RobotServerDebugPrefillResult =
  | { readonly ok: true; readonly value: RobotServerDebugPrefill | null }
  | { readonly ok: false; readonly message: string };

export type RobotServerDebugPrefillLoader = (
  signal?: AbortSignal,
) => Promise<RobotServerDebugPrefillResult>;

const STRING_FIELD_LIMITS = Object.freeze({
  creatorName: 512,
  creatorUid: 512,
  httpBaseUrl: 2_048,
  namespace: 256,
  platformId: 512,
  robotId: 256,
  secret: 8_192,
  serverOrigin: 2_048,
  socketNamespaceUrl: 2_048,
  socketPath: 2_048,
} satisfies Readonly<Record<string, number>>);

const ALLOWED_FIELDS = new Set([
  "authKind",
  "connectionKind",
  ...Object.keys(STRING_FIELD_LIMITS),
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readOptionalString = (
  record: Record<string, unknown>,
  field: keyof typeof STRING_FIELD_LIMITS,
): string | undefined => {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > STRING_FIELD_LIMITS[field]) {
    throw new Error("invalid-field");
  }
  return value;
};

export const parseRobotServerDebugPrefill = (
  input: unknown,
): RobotServerDebugPrefillResult => {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !ALLOWED_FIELDS.has(key))
  ) {
    return { ok: false, message: "本地 .debug 预填配置格式无效。" };
  }

  try {
    const authKind = input["authKind"];
    if (
      authKind !== undefined &&
      authKind !== "admin" &&
      authKind !== "bearer" &&
      authKind !== "password"
    ) {
      throw new Error("invalid-auth-kind");
    }
    const connectionKind = input["connectionKind"];
    if (
      connectionKind !== undefined &&
      connectionKind !== "direct" &&
      connectionKind !== "standard"
    ) {
      throw new Error("invalid-connection-kind");
    }
    if (
      connectionKind === "direct" &&
      (authKind === undefined || authKind === "password")
    ) {
      throw new Error("invalid-direct-auth-kind");
    }

    const creatorName = readOptionalString(input, "creatorName");
    const creatorUid = readOptionalString(input, "creatorUid");
    const httpBaseUrl = readOptionalString(input, "httpBaseUrl");
    const namespace = readOptionalString(input, "namespace");
    const platformId = readOptionalString(input, "platformId");
    const robotId = readOptionalString(input, "robotId");
    const secret = readOptionalString(input, "secret");
    const serverOrigin = readOptionalString(input, "serverOrigin");
    const socketNamespaceUrl = readOptionalString(input, "socketNamespaceUrl");
    const socketPath = readOptionalString(input, "socketPath");

    return {
      ok: true,
      value: {
        ...(authKind === undefined ? {} : { authKind }),
        ...(connectionKind === undefined ? {} : { connectionKind }),
        ...(creatorName === undefined ? {} : { creatorName }),
        ...(creatorUid === undefined ? {} : { creatorUid }),
        ...(httpBaseUrl === undefined ? {} : { httpBaseUrl }),
        ...(namespace === undefined ? {} : { namespace }),
        ...(platformId === undefined ? {} : { platformId }),
        ...(robotId === undefined ? {} : { robotId }),
        ...(secret === undefined ? {} : { secret }),
        ...(serverOrigin === undefined ? {} : { serverOrigin }),
        ...(socketNamespaceUrl === undefined ? {} : { socketNamespaceUrl }),
        ...(socketPath === undefined ? {} : { socketPath }),
      },
    };
  } catch {
    return { ok: false, message: "本地 .debug 预填配置格式无效。" };
  }
};

export const loadRobotServerDebugPrefill: RobotServerDebugPrefillLoader =
  async (signal) => {
    try {
      const response = await fetch(ROBOTSERVER_DEBUG_PREFILL_PATH, {
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status === 204 || response.status === 404) {
        return { ok: true, value: null };
      }
      if (!response.ok) {
        return { ok: false, message: "无法加载本地 .debug 预填配置。" };
      }
      return parseRobotServerDebugPrefill(await response.json());
    } catch {
      if (signal?.aborted === true) return { ok: true, value: null };
      return { ok: false, message: "无法加载本地 .debug 预填配置。" };
    }
  };
