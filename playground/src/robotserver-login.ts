import type {
  RobotServerConnectionTargetConfig,
  RobotServerConnectionValidation,
} from "./robotserver-session.js";
import { createRobotServerConnectionConfig } from "./robotserver-session.js";

const MAX_PASSWORD_CHARACTERS = 4_096;

export interface RobotServerPasswordLoginDependencies {
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}

const loginError = (status: number): string => {
  if (status === 401) return "管理员密码不正确。";
  if (status === 501) return "该 RobotServer 尚未配置管理员密码。";
  if (status === 408 || status === 504) return "登录请求超时，请稍后重试。";
  return "RobotServer 登录失败，请检查连接参数后重试。";
};

export const loginRobotServerWithPassword = async (
  target: RobotServerConnectionTargetConfig,
  password: string,
  dependencies: RobotServerPasswordLoginDependencies = {},
): Promise<RobotServerConnectionValidation> => {
  if (password.length === 0 || password.length > MAX_PASSWORD_CHARACTERS) {
    return { ok: false, message: "请输入不超过 4096 个字符的管理员密码。" };
  }

  let response: Response;
  try {
    response = await (dependencies.fetch ?? globalThis.fetch)(
      `${target.httpBaseUrl}/v1/auth/login`,
      {
        body: JSON.stringify({ password }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal }),
      },
    );
  } catch {
    return { ok: false, message: "无法连接 RobotServer 登录接口。" };
  }
  if (!response.ok) return { ok: false, message: loginError(response.status) };

  try {
    const payload = (await response.json()) as unknown;
    if (payload === null || typeof payload !== "object") throw new Error();
    const envelope = payload as Record<string, unknown>;
    const data = envelope["data"];
    if (envelope["code"] !== 200 || data === null || typeof data !== "object") {
      throw new Error();
    }
    const accessToken = (data as Record<string, unknown>)["accessToken"];
    if (
      typeof accessToken !== "string" ||
      accessToken.length === 0 ||
      accessToken.length > 8_192
    ) {
      throw new Error();
    }
    return createRobotServerConnectionConfig(target, "admin", accessToken);
  } catch {
    return {
      ok: false,
      message: "RobotServer 返回了无法识别的登录结果。",
    };
  }
};
