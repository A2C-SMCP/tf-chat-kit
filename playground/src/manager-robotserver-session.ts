import {
  createManagerClient,
  managerRobotEligibility,
  type ManagerRobot,
} from "../../packages/chat-auth/src/manager.js";
import type { AuthClient } from "../../packages/chat-auth/src/headless.js";
import type { PlaygroundRobotDescriptor } from "./manager-directory.js";
import type { RobotServerConnectionConfig } from "./robotserver-session.js";

export interface ManagerRobotServerSessionOptions {
  readonly client: AuthClient;
  readonly managerBaseUrl: string;
  readonly robot: PlaygroundRobotDescriptor;
  readonly allowedServerOrigins?: readonly string[] | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly creator?:
    { readonly name: string; readonly uid: string } | undefined;
}
/** Uses the same public browser-to-Server contract as independent hosts. */
export const createManagerRobotServerConnection = async (
  options: ManagerRobotServerSessionOptions,
): Promise<RobotServerConnectionConfig> => {
  const robotFields = {
    ...options.robot,
    employeeId: options.robot.managerEmployeeId,
  };
  const eligibility = managerRobotEligibility(robotFields);
  const robot: ManagerRobot = { ...robotFields, eligibility };
  const allowedOrigins = [
    ...(options.allowedServerOrigins ?? []),
    "https://api.turingfocus.cn",
    "https://api-staging.turingfocus.cn",
    "https://staging.turingfocus.cn",
  ];
  const manager = createManagerClient({
    auth: options.client,
    baseUrl: options.managerBaseUrl,
    fetch: options.fetch,
    now: options.now,
    routing: {
      allowedOrigins,
      isTrustedOrigin: (origin) => {
        const url = new URL(origin);
        return (
          url.protocol === "https:" &&
          (url.hostname === "turingfocus.cn" ||
            url.hostname.endsWith(".turingfocus.cn"))
        );
      },
      http: { kind: "routed-server" },
    },
  });
  try {
    const connection = await manager.connect(robot, { signal: options.signal });
    return {
      httpBaseUrl: connection.target.baseUrl,
      socketNamespaceUrl: connection.target.socketNamespaceUrl,
      socketPath: connection.target.socketPath,
      creator: options.creator ?? {
        name: "Manager 用户",
        uid: options.client.getSnapshot().account?.userId ?? "manager-user",
      },
      sessionProvider: connection.sessionProvider,
      disposeSession: () => manager.dispose(),
    };
  } catch (error) {
    await manager.dispose();
    throw error;
  }
};
