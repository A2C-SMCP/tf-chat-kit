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

export {
  parseManagerRobots as parsePlaygroundRobots,
  parseManagerConnectionInfo as parsePlaygroundConnectionInfo,
} from "../../packages/chat-auth/src/manager.js";
import { createManagerClient } from "../../packages/chat-auth/src/manager.js";

export const loadManagerConnectionInfo = async (
  client: AuthClient,
  baseUrl: string,
  employeeId: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<PlaygroundManagerConnectionInfo> => {
  const manager = createManagerClient({
    auth: client,
    baseUrl,
    fetch: fetcher,
    routing: { allowedOrigins: [], http: { kind: "direct" } },
  });
  try {
    return await manager.getConnectionInfo(employeeId);
  } finally {
    await manager.dispose();
  }
};
export const loadManagerRobotDirectory = async (
  client: AuthClient,
  baseUrl: string,
  _organizationId: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<readonly PlaygroundRobotDescriptor[]> => {
  const manager = createManagerClient({
    auth: client,
    baseUrl,
    fetch: fetcher,
    routing: { allowedOrigins: [], http: { kind: "direct" } },
  });
  try {
    let page = await manager.loadPage();
    for (let next = 2; page.hasMore; next++) {
      if (next > 100)
        throw new Error(
          "Manager directory exceeds the 100-page Playground bound; use the public paged API.",
        );
      page = await manager.loadPage(next);
    }
    return manager.getSnapshot().items;
  } finally {
    await manager.dispose();
  }
};
